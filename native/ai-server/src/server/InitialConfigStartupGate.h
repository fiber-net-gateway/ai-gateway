#ifndef FIBER_AI_SERVER_INITIAL_CONFIG_STARTUP_GATE_H
#define FIBER_AI_SERVER_INITIAL_CONFIG_STARTUP_GATE_H

#include "../config/LlmConfigManager.h"

#include <chrono>
#include <cstdint>
#include <memory>

#include <fiber/async/Task.h>

namespace fiber::ai_server {

enum class InitialConfigGateStatus : std::uint8_t {
    Installed,
    Rejected,
    Unavailable,
    TimedOut,
};

struct InitialConfigGateResult {
    InitialConfigGateStatus status = InitialConfigGateStatus::Unavailable;
    std::shared_ptr<const LlmConfigFailure> failure;
};

[[nodiscard]] async::Task<InitialConfigGateResult>
wait_for_initial_config(async::Task<bool> worker_install,
                        LlmConfigManager::InitialRejectionSubscriber initial_rejection,
                        std::chrono::milliseconds timeout) noexcept;

} // namespace fiber::ai_server

#endif // FIBER_AI_SERVER_INITIAL_CONFIG_STARTUP_GATE_H
