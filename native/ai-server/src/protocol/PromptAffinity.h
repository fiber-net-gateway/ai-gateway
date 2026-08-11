#ifndef FIBER_AI_SERVER_PROMPT_AFFINITY_H
#define FIBER_AI_SERVER_PROMPT_AFFINITY_H

#include <array>
#include <cstddef>
#include <cstdint>
#include <string_view>

#include <openssl/sha.h>

namespace fiber::ai_server {

using PromptDigest = std::array<std::uint8_t, SHA256_DIGEST_LENGTH>;

enum class PromptRouteKeySource : std::uint8_t {
    OpenAiPromptCacheKey,
    OpenAiSemanticAnchor,
    AnthropicMetadataUserId,
    AnthropicExplicitCacheAnchor,
    AnthropicAutomaticCacheAnchor,
    AnthropicConversationAnchor,
    PrincipalModelFallback,
    Count,
};

struct PromptRouteCandidate {
    PromptDigest digest{};
    PromptRouteKeySource source = PromptRouteKeySource::PrincipalModelFallback;
    bool available = false;
};

class PromptDigestBuilder {
public:
    PromptDigestBuilder() noexcept;

    [[nodiscard]] bool add_null() noexcept;
    [[nodiscard]] bool add_bool(bool value) noexcept;
    [[nodiscard]] bool add_integer(std::int64_t value) noexcept;
    [[nodiscard]] bool add_double(double value) noexcept;
    [[nodiscard]] bool add_big_number(std::string_view value) noexcept;
    [[nodiscard]] bool add_text(std::string_view value) noexcept;
    [[nodiscard]] bool add_key(std::string_view value) noexcept;
    [[nodiscard]] bool begin_object() noexcept;
    [[nodiscard]] bool end_object() noexcept;
    [[nodiscard]] bool begin_array() noexcept;
    [[nodiscard]] bool end_array() noexcept;
    [[nodiscard]] bool add_component(std::string_view name, const PromptDigest &digest) noexcept;
    [[nodiscard]] bool snapshot(PromptDigest &digest) const noexcept;

private:
    [[nodiscard]] bool add_tag(std::uint8_t tag) noexcept;
    [[nodiscard]] bool add_bytes(std::string_view value) noexcept;
    [[nodiscard]] bool add_u64(std::uint64_t value) noexcept;

    SHA256_CTX context_{};
    bool valid_ = false;
};

[[nodiscard]] bool digest_opaque_route_key(std::string_view domain, std::string_view value,
                                           PromptDigest &digest) noexcept;

} // namespace fiber::ai_server

#endif // FIBER_AI_SERVER_PROMPT_AFFINITY_H
