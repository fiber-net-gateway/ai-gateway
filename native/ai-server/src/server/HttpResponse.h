#ifndef FIBER_AI_SERVER_HTTP_RESPONSE_H
#define FIBER_AI_SERVER_HTTP_RESPONSE_H

#include <cstddef>
#include <cstdint>

#include <fiber/async/Task.h>
#include <fiber/common/IoError.h>
#include <fiber/common/mem/IoBufChain.h>
#include <fiber/http/HttpCommon.h>

namespace fiber::http {
class HttpExchange;
class HttpHeaders;
} // namespace fiber::http

namespace fiber::ai_server {

[[nodiscard]] constexpr bool is_get_or_head(http::HttpMethod method) noexcept {
    return method == http::HttpMethod::Get || method == http::HttpMethod::Head;
}

[[nodiscard]] async::Task<common::IoResult<void>> send_fixed_response(http::HttpExchange &exchange,
                                                                      http::HttpHeaders &headers, int status_code,
                                                                      const std::uint8_t *body,
                                                                      std::size_t body_size) noexcept;

[[nodiscard]] async::Task<common::IoResult<void>> send_fixed_response(http::HttpExchange &exchange,
                                                                      http::HttpHeaders &headers, int status_code,
                                                                      mem::IoBufChain body) noexcept;

} // namespace fiber::ai_server

#endif // FIBER_AI_SERVER_HTTP_RESPONSE_H
