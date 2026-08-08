#ifndef FIBER_AI_SERVER_LLM_AUDIT_HTTP_SENDER_H
#define FIBER_AI_SERVER_LLM_AUDIT_HTTP_SENDER_H

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>

#include <common/NonCopyable.h>
#include <common/NonMovable.h>
#include <fiber/nacos/NamingService.h>

namespace fiber::ai_server {

struct LlmAuditDeliveryOptions {
    std::string instance_id;
    std::string ingest_token;
    std::size_t queue_capacity_bytes = 16 * 1024 * 1024;
    std::size_t batch_size = 100;
    std::size_t batch_max_bytes = 8 * 1024 * 1024;
    std::chrono::milliseconds flush_interval{250};
    std::chrono::milliseconds connect_timeout{2000};
    std::chrono::milliseconds request_timeout{10000};
};

struct LlmAuditDeliveryStats {
    std::uint64_t queued_records = 0;
    std::uint64_t delivered_records = 0;
    std::uint64_t dropped_records = 0;
    std::uint64_t retryable_failures = 0;
    std::uint64_t permanent_failures = 0;
    std::uint64_t queue_bytes = 0;
    std::uint64_t endpoint_count = 0;
};

class LlmAuditHttpSender final : public common::NonCopyable, public common::NonMovable {
public:
    explicit LlmAuditHttpSender(LlmAuditDeliveryOptions options);
    ~LlmAuditHttpSender();

    [[nodiscard]] bool start() noexcept;
    void shutdown() noexcept;

    [[nodiscard]] bool submit(std::string audit_json, std::int64_t occurred_at_millis) noexcept;
    void update_endpoints(const std::shared_ptr<const nacos::ServiceInfo> &service) noexcept;
    void clear_endpoints() noexcept;
    [[nodiscard]] LlmAuditDeliveryStats stats() const noexcept;

private:
    class Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace fiber::ai_server

#endif // FIBER_AI_SERVER_LLM_AUDIT_HTTP_SENDER_H
