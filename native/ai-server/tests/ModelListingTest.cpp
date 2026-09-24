#include <gtest/gtest.h>

#include <array>
#include <cctype>
#include <charconv>
#include <chrono>
#include <cstdint>
#include <future>
#include <memory>
#include <string>
#include <string_view>
#include <thread>
#include <utility>

#include <cerrno>
#include <netinet/in.h>
#include <openssl/hmac.h>
#include <sys/socket.h>
#include <unistd.h>

#include <fiber/async/Spawn.h>
#include <fiber/async/Yield.h>
#include <fiber/common/IoError.h>
#include <fiber/dns/DnsCache2.h>
#include <fiber/event/EventLoop.h>
#include <fiber/event/EventLoopGroup.h>
#include <fiber/net/IpAddress.h>
#include <fiber/net/SocketAddress.h>

#include "AiServer.h"
#include "FakeNacosServices.h"
#include "config/LlmConfigManager.h"

namespace {

using namespace std::chrono_literals;

constexpr std::string_view kBt1Kid = "test1";
constexpr std::string_view kBt1Secret = "model-listing-test-secret";
constexpr std::string_view kRandomBytes = "abcdefghijklmnop";
constexpr std::string_view kOpenModel = "open-model";
constexpr std::string_view kRestrictedModel = "restricted-model";

fiber::common::IoResult<std::uint16_t> bound_port(int fd) noexcept {
    sockaddr_storage storage{};
    socklen_t length = sizeof(storage);
    if (::getsockname(fd, reinterpret_cast<sockaddr *>(&storage), &length) != 0) {
        return std::unexpected(fiber::common::io_err_from_errno(errno));
    }
    fiber::net::SocketAddress address;
    if (!fiber::net::SocketAddress::from_sockaddr(reinterpret_cast<sockaddr *>(&storage), length, address)) {
        return std::unexpected(fiber::common::IoErr::Invalid);
    }
    return address.port();
}

std::string base64url_encode(std::string_view bytes) {
    constexpr std::string_view alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    std::string output;
    output.reserve((bytes.size() * 4 + 2) / 3);
    std::size_t pos = 0;
    while (pos + 3 <= bytes.size()) {
        const auto a = static_cast<std::uint8_t>(bytes[pos]);
        const auto b = static_cast<std::uint8_t>(bytes[pos + 1]);
        const auto c = static_cast<std::uint8_t>(bytes[pos + 2]);
        output.push_back(alphabet[a >> 2]);
        output.push_back(alphabet[((a & 0x03U) << 4) | (b >> 4)]);
        output.push_back(alphabet[((b & 0x0fU) << 2) | (c >> 6)]);
        output.push_back(alphabet[c & 0x3fU]);
        pos += 3;
    }
    if (pos < bytes.size()) {
        const auto a = static_cast<std::uint8_t>(bytes[pos]);
        output.push_back(alphabet[a >> 2]);
        if (pos + 1 == bytes.size()) {
            output.push_back(alphabet[(a & 0x03U) << 4]);
        } else {
            const auto b = static_cast<std::uint8_t>(bytes[pos + 1]);
            output.push_back(alphabet[((a & 0x03U) << 4) | (b >> 4)]);
            output.push_back(alphabet[(b & 0x0fU) << 2]);
        }
    }
    return output;
}

std::string issue_token(std::string_view username) {
    const auto expires =
            std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch())
                    .count() +
            3600;
    std::string signing_input = "BT1.";
    signing_input.append(kBt1Kid);
    signing_input.push_back('.');
    signing_input.append(base64url_encode(username));
    signing_input.push_back('.');
    signing_input.append(std::to_string(expires));
    signing_input.push_back('.');
    signing_input.append(base64url_encode(kRandomBytes));

    std::array<std::uint8_t, EVP_MAX_MD_SIZE> digest{};
    unsigned int digest_size = 0;
    if (!HMAC(EVP_sha256(), kBt1Secret.data(), kBt1Secret.size(),
              reinterpret_cast<const std::uint8_t *>(signing_input.data()), signing_input.size(), digest.data(),
              &digest_size)) {
        return {};
    }
    signing_input.push_back('.');
    signing_input.append(
            base64url_encode({reinterpret_cast<const char *>(digest.data()), static_cast<std::size_t>(digest_size)}));
    return signing_input;
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
            if (colon != std::string_view::npos) {
                const std::string_view field = line.substr(0, colon);
                bool equal = field.size() == name.size();
                if (equal) {
                    for (std::size_t index = 0; index < field.size(); ++index) {
                        const char left = static_cast<char>(std::tolower(static_cast<unsigned char>(field[index])));
                        const char right = static_cast<char>(std::tolower(static_cast<unsigned char>(name[index])));
                        if (left != right) {
                            equal = false;
                            break;
                        }
                    }
                }
                if (equal) {
                    std::string_view value = line.substr(colon + 1);
                    while (!value.empty() && (value.front() == ' ' || value.front() == '\t')) {
                        value.remove_prefix(1);
                    }
                    return std::string(value);
                }
            }
            if (line_end == std::string_view::npos) {
                break;
            }
            remaining.remove_prefix(line_end + 2);
        }
        return {};
    }
};

RawHttpResponse request(std::uint16_t port, std::string_view method, std::string_view target,
                        std::string_view token = {}) {
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
    encoded.reserve(method.size() + target.size() + token.size() + 96);
    encoded.append(method);
    encoded.push_back(' ');
    encoded.append(target);
    encoded.append(" HTTP/1.1\r\nHost: 127.0.0.1\r\n");
    if (!token.empty()) {
        encoded.append("Authorization: Bearer ");
        encoded.append(token);
        encoded.append("\r\n");
    }
    encoded.append("Connection: close\r\n\r\n");
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

// Real AiServer driven through FakeConfigService Data IDs: open-model is visible to every
// authenticated user, restricted-model only to the alpha group (alice).
class ModelListingHarness {
public:
    ModelListingHarness() {
        server_ = std::make_unique<fiber::ai_server::AiServer>(accept_loop_, workers_, dns_cache_);
        workers_.start();
        std::promise<std::uint16_t> started;
        auto future = started.get_future();
        fiber::async::spawn(accept_loop_, [this, &started]() -> fiber::async::DetachedTask {
            EXPECT_TRUE(manager_.start());
            co_await publish_configs();
            EXPECT_TRUE(manager_.ready());
            EXPECT_TRUE(co_await server_->start_config_workers(manager_));

            fiber::net::SocketAddress address(fiber::net::IpAddress::loopback_v4(), 0);
            auto bound = server_->bind(address, {});
            EXPECT_TRUE(bound);
            auto port = bound_port(server_->fd());
            if (!bound || !port) {
                started.set_value(0);
                co_await server_->shutdown_and_wait();
                co_await manager_.shutdown();
                accept_loop_.stop();
                co_return;
            }
            fiber::async::spawn([this]() { return server_->serve(); });
            started.set_value(*port);
        });
        accept_thread_ = std::thread([this] { accept_loop_.run(); });
        if (future.wait_for(5s) == std::future_status::ready) {
            port_ = future.get();
        }
    }

    ~ModelListingHarness() {
        if (accept_thread_.joinable()) {
            std::promise<void> stopped;
            auto future = stopped.get_future();
            fiber::async::spawn(accept_loop_, [this, &stopped]() -> fiber::async::DetachedTask {
                co_await server_->shutdown_and_wait();
                co_await manager_.shutdown();
                stopped.set_value();
                accept_loop_.stop();
            });
            (void) future.wait_for(5s);
            accept_thread_.join();
        }
        workers_.stop();
        workers_.join();
        server_.reset();
    }

    [[nodiscard]] std::uint16_t port() const noexcept { return port_; }

private:
    // The manager subscribes bt1/models eagerly but provider and user-group Data IDs only after
    // the models config references them, so publishes interleave with yields to let subscriptions
    // form before the dependent content arrives.
    fiber::async::Task<void> publish_configs() {
        service_.push(fiber::ai_server::kBt1KeysDataId,
                      R"({"version":1,"data":{"keys":[{"kid":")" + std::string(kBt1Kid) + R"(","secret":")" +
                              std::string(kBt1Secret) + R"("}]}})",
                      "bt1");
        service_.push(fiber::ai_server::kModelsDataId,
                      R"({"version":1,"data":[)"
                      R"({"model-name":")" +
                              std::string(kOpenModel) + R"(","providers":["listing"]},)" + R"({"model-name":")" +
                              std::string(kRestrictedModel) +
                              R"(","providers":["listing"],"allow-user-groups":["alpha"]}]})",
                      "models");
        for (std::size_t i = 0; i < 8; ++i) {
            co_await fiber::async::yield();
        }
        service_.push(std::string(fiber::ai_server::kProviderDataIdPrefix) + "listing",
                      R"({"version":1,"data":{"provider":"listing","baseurl":"http://127.0.0.1:9","api-tokens":[],)"
                      R"("protocol":[{"type":"openai-chat-completions","path":"/provider/chat","model":"upstream"}]}})",
                      "provider");
        service_.push(std::string(fiber::ai_server::kUserGroupDataIdPrefix) + "alpha",
                      R"({"version":1,"data":{"name":"alpha","users":["alice"]}})", "group");
        for (std::size_t i = 0; i < 8; ++i) {
            co_await fiber::async::yield();
        }
    }

    fiber::event::EventLoop accept_loop_;
    fiber::event::EventLoopGroup workers_{1};
    fiber::dns::SharedDnsCache2 dns_cache_;
    fiber::tests::FakeConfigService service_;
    fiber::tests::FakeNamingService naming_;
    fiber::ai_server::LlmConfigManager manager_{accept_loop_, service_, naming_};
    std::unique_ptr<fiber::ai_server::AiServer> server_;
    std::thread accept_thread_;
    std::uint16_t port_ = 0;
};

TEST(ModelListingTest, ListsOnlyModelsVisibleToTheAuthenticatedUser) {
    ModelListingHarness server;
    ASSERT_NE(server.port(), 0);

    const RawHttpResponse anonymous_list = request(server.port(), "GET", "/v1/models");
    EXPECT_EQ(anonymous_list.status, 401);
    EXPECT_NE(anonymous_list.body.find("\"code\":\"invalid_token\""), std::string::npos);

    const RawHttpResponse alice_list = request(server.port(), "GET", "/v1/models", issue_token("alice"));
    EXPECT_EQ(alice_list.status, 200);
    EXPECT_EQ(alice_list.header("Content-Type"), "application/json");
    EXPECT_NE(alice_list.body.find("\"object\":\"list\""), std::string::npos);
    EXPECT_NE(alice_list.body.find(kOpenModel), std::string::npos);
    EXPECT_NE(alice_list.body.find(kRestrictedModel), std::string::npos);

    const RawHttpResponse bob_list = request(server.port(), "GET", "/v1/models", issue_token("bob"));
    EXPECT_EQ(bob_list.status, 200);
    EXPECT_NE(bob_list.body.find(kOpenModel), std::string::npos);
    EXPECT_EQ(bob_list.body.find(kRestrictedModel), std::string::npos);
    EXPECT_NE(bob_list.body.find("\"owned_by\":\"ai-gateway\""), std::string::npos);

    // zhangwang keeps the authorize_model super-admin bypass and therefore sees every model.
    const RawHttpResponse admin_list = request(server.port(), "GET", "/v1/models", issue_token("zhangwang"));
    EXPECT_EQ(admin_list.status, 200);
    EXPECT_NE(admin_list.body.find(kOpenModel), std::string::npos);
    EXPECT_NE(admin_list.body.find(kRestrictedModel), std::string::npos);

    const RawHttpResponse admin_retrieve =
            request(server.port(), "GET", "/v1/models/restricted-model", issue_token("zhangwang"));
    EXPECT_EQ(admin_retrieve.status, 200);
    EXPECT_NE(admin_retrieve.body.find(kRestrictedModel), std::string::npos);
}

TEST(ModelListingTest, RetrieveReturnsSingleObjectOnlyWhenVisible) {
    ModelListingHarness server;
    ASSERT_NE(server.port(), 0);

    const RawHttpResponse anonymous_retrieve = request(server.port(), "GET", "/v1/models/open-model");
    EXPECT_EQ(anonymous_retrieve.status, 401);

    const RawHttpResponse alice_retrieve =
            request(server.port(), "GET", "/v1/models/restricted-model", issue_token("alice"));
    EXPECT_EQ(alice_retrieve.status, 200);
    EXPECT_EQ(alice_retrieve.body, R"({"id":"restricted-model","object":"model","created":0,"owned_by":"ai-gateway"})");

    const RawHttpResponse bob_retrieve =
            request(server.port(), "GET", "/v1/models/restricted-model", issue_token("bob"));
    EXPECT_EQ(bob_retrieve.status, 404);
    EXPECT_NE(bob_retrieve.body.find("\"code\":\"model_not_found\""), std::string::npos);

    const RawHttpResponse unknown = request(server.port(), "GET", "/v1/models/never-configured", issue_token("alice"));
    EXPECT_EQ(unknown.status, 404);
    EXPECT_NE(unknown.body.find("model_not_found"), std::string::npos);

    const RawHttpResponse invalid = request(server.port(), "GET", "/v1/models/Invalid!Name", issue_token("alice"));
    EXPECT_EQ(invalid.status, 404);
    EXPECT_NE(invalid.body.find("model_not_found"), std::string::npos);

    const RawHttpResponse multi_segment =
            request(server.port(), "GET", "/v1/models/open-model/extra", issue_token("alice"));
    EXPECT_EQ(multi_segment.status, 404);
}

TEST(ModelListingTest, RejectsNonGetMethodsAndSupportsHead) {
    ModelListingHarness server;
    ASSERT_NE(server.port(), 0);
    const std::string token = issue_token("alice");

    const RawHttpResponse post = request(server.port(), "POST", "/v1/models", token);
    EXPECT_EQ(post.status, 405);
    EXPECT_EQ(post.header("Allow"), "GET, HEAD");

    const RawHttpResponse deleted = request(server.port(), "DELETE", "/v1/models/open-model", token);
    EXPECT_EQ(deleted.status, 405);

    const RawHttpResponse head = request(server.port(), "HEAD", "/v1/models", token);
    EXPECT_EQ(head.status, 200);
    EXPECT_TRUE(head.body.empty());
    EXPECT_EQ(head.header("Content-Type"), "application/json");
    EXPECT_NE(head.header("Content-Length"), "0");
}

} // namespace
