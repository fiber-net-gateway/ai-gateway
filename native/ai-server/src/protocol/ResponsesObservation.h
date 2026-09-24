#ifndef FIBER_AI_SERVER_RESPONSES_OBSERVATION_H
#define FIBER_AI_SERVER_RESPONSES_OBSERVATION_H

#include "TokenUsage.h"

namespace fiber::ai_server {

enum class ResponsesTerminal : std::uint8_t { None, Completed, Failed, Incomplete, Error };
enum class ResponsesErrorKind : std::uint8_t { Unknown, Authentication, RateLimit, Server };
enum class ResponsesResult : std::uint8_t {
    Completed,
    Failed,
    Incomplete,
    Error,
    Interrupted,
    InvalidResponse,
    Aborted,
    Count
};

struct ResponsesObservation {
    std::optional<LlmTokenUsage> usage;
    ResponsesTerminal terminal = ResponsesTerminal::None;
    ResponsesErrorKind error_kind = ResponsesErrorKind::Unknown;
    std::optional<std::int64_t> sequence_number;
    bool output_token_observed = false;
    bool output_delta = false;
    bool invalid_json_or_shape = false;
    bool state_policy_violation = false;
    bool invalid_usage = false;
};

[[nodiscard]] ResponsesObservation observe_responses(std::string_view input, bool streaming) noexcept;
[[nodiscard]] std::string_view responses_terminal_error(ResponsesTerminal terminal) noexcept;
[[nodiscard]] ResponsesResult responses_result(ResponsesTerminal terminal) noexcept;

// Fixed-size state: no output, identifiers or Provider error text is retained.
struct ResponsesStreamState {
    ResponsesTerminal terminal = ResponsesTerminal::None;
    ResponsesErrorKind error_kind = ResponsesErrorKind::Unknown;
    std::optional<LlmTokenUsage> usage;
    std::int64_t max_sequence = -1;
    std::string_view failure;

    [[nodiscard]] bool observe(const ResponsesObservation &observation, bool ended_by_delimiter) noexcept;
    [[nodiscard]] bool finish() noexcept;
};

} // namespace fiber::ai_server
#endif
