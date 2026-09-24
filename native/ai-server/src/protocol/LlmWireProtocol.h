#ifndef FIBER_AI_SERVER_LLM_WIRE_PROTOCOL_H
#define FIBER_AI_SERVER_LLM_WIRE_PROTOCOL_H

#include <cstddef>
#include <cstdint>
#include <string_view>
#include <utility>

namespace fiber::ai_server {

// These values participate in routing digests. Append; never reorder.
enum class LlmWireProtocol : std::uint8_t {
    OpenAiChatCompletions = 0,
    AnthropicMessages = 1,
    OpenAiResponses = 2,
    Count,
};

constexpr bool uses_openai_error_envelope(LlmWireProtocol protocol) noexcept {
    switch (protocol) {
        case LlmWireProtocol::OpenAiChatCompletions:
        case LlmWireProtocol::OpenAiResponses:
            return true;
        case LlmWireProtocol::AnthropicMessages:
            return false;
        case LlmWireProtocol::Count:
            std::unreachable();
    }
    std::unreachable();
}

constexpr std::string_view llm_protocol_name(LlmWireProtocol protocol) noexcept {
    switch (protocol) {
        case LlmWireProtocol::OpenAiChatCompletions:
            return "openai";
        case LlmWireProtocol::AnthropicMessages:
            return "anthropic";
        case LlmWireProtocol::OpenAiResponses:
            return "openai-responses";
        case LlmWireProtocol::Count:
            std::unreachable();
    }
    std::unreachable();
}

constexpr std::size_t llm_protocol_index(LlmWireProtocol protocol) noexcept {
    return static_cast<std::size_t>(protocol);
}

} // namespace fiber::ai_server
#endif
