#include "ProviderRouteKey.h"

namespace fiber::ai_server {

std::expected<ProviderRouteKey, ProviderRouteKeyError>
build_provider_route_key(LlmWireProtocol protocol, std::string_view authenticated_principal,
                         std::string_view logical_model, const LlmRoutingData &routing) noexcept {
    const PromptRouteCandidate *candidate = nullptr;
    if (routing.direct_route_key.available) {
        candidate = &routing.direct_route_key;
    } else if (routing.prompt_affinity.available) {
        candidate = &routing.prompt_affinity;
    }

    PromptDigestBuilder builder;
    if (!builder.add_text("ai-gateway/provider-cache-affinity-v1") ||
        !builder.add_integer(static_cast<std::int64_t>(protocol)) || !builder.add_text(authenticated_principal) ||
        !builder.add_text(logical_model)) {
        return std::unexpected(ProviderRouteKeyError::DigestFailure);
    }

    ProviderRouteKey result;
    if (candidate) {
        if (!builder.add_integer(static_cast<std::int64_t>(candidate->source)) ||
            !builder.add_component("candidate", candidate->digest)) {
            return std::unexpected(ProviderRouteKeyError::DigestFailure);
        }
        result.source = candidate->source;
    } else {
        if (!builder.add_integer(static_cast<std::int64_t>(PromptRouteKeySource::PrincipalModelFallback))) {
            return std::unexpected(ProviderRouteKeyError::DigestFailure);
        }
        result.source = PromptRouteKeySource::PrincipalModelFallback;
    }
    if (!builder.snapshot(result.digest)) {
        return std::unexpected(ProviderRouteKeyError::DigestFailure);
    }
    return result;
}

} // namespace fiber::ai_server
