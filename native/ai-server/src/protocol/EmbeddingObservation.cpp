#include "EmbeddingObservation.h"

#include <array>
#include <bitset>
#include <cmath>
#include <fiber/common/json/JsonParser.h>

namespace fiber::ai_server {
namespace {
using json::TokenKind;

class Observer {
public:
    explicit Observer(const EmbeddingRequestInfo &request) noexcept : request_(request) {}

    EmbeddingObservation run(std::string_view input) noexcept {
        if (request_.input_count == 0 || request_.input_count > EmbeddingRequestInfo::kMaxInputs ||
            !parser_.feed(input.data(), input.size()))
            return {.invalid_response = true};
        parser_.finish();
        if (!next() || !object(Scope::Root) || parser_.next() != json::JsonParser::Status::Complete ||
            indices_.count() != request_.input_count)
            return {.invalid_response = true};
        if (usage_valid_ && prompt_ && total_ && *prompt_ == *total_)
            return {.usage = LlmTokenUsage{.in_cache = 0, .in_nocache = *prompt_, .out = 0}};
        return {};
    }

private:
    enum class Scope { Root, Item, Usage };
    const json::Token &token() const noexcept { return *parser_.current_token(); }
    bool next() noexcept { return parser_.next() == json::JsonParser::Status::Token; }
    bool skip() noexcept {
        if (token().kind != TokenKind::StartObj && token().kind != TokenKind::StartArr)
            return true;
        std::size_t depth = 1;
        while (depth != 0) {
            if (!next())
                return false;
            if (token().kind == TokenKind::StartObj || token().kind == TokenKind::StartArr)
                ++depth;
            else if (token().kind == TokenKind::EndObj || token().kind == TokenKind::EndArr)
                --depth;
        }
        return true;
    }
    bool text(std::string_view expected) const noexcept {
        return token().kind == TokenKind::Text && token().view == expected;
    }
    bool dimension(std::size_t count) noexcept {
        if (count == 0 || (request_.dimensions && count != static_cast<std::uint64_t>(*request_.dimensions)))
            return false;
        if (dimension_ == 0)
            dimension_ = count;
        return dimension_ == count;
    }
    bool vector() noexcept {
        if (request_.base64) {
            if (token().kind != TokenKind::Text)
                return false;
            const auto value = token().view;
            if (value.empty() || value.size() % 4 != 0)
                return false;
            const std::size_t padding = value.ends_with("==") ? 2 : value.ends_with("=") ? 1 : 0;
            const auto digit = [](char c) noexcept -> int {
                if (c >= 'A' && c <= 'Z')
                    return c - 'A';
                if (c >= 'a' && c <= 'z')
                    return c - 'a' + 26;
                if (c >= '0' && c <= '9')
                    return c - '0' + 52;
                if (c == '+')
                    return 62;
                if (c == '/')
                    return 63;
                return -1;
            };
            for (std::size_t i = 0; i < value.size() - padding; ++i) {
                if (digit(value[i]) < 0)
                    return false;
            }
            const auto last = digit(value[value.size() - padding - 1]);
            if ((padding == 2 && (last & 15) != 0) || (padding == 1 && (last & 3) != 0))
                return false;
            const std::size_t bytes = value.size() / 4 * 3 - padding;
            return bytes % 4 == 0 && dimension(bytes / 4);
        }
        if (token().kind != TokenKind::StartArr || !next())
            return false;
        std::size_t count = 0;
        while (token().kind != TokenKind::EndArr) {
            if (token().kind != TokenKind::Integer &&
                (token().kind != TokenKind::Double || !std::isfinite(token().fnum)))
                return false;
            ++count;
            if (!next())
                return false;
        }
        return dimension(count);
    }
    bool data() noexcept {
        if (token().kind != TokenKind::StartArr || !next())
            return false;
        std::size_t count = 0;
        while (token().kind != TokenKind::EndArr) {
            if (++count > request_.input_count || !object(Scope::Item) || !next())
                return false;
        }
        return count == request_.input_count;
    }
    bool object(Scope scope) noexcept {
        if (token().kind != TokenKind::StartObj || !next())
            return false;
        std::uint32_t seen = 0;
        while (token().kind != TokenKind::EndObj) {
            const auto key = token().view;
            int field = -1;
            if (scope == Scope::Root) {
                if (key == "object")
                    field = 0;
                else if (key == "model")
                    field = 1;
                else if (key == "data")
                    field = 2;
                else if (key == "usage")
                    field = 3;
            } else if (scope == Scope::Item) {
                if (key == "object")
                    field = 0;
                else if (key == "index")
                    field = 1;
                else if (key == "embedding")
                    field = 2;
            } else {
                if (key == "prompt_tokens")
                    field = 0;
                else if (key == "total_tokens")
                    field = 1;
            }
            if (field >= 0) {
                if (seen & (1U << field)) {
                    if (scope != Scope::Usage)
                        return false;
                    usage_valid_ = false;
                }
                seen |= 1U << field;
            }
            if (!next())
                return false;
            if (field < 0) {
                if (!skip())
                    return false;
            } else if (scope == Scope::Usage) {
                if (token().kind == TokenKind::Integer && token().inum >= 0)
                    (field == 0 ? prompt_ : total_) = token().inum;
                else {
                    usage_valid_ = false;
                    if (!skip())
                        return false;
                }
            } else if (scope == Scope::Root) {
                if (field == 0 && !text("list"))
                    return false;
                if (field == 1 && (token().kind != TokenKind::Text || token().view.empty()))
                    return false;
                if (field == 2 && !data())
                    return false;
                if (field == 3) {
                    if (token().kind == TokenKind::StartObj) {
                        if (!object(Scope::Usage))
                            return false;
                    } else {
                        usage_valid_ = false;
                        if (!skip())
                            return false;
                    }
                }
            } else {
                if (field == 0 && !text("embedding"))
                    return false;
                if (field == 1) {
                    if (token().kind != TokenKind::Integer || token().inum < 0 ||
                        static_cast<std::uint64_t>(token().inum) >= request_.input_count)
                        return false;
                    const auto index = static_cast<std::size_t>(token().inum);
                    if (indices_[index])
                        return false;
                    indices_[index] = true;
                }
                if (field == 2 && !vector())
                    return false;
            }
            if (!next())
                return false;
        }
        return scope == Scope::Usage || (seen & 7U) == 7U;
    }

    const EmbeddingRequestInfo &request_;
    json::JsonParser parser_;
    std::bitset<EmbeddingRequestInfo::kMaxInputs> indices_;
    std::size_t dimension_ = 0;
    std::optional<std::int64_t> prompt_;
    std::optional<std::int64_t> total_;
    bool usage_valid_ = true;
};
} // namespace

EmbeddingObservation observe_embedding(std::string_view input, const EmbeddingRequestInfo &request) noexcept {
    return Observer(request).run(input);
}
} // namespace fiber::ai_server
