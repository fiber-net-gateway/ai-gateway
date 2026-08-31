#include <gtest/gtest.h>

#include <array>
#include <charconv>
#include <chrono>
#include <future>
#include <memory>
#include <string>
#include <string_view>
#include <thread>

#include <arpa/inet.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include "audit/LlmAuditHttpSender.h"

namespace {

using fiber::ai_server::LlmAuditDeliveryOptions;
using fiber::ai_server::LlmAuditHttpSender;

struct LoopbackListener {
    int fd = -1;
    std::uint16_t port = 0;

    LoopbackListener() = default;
    LoopbackListener(const LoopbackListener &) = delete;
    LoopbackListener &operator=(const LoopbackListener &) = delete;
    LoopbackListener(LoopbackListener &&other) noexcept : fd(other.fd), port(other.port) { other.fd = -1; }
    LoopbackListener &operator=(LoopbackListener &&) = delete;

    ~LoopbackListener() {
        if (fd >= 0) {
            ::close(fd);
        }
    }
};

LoopbackListener listen_on_loopback() {
    LoopbackListener listener;
    listener.fd = ::socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (listener.fd < 0) {
        return listener;
    }
    sockaddr_in address{
            .sin_family = AF_INET,
            .sin_port = 0,
            .sin_addr = {.s_addr = htonl(INADDR_LOOPBACK)},
    };
    if (::bind(listener.fd, reinterpret_cast<const sockaddr *>(&address), sizeof(address)) != 0 ||
        ::listen(listener.fd, 1) != 0) {
        ::close(listener.fd);
        listener.fd = -1;
        return listener;
    }
    socklen_t size = sizeof(address);
    if (::getsockname(listener.fd, reinterpret_cast<sockaddr *>(&address), &size) != 0) {
        ::close(listener.fd);
        listener.fd = -1;
        return listener;
    }
    listener.port = ntohs(address.sin_port);
    return listener;
}

std::size_t content_length(std::string_view request) {
    constexpr std::string_view prefix = "Content-Length: ";
    const std::size_t position = request.find(prefix);
    if (position == std::string_view::npos) {
        return 0;
    }
    const char *begin = request.data() + position + prefix.size();
    const char *end = request.data() + request.find("\r\n", position);
    std::size_t value = 0;
    const auto parsed = std::from_chars(begin, end, value);
    return parsed.ec == std::errc{} ? value : 0;
}

std::string accept_one_request(int listener, int status) {
    pollfd descriptor{.fd = listener, .events = POLLIN, .revents = 0};
    if (::poll(&descriptor, 1, 5'000) != 1) {
        return {};
    }
    const int client = ::accept4(listener, nullptr, nullptr, SOCK_CLOEXEC);
    if (client < 0) {
        return {};
    }
    timeval timeout{.tv_sec = 5, .tv_usec = 0};
    (void) ::setsockopt(client, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));

    std::string request;
    std::array<char, 4096> buffer{};
    for (;;) {
        const ssize_t received = ::recv(client, buffer.data(), buffer.size(), 0);
        if (received <= 0) {
            break;
        }
        request.append(buffer.data(), static_cast<std::size_t>(received));
        const std::size_t header_end = request.find("\r\n\r\n");
        if (header_end != std::string::npos && request.size() >= header_end + 4 + content_length(request)) {
            break;
        }
    }
    const std::string response =
            "HTTP/1.1 " + std::to_string(status) + " Test\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}";
    (void) ::send(client, response.data(), response.size(), MSG_NOSIGNAL);
    ::close(client);
    return request;
}

TEST(LlmAuditHttpSenderTest, PostsAuthenticatedBatchToDiscoveredHealthyEndpoint) {
    LoopbackListener listener = listen_on_loopback();
    ASSERT_GE(listener.fd, 0);
    auto captured = std::async(std::launch::async, accept_one_request, listener.fd, 202);

    LlmAuditDeliveryOptions options{
            .instance_id = "ai-server-test-1",
            .ingest_token = "0123456789abcdef0123456789abcdef",
            .queue_capacity_bytes = 64 * 1024,
            .batch_size = 1,
            .batch_max_bytes = 64 * 1024,
            .flush_interval = std::chrono::milliseconds(10),
            .connect_timeout = std::chrono::milliseconds(500),
            .request_timeout = std::chrono::milliseconds(1000),
    };
    LlmAuditHttpSender sender(std::move(options));
    ASSERT_TRUE(sender.start());

    const std::array hosts{
            fiber::nacos::ServiceInstance{
                    .instance_id = "console-1",
                    .ip = "127.0.0.1",
                    .port = listener.port,
                    .weight = 1,
                    .healthy = true,
                    .enabled = true,
            },
            fiber::nacos::ServiceInstance{
                    .instance_id = "invalid-hostname",
                    .ip = "console-api.local",
                    .port = 3000,
                    .weight = 1,
                    .healthy = true,
                    .enabled = true,
            },
    };
    auto service = std::make_shared<fiber::nacos::ServiceInfo>();
    service->hosts = hosts;
    sender.update_endpoints(service);
    EXPECT_EQ(sender.stats().endpoint_count, 1u);
    ASSERT_TRUE(sender.submit(R"({"schema_version":6,"request_id":"request-1","auth_user":"alice"})", 1786183200000));

    ASSERT_EQ(captured.wait_for(std::chrono::seconds(5)), std::future_status::ready);
    const std::string request = captured.get();
    for (int attempt = 0; attempt < 100 && sender.stats().delivered_records != 1; ++attempt) {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    sender.shutdown();

    EXPECT_NE(request.find("POST /api/internal/llm-call-audits/batches HTTP/1.1"), std::string::npos);
    EXPECT_NE(request.find("Authorization: Bearer 0123456789abcdef0123456789abcdef"), std::string::npos);
    EXPECT_NE(request.find(R"("instanceId":"ai-server-test-1")"), std::string::npos);
    EXPECT_NE(request.find(R"("occurredAt":"2026-08-08T10:00:00.000Z")"), std::string::npos);
    EXPECT_NE(request.find(R"("request_id":"request-1")"), std::string::npos);
    EXPECT_EQ(sender.stats().delivered_records, 1u);
    EXPECT_EQ(sender.stats().dropped_records, 0u);
}

TEST(LlmAuditHttpSenderTest, RejectsSubmissionBeforeStart) {
    LlmAuditDeliveryOptions options;
    options.instance_id = "ai-server-test-1";
    options.ingest_token = "0123456789abcdef0123456789abcdef";
    LlmAuditHttpSender sender(std::move(options));

    EXPECT_FALSE(sender.submit("{}", 0));
    EXPECT_EQ(sender.stats().dropped_records, 1u);
}

TEST(LlmAuditHttpSenderTest, DropsPermanentlyRejectedBatchWithoutRetry) {
    LoopbackListener listener = listen_on_loopback();
    ASSERT_GE(listener.fd, 0);
    auto captured = std::async(std::launch::async, accept_one_request, listener.fd, 401);

    LlmAuditDeliveryOptions options;
    options.instance_id = "ai-server-test-1";
    options.ingest_token = "0123456789abcdef0123456789abcdef";
    options.batch_size = 1;
    options.flush_interval = std::chrono::milliseconds(10);
    options.connect_timeout = std::chrono::milliseconds(500);
    options.request_timeout = std::chrono::milliseconds(1000);
    LlmAuditHttpSender sender(std::move(options));
    ASSERT_TRUE(sender.start());

    const std::array hosts{fiber::nacos::ServiceInstance{
            .instance_id = "console-1",
            .ip = "127.0.0.1",
            .port = listener.port,
            .weight = 1,
            .healthy = true,
            .enabled = true,
    }};
    auto service = std::make_shared<fiber::nacos::ServiceInfo>();
    service->hosts = hosts;
    sender.update_endpoints(service);
    ASSERT_TRUE(sender.submit(R"({"schema_version":6,"request_id":"request-2","auth_user":"alice"})", 1786183200000));

    ASSERT_EQ(captured.wait_for(std::chrono::seconds(5)), std::future_status::ready);
    EXPECT_FALSE(captured.get().empty());
    for (int attempt = 0; attempt < 100 && sender.stats().permanent_failures != 1; ++attempt) {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
    sender.shutdown();

    EXPECT_EQ(sender.stats().permanent_failures, 1u);
    EXPECT_EQ(sender.stats().dropped_records, 1u);
    EXPECT_EQ(sender.stats().delivered_records, 0u);
}

} // namespace
