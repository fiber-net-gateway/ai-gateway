#include "../src/AiServer.h"

#include <array>
#include <charconv>
#include <chrono>
#include <cstdint>
#include <future>
#include <memory>
#include <string>
#include <string_view>

#include <cerrno>
#include <netinet/in.h>
#include <sys/socket.h>
#include <unistd.h>

#include <gtest/gtest.h>

#include <fiber/async/Spawn.h>
#include <fiber/common/IoError.h>
#include <fiber/dns/DnsCache2.h>
#include <fiber/event/EventLoopGroup.h>
#include <fiber/net/IpAddress.h>
#include <fiber/net/SocketAddress.h>

namespace fiber::ai_server {
namespace {

using namespace std::chrono_literals;

common::IoResult<std::uint16_t> bound_port(int fd) noexcept {
    sockaddr_storage storage{};
    socklen_t length = sizeof(storage);
    if (::getsockname(fd, reinterpret_cast<sockaddr *>(&storage), &length) != 0) {
        return std::unexpected(common::io_err_from_errno(errno));
    }
    net::SocketAddress address;
    if (!net::SocketAddress::from_sockaddr(reinterpret_cast<sockaddr *>(&storage), length, address)) {
        return std::unexpected(common::IoErr::Invalid);
    }
    return address.port();
}

bool ascii_equal_ci(std::string_view lhs, std::string_view rhs) noexcept {
    if (lhs.size() != rhs.size()) {
        return false;
    }
    for (std::size_t index = 0; index < lhs.size(); ++index) {
        unsigned char left = static_cast<unsigned char>(lhs[index]);
        unsigned char right = static_cast<unsigned char>(rhs[index]);
        if (left >= 'A' && left <= 'Z') {
            left = static_cast<unsigned char>(left + ('a' - 'A'));
        }
        if (right >= 'A' && right <= 'Z') {
            right = static_cast<unsigned char>(right + ('a' - 'A'));
        }
        if (left != right) {
            return false;
        }
    }
    return true;
}

struct RawHttpResponse {
    int status = 0;
    int system_error = 0;
    std::string headers;
    std::string body;

    [[nodiscard]] std::string header(std::string_view name) const {
        std::string_view remaining(headers);
        const std::size_t status_end = remaining.find("\r\n");
        if (status_end == std::string_view::npos) {
            return {};
        }
        remaining.remove_prefix(status_end + 2);
        while (!remaining.empty()) {
            const std::size_t line_end = remaining.find("\r\n");
            const std::string_view line = remaining.substr(0, line_end);
            const std::size_t colon = line.find(':');
            if (colon != std::string_view::npos && ascii_equal_ci(line.substr(0, colon), name)) {
                std::string_view value = line.substr(colon + 1);
                while (!value.empty() && (value.front() == ' ' || value.front() == '\t')) {
                    value.remove_prefix(1);
                }
                return std::string(value);
            }
            if (line_end == std::string_view::npos) {
                break;
            }
            remaining.remove_prefix(line_end + 2);
        }
        return {};
    }
};

RawHttpResponse request(std::uint16_t port, std::string_view method, std::string_view target) {
    RawHttpResponse response;
    const int fd = ::socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (fd < 0) {
        response.system_error = errno;
        return response;
    }
    const timeval timeout{.tv_sec = 5, .tv_usec = 0};
    (void) ::setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    (void) ::setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(port);
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (::connect(fd, reinterpret_cast<const sockaddr *>(&address), sizeof(address)) != 0) {
        response.system_error = errno;
        (void) ::close(fd);
        return response;
    }

    std::string encoded;
    encoded.reserve(method.size() + target.size() + 64);
    encoded.append(method);
    encoded.push_back(' ');
    encoded.append(target);
    encoded.append(" HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    std::size_t sent = 0;
    while (sent < encoded.size()) {
        const ssize_t written = ::send(fd, encoded.data() + sent, encoded.size() - sent, MSG_NOSIGNAL);
        if (written <= 0) {
            response.system_error = written < 0 ? errno : EPIPE;
            (void) ::close(fd);
            return response;
        }
        sent += static_cast<std::size_t>(written);
    }

    std::string raw;
    std::array<char, 4096> buffer{};
    for (;;) {
        const ssize_t received = ::recv(fd, buffer.data(), buffer.size(), 0);
        if (received == 0) {
            break;
        }
        if (received < 0) {
            response.system_error = errno;
            (void) ::close(fd);
            return response;
        }
        raw.append(buffer.data(), static_cast<std::size_t>(received));
    }
    (void) ::close(fd);

    const std::size_t header_end = raw.find("\r\n\r\n");
    if (header_end == std::string::npos) {
        response.system_error = EPROTO;
        return response;
    }
    response.headers = raw.substr(0, header_end + 2);
    response.body = raw.substr(header_end + 4);
    const std::size_t first_space = response.headers.find(' ');
    if (first_space == std::string::npos) {
        response.system_error = EPROTO;
        return response;
    }
    const char *status_begin = response.headers.data() + first_space + 1;
    const char *status_end = status_begin;
    while (status_end != response.headers.data() + response.headers.size() && *status_end >= '0' &&
           *status_end <= '9') {
        ++status_end;
    }
    const auto converted = std::from_chars(status_begin, status_end, response.status);
    if (converted.ec != std::errc{} || converted.ptr != status_end) {
        response.system_error = EPROTO;
    }
    return response;
}

class AiServerHttpHarness {
public:
    AiServerHttpHarness() : server_(std::make_unique<AiServer>(workers_.at(0), workers_, dns_cache_)) {
        workers_.start();
        std::promise<std::uint16_t> started;
        auto future = started.get_future();
        async::spawn(workers_.at(0), [this, &started]() -> async::DetachedTask {
            const net::SocketAddress address(net::IpAddress::loopback_v4(), 0);
            if (!server_->bind(address, {})) {
                started.set_value(0);
                co_return;
            }
            auto port = bound_port(server_->fd());
            if (!port) {
                started.set_value(0);
                co_return;
            }
            async::spawn([this]() { return server_->serve(); });
            started.set_value(*port);
        });
        if (future.wait_for(5s) == std::future_status::ready) {
            port_ = future.get();
        }
    }

    ~AiServerHttpHarness() {
        if (port_ != 0) {
            std::promise<void> stopped;
            auto future = stopped.get_future();
            async::spawn(workers_.at(0), [this, &stopped]() -> async::DetachedTask {
                co_await server_->shutdown_and_wait();
                stopped.set_value();
            });
            (void) future.wait_for(5s);
        }
        workers_.stop();
        workers_.join();
        server_.reset();
    }

    [[nodiscard]] std::uint16_t port() const noexcept { return port_; }

private:
    event::EventLoopGroup workers_{1};
    dns::SharedDnsCache2 dns_cache_;
    std::unique_ptr<AiServer> server_;
    std::uint16_t port_ = 0;
};

void expect_successful_response(const RawHttpResponse &response, int status) {
    EXPECT_EQ(response.system_error, 0);
    EXPECT_EQ(response.status, status);
}

TEST(AiServerHttpTest, HeadReturnsGetMetadataWithoutResponseBody) {
    AiServerHttpHarness server;
    ASSERT_NE(server.port(), 0);

    const RawHttpResponse get_health = request(server.port(), "GET", "/health");
    const RawHttpResponse head_health = request(server.port(), "HEAD", "/health");
    expect_successful_response(get_health, 200);
    expect_successful_response(head_health, 200);
    EXPECT_EQ(get_health.body, "{\"status\":\"ok\"}\n");
    EXPECT_TRUE(head_health.body.empty());
    EXPECT_EQ(head_health.header("Content-Type"), get_health.header("Content-Type"));
    EXPECT_EQ(head_health.header("Content-Length"), get_health.header("Content-Length"));

    const RawHttpResponse get_ready = request(server.port(), "GET", "/ready");
    const RawHttpResponse head_ready = request(server.port(), "HEAD", "/ready");
    expect_successful_response(get_ready, 503);
    expect_successful_response(head_ready, 503);
    EXPECT_EQ(get_ready.body, "{\"status\":\"not_ready\"}\n");
    EXPECT_TRUE(head_ready.body.empty());
    EXPECT_EQ(head_ready.header("Content-Length"), get_ready.header("Content-Length"));

    const RawHttpResponse head_metrics = request(server.port(), "HEAD", "/metrics");
    expect_successful_response(head_metrics, 200);
    EXPECT_TRUE(head_metrics.body.empty());
    EXPECT_EQ(head_metrics.header("Content-Type"), "text/plain; version=0.0.4; charset=utf-8");
    EXPECT_FALSE(head_metrics.header("Content-Length").empty());

    const RawHttpResponse head_metrics_alias = request(server.port(), "HEAD", "/_metric_prometheus");
    expect_successful_response(head_metrics_alias, 200);
    EXPECT_TRUE(head_metrics_alias.body.empty());
    EXPECT_FALSE(head_metrics_alias.header("Content-Length").empty());

    const RawHttpResponse put_health = request(server.port(), "PUT", "/health");
    expect_successful_response(put_health, 405);
    EXPECT_EQ(put_health.header("Allow"), "GET, HEAD");

    const RawHttpResponse head_unknown = request(server.port(), "HEAD", "/does-not-exist");
    expect_successful_response(head_unknown, 404);
    EXPECT_TRUE(head_unknown.body.empty());
    EXPECT_FALSE(head_unknown.header("Content-Length").empty());

    const RawHttpResponse head_rate_limit = request(server.port(), "HEAD", "/internal/llm/rate-limit/check");
    expect_successful_response(head_rate_limit, 405);
    EXPECT_TRUE(head_rate_limit.body.empty());
    EXPECT_EQ(head_rate_limit.header("Allow"), "POST");
    EXPECT_FALSE(head_rate_limit.header("Content-Length").empty());

    const RawHttpResponse head_llm = request(server.port(), "HEAD", "/v1/chat/completions");
    expect_successful_response(head_llm, 401);
    EXPECT_TRUE(head_llm.body.empty());
    EXPECT_FALSE(head_llm.header("Content-Length").empty());
}

} // namespace
} // namespace fiber::ai_server
