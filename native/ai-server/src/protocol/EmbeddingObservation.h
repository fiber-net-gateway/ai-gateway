#ifndef FIBER_AI_SERVER_EMBEDDING_OBSERVATION_H
#define FIBER_AI_SERVER_EMBEDDING_OBSERVATION_H

#include "TokenUsage.h"

namespace fiber::ai_server {

struct EmbeddingObservation {
    std::optional<LlmTokenUsage> usage;
    bool invalid_response = false;
};

// Scans the original response without retaining vectors or constructing a JSON DOM.
[[nodiscard]] EmbeddingObservation observe_embedding(std::string_view input,
                                                     const EmbeddingRequestInfo &request) noexcept;

} // namespace fiber::ai_server
#endif
