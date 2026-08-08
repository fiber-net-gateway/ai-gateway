#include "LlmAuditHttpSender.h"

#include "../observability/AiServerLogCategories.h"

#include <algorithm>
#include <array>
#include <atomic>
#include <charconv>
#include <chrono>
#include <condition_variable>
#include <ctime>
#include <cstdio>
#include <cstring>
#include <deque>
#include <mutex>
#include <new>
#include <limits>
#include <string_view>
#include <thread>
#include <utility>
#include <vector>

#include <arpa/inet.h>
#include <cerrno>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#include <log/Log.h>

namespace fiber::ai_server {
namespace {

DEFINE_LOGGER(LOG_AUDIT_HTTP, kAiServerLifecycleLogger);

constexpr std::string_view kIngestPath = "/api/internal/llm-call-audits/batches";

struct Endpoint {
    std::string ip;
    std::uint16_t port = 0;
};

struct QueueItem {
    std::string audit_json;
    std::int64_t occurred_at_millis = 0;
    std::size_t accounted_bytes = 0;
};

enum class DeliveryResult : std::uint8_t { Success, Retryable, Permanent };

bool is_ip_literal(std::string_view value) noexcept {
    if (value.empty() || value.size() >= INET6_ADDRSTRLEN) {
        return false;
    }
    std::array<char, INET6_ADDRSTRLEN> text{};
    std::memcpy(text.data(), value.data(), value.size());
    in_addr ipv4{};
    in6_addr ipv6{};
    if (::inet_pton(AF_INET, text.data(), &ipv4) == 1) {
        const std::uint32_t address = ntohl(ipv4.s_addr);
        return address != INADDR_ANY && address != INADDR_BROADCAST &&
               (address & 0xf0000000U) != 0xe0000000U;
    }
    if (::inet_pton(AF_INET6, text.data(), &ipv6) == 1) {
        return !IN6_IS_ADDR_UNSPECIFIED(&ipv6) && !IN6_IS_ADDR_MULTICAST(&ipv6);
    }
    return false;
}

std::string iso8601(std::int64_t millis) {
    const std::time_t seconds = static_cast<std::time_t>(millis / 1000);
    const int fraction = static_cast<int>((millis % 1000 + 1000) % 1000);
    std::tm utc{};
    if (::gmtime_r(&seconds, &utc) == nullptr) {
        return "1970-01-01T00:00:00.000Z";
    }
    std::array<char, 32> output{};
    const int length = std::snprintf(output.data(), output.size(), "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
                                     utc.tm_year + 1900, utc.tm_mon + 1, utc.tm_mday, utc.tm_hour, utc.tm_min,
                                     utc.tm_sec, fraction);
    return length > 0 ? std::string(output.data(), static_cast<std::size_t>(length))
                      : std::string("1970-01-01T00:00:00.000Z");
}

std::int64_t wall_now_millis() noexcept {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
                   std::chrono::system_clock::now().time_since_epoch())
            .count();
}

int connect_socket(const Endpoint &endpoint, std::chrono::milliseconds timeout) noexcept {
    sockaddr_storage storage{};
    socklen_t length = 0;
    int family = AF_UNSPEC;
    if (::inet_pton(AF_INET, endpoint.ip.c_str(), &reinterpret_cast<sockaddr_in *>(&storage)->sin_addr) == 1) {
        auto *address = reinterpret_cast<sockaddr_in *>(&storage);
        address->sin_family = AF_INET;
        address->sin_port = htons(endpoint.port);
        family = AF_INET;
        length = sizeof(sockaddr_in);
    } else if (::inet_pton(AF_INET6, endpoint.ip.c_str(), &reinterpret_cast<sockaddr_in6 *>(&storage)->sin6_addr) ==
               1) {
        auto *address = reinterpret_cast<sockaddr_in6 *>(&storage);
        address->sin6_family = AF_INET6;
        address->sin6_port = htons(endpoint.port);
        family = AF_INET6;
        length = sizeof(sockaddr_in6);
    } else {
        return -1;
    }

    const int fd = ::socket(family, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) {
        return -1;
    }
    const int flags = ::fcntl(fd, F_GETFL, 0);
    if (flags < 0 || ::fcntl(fd, F_SETFL, flags | O_NONBLOCK) != 0) {
        ::close(fd);
        return -1;
    }
    const int connected = ::connect(fd, reinterpret_cast<const sockaddr *>(&storage), length);
    if (connected != 0 && errno != EINPROGRESS) {
        ::close(fd);
        return -1;
    }
    if (connected != 0) {
        pollfd descriptor{.fd = fd, .events = POLLOUT, .revents = 0};
        const auto bounded = std::clamp<std::int64_t>(timeout.count(), 1, std::numeric_limits<int>::max());
        if (::poll(&descriptor, 1, static_cast<int>(bounded)) != 1) {
            ::close(fd);
            return -1;
        }
        int socket_error = 0;
        socklen_t error_length = sizeof(socket_error);
        if (::getsockopt(fd, SOL_SOCKET, SO_ERROR, &socket_error, &error_length) != 0 || socket_error != 0) {
            ::close(fd);
            return -1;
        }
    }
    if (::fcntl(fd, F_SETFL, flags) != 0) {
        ::close(fd);
        return -1;
    }
    return fd;
}

bool send_all(int fd, std::string_view value) noexcept {
    std::size_t offset = 0;
    while (offset < value.size()) {
        const ssize_t written = ::send(fd, value.data() + offset, value.size() - offset, MSG_NOSIGNAL);
        if (written > 0) {
            offset += static_cast<std::size_t>(written);
            continue;
        }
        if (written < 0 && errno == EINTR) {
            continue;
        }
        return false;
    }
    return true;
}

int read_status(int fd) noexcept {
    std::array<char, 4096> response{};
    std::size_t size = 0;
    while (size < response.size()) {
        const ssize_t received = ::recv(fd, response.data() + size, response.size() - size, 0);
        if (received > 0) {
            size += static_cast<std::size_t>(received);
            if (std::string_view(response.data(), size).find("\r\n") != std::string_view::npos) {
                break;
            }
            continue;
        }
        if (received < 0 && errno == EINTR) {
            continue;
        }
        return 0;
    }
    const std::string_view line(response.data(), size);
    const std::size_t first_space = line.find(' ');
    if (!line.starts_with("HTTP/1.") || first_space == std::string_view::npos || first_space + 4 > line.size()) {
        return 0;
    }
    int status = 0;
    const auto parsed = std::from_chars(line.data() + first_space + 1, line.data() + first_space + 4, status);
    return parsed.ec == std::errc{} ? status : 0;
}

DeliveryResult post(const Endpoint &endpoint, std::string_view token, std::string_view body,
                    std::chrono::milliseconds connect_timeout, std::chrono::milliseconds request_timeout) noexcept {
    const int fd = connect_socket(endpoint, connect_timeout);
    if (fd < 0) {
        return DeliveryResult::Retryable;
    }
    const auto timeout_micros =
            std::chrono::duration_cast<std::chrono::microseconds>(std::max(request_timeout, std::chrono::milliseconds(1)))
                    .count();
    timeval timeout{
            .tv_sec = static_cast<time_t>(timeout_micros / 1'000'000),
            .tv_usec = static_cast<suseconds_t>(timeout_micros % 1'000'000),
    };
    (void) ::setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
    (void) ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));

    std::string host = endpoint.ip.find(':') == std::string::npos ? endpoint.ip : '[' + endpoint.ip + ']';
    std::string request;
    request.reserve(body.size() + token.size() + 512);
    request.append("POST ").append(kIngestPath).append(" HTTP/1.1\r\nHost: ").append(host).append(":");
    request.append(std::to_string(endpoint.port));
    request.append("\r\nAuthorization: Bearer ").append(token);
    request.append("\r\nContent-Type: application/json\r\nContent-Length: ");
    request.append(std::to_string(body.size()));
    request.append("\r\nConnection: close\r\n\r\n").append(body);

    const bool sent = send_all(fd, request);
    const int status = sent ? read_status(fd) : 0;
    ::close(fd);
    if (status == 202) {
        return DeliveryResult::Success;
    }
    if (status >= 400 && status < 500 && status != 408 && status != 425 && status != 429) {
        return DeliveryResult::Permanent;
    }
    return DeliveryResult::Retryable;
}

std::string make_batch(const LlmAuditDeliveryOptions &options, const std::vector<QueueItem> &items) {
    std::string body;
    std::size_t reserve = 256;
    for (const QueueItem &item: items) {
        reserve += item.audit_json.size() + 96;
    }
    body.reserve(reserve);
    body.append("{\"schemaVersion\":1,\"instanceId\":\"").append(options.instance_id);
    body.append("\",\"sentAt\":\"").append(iso8601(wall_now_millis()));
    body.append("\",\"records\":[");
    for (std::size_t i = 0; i < items.size(); ++i) {
        if (i != 0) {
            body.push_back(',');
        }
        body.append("{\"occurredAt\":\"").append(iso8601(items[i].occurred_at_millis));
        body.append("\",\"audit\":").append(items[i].audit_json).push_back('}');
    }
    body.append("]}");
    return body;
}

} // namespace

class LlmAuditHttpSender::Impl final {
public:
    explicit Impl(LlmAuditDeliveryOptions value) : options(std::move(value)) {}

    bool start() noexcept {
        std::lock_guard lock(mutex);
        if (started) {
            return true;
        }
        if (stopping) {
            return false;
        }
        try {
            worker = std::thread([this]() { run(); });
            started = true;
            return true;
        } catch (...) {
            return false;
        }
    }

    void shutdown() noexcept {
        {
            std::lock_guard lock(mutex);
            stopping = true;
        }
        changed.notify_all();
        if (worker.joinable()) {
            worker.join();
        }
    }

    bool submit(std::string value, std::int64_t occurred_at_millis) noexcept {
        const std::size_t accounted = value.size() + 128;
        std::lock_guard lock(mutex);
        if (!started || stopping || accounted > options.queue_capacity_bytes ||
            queue_bytes > options.queue_capacity_bytes - accounted) {
            dropped.fetch_add(1, std::memory_order_relaxed);
            return false;
        }
        try {
            queue.push_back(QueueItem{
                    .audit_json = std::move(value),
                    .occurred_at_millis = occurred_at_millis,
                    .accounted_bytes = accounted,
            });
        } catch (...) {
            dropped.fetch_add(1, std::memory_order_relaxed);
            return false;
        }
        queue_bytes += accounted;
        queued.fetch_add(1, std::memory_order_relaxed);
        changed.notify_one();
        return true;
    }

    void update_endpoints(const std::shared_ptr<const nacos::ServiceInfo> &service) noexcept {
        std::vector<Endpoint> next;
        if (service) {
            try {
                next.reserve(service->hosts.size());
                for (const nacos::ServiceInstance &host: service->hosts) {
                    if (host.healthy && host.enabled && host.weight > 0 && host.port != 0 &&
                        is_ip_literal(host.ip)) {
                        next.push_back(Endpoint{.ip = std::string(host.ip), .port = host.port});
                    }
                }
            } catch (...) {
                return;
            }
        }
        {
            std::lock_guard lock(mutex);
            endpoints = std::move(next);
            if (endpoint_index >= endpoints.size()) {
                endpoint_index = 0;
            }
        }
        changed.notify_all();
    }

    void clear_endpoints() noexcept {
        {
            std::lock_guard lock(mutex);
            endpoints.clear();
            endpoint_index = 0;
        }
        changed.notify_all();
    }

    LlmAuditDeliveryStats stats() const noexcept {
        std::lock_guard lock(mutex);
        return LlmAuditDeliveryStats{
                .queued_records = queued.load(std::memory_order_relaxed),
                .delivered_records = delivered.load(std::memory_order_relaxed),
                .dropped_records = dropped.load(std::memory_order_relaxed),
                .retryable_failures = retryable_failures.load(std::memory_order_relaxed),
                .permanent_failures = permanent_failures.load(std::memory_order_relaxed),
                .queue_bytes = queue_bytes,
                .endpoint_count = endpoints.size(),
        };
    }

private:
    void run() noexcept {
        std::size_t failures = 0;
        for (;;) {
            std::vector<QueueItem> batch;
            Endpoint endpoint;
            {
                std::unique_lock lock(mutex);
                changed.wait(lock, [this]() { return stopping || (!queue.empty() && !endpoints.empty()); });
                if (stopping && (queue.empty() || endpoints.empty())) {
                    drop_all_locked();
                    return;
                }
                if (queue.size() < options.batch_size && !stopping) {
                    changed.wait_for(lock, options.flush_interval,
                                     [this]() { return stopping || queue.size() >= options.batch_size; });
                }
                if (endpoints.empty()) {
                    continue;
                }
                std::size_t batch_bytes = 256;
                try {
                    batch.reserve(std::min(options.batch_size, queue.size()));
                    for (const QueueItem &item: queue) {
                        const std::size_t next_bytes = item.audit_json.size() + 96;
                        if (!batch.empty() && (batch.size() >= options.batch_size ||
                                               batch_bytes + next_bytes > options.batch_max_bytes)) {
                            break;
                        }
                        batch.push_back(item);
                        batch_bytes += next_bytes;
                    }
                } catch (...) {
                    dropped.fetch_add(1, std::memory_order_relaxed);
                    pop_locked(1);
                    continue;
                }
                endpoint = endpoints[endpoint_index++ % endpoints.size()];
            }

            DeliveryResult result = DeliveryResult::Retryable;
            try {
                const std::string body = make_batch(options, batch);
                if (body.size() <= options.batch_max_bytes) {
                    result = post(endpoint, options.ingest_token, body, options.connect_timeout,
                                  options.request_timeout);
                } else {
                    result = DeliveryResult::Permanent;
                }
            } catch (...) {
                result = DeliveryResult::Retryable;
            }

            if (result == DeliveryResult::Success) {
                {
                    std::lock_guard lock(mutex);
                    pop_locked(batch.size());
                }
                delivered.fetch_add(batch.size(), std::memory_order_relaxed);
                failures = 0;
                continue;
            }
            if (result == DeliveryResult::Permanent) {
                {
                    std::lock_guard lock(mutex);
                    pop_locked(batch.size());
                }
                permanent_failures.fetch_add(1, std::memory_order_relaxed);
                dropped.fetch_add(batch.size(), std::memory_order_relaxed);
                failures = 0;
                LOG(LOG_AUDIT_HTTP, ERROR) << "audit HTTP batch permanently rejected records=" << batch.size();
                continue;
            }

            retryable_failures.fetch_add(1, std::memory_order_relaxed);
            ++failures;
            LOG(LOG_AUDIT_HTTP, WARN) << "audit HTTP delivery failed; retrying failures=" << failures;
            std::unique_lock lock(mutex);
            if (stopping) {
                drop_all_locked();
                return;
            }
            const auto backoff = std::chrono::milliseconds(
                    std::min<std::int64_t>(250 * (1LL << std::min<std::size_t>(failures, 7)), 30'000));
            changed.wait_for(lock, backoff, [this]() { return stopping; });
        }
    }

    void pop_locked(std::size_t count) noexcept {
        while (count-- > 0 && !queue.empty()) {
            queue_bytes -= queue.front().accounted_bytes;
            queue.pop_front();
        }
    }

    void drop_all_locked() noexcept {
        dropped.fetch_add(queue.size(), std::memory_order_relaxed);
        queue.clear();
        queue_bytes = 0;
    }

    LlmAuditDeliveryOptions options;
    mutable std::mutex mutex;
    std::condition_variable changed;
    std::deque<QueueItem> queue;
    std::vector<Endpoint> endpoints;
    std::thread worker;
    std::size_t queue_bytes = 0;
    std::size_t endpoint_index = 0;
    bool stopping = false;
    bool started = false;
    std::atomic<std::uint64_t> queued{0};
    std::atomic<std::uint64_t> delivered{0};
    std::atomic<std::uint64_t> dropped{0};
    std::atomic<std::uint64_t> retryable_failures{0};
    std::atomic<std::uint64_t> permanent_failures{0};
};

LlmAuditHttpSender::LlmAuditHttpSender(LlmAuditDeliveryOptions options) :
    impl_(std::make_unique<Impl>(std::move(options))) {}

LlmAuditHttpSender::~LlmAuditHttpSender() { shutdown(); }

bool LlmAuditHttpSender::start() noexcept { return impl_->start(); }

void LlmAuditHttpSender::shutdown() noexcept {
    if (impl_) {
        impl_->shutdown();
    }
}

bool LlmAuditHttpSender::submit(std::string audit_json, std::int64_t occurred_at_millis) noexcept {
    return impl_->submit(std::move(audit_json), occurred_at_millis);
}

void LlmAuditHttpSender::update_endpoints(const std::shared_ptr<const nacos::ServiceInfo> &service) noexcept {
    impl_->update_endpoints(service);
}

void LlmAuditHttpSender::clear_endpoints() noexcept { impl_->clear_endpoints(); }

LlmAuditDeliveryStats LlmAuditHttpSender::stats() const noexcept { return impl_->stats(); }

} // namespace fiber::ai_server
