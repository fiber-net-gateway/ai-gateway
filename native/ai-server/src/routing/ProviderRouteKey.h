#ifndef FIBER_AI_SERVER_PROVIDER_ROUTE_KEY_H
#define FIBER_AI_SERVER_PROVIDER_ROUTE_KEY_H

#include "../protocol/LlmBody.h"

#include <expected>
#include <string_view>

namespace fiber::ai_server {

enum class ProviderRouteKeyError : std::uint8_t {
    DigestFailure,
};

struct ProviderRouteKey {
    PromptDigest digest{};
    PromptRouteKeySource source = PromptRouteKeySource::PrincipalModelFallback;
};

[[nodiscard]] std::expected<ProviderRouteKey, ProviderRouteKeyError>
build_provider_route_key(LlmWireProtocol protocol, std::string_view authenticated_principal,
                         std::string_view logical_model, const LlmRoutingData &routing) noexcept;

} // namespace fiber::ai_server

#endif // FIBER_AI_SERVER_PROVIDER_ROUTE_KEY_H
