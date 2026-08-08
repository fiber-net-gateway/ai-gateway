#ifndef FIBER_AI_SERVER_LLM_REQUEST_HANDLER_H
#define FIBER_AI_SERVER_LLM_REQUEST_HANDLER_H

#include "../config/LlmConfigSnapshot.h"
#include "../audit/LlmAuditHttpSender.h"
#include "../limit/TokenRateLimitCoordinator.h"
#include "../observability/AiServerMetrics.h"
#include "../protocol/LlmBody.h"
#include "../provider/ProviderHttpClient.h"
#include "../provider/ProviderRuntime.h"

#include <cstddef>
#include <memory>

#include <fiber/async/Task.h>

namespace fiber::http {
class HttpExchange;
}

namespace fiber::ai_server {

class AiServerCatRequest;

class LlmRequestHandler {
public:
    LlmRequestHandler(ProviderHttpClient &provider_client, ProviderRuntimeRegistry &provider_runtime,
                      TokenRateLimitCoordinator &rate_limiters, AiServerMetrics::Worker &metrics,
                      std::size_t audit_max_record_bytes, LlmAuditHttpSender *audit_http_sender = nullptr) noexcept :
        provider_client_(&provider_client), provider_runtime_(&provider_runtime), rate_limiters_(&rate_limiters),
        metrics_(&metrics), audit_max_record_bytes_(audit_max_record_bytes), audit_http_sender_(audit_http_sender) {}

    [[nodiscard]] async::Task<void> handle(http::HttpExchange &exchange, LlmWireProtocol protocol,
                                           std::shared_ptr<const LlmConfigSnapshot> config,
                                           AiServerCatRequest *cat_request = nullptr) noexcept;

private:
    ProviderHttpClient *provider_client_ = nullptr;
    ProviderRuntimeRegistry *provider_runtime_ = nullptr;
    TokenRateLimitCoordinator *rate_limiters_ = nullptr;
    AiServerMetrics::Worker *metrics_ = nullptr;
    std::size_t audit_max_record_bytes_ = 0;
    LlmAuditHttpSender *audit_http_sender_ = nullptr;
};

} // namespace fiber::ai_server

#endif // FIBER_AI_SERVER_LLM_REQUEST_HANDLER_H
