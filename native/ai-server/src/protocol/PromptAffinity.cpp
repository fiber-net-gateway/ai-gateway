#include "PromptAffinity.h"

#include <bit>

namespace fiber::ai_server {
namespace {

constexpr std::string_view kComponentDomain = "ai-gateway/prompt-affinity-component-v1";

enum class DigestTag : std::uint8_t {
    Null = 1,
    False,
    True,
    Integer,
    Double,
    BigNumber,
    Text,
    Key,
    ObjectBegin,
    ObjectEnd,
    ArrayBegin,
    ArrayEnd,
    Component,
};

} // namespace

PromptDigestBuilder::PromptDigestBuilder() noexcept {
    valid_ = SHA256_Init(&context_) == 1;
    if (valid_) {
        valid_ = add_bytes(kComponentDomain);
    }
}

bool PromptDigestBuilder::add_tag(std::uint8_t tag) noexcept {
    if (!valid_ || SHA256_Update(&context_, &tag, sizeof(tag)) != 1) {
        valid_ = false;
    }
    return valid_;
}

bool PromptDigestBuilder::add_u64(std::uint64_t value) noexcept {
    std::array<std::uint8_t, sizeof(value)> encoded{};
    for (std::size_t i = 0; i < encoded.size(); ++i) {
        encoded[encoded.size() - i - 1] = static_cast<std::uint8_t>(value & 0xffU);
        value >>= 8U;
    }
    if (!valid_ || SHA256_Update(&context_, encoded.data(), encoded.size()) != 1) {
        valid_ = false;
    }
    return valid_;
}

bool PromptDigestBuilder::add_bytes(std::string_view value) noexcept {
    if (!add_u64(value.size())) {
        return false;
    }
    if (!value.empty() && SHA256_Update(&context_, value.data(), value.size()) != 1) {
        valid_ = false;
    }
    return valid_;
}

bool PromptDigestBuilder::add_null() noexcept { return add_tag(static_cast<std::uint8_t>(DigestTag::Null)); }

bool PromptDigestBuilder::add_bool(bool value) noexcept {
    return add_tag(static_cast<std::uint8_t>(value ? DigestTag::True : DigestTag::False));
}

bool PromptDigestBuilder::add_integer(std::int64_t value) noexcept {
    return add_tag(static_cast<std::uint8_t>(DigestTag::Integer)) && add_u64(static_cast<std::uint64_t>(value));
}

bool PromptDigestBuilder::add_double(double value) noexcept {
    return add_tag(static_cast<std::uint8_t>(DigestTag::Double)) && add_u64(std::bit_cast<std::uint64_t>(value));
}

bool PromptDigestBuilder::add_big_number(std::string_view value) noexcept {
    return add_tag(static_cast<std::uint8_t>(DigestTag::BigNumber)) && add_bytes(value);
}

bool PromptDigestBuilder::add_text(std::string_view value) noexcept {
    return add_tag(static_cast<std::uint8_t>(DigestTag::Text)) && add_bytes(value);
}

bool PromptDigestBuilder::add_key(std::string_view value) noexcept {
    return add_tag(static_cast<std::uint8_t>(DigestTag::Key)) && add_bytes(value);
}

bool PromptDigestBuilder::begin_object() noexcept { return add_tag(static_cast<std::uint8_t>(DigestTag::ObjectBegin)); }

bool PromptDigestBuilder::end_object() noexcept { return add_tag(static_cast<std::uint8_t>(DigestTag::ObjectEnd)); }

bool PromptDigestBuilder::begin_array() noexcept { return add_tag(static_cast<std::uint8_t>(DigestTag::ArrayBegin)); }

bool PromptDigestBuilder::end_array() noexcept { return add_tag(static_cast<std::uint8_t>(DigestTag::ArrayEnd)); }

bool PromptDigestBuilder::add_component(std::string_view name, const PromptDigest &digest) noexcept {
    return add_tag(static_cast<std::uint8_t>(DigestTag::Component)) && add_bytes(name) &&
           add_bytes(std::string_view(reinterpret_cast<const char *>(digest.data()), digest.size()));
}

bool PromptDigestBuilder::snapshot(PromptDigest &digest) const noexcept {
    if (!valid_) {
        return false;
    }
    SHA256_CTX copy = context_;
    return SHA256_Final(digest.data(), &copy) == 1;
}

bool digest_opaque_route_key(std::string_view domain, std::string_view value, PromptDigest &digest) noexcept {
    PromptDigestBuilder builder;
    return builder.add_text(domain) && builder.add_text(value) && builder.snapshot(digest);
}

} // namespace fiber::ai_server
