#include "LlmBody.h"

#include <algorithm>
#include <array>
#include <charconv>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <limits>
#include <optional>
#include <string_view>
#include <type_traits>
#include <utility>

#include <fiber/common/json/JsonParser.h>

namespace fiber::ai_server {
namespace {

using json::JsonParser;
using json::Token;
using json::TokenKind;
using json::TokenRole;

template<typename T>
class RequestArrayBuilder {
    static_assert(std::is_trivially_copyable_v<T>);

public:
    explicit RequestArrayBuilder(mem::BufPool &pool) noexcept : pool_(&pool) {}

    [[nodiscard]] bool append(const T &value) noexcept {
        if (size_ == capacity_ && !grow()) {
            return false;
        }
        data_[size_++] = value;
        return true;
    }

    [[nodiscard]] json::JsonArray<T> finish() const noexcept { return json::JsonArray<T>(data_, size_); }

private:
    [[nodiscard]] bool grow() noexcept {
        const std::size_t next = capacity_ == 0 ? 8 : capacity_ * 2;
        if (next < capacity_ || next > std::numeric_limits<std::size_t>::max() / sizeof(T)) {
            return false;
        }
        T *replacement = pool_->alloc<T>(next);
        if (!replacement) {
            return false;
        }
        if (size_ > 0) {
            std::memcpy(replacement, data_, size_ * sizeof(T));
        }
        data_ = replacement;
        capacity_ = next;
        return true;
    }

    mem::BufPool *pool_ = nullptr;
    T *data_ = nullptr;
    std::size_t size_ = 0;
    std::size_t capacity_ = 0;
};

bool copy_text(mem::BufPool &pool, std::string_view value, std::string_view &out) noexcept {
    if (value.empty()) {
        out = {};
        return true;
    }
    auto *data = static_cast<char *>(pool.alloc(value.size(), alignof(char)));
    if (!data) {
        return false;
    }
    std::memcpy(data, value.data(), value.size());
    out = std::string_view(data, value.size());
    return true;
}

struct DigestPart {
    PromptDigest full{};
    PromptDigest breakpoint{};
    bool available = false;
    bool breakpoint_available = false;
};

struct AffinityState {
    DigestPart tools;
    DigestPart system;
    DigestPart first_message;
    DigestPart openai_messages;
    bool top_level_cache_control = false;
    bool explicit_after_first_message = false;
};

class BodyParser {
public:
    BodyParser(LlmWireProtocol protocol, std::string_view input, mem::BufPool &pool) noexcept :
        protocol_(protocol), input_(input), pool_(&pool), patches_(pool), members_(pool) {}

    [[nodiscard]] bool run() noexcept {
        if (!parser_.feed(input_.data(), input_.size())) {
            return parser_error();
        }
        parser_.finish();
        if (!advance("expected a JSON document")) {
            return false;
        }
        if (current().kind != TokenKind::StartObj || current().role != TokenRole::Value) {
            return set_error(LlmBodyErrorCode::ExpectedObject, {}, "request body must be a JSON object");
        }
        if (!parse_root()) {
            return false;
        }
        switch (parser_.next()) {
            case JsonParser::Status::Complete:
                return finish_affinity();
            case JsonParser::Status::Error:
                return parser_error();
            case JsonParser::Status::Token:
                (void) parser_.fail("multiple JSON root values");
                return parser_error();
            case JsonParser::Status::NeedMore:
                (void) parser_.fail("unexpected end of JSON input");
                return parser_error();
        }
        return set_error(LlmBodyErrorCode::InvalidJson, {}, "invalid parser state");
    }

    [[nodiscard]] json::JsonArray<ResponsesBodyMember> members() const noexcept { return members_.finish(); }
    [[nodiscard]] ResponsesBodyPolicyInfo policy() const noexcept { return policy_; }
    [[nodiscard]] LlmRoutingData routing() const noexcept { return routing_; }
    [[nodiscard]] json::JsonArray<LlmBodyPatchSite> patches() const noexcept { return patches_.finish(); }
    [[nodiscard]] const std::optional<LlmBodyError> &error() const noexcept { return error_; }

private:
    [[nodiscard]] const Token &current() const noexcept { return *parser_.current_token(); }

    [[nodiscard]] bool set_error(LlmBodyErrorCode code, std::string_view field, const char *message) noexcept {
        if (!error_) {
            error_ = LlmBodyError{
                    .code = code,
                    .offset = parser_.current_token() ? parser_.current_offset() : parser_.error().offset,
                    .field = field,
                    .message = message,
            };
        }
        return false;
    }

    [[nodiscard]] bool parser_error() noexcept {
        return set_error(LlmBodyErrorCode::InvalidJson, {},
                         parser_.error().message ? parser_.error().message : "failed to parse JSON request body");
    }

    [[nodiscard]] bool advance(const char *message) noexcept {
        switch (parser_.next()) {
            case JsonParser::Status::Token:
                return true;
            case JsonParser::Status::Error:
                return parser_error();
            case JsonParser::Status::Complete:
            case JsonParser::Status::NeedMore:
                (void) parser_.fail(message);
                return parser_error();
        }
        return set_error(LlmBodyErrorCode::InvalidJson, {}, "invalid parser state");
    }

    [[nodiscard]] bool append_patch(LlmBodyPatchKind kind) noexcept {
        if (patches_.append(LlmBodyPatchSite{
                    .begin = parser_.current_offset(),
                    .end = parser_.current_end_offset(),
                    .kind = kind,
            })) {
            return true;
        }
        return set_error(LlmBodyErrorCode::OutOfMemory, {}, "out of memory");
    }

    [[nodiscard]] bool parse_root() noexcept {
        if (protocol_ == LlmWireProtocol::OpenAiEmbedding)
            return parse_embedding_root();
        if (protocol_ == LlmWireProtocol::OpenAiResponses) {
            return parse_responses_root();
        }
        if (!advance("expected an object member or closing brace")) {
            return false;
        }
        while (current().kind != TokenKind::EndObj) {
            if (current().kind != TokenKind::Text || current().role != TokenRole::ObjectKey) {
                return set_error(LlmBodyErrorCode::InvalidJson, {}, "expected an object member name");
            }
            const std::string_view key = current().view;
            enum class RootField : std::uint8_t {
                Other,
                Model,
                Stream,
                Metadata,
                PromptCacheKey,
                CacheControl,
                Tools,
                System,
                Messages,
            };
            RootField field = RootField::Other;
            if (key == "model") {
                field = RootField::Model;
            } else if (key == "stream") {
                field = RootField::Stream;
            } else if (key == "metadata") {
                field = RootField::Metadata;
            } else if (key == "prompt_cache_key") {
                field = RootField::PromptCacheKey;
            } else if (key == "cache_control") {
                field = RootField::CacheControl;
            } else if (key == "tools") {
                field = RootField::Tools;
            } else if (key == "system") {
                field = RootField::System;
            } else if (key == "messages") {
                field = RootField::Messages;
            }

            if (!advance("expected an object member value")) {
                return false;
            }
            bool ok = false;
            switch (field) {
                case RootField::Model:
                    ok = parse_model();
                    break;
                case RootField::Stream:
                    ok = parse_stream();
                    break;
                case RootField::Metadata:
                    ok = parse_metadata();
                    break;
                case RootField::PromptCacheKey:
                    ok = protocol_ == LlmWireProtocol::OpenAiChatCompletions
                                 ? parse_direct_key("$.prompt_cache_key", "openai-prompt-cache-key",
                                                    PromptRouteKeySource::OpenAiPromptCacheKey)
                                 : skip_value();
                    break;
                case RootField::CacheControl:
                    ok = protocol_ == LlmWireProtocol::AnthropicMessages ? parse_top_level_cache_control()
                                                                         : skip_value();
                    break;
                case RootField::Tools:
                    ok = parse_tools();
                    break;
                case RootField::System:
                    ok = protocol_ == LlmWireProtocol::AnthropicMessages ? parse_anthropic_system() : skip_value();
                    break;
                case RootField::Messages:
                    ok = parse_messages();
                    break;
                case RootField::Other:
                    ok = skip_value();
                    break;
            }
            if (!ok || !advance("expected an object member or closing brace")) {
                return false;
            }
        }
        return true;
    }

    [[nodiscard]] bool embedding_input_error() noexcept {
        return set_error(LlmBodyErrorCode::InvalidFieldType, "input", "expected nonempty homogeneous embedding input");
    }

    [[nodiscard]] bool parse_embedding_tokens() noexcept {
        if (!advance("expected token ID"))
            return false;
        std::size_t count = 0;
        while (current().kind != TokenKind::EndArr) {
            if (current().kind != TokenKind::Integer || current().inum < 0)
                return embedding_input_error();
            ++count;
            if (!advance("expected token ID"))
                return false;
        }
        return count != 0 || embedding_input_error();
    }

    [[nodiscard]] bool parse_embedding_input() noexcept {
        if (current().kind == TokenKind::Text) {
            routing_.embedding.input_count = 1;
            return !current().view.empty() || embedding_input_error();
        }
        if (current().kind != TokenKind::StartArr || !advance("expected embedding input"))
            return embedding_input_error();
        const auto kind = current().kind;
        if (kind != TokenKind::Text && kind != TokenKind::Integer && kind != TokenKind::StartArr)
            return embedding_input_error();
        std::size_t count = 0;
        while (current().kind != TokenKind::EndArr) {
            if (current().kind != kind)
                return embedding_input_error();
            if (kind == TokenKind::Text && current().view.empty())
                return embedding_input_error();
            if (kind == TokenKind::Integer && current().inum < 0)
                return embedding_input_error();
            if (kind == TokenKind::StartArr && !parse_embedding_tokens())
                return false;
            if (++count > EmbeddingRequestInfo::kMaxInputs && kind != TokenKind::Integer)
                return embedding_input_error();
            if (!advance("expected embedding input"))
                return false;
        }
        routing_.embedding.input_count = kind == TokenKind::Integer ? 1 : count;
        return true;
    }

    [[nodiscard]] bool parse_embedding_root() noexcept {
        constexpr std::string_view fields[] = {"model", "input", "dimensions", "encoding_format", "user", "stream"};
        std::uint32_t seen = 0;
        std::size_t count = 0;
        if (!advance("expected object member"))
            return false;
        while (current().kind != TokenKind::EndObj) {
            if (++count > 4096)
                return set_error(LlmBodyErrorCode::TooManyFields, {}, "too many request fields");
            std::size_t field = std::size(fields);
            for (std::size_t i = 0; i < std::size(fields); ++i) {
                if (current().view == fields[i]) {
                    field = i;
                    break;
                }
            }
            if (field < std::size(fields)) {
                if (seen & (1U << field))
                    return set_error(LlmBodyErrorCode::DuplicateField, fields[field], "duplicate request field");
                seen |= 1U << field;
            }
            if (!advance("expected member value"))
                return false;
            switch (field) {
                case 0:
                    if (current().kind != TokenKind::Text || current().view.empty() || current().view.size() > 512)
                        return set_error(LlmBodyErrorCode::InvalidFieldType, "model", "expected nonempty model");
                    if (!parse_model())
                        return false;
                    break;
                case 1:
                    if (!parse_embedding_input())
                        return false;
                    break;
                case 2:
                    if (current().kind != TokenKind::Integer || current().inum <= 0)
                        return set_error(LlmBodyErrorCode::InvalidFieldType, "dimensions", "expected positive integer");
                    routing_.embedding.dimensions = current().inum;
                    break;
                case 3:
                    if (current().kind != TokenKind::Text || (current().view != "float" && current().view != "base64"))
                        return set_error(LlmBodyErrorCode::InvalidFieldType, "encoding_format",
                                         "expected float or base64");
                    routing_.embedding.base64 = current().view == "base64";
                    break;
                case 4:
                    if (current().kind != TokenKind::Text)
                        return set_error(LlmBodyErrorCode::InvalidFieldType, "user", "expected string");
                    break;
                case 5:
                    return set_error(LlmBodyErrorCode::InvalidFieldType, "stream", "embeddings do not support stream");
                default:
                    if (!skip_value())
                        return false;
            }
            if (!advance("expected object member"))
                return false;
        }
        if (!(seen & 1U))
            return set_error(LlmBodyErrorCode::InvalidFieldType, "model", "model is required");
        if (!(seen & 2U))
            return set_error(LlmBodyErrorCode::InvalidFieldType, "input", "input is required");
        return true;
    }

    [[nodiscard]] bool responses_item_error(LlmBodyErrorCode code, std::size_t index) noexcept {
        std::array<char, 48> path{};
        std::memcpy(path.data(), "input[", 6);
        auto result = std::to_chars(path.data() + 6, path.data() + path.size() - 1, index);
        *result.ptr++ = ']';
        std::string_view field;
        if (!copy_text(*pool_, {path.data(), static_cast<std::size_t>(result.ptr - path.data())}, field)) {
            return set_error(LlmBodyErrorCode::OutOfMemory, {}, "out of memory");
        }
        return set_error(code, field, "send a complete input item with one type discriminator");
    }

    [[nodiscard]] bool parse_responses_input() noexcept {
        PromptDigestBuilder prefix;
        if (current().kind == TokenKind::Text) {
            routing_.messages_count = 1;
            affinity_.openai_messages.available = !current().view.empty();
            return hash_value(prefix) && prefix.snapshot(affinity_.openai_messages.full);
        }
        if (current().kind != TokenKind::StartArr) {
            return set_error(LlmBodyErrorCode::InvalidFieldType, "input", "expected string or array input");
        }
        if (!advance("expected input item"))
            return false;
        bool anchor_open = true;
        std::size_t index = 0;
        while (current().kind != TokenKind::EndArr) {
            if (current().kind != TokenKind::StartObj) {
                return set_error(LlmBodyErrorCode::InvalidFieldType, "input", "expected input item object");
            }
            PromptDigestBuilder item;
            if (!item.begin_object() || !advance("expected item member"))
                return false;
            bool type_seen = false;
            bool message_type = true;
            int role = 0;
            while (current().kind != TokenKind::EndObj) {
                const bool type = current().view == "type";
                const bool is_role = current().view == "role";
                if (type && type_seen)
                    return responses_item_error(LlmBodyErrorCode::DuplicateField, index);
                type_seen = type_seen || type;
                if (anchor_open && !item.add_key(current().view))
                    return false;
                if (!advance("expected item value"))
                    return false;
                if (type) {
                    if (current().kind != TokenKind::Text) {
                        return set_error(LlmBodyErrorCode::InvalidFieldType, "input", "expected string item type");
                    }
                    if (current().view == "item_reference") {
                        return responses_item_error(LlmBodyErrorCode::StatefulInputReference, index);
                    }
                    message_type = current().view == "message";
                }
                if (is_role) {
                    role = current().kind != TokenKind::Text                               ? 0
                           : current().view == "user"                                      ? 1
                           : (current().view == "system" || current().view == "developer") ? 2
                           : current().view == "assistant"                                 ? 3
                                                                                           : 0;
                }
                if (!(anchor_open ? hash_value(item) : skip_value()) || !advance("expected item member"))
                    return false;
            }
            if (message_type && role != 0)
                ++routing_.messages_count;
            if (anchor_open) {
                if (message_type && (role == 1 || role == 2)) {
                    PromptDigest digest;
                    if (!item.end_object() || !item.snapshot(digest) || !prefix.add_component("message", digest) ||
                        !prefix.snapshot(affinity_.openai_messages.full))
                        return false;
                    affinity_.openai_messages.available = true;
                    if (role == 1)
                        anchor_open = false;
                } else {
                    anchor_open = false;
                }
            }
            ++index;
            if (!advance("expected input item"))
                return false;
        }
        return true;
    }

    [[nodiscard]] bool parse_responses_root() noexcept {
        constexpr std::string_view fields[] = {"model",        "stream",     "input",
                                               "instructions", "tools",      "prompt_cache_key",
                                               "store",        "background", "previous_response_id",
                                               "conversation"};
        std::uint32_t seen = 0;
        std::size_t count = 0;
        if (!advance("expected object member"))
            return false;
        while (current().kind != TokenKind::EndObj) {
            if (++count > 4096)
                return set_error(LlmBodyErrorCode::TooManyFields, {}, "too many request fields");
            const std::size_t begin = parser_.current_offset();
            std::size_t field = std::size(fields);
            for (std::size_t i = 0; i < std::size(fields); ++i) {
                if (current().view == fields[i]) {
                    field = i;
                    break;
                }
            }
            if (field < 6 && (seen & (1U << field))) {
                return set_error(LlmBodyErrorCode::DuplicateField, fields[field], "duplicate request field");
            }
            if (field < std::size(fields))
                seen |= 1U << field;
            if (!advance("expected member value"))
                return false;
            ResponsesBodyMember member{.begin = begin, .value_begin = parser_.current_offset()};
            bool ok = false;
            switch (field) {
                case 0:
                    member.kind = ResponsesMemberKind::Model;
                    ok = parse_model();
                    break;
                case 1:
                    member.kind = ResponsesMemberKind::Stream;
                    ok = parse_stream();
                    if (ok && !routing_.stream.is_present())
                        routing_.stream.set_present(false);
                    break;
                case 2:
                    ok = parse_responses_input();
                    break;
                case 3: {
                    if (current().kind != TokenKind::Null && current().kind != TokenKind::Text) {
                        return set_error(LlmBodyErrorCode::InvalidFieldType, "instructions",
                                         "expected string instructions");
                    }
                    affinity_.system.available = current().kind == TokenKind::Text && !current().view.empty();
                    PromptDigestBuilder digest;
                    ok = hash_value(digest) && digest.snapshot(affinity_.system.full);
                    break;
                }
                case 4:
                    if (current().kind != TokenKind::Null && current().kind != TokenKind::StartArr) {
                        return set_error(LlmBodyErrorCode::InvalidFieldType, "tools", "expected tools array");
                    }
                    ok = parse_tools();
                    break;
                case 5:
                    ok = parse_direct_key("prompt_cache_key", "openai-prompt-cache-key",
                                          PromptRouteKeySource::OpenAiPromptCacheKey);
                    break;
                case 6:
                case 7:
                    member.kind = ResponsesMemberKind::Drop;
                    if (current().kind != TokenKind::Null && current().kind != TokenKind::Bool) {
                        return set_error(LlmBodyErrorCode::InvalidFieldType, fields[field],
                                         "expected boolean policy field");
                    }
                    if (current().kind == TokenKind::Bool && current().bval) {
                        (field == 6 ? policy_.store_was_true : policy_.background_was_true) = true;
                    }
                    ok = true;
                    break;
                case 8:
                case 9:
                    member.kind = ResponsesMemberKind::Drop;
                    (field == 8 ? policy_.previous_response_removed : policy_.conversation_removed) = true;
                    ok = skip_value();
                    break;
                default:
                    ok = skip_value();
                    break;
            }
            if (!ok)
                return error_ ? false : set_error(LlmBodyErrorCode::OutOfMemory, {}, "failed to parse input");
            member.end = parser_.current_end_offset();
            if (!members_.append(member))
                return set_error(LlmBodyErrorCode::OutOfMemory, {}, "out of memory");
            if (!advance("expected object member"))
                return false;
        }
        if (!routing_.model.is_present() || routing_.model->empty()) {
            return set_error(LlmBodyErrorCode::InvalidFieldType, "model", "expected nonempty model");
        }
        if (!(seen & (1U << 2)))
            return set_error(LlmBodyErrorCode::InvalidFieldType, "input", "input is required");
        return true;
    }

    [[nodiscard]] bool parse_model() noexcept {
        if (!append_patch(LlmBodyPatchKind::Model)) {
            return false;
        }
        if (current().kind == TokenKind::Null) {
            routing_.model.set_null();
            return true;
        }
        if (current().kind != TokenKind::Text) {
            return set_error(LlmBodyErrorCode::InvalidFieldType, "$.model", "expected a JSON string");
        }
        std::string_view value;
        if (!copy_text(*pool_, current().view, value)) {
            return set_error(LlmBodyErrorCode::OutOfMemory, "$.model", "out of memory");
        }
        routing_.model.set_present(value);
        return true;
    }

    [[nodiscard]] bool parse_stream() noexcept {
        if (!append_patch(LlmBodyPatchKind::Stream)) {
            return false;
        }
        if (current().kind == TokenKind::Null) {
            routing_.stream.set_null();
            return true;
        }
        if (current().kind != TokenKind::Bool) {
            return set_error(LlmBodyErrorCode::InvalidFieldType, "$.stream", "expected a JSON boolean");
        }
        routing_.stream.set_present(current().bval);
        return true;
    }

    [[nodiscard]] bool parse_direct_key(std::string_view field, std::string_view domain,
                                        PromptRouteKeySource source) noexcept {
        routing_.direct_route_key = {};
        if (current().kind == TokenKind::Null) {
            return true;
        }
        if (current().kind != TokenKind::Text) {
            return set_error(LlmBodyErrorCode::InvalidFieldType, field, "expected a JSON string");
        }
        if (current().view.empty()) {
            return true;
        }
        if (!digest_opaque_route_key(domain, current().view, routing_.direct_route_key.digest)) {
            return set_error(LlmBodyErrorCode::OutOfMemory, field, "failed to hash route key");
        }
        routing_.direct_route_key.source = source;
        routing_.direct_route_key.available = true;
        return true;
    }

    [[nodiscard]] bool parse_metadata() noexcept {
        if (current().kind != TokenKind::StartObj) {
            return skip_value();
        }
        if (!advance("expected a metadata member or closing brace")) {
            return false;
        }
        while (current().kind != TokenKind::EndObj) {
            if (current().kind != TokenKind::Text || current().role != TokenRole::ObjectKey) {
                return set_error(LlmBodyErrorCode::InvalidJson, {}, "expected a metadata member name");
            }
            const bool user_id = protocol_ == LlmWireProtocol::AnthropicMessages && current().view == "user_id";
            if (!advance("expected a metadata member value")) {
                return false;
            }
            if (user_id) {
                if (!parse_direct_key("$.metadata.user_id", "anthropic-metadata-user-id",
                                      PromptRouteKeySource::AnthropicMetadataUserId)) {
                    return false;
                }
            } else if (!skip_value()) {
                return false;
            }
            if (!advance("expected a metadata member or closing brace")) {
                return false;
            }
        }
        return true;
    }

    [[nodiscard]] bool parse_top_level_cache_control() noexcept {
        bool marker = false;
        if (!parse_cache_control(marker)) {
            return false;
        }
        affinity_.top_level_cache_control = affinity_.top_level_cache_control || marker;
        return true;
    }

    [[nodiscard]] bool parse_cache_control(bool &marker) noexcept {
        marker = false;
        if (current().kind != TokenKind::StartObj) {
            return skip_value();
        }
        if (!advance("expected a cache control member or closing brace")) {
            return false;
        }
        while (current().kind != TokenKind::EndObj) {
            if (current().kind != TokenKind::Text || current().role != TokenRole::ObjectKey) {
                return set_error(LlmBodyErrorCode::InvalidJson, {}, "expected a cache control member name");
            }
            const bool type = current().view == "type";
            if (!advance("expected a cache control member value")) {
                return false;
            }
            if (type && current().kind == TokenKind::Text && current().view == "ephemeral") {
                marker = true;
            }
            if (!skip_value() || !advance("expected a cache control member or closing brace")) {
                return false;
            }
        }
        return true;
    }

    [[nodiscard]] bool hash_token(PromptDigestBuilder &builder) noexcept {
        switch (current().kind) {
            case TokenKind::Null:
                return builder.add_null();
            case TokenKind::Bool:
                return builder.add_bool(current().bval);
            case TokenKind::Integer:
                return builder.add_integer(current().inum);
            case TokenKind::BigNumber:
                return builder.add_big_number(current().view);
            case TokenKind::Double:
                return builder.add_double(current().fnum);
            case TokenKind::Text:
                return builder.add_text(current().view);
            case TokenKind::StartObj:
            case TokenKind::EndObj:
            case TokenKind::StartArr:
            case TokenKind::EndArr:
                break;
        }
        return false;
    }

    [[nodiscard]] bool hash_value(PromptDigestBuilder &builder) noexcept {
        if (current().kind == TokenKind::StartObj) {
            if (!builder.begin_object() || !advance("expected an object member or closing brace")) {
                return false;
            }
            while (current().kind != TokenKind::EndObj) {
                if (current().kind != TokenKind::Text || current().role != TokenRole::ObjectKey) {
                    return set_error(LlmBodyErrorCode::InvalidJson, {}, "expected an object member name");
                }
                if (!builder.add_key(current().view) || !advance("expected an object member value") ||
                    !hash_value(builder) || !advance("expected an object member or closing brace")) {
                    return false;
                }
            }
            return builder.end_object();
        }
        if (current().kind == TokenKind::StartArr) {
            if (!builder.begin_array() || !advance("expected an array element or closing bracket")) {
                return false;
            }
            while (current().kind != TokenKind::EndArr) {
                if (!hash_value(builder) || !advance("expected an array element or closing bracket")) {
                    return false;
                }
            }
            return builder.end_array();
        }
        if (current().kind == TokenKind::EndObj || current().kind == TokenKind::EndArr) {
            return set_error(LlmBodyErrorCode::InvalidJson, {}, "unexpected container end");
        }
        return hash_token(builder);
    }

    [[nodiscard]] bool skip_value() noexcept {
        if (current().kind != TokenKind::StartObj && current().kind != TokenKind::StartArr) {
            return current().kind != TokenKind::EndObj && current().kind != TokenKind::EndArr;
        }
        std::size_t depth = 1;
        while (depth > 0) {
            if (!advance("unexpected end of JSON value")) {
                return false;
            }
            if (current().kind == TokenKind::StartObj || current().kind == TokenKind::StartArr) {
                ++depth;
                if (protocol_ == LlmWireProtocol::OpenAiEmbedding && depth > 64)
                    return set_error(LlmBodyErrorCode::InvalidFieldType, {}, "request nesting exceeds limit");
            } else if (current().kind == TokenKind::EndObj || current().kind == TokenKind::EndArr) {
                --depth;
            }
        }
        return true;
    }

    [[nodiscard]] bool hash_cacheable_block(PromptDigestBuilder &builder, bool &marker) noexcept {
        marker = false;
        if (current().kind != TokenKind::StartObj) {
            return hash_value(builder);
        }
        if (!builder.begin_object() || !advance("expected a content block member or closing brace")) {
            return false;
        }
        while (current().kind != TokenKind::EndObj) {
            if (current().kind != TokenKind::Text || current().role != TokenRole::ObjectKey) {
                return set_error(LlmBodyErrorCode::InvalidJson, {}, "expected a content block member name");
            }
            const std::string_view key = current().view;
            const bool cache_control = key == "cache_control";
            if (!cache_control && !builder.add_key(key)) {
                return false;
            }
            if (!advance("expected a content block member value")) {
                return false;
            }
            if (cache_control) {
                bool current_marker = false;
                if (!parse_cache_control(current_marker)) {
                    return false;
                }
                marker = marker || current_marker;
            } else if (!hash_value(builder)) {
                return false;
            }
            if (!advance("expected a content block member or closing brace")) {
                return false;
            }
        }
        return builder.end_object();
    }

    [[nodiscard]] bool parse_cacheable_part(DigestPart &part) noexcept {
        part = {};
        PromptDigestBuilder builder;
        if (current().kind != TokenKind::StartArr) {
            const bool nonempty_text = current().kind == TokenKind::Text && !current().view.empty();
            const bool available =
                    current().kind != TokenKind::Null && (current().kind != TokenKind::Text || nonempty_text);
            if (!hash_value(builder) || !builder.snapshot(part.full)) {
                return set_error(LlmBodyErrorCode::OutOfMemory, {}, "failed to hash prompt component");
            }
            part.available = available;
            return true;
        }

        if (!builder.begin_array() || !advance("expected an array element or closing bracket")) {
            return false;
        }
        std::size_t count = 0;
        while (current().kind != TokenKind::EndArr) {
            bool marker = false;
            if (!hash_cacheable_block(builder, marker)) {
                return false;
            }
            ++count;
            if (marker && !part.breakpoint_available) {
                PromptDigestBuilder breakpoint = builder;
                if (!breakpoint.end_array() || !breakpoint.snapshot(part.breakpoint)) {
                    return set_error(LlmBodyErrorCode::OutOfMemory, {}, "failed to hash cache breakpoint");
                }
                part.breakpoint_available = true;
            }
            if (!advance("expected an array element or closing bracket")) {
                return false;
            }
        }
        if (!builder.end_array() || !builder.snapshot(part.full)) {
            return set_error(LlmBodyErrorCode::OutOfMemory, {}, "failed to hash prompt component");
        }
        part.available = count != 0;
        return true;
    }

    [[nodiscard]] bool parse_tools() noexcept {
        if (protocol_ == LlmWireProtocol::AnthropicMessages) {
            if (current().kind == TokenKind::StartArr) {
                PromptDigestBuilder builder;
                affinity_.tools = {};
                if (!builder.begin_array() || !advance("expected a tool or closing bracket")) {
                    return false;
                }
                while (current().kind != TokenKind::EndArr) {
                    bool marker = false;
                    if (!hash_cacheable_block(builder, marker)) {
                        return false;
                    }
                    ++routing_.tools_count;
                    if (marker && !affinity_.tools.breakpoint_available) {
                        PromptDigestBuilder breakpoint = builder;
                        if (!breakpoint.end_array() || !breakpoint.snapshot(affinity_.tools.breakpoint)) {
                            return set_error(LlmBodyErrorCode::OutOfMemory, {}, "failed to hash tool breakpoint");
                        }
                        affinity_.tools.breakpoint_available = true;
                    }
                    if (!advance("expected a tool or closing bracket")) {
                        return false;
                    }
                }
                if (!builder.end_array() || !builder.snapshot(affinity_.tools.full)) {
                    return set_error(LlmBodyErrorCode::OutOfMemory, {}, "failed to hash tools");
                }
                affinity_.tools.available = routing_.tools_count != 0;
                return true;
            }
            return parse_cacheable_part(affinity_.tools);
        }

        PromptDigestBuilder builder;
        std::size_t count = 0;
        if (current().kind == TokenKind::StartArr) {
            if (!builder.begin_array() || !advance("expected a tool or closing bracket")) {
                return false;
            }
            while (current().kind != TokenKind::EndArr) {
                if (!hash_value(builder)) {
                    return false;
                }
                ++count;
                if (!advance("expected a tool or closing bracket")) {
                    return false;
                }
            }
            if (!builder.end_array()) {
                return false;
            }
        } else if (!hash_value(builder)) {
            return false;
        } else if (current().kind != TokenKind::Null) {
            count = 1;
        }
        routing_.tools_count = count;
        if (!builder.snapshot(affinity_.tools.full)) {
            return set_error(LlmBodyErrorCode::OutOfMemory, {}, "failed to hash tools");
        }
        affinity_.tools.available = count != 0;
        return true;
    }

    [[nodiscard]] bool parse_anthropic_system() noexcept { return parse_cacheable_part(affinity_.system); }

    [[nodiscard]] bool parse_anthropic_content(DigestPart &content) noexcept { return parse_cacheable_part(content); }

    [[nodiscard]] bool combine_message_parts(const DigestPart &role, const DigestPart &content,
                                             DigestPart &message) noexcept {
        message = {};
        PromptDigestBuilder full;
        if (role.available && !full.add_component("role", role.full)) {
            return false;
        }
        if (content.available && !full.add_component("content", content.full)) {
            return false;
        }
        message.available = role.available || content.available;
        if (message.available && !full.snapshot(message.full)) {
            return false;
        }
        if (content.breakpoint_available) {
            PromptDigestBuilder breakpoint;
            if ((role.available && !breakpoint.add_component("role", role.full)) ||
                !breakpoint.add_component("content", content.breakpoint) || !breakpoint.snapshot(message.breakpoint)) {
                return false;
            }
            message.breakpoint_available = true;
        }
        return true;
    }

    [[nodiscard]] bool parse_anthropic_first_message() noexcept {
        if (current().kind != TokenKind::StartObj) {
            PromptDigestBuilder builder;
            if (!hash_value(builder) || !builder.snapshot(affinity_.first_message.full)) {
                return set_error(LlmBodyErrorCode::OutOfMemory, {}, "failed to hash first message");
            }
            affinity_.first_message.available = true;
            return true;
        }

        DigestPart role;
        DigestPart content;
        if (!advance("expected a message member or closing brace")) {
            return false;
        }
        while (current().kind != TokenKind::EndObj) {
            if (current().kind != TokenKind::Text || current().role != TokenRole::ObjectKey) {
                return set_error(LlmBodyErrorCode::InvalidJson, {}, "expected a message member name");
            }
            const bool is_role = current().view == "role";
            const bool is_content = current().view == "content";
            if (!advance("expected a message member value")) {
                return false;
            }
            if (is_role) {
                PromptDigestBuilder builder;
                if (!hash_value(builder) || !builder.snapshot(role.full)) {
                    return set_error(LlmBodyErrorCode::OutOfMemory, {}, "failed to hash message role");
                }
                role.available = true;
            } else if (is_content) {
                if (!parse_anthropic_content(content)) {
                    return false;
                }
            } else if (!skip_value()) {
                return false;
            }
            if (!advance("expected a message member or closing brace")) {
                return false;
            }
        }
        if (!combine_message_parts(role, content, affinity_.first_message)) {
            return set_error(LlmBodyErrorCode::OutOfMemory, {}, "failed to hash first message");
        }
        return true;
    }

    [[nodiscard]] bool scan_cacheable_blocks(bool &marker) noexcept {
        marker = false;
        if (current().kind != TokenKind::StartArr) {
            return skip_value();
        }
        if (!advance("expected a content block or closing bracket")) {
            return false;
        }
        while (current().kind != TokenKind::EndArr) {
            if (current().kind != TokenKind::StartObj) {
                if (!skip_value()) {
                    return false;
                }
            } else {
                if (!advance("expected a content block member or closing brace")) {
                    return false;
                }
                while (current().kind != TokenKind::EndObj) {
                    if (current().kind != TokenKind::Text || current().role != TokenRole::ObjectKey) {
                        return set_error(LlmBodyErrorCode::InvalidJson, {}, "expected a content block member name");
                    }
                    const bool cache_control = current().view == "cache_control";
                    if (!advance("expected a content block member value")) {
                        return false;
                    }
                    if (cache_control) {
                        bool current_marker = false;
                        if (!parse_cache_control(current_marker)) {
                            return false;
                        }
                        marker = marker || current_marker;
                    } else if (!skip_value()) {
                        return false;
                    }
                    if (!advance("expected a content block member or closing brace")) {
                        return false;
                    }
                }
            }
            if (!advance("expected a content block or closing bracket")) {
                return false;
            }
        }
        return true;
    }

    [[nodiscard]] bool scan_anthropic_message(bool &marker) noexcept {
        marker = false;
        if (current().kind != TokenKind::StartObj) {
            return skip_value();
        }
        if (!advance("expected a message member or closing brace")) {
            return false;
        }
        while (current().kind != TokenKind::EndObj) {
            if (current().kind != TokenKind::Text || current().role != TokenRole::ObjectKey) {
                return set_error(LlmBodyErrorCode::InvalidJson, {}, "expected a message member name");
            }
            const bool content = current().view == "content";
            if (!advance("expected a message member value")) {
                return false;
            }
            if (content) {
                bool current_marker = false;
                if (!scan_cacheable_blocks(current_marker)) {
                    return false;
                }
                marker = marker || current_marker;
            } else if (!skip_value()) {
                return false;
            }
            if (!advance("expected a message member or closing brace")) {
                return false;
            }
        }
        return true;
    }

    [[nodiscard]] bool parse_openai_message(PromptDigest &digest, bool &is_user) noexcept {
        is_user = false;
        PromptDigestBuilder builder;
        if (current().kind != TokenKind::StartObj) {
            if (!hash_value(builder) || !builder.snapshot(digest)) {
                return set_error(LlmBodyErrorCode::OutOfMemory, {}, "failed to hash message");
            }
            return true;
        }
        if (!builder.begin_object() || !advance("expected a message member or closing brace")) {
            return false;
        }
        while (current().kind != TokenKind::EndObj) {
            if (current().kind != TokenKind::Text || current().role != TokenRole::ObjectKey) {
                return set_error(LlmBodyErrorCode::InvalidJson, {}, "expected a message member name");
            }
            const std::string_view key = current().view;
            const bool role = key == "role";
            if (!builder.add_key(key) || !advance("expected a message member value")) {
                return false;
            }
            if (role && current().kind == TokenKind::Text && current().view == "user") {
                is_user = true;
            }
            if (!hash_value(builder) || !advance("expected a message member or closing brace")) {
                return false;
            }
        }
        if (!builder.end_object() || !builder.snapshot(digest)) {
            return set_error(LlmBodyErrorCode::OutOfMemory, {}, "failed to hash message");
        }
        return true;
    }

    [[nodiscard]] bool parse_messages() noexcept {
        if (current().kind != TokenKind::StartArr) {
            return skip_value();
        }
        if (!advance("expected a message or closing bracket")) {
            return false;
        }
        if (protocol_ == LlmWireProtocol::AnthropicMessages) {
            while (current().kind != TokenKind::EndArr) {
                const std::size_t index = routing_.messages_count++;
                if (index == 0) {
                    if (!parse_anthropic_first_message()) {
                        return false;
                    }
                } else {
                    bool marker = false;
                    if (!scan_anthropic_message(marker)) {
                        return false;
                    }
                    affinity_.explicit_after_first_message = affinity_.explicit_after_first_message || marker;
                }
                if (!advance("expected a message or closing bracket")) {
                    return false;
                }
            }
            return true;
        }

        PromptDigestBuilder prefix;
        PromptDigest first{};
        PromptDigest through_user{};
        bool first_available = false;
        bool user_available = false;
        if (!prefix.begin_array()) {
            return false;
        }
        while (current().kind != TokenKind::EndArr) {
            PromptDigest message{};
            bool is_user = false;
            if (!parse_openai_message(message, is_user)) {
                return false;
            }
            ++routing_.messages_count;
            if (!user_available && !prefix.add_component("message", message)) {
                return false;
            }
            if (!first_available) {
                if (!prefix.snapshot(first)) {
                    return set_error(LlmBodyErrorCode::OutOfMemory, {}, "failed to hash first message");
                }
                first_available = true;
            }
            if (is_user && !user_available) {
                if (!prefix.snapshot(through_user)) {
                    return set_error(LlmBodyErrorCode::OutOfMemory, {}, "failed to hash message prefix");
                }
                user_available = true;
            }
            if (!advance("expected a message or closing bracket")) {
                return false;
            }
        }
        affinity_.openai_messages.available = first_available;
        affinity_.openai_messages.full = user_available ? through_user : first;
        return true;
    }

    [[nodiscard]] bool combine_candidate(PromptRouteKeySource source, const DigestPart *first, const DigestPart *second,
                                         const DigestPart *third, PromptRouteCandidate &candidate,
                                         bool use_breakpoint = false) noexcept {
        PromptDigestBuilder builder;
        bool available = false;
        const DigestPart *parts[] = {first, second, third};
        constexpr std::string_view names[] = {"tools", "system", "message"};
        for (std::size_t i = 0; i < std::size(parts); ++i) {
            if (!parts[i]) {
                continue;
            }
            const bool part_available = use_breakpoint && i == 2 ? parts[i]->breakpoint_available : parts[i]->available;
            if (!part_available) {
                continue;
            }
            const PromptDigest &digest = use_breakpoint && i == 2 ? parts[i]->breakpoint : parts[i]->full;
            if (!builder.add_component(names[i], digest)) {
                return false;
            }
            available = true;
        }
        candidate = {};
        if (!available) {
            return true;
        }
        if (!builder.snapshot(candidate.digest)) {
            return false;
        }
        candidate.source = source;
        candidate.available = true;
        return true;
    }

    [[nodiscard]] bool finish_anthropic_affinity() noexcept {
        PromptRouteCandidate &candidate = routing_.prompt_affinity;
        // Cache prefixes follow Anthropic's logical tools -> system -> messages order, independent of root JSON
        // member order. An early explicit breakpoint is exact; a later or automatic breakpoint uses the stable
        // conversation anchor so growing turns cannot move Provider/token affinity.
        if (affinity_.tools.breakpoint_available) {
            DigestPart breakpoint = affinity_.tools;
            breakpoint.full = breakpoint.breakpoint;
            breakpoint.available = true;
            return combine_candidate(PromptRouteKeySource::AnthropicExplicitCacheAnchor, &breakpoint, nullptr, nullptr,
                                     candidate);
        }
        if (affinity_.system.breakpoint_available) {
            DigestPart breakpoint = affinity_.system;
            breakpoint.full = breakpoint.breakpoint;
            breakpoint.available = true;
            return combine_candidate(PromptRouteKeySource::AnthropicExplicitCacheAnchor, &affinity_.tools, &breakpoint,
                                     nullptr, candidate);
        }
        if (affinity_.first_message.breakpoint_available) {
            return combine_candidate(PromptRouteKeySource::AnthropicExplicitCacheAnchor, &affinity_.tools,
                                     &affinity_.system, &affinity_.first_message, candidate, true);
        }
        const PromptRouteKeySource source =
                affinity_.explicit_after_first_message
                        ? PromptRouteKeySource::AnthropicExplicitCacheAnchor
                        : (affinity_.top_level_cache_control ? PromptRouteKeySource::AnthropicAutomaticCacheAnchor
                                                             : PromptRouteKeySource::AnthropicConversationAnchor);
        return combine_candidate(source, &affinity_.tools, &affinity_.system, &affinity_.first_message, candidate);
    }

    [[nodiscard]] bool finish_openai_affinity() noexcept {
        return combine_candidate(PromptRouteKeySource::OpenAiSemanticAnchor, &affinity_.tools, nullptr,
                                 &affinity_.openai_messages, routing_.prompt_affinity);
    }

    [[nodiscard]] bool finish_affinity() noexcept {
        if (protocol_ == LlmWireProtocol::OpenAiEmbedding)
            return true;
        if (protocol_ == LlmWireProtocol::OpenAiResponses) {
            return combine_candidate(PromptRouteKeySource::ResponsesSemanticAnchor, &affinity_.tools, &affinity_.system,
                                     &affinity_.openai_messages, routing_.prompt_affinity) ||
                   set_error(LlmBodyErrorCode::OutOfMemory, {}, "failed to hash prompt affinity");
        }
        const bool ok = protocol_ == LlmWireProtocol::AnthropicMessages ? finish_anthropic_affinity()
                                                                        : finish_openai_affinity();
        return ok || set_error(LlmBodyErrorCode::OutOfMemory, {}, "failed to hash prompt affinity");
    }

    LlmWireProtocol protocol_ = LlmWireProtocol::OpenAiChatCompletions;
    std::string_view input_;
    mem::BufPool *pool_ = nullptr;
    JsonParser parser_;
    LlmRoutingData routing_;
    AffinityState affinity_;
    RequestArrayBuilder<LlmBodyPatchSite> patches_;
    RequestArrayBuilder<ResponsesBodyMember> members_;
    ResponsesBodyPolicyInfo policy_;
    std::optional<LlmBodyError> error_;
};

} // namespace

std::expected<ParsedLlmBody, LlmBodyError> ParsedLlmBody::parse(LlmWireProtocol protocol, mem::IoBuf body,
                                                                mem::BufPool &pool) noexcept {
    if (!body) {
        return std::unexpected(LlmBodyError{
                .code = LlmBodyErrorCode::OutOfMemory,
                .message = "request body storage is unavailable",
        });
    }

    const std::string_view input(reinterpret_cast<const char *>(body.readable_data()), body.readable());
    BodyParser parser(protocol, input, pool);
    if (!parser.run()) {
        return std::unexpected(*parser.error());
    }
    return ParsedLlmBody(std::move(body), parser.routing(), parser.patches(), protocol, parser.members(),
                         parser.policy());
}

} // namespace fiber::ai_server
