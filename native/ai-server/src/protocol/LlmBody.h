#ifndef FIBER_AI_SERVER_LLM_BODY_H
#define FIBER_AI_SERVER_LLM_BODY_H

#include <cstddef>
#include <cstdint>
#include <expected>
#include <optional>
#include <string_view>
#include <utility>

#include <fiber/common/json/JsonValue.h>
#include <fiber/common/mem/BufPool.h>
#include <fiber/common/mem/IoBuf.h>
#include <fiber/common/mem/IoBufChain.h>

#include "LlmWireProtocol.h"
#include "PromptAffinity.h"

namespace fiber::ai_server {

enum class LlmBodyErrorCode : std::uint8_t {
    InvalidJson,
    ExpectedObject,
    InvalidFieldType,
    OutOfMemory,
    InvalidReplacement,
    InvalidPatch,
    DuplicateField,
    StatefulInputReference,
    TooManyFields,
};

struct LlmBodyError {
    LlmBodyErrorCode code = LlmBodyErrorCode::InvalidJson;
    std::size_t offset = 0;
    std::string_view field;
    const char *message = nullptr;
};

struct EmbeddingRequestInfo {
    static constexpr std::size_t kMaxInputs = 2048;
    std::size_t input_count = 0;
    std::optional<std::int64_t> dimensions;
    bool base64 = false;
};

struct LlmRoutingData {
    json::Nullable<std::string_view> model;
    json::Nullable<bool> stream;
    PromptRouteCandidate direct_route_key;
    PromptRouteCandidate prompt_affinity;
    std::size_t messages_count = 0;
    std::size_t tools_count = 0;
    EmbeddingRequestInfo embedding;
};

enum class LlmBodyPatchKind : std::uint8_t {
    Model,
    Stream,
};

struct LlmBodyPatchSite {
    std::size_t begin = 0;
    std::size_t end = 0;
    LlmBodyPatchKind kind = LlmBodyPatchKind::Model;
};

enum class ResponsesMemberKind : std::uint8_t { Keep, Model, Stream, Drop };

struct ResponsesBodyMember {
    std::size_t begin = 0;
    std::size_t value_begin = 0;
    std::size_t end = 0;
    ResponsesMemberKind kind = ResponsesMemberKind::Keep;
};

struct ResponsesBodyPolicyInfo {
    bool store_was_true = false;
    bool background_was_true = false;
    bool previous_response_removed = false;
    bool conversation_removed = false;
};

class ParsedLlmBody {
public:
    ParsedLlmBody() noexcept = default;
    ~ParsedLlmBody() = default;

    ParsedLlmBody(const ParsedLlmBody &) = delete;
    ParsedLlmBody &operator=(const ParsedLlmBody &) = delete;
    ParsedLlmBody(ParsedLlmBody &&) noexcept = default;
    ParsedLlmBody &operator=(ParsedLlmBody &&) noexcept = default;

    [[nodiscard]] static std::expected<ParsedLlmBody, LlmBodyError> parse(LlmWireProtocol protocol, mem::IoBuf body,
                                                                          mem::BufPool &pool) noexcept;

    [[nodiscard]] const ResponsesBodyPolicyInfo &responses_policy() const noexcept { return responses_policy_; }
    [[nodiscard]] const LlmRoutingData &routing() const noexcept { return routing_; }
    [[nodiscard]] const mem::IoBuf &raw_body() const noexcept { return raw_body_; }
    [[nodiscard]] std::size_t body_size() const noexcept { return raw_body_.readable(); }
    [[nodiscard]] const json::JsonArray<LlmBodyPatchSite> &patch_sites() const noexcept { return patch_sites_; }

    [[nodiscard]] std::expected<mem::IoBufChain, LlmBodyError> rewrite(std::string_view upstream_model,
                                                                       std::optional<bool> stream) const noexcept;

private:
    ParsedLlmBody(mem::IoBuf body, LlmRoutingData routing, json::JsonArray<LlmBodyPatchSite> patch_sites,
                  LlmWireProtocol protocol, json::JsonArray<ResponsesBodyMember> members,
                  ResponsesBodyPolicyInfo policy) noexcept :
        raw_body_(std::move(body)), routing_(routing), patch_sites_(patch_sites), protocol_(protocol),
        responses_members_(members), responses_policy_(policy) {}

    mem::IoBuf raw_body_;
    LlmRoutingData routing_;
    json::JsonArray<LlmBodyPatchSite> patch_sites_;
    LlmWireProtocol protocol_ = LlmWireProtocol::OpenAiChatCompletions;
    json::JsonArray<ResponsesBodyMember> responses_members_;
    ResponsesBodyPolicyInfo responses_policy_;
};

} // namespace fiber::ai_server

#endif // FIBER_AI_SERVER_LLM_BODY_H
