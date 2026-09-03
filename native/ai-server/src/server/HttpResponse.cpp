#include "HttpResponse.h"

#include <array>
#include <charconv>
#include <limits>
#include <string_view>
#include <utility>

#include <fiber/http/HttpBodySpec.h>
#include <fiber/http/HttpExchange.h>
#include <fiber/http/HttpExchangeIo.h>
#include <fiber/http/HttpHeaders.h>

namespace fiber::ai_server {
namespace {

common::IoResult<void>
set_head_content_length(http::HttpHeaders &headers, std::size_t body_size,
                        std::array<char, std::numeric_limits<std::size_t>::digits10 + 1> &storage) noexcept {
    const auto converted = std::to_chars(storage.data(), storage.data() + storage.size(), body_size);
    if (converted.ec != std::errc{}) {
        return std::unexpected(common::IoErr::Invalid);
    }
    const std::string_view value(storage.data(), static_cast<std::size_t>(converted.ptr - storage.data()));
    if (!headers.set_view("Content-Length", value)) {
        return std::unexpected(common::IoErr::NoMem);
    }
    return {};
}

async::Task<common::IoResult<void>> send_response_header(http::HttpExchange &exchange, http::HttpHeaders &headers,
                                                         int status_code, std::size_t body_size, bool head) noexcept {
    std::array<char, std::numeric_limits<std::size_t>::digits10 + 1> content_length{};
    if (head) {
        auto set_length = set_head_content_length(headers, body_size, content_length);
        if (!set_length) {
            co_return std::unexpected(set_length.error());
        }
    }
    co_return co_await exchange.send_header({
            .kind = http::OutgoingHeaderKind::Final,
            .status_code = status_code,
            .headers = &headers,
            .body = head ? http::HttpBodySpec::None() : http::HttpBodySpec::ContentLength(body_size),
            .connection_mode = http::ResponseConnectionMode::Auto,
            .end_stream = head || body_size == 0,
    });
}

} // namespace

async::Task<common::IoResult<void>> send_fixed_response(http::HttpExchange &exchange, http::HttpHeaders &headers,
                                                        int status_code, const std::uint8_t *body,
                                                        std::size_t body_size) noexcept {
    if (body_size != 0 && body == nullptr) {
        co_return std::unexpected(common::IoErr::Invalid);
    }
    const bool head = exchange.method() == http::HttpMethod::Head;
    auto sent_header = co_await send_response_header(exchange, headers, status_code, body_size, head);
    if (!sent_header || head || body_size == 0) {
        co_return sent_header;
    }
    auto written = co_await exchange.write_all(body, body_size, true);
    if (!written) {
        co_return std::unexpected(written.error());
    }
    co_return common::IoResult<void>{};
}

async::Task<common::IoResult<void>> send_fixed_response(http::HttpExchange &exchange, http::HttpHeaders &headers,
                                                        int status_code, mem::IoBufChain body) noexcept {
    const std::size_t body_size = body.readable_bytes();
    const bool head = exchange.method() == http::HttpMethod::Head;
    auto sent_header = co_await send_response_header(exchange, headers, status_code, body_size, head);
    if (!sent_header || head || body_size == 0) {
        co_return sent_header;
    }
    body.mark_complete();
    auto written = co_await exchange.write_all(std::move(body));
    if (!written) {
        co_return std::unexpected(written.error());
    }
    co_return common::IoResult<void>{};
}

} // namespace fiber::ai_server
