#ifndef FIBER_AI_SERVER_MODEL_LISTING_HANDLER_H
#define FIBER_AI_SERVER_MODEL_LISTING_HANDLER_H

#include "../config/LlmConfigSnapshot.h"

#include <memory>
#include <string_view>

#include <fiber/async/Task.h>

namespace fiber::http {
class HttpExchange;
}

namespace fiber::ai_server {

class AiServerCatRequest;

// Serves the OpenAI-compatible model directory from the active configuration snapshot.
// No provider traffic: the listed models are exactly the gateway's configured routes the
// authenticated user is allowed to call. model_id selects single-model retrieval; an empty
// model_id lists every visible model.
class ModelListingHandler {
public:
    [[nodiscard]] async::Task<void> handle(http::HttpExchange &exchange,
                                           std::shared_ptr<const LlmConfigSnapshot> config,
                                           AiServerCatRequest *cat_request, std::string_view model_id) noexcept;
};

} // namespace fiber::ai_server

#endif // FIBER_AI_SERVER_MODEL_LISTING_HANDLER_H
