#include "ResponsesObservation.h"

#include <fiber/common/json/JsonParser.h>

namespace fiber::ai_server {
namespace {
using json::TokenKind;

ResponsesTerminal terminal_for(std::string_view value) noexcept {
    if (value == "completed" || value == "response.completed")
        return ResponsesTerminal::Completed;
    if (value == "failed" || value == "response.failed")
        return ResponsesTerminal::Failed;
    if (value == "incomplete" || value == "response.incomplete")
        return ResponsesTerminal::Incomplete;
    if (value == "error")
        return ResponsesTerminal::Error;
    return ResponsesTerminal::None;
}

class Observer {
public:
    explicit Observer(bool streaming) noexcept : streaming_(streaming) {}

    ResponsesObservation run(std::string_view input) noexcept {
        if (!parser_.feed(input.data(), input.size()))
            return invalid();
        parser_.finish();
        if (!next() || token().kind != TokenKind::StartObj || !object(streaming_ ? Scope::Event : Scope::Response) ||
            parser_.next() != json::JsonParser::Status::Complete)
            return invalid();
        if (streaming_) {
            if (!type_seen_)
                return invalid();
            result_.terminal = event_terminal_;
            if (event_terminal_ != ResponsesTerminal::None && event_terminal_ != ResponsesTerminal::Error &&
                (!response_seen_ || !object_valid_ || status_ != event_terminal_))
                return invalid();
            result_.output_token_observed = result_.output_delta && delta_nonempty_;
        } else {
            if (!object_valid_ || status_ == ResponsesTerminal::None || status_ == ResponsesTerminal::Error)
                return invalid();
            result_.terminal = status_;
        }
        if ((!streaming_ ||
             (result_.terminal != ResponsesTerminal::None && result_.terminal != ResponsesTerminal::Error)) &&
            (input_tokens_ || output_tokens_ || cache_tokens_)) {
            auto cached = cache_tokens_;
            if (!cache_seen_ && input_tokens_)
                cached = 0;
            std::optional<std::int64_t> uncached;
            if (input_tokens_ && cached) {
                if (*input_tokens_ >= *cached)
                    uncached = *input_tokens_ - *cached;
                else
                    result_.invalid_usage = true;
            }
            result_.usage = LlmTokenUsage{.in_cache = cached, .in_nocache = uncached, .out = output_tokens_};
        }
        return result_;
    }

private:
    enum class Scope { Event, Response, Usage, Details, Error };
    const json::Token &token() const noexcept { return *parser_.current_token(); }
    bool next() noexcept { return parser_.next() == json::JsonParser::Status::Token; }
    ResponsesObservation invalid() noexcept {
        result_.invalid_json_or_shape = true;
        result_.usage.reset();
        return result_;
    }
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
    bool count(std::optional<std::int64_t> &value) noexcept {
        value.reset();
        if (token().kind == TokenKind::Integer && token().inum >= 0)
            value = token().inum;
        else if (token().kind != TokenKind::Null)
            result_.invalid_usage = true;
        return skip();
    }
    void error_code() noexcept {
        if (token().kind != TokenKind::Text)
            return;
        const auto value = token().view;
        ResponsesErrorKind kind = ResponsesErrorKind::Unknown;
        if (value == "invalid_api_key" || value == "authentication_error" || value == "permission_denied")
            kind = ResponsesErrorKind::Authentication;
        else if (value == "rate_limit_exceeded" || value == "rate_limit_error" || value == "insufficient_quota")
            kind = ResponsesErrorKind::RateLimit;
        else if (value == "server_error" || value == "internal_error")
            kind = ResponsesErrorKind::Server;
        if (kind != ResponsesErrorKind::Unknown)
            result_.error_kind = kind;
    }
    bool object(Scope scope) noexcept {
        if (token().kind != TokenKind::StartObj || !next())
            return false;
        std::uint32_t seen = 0;
        while (token().kind != TokenKind::EndObj) {
            if (token().kind != TokenKind::Text || token().role != json::TokenRole::ObjectKey)
                return false;
            // Resolve before next(): decoded token storage belongs to the parser.
            const auto key = token().view;
            int field = -1;
            if (scope == Scope::Event) {
                if (key == "type")
                    field = 0;
                else if (key == "response")
                    field = 1;
                else if (key == "sequence_number")
                    field = 2;
                else if (key == "delta")
                    field = 3;
                else if (key == "code")
                    field = 4;
            } else if (scope == Scope::Response) {
                if (key == "object")
                    field = 0;
                else if (key == "status")
                    field = 1;
                else if (key == "usage")
                    field = 2;
                else if (key == "store" || key == "background")
                    field = key == "store" ? 3 : 4;
                else if (key == "previous_response_id" || key == "conversation")
                    field = key == "conversation" ? 5 : 6;
                else if (key == "error")
                    field = 7;
            } else if (scope == Scope::Usage) {
                if (key == "input_tokens")
                    field = 0;
                else if (key == "output_tokens")
                    field = 1;
                else if (key == "input_tokens_details")
                    field = 2;
            } else if (scope == Scope::Details) {
                if (key == "cached_tokens")
                    field = 0;
            } else if (scope == Scope::Error) {
                if (key == "code")
                    field = 0;
                else if (key == "type")
                    field = 1;
            }
            if (field >= 0) {
                if (seen & (1U << field))
                    return false;
                seen |= 1U << field;
            }
            if (!next())
                return false;
            bool consumed = false;
            if (field >= 0 && scope == Scope::Event) {
                switch (field) {
                    case 0:
                        if (token().kind != TokenKind::Text || token().view.empty())
                            return false;
                        type_seen_ = true;
                        event_terminal_ = terminal_for(token().view);
                        // A buffered status name is not an event type.
                        if (!token().view.starts_with("response.") && token().view != "error")
                            event_terminal_ = ResponsesTerminal::None;
                        result_.output_delta = token().view == "response.output_text.delta" ||
                                               token().view == "response.refusal.delta" ||
                                               token().view == "response.function_call_arguments.delta" ||
                                               token().view == "response.custom_tool_call_input.delta" ||
                                               token().view == "response.reasoning_text.delta" ||
                                               token().view == "response.reasoning_summary_text.delta";
                        break;
                    case 1:
                        response_seen_ = true;
                        if (!object(Scope::Response))
                            return false;
                        consumed = true;
                        break;
                    case 2:
                        if (token().kind != TokenKind::Integer || token().inum < 0)
                            return false;
                        result_.sequence_number = token().inum;
                        break;
                    case 3:
                        delta_nonempty_ = token().kind == TokenKind::Text && !token().view.empty();
                        break;
                    case 4:
                        error_code();
                        break;
                }
            } else if (field >= 0 && scope == Scope::Response) {
                switch (field) {
                    case 0:
                        object_valid_ = token().kind == TokenKind::Text && token().view == "response";
                        break;
                    case 1:
                        if (token().kind != TokenKind::Text)
                            return false;
                        status_ = terminal_for(token().view);
                        if (token().view.starts_with("response."))
                            status_ = ResponsesTerminal::None;
                        break;
                    case 2:
                        if (token().kind == TokenKind::StartObj) {
                            if (!object(Scope::Usage))
                                return false;
                            consumed = true;
                        }
                        break;
                    case 3:
                    case 4:
                        if (token().kind != TokenKind::Null && token().kind != TokenKind::Bool)
                            return false;
                        if (token().kind == TokenKind::Bool && token().bval)
                            result_.state_policy_violation = true;
                        break;
                    case 5:
                    case 6:
                        if (token().kind != TokenKind::Null &&
                            !(token().kind == TokenKind::Text && token().view.empty()))
                            result_.state_policy_violation = true;
                        break;
                    case 7:
                        if (token().kind == TokenKind::StartObj) {
                            if (!object(Scope::Error))
                                return false;
                            consumed = true;
                        }
                        break;
                }
            } else if (field >= 0 && scope == Scope::Usage) {
                if (field == 0 || field == 1) {
                    if (!count(field == 0 ? input_tokens_ : output_tokens_))
                        return false;
                    consumed = true;
                } else if (token().kind == TokenKind::StartObj) {
                    if (!object(Scope::Details))
                        return false;
                    consumed = true;
                } else {
                    cache_seen_ = true;
                    result_.invalid_usage |= token().kind != TokenKind::Null;
                }
            } else if (field >= 0 && scope == Scope::Details) {
                cache_seen_ = true;
                if (!count(cache_tokens_))
                    return false;
                consumed = true;
            } else if (field >= 0 && scope == Scope::Error)
                error_code();
            if ((!consumed && !skip()) || !next())
                return false;
        }
        return true;
    }

    json::JsonParser parser_;
    ResponsesObservation result_;
    std::optional<std::int64_t> input_tokens_, output_tokens_, cache_tokens_;
    ResponsesTerminal status_ = ResponsesTerminal::None;
    ResponsesTerminal event_terminal_ = ResponsesTerminal::None;
    bool streaming_, type_seen_ = false, response_seen_ = false, object_valid_ = false;
    bool cache_seen_ = false, delta_nonempty_ = false;
};
} // namespace

ResponsesObservation observe_responses(std::string_view input, bool streaming) noexcept {
    return Observer(streaming).run(input);
}

std::string_view responses_terminal_error(ResponsesTerminal terminal) noexcept {
    switch (terminal) {
        case ResponsesTerminal::Completed:
            return {};
        case ResponsesTerminal::Failed:
            return "responses_failed";
        case ResponsesTerminal::Incomplete:
            return "responses_incomplete";
        case ResponsesTerminal::Error:
            return "responses_error";
        case ResponsesTerminal::None:
            return "upstream_missing_terminal_event";
    }
    std::unreachable();
}

ResponsesResult responses_result(ResponsesTerminal terminal) noexcept {
    switch (terminal) {
        case ResponsesTerminal::Completed:
            return ResponsesResult::Completed;
        case ResponsesTerminal::Failed:
            return ResponsesResult::Failed;
        case ResponsesTerminal::Incomplete:
            return ResponsesResult::Incomplete;
        case ResponsesTerminal::Error:
            return ResponsesResult::Error;
        case ResponsesTerminal::None:
            return ResponsesResult::Interrupted;
    }
    std::unreachable();
}

bool ResponsesStreamState::observe(const ResponsesObservation &observation, bool ended_by_delimiter) noexcept {
    if (observation.sequence_number && *observation.sequence_number > max_sequence)
        max_sequence = *observation.sequence_number;
    if (observation.state_policy_violation)
        failure = "upstream_state_policy_violation";
    else if (observation.invalid_json_or_shape || !ended_by_delimiter)
        failure = "upstream_invalid_response";
    else if (terminal != ResponsesTerminal::None &&
             ((observation.terminal != ResponsesTerminal::None && observation.terminal != terminal) ||
              observation.output_delta)) {
        failure = "upstream_invalid_response";
    }
    if (!failure.empty())
        return false;
    if (terminal == ResponsesTerminal::None && observation.terminal != ResponsesTerminal::None) {
        terminal = observation.terminal;
        error_kind = observation.error_kind;
        usage = observation.usage;
    }
    return true;
}

bool ResponsesStreamState::finish() noexcept {
    if (failure.empty() && terminal == ResponsesTerminal::None)
        failure = "upstream_missing_terminal_event";
    return failure.empty();
}

} // namespace fiber::ai_server
