#include "ModelListingHandler.h"

#include "HttpResponse.h"

#include "../auth/Bt1TokenVerifier.h"
#include "../auth/LlmRequestAuthenticator.h"
#include "../observability/AiServerCatRequest.h"
#include "../protocol/LlmError.h"
#include "../protocol/LlmWireProtocol.h"
#include "../routing/ModelAuthorization.h"

#include <chrono>
#include <cstdint>
#include <string>
#include <string_view>
#include <utility>

#include <fiber/common/json/JsonEncode.h>
#include <fiber/http/HttpExchange.h>
#include <fiber/http/HttpExchangeIo.h>
#include <fiber/http/HttpHeaders.h>

namespace fiber::ai_server {
namespace {

// The published model configuration carries routing fields only; the listing uses fixed
// placeholders for the metadata OpenAI clients expect. created/owned_by become real when
// the models Data ID grows display-name/created-at metadata.
constexpr std::string_view kModelOwnedBy = "ai-gateway";
constexpr std::string_view kEncodeFallbackBody =
        R"({"error":{"message":"internal server error","type":"server_error","param":null,"code":"internal_error"}})";

std::int64_t wall_now_seconds() noexcept {
    return std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch())
            .count();
}

class StringSink final : public json::OutputSink {
public:
    [[nodiscard]] bool write(const char *data, std::size_t size) override {
        body_.append(data, size);
        return true;
    }

    [[nodiscard]] std::string take_body() noexcept { return std::move(body_); }

private:
    std::string body_;
};

bool ok(json::Generator::Result result) noexcept { return result == json::Generator::Result::OK; }

json::Generator::Result encode_model_string(json::Generator &generator, std::string_view key,
                                            std::string_view value) noexcept {
    json::Generator::Result result = generator.string(key.data(), key.size());
    if (ok(result)) {
        result = generator.string(value.data(), value.size());
    }
    return result;
}

json::Generator::Result encode_model_object(json::Generator &generator, std::string_view model_name) noexcept {
    json::Generator::Result result = generator.map_open();
    if (ok(result)) {
        result = encode_model_string(generator, "id", model_name);
    }
    if (ok(result)) {
        result = encode_model_string(generator, "object", "model");
    }
    if (ok(result)) {
        result = generator.string("created", 7);
    }
    if (ok(result)) {
        result = generator.integer(0);
    }
    if (ok(result)) {
        result = encode_model_string(generator, "owned_by", kModelOwnedBy);
    }
    if (ok(result)) {
        result = generator.map_close();
    }
    return result;
}

std::string encode_model_list(const LlmProjectSnapshot &project, std::string_view username) noexcept {
    StringSink sink;
    json::Generator generator(sink);
    generator.set_option(json::Generator::Option::ValidateUtf8);

    json::Generator::Result result = generator.map_open();
    if (ok(result)) {
        result = encode_model_string(generator, "object", "list");
    }
    if (ok(result)) {
        result = generator.string("data", 4);
    }
    if (ok(result)) {
        result = generator.array_open();
    }
    for (const CompiledModelRoute &route: project.models()) {
        if (!ok(result) || !model_visible_to_user(route, username)) {
            continue;
        }
        result = encode_model_object(generator, route.model_name);
    }
    if (ok(result)) {
        result = generator.array_close();
    }
    if (ok(result)) {
        result = generator.map_close();
    }
    if (!ok(result)) {
        return {};
    }
    return sink.take_body();
}

std::string encode_single_model(std::string_view model_name) noexcept {
    StringSink sink;
    json::Generator generator(sink);
    generator.set_option(json::Generator::Option::ValidateUtf8);
    if (ok(encode_model_object(generator, model_name))) {
        return sink.take_body();
    }
    return {};
}

LlmError method_not_allowed_error() noexcept {
    return LlmError{
            .status_code = 405,
            .code = "method_not_allowed",
            .type = "invalid_request_error",
            .message = "method not allowed",
    };
}

LlmError config_unavailable_error() noexcept {
    return LlmError{
            .status_code = 503,
            .code = "model_config_unavailable",
            .type = "server_error",
            .message = "model listing config is unavailable",
    };
}

LlmError auth_error(const Bt1AuthError &error) noexcept {
    return LlmError{
            .status_code = 401,
            .code = bt1_auth_error_name(error.kind),
            .type = "authentication_error",
            .message = bt1_auth_error_message(error.kind),
    };
}

LlmError model_not_found_error(std::string_view message) noexcept {
    return LlmError{
            .status_code = 404,
            .code = "model_not_found",
            .type = "invalid_request_error",
            .message = message,
    };
}

async::Task<void> send_body(http::HttpExchange &exchange, AiServerCatRequest *cat_request, int status_code,
                            std::string_view body, bool allow_get_and_head = false) noexcept {
    http::HttpHeaders headers(exchange.pool());
    headers.set_view("Content-Type", "application/json");
    if (allow_get_and_head) {
        headers.set_view("Allow", "GET, HEAD");
    }
    if (cat_request) {
        cat_request->inject_response_header(headers);
    }
    (void) co_await send_fixed_response(exchange, headers, status_code,
                                        reinterpret_cast<const std::uint8_t *>(body.data()), body.size());
}

async::Task<void> send_error(http::HttpExchange &exchange, AiServerCatRequest *cat_request, const LlmError &error,
                             bool allow_get_and_head = false) noexcept {
    auto encoded = encode_llm_error(LlmWireProtocol::OpenAiChatCompletions, error);
    if (encoded) {
        co_await send_body(
                exchange, cat_request, error.status_code,
                std::string_view(reinterpret_cast<const char *>(encoded->readable_data()), encoded->readable()),
                allow_get_and_head);
        co_return;
    }
    co_await send_body(exchange, cat_request, 500, kEncodeFallbackBody, allow_get_and_head);
}

} // namespace

async::Task<void> ModelListingHandler::handle(http::HttpExchange &exchange,
                                              std::shared_ptr<const LlmConfigSnapshot> config,
                                              AiServerCatRequest *cat_request, std::string_view model_id) noexcept {
    if (!is_get_or_head(exchange.method())) {
        co_await send_error(exchange, cat_request, method_not_allowed_error(), true);
        co_return;
    }
    if (!config || !config->project) {
        co_await send_error(exchange, cat_request, config_unavailable_error());
        co_return;
    }
    auto authenticated = authenticate_llm_request(exchange.request_headers(), std::move(config), wall_now_seconds());
    if (!authenticated) {
        co_await send_error(exchange, cat_request, auth_error(authenticated.error()));
        co_return;
    }
    const LlmProjectSnapshot &project = *authenticated->config().project;
    const std::string_view username = authenticated->principal().username();

    if (model_id.empty()) {
        std::string body = encode_model_list(project, username);
        if (body.empty()) {
            co_await send_body(exchange, cat_request, 500, kEncodeFallbackBody);
            co_return;
        }
        co_await send_body(exchange, cat_request, 200, body);
        co_return;
    }
    const CompiledModelRoute *route = valid_llm_model_name(model_id) ? project.find_model(model_id) : nullptr;
    if (!route || !model_visible_to_user(*route, username)) {
        // The message lives in this frame so the string_view stays valid across the co_await.
        std::string message = "The model '";
        message.append(model_id);
        message.append("' does not exist or you do not have access to it.");
        co_await send_error(exchange, cat_request, model_not_found_error(message));
        co_return;
    }
    std::string body = encode_single_model(route->model_name);
    if (body.empty()) {
        co_await send_body(exchange, cat_request, 500, kEncodeFallbackBody);
        co_return;
    }
    co_await send_body(exchange, cat_request, 200, body);
}

} // namespace fiber::ai_server
