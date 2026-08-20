#include "InitialConfigStartupGate.h"

#include <utility>

#include <fiber/async/Sleep.h>
#include <fiber/async/TaskSelect.h>
#include <fiber/async/WhenAny.h>
#include <fiber/common/Assert.h>

namespace fiber::ai_server {
namespace {

async::Task<InitialConfigGateResult>
wait_for_install_or_rejection(async::Task<bool> worker_install,
                              LlmConfigManager::InitialRejectionSubscriber initial_rejection) noexcept {
    auto rejection = initial_rejection.current();
    if (rejection.value) {
        co_return InitialConfigGateResult{
                .status = InitialConfigGateStatus::Rejected,
                .failure = std::move(rejection.value),
        };
    }

    auto installed_or_rejected = co_await async::when_any(
            [&worker_install]() { return std::move(worker_install).select(); },
            [&initial_rejection, version = rejection.version]() { return initial_rejection.next(version); });
    if (installed_or_rejected.is<0>()) {
        const bool installed = std::move(installed_or_rejected).get<0>();
        co_return InitialConfigGateResult{
                .status = installed ? InitialConfigGateStatus::Installed : InitialConfigGateStatus::Unavailable,
        };
    }

    auto rejected = std::move(installed_or_rejected).get<1>();
    FIBER_ASSERT(rejected.value != nullptr);
    co_return InitialConfigGateResult{
            .status = InitialConfigGateStatus::Rejected,
            .failure = std::move(rejected.value),
    };
}

} // namespace

async::Task<InitialConfigGateResult>
wait_for_initial_config(async::Task<bool> worker_install,
                        LlmConfigManager::InitialRejectionSubscriber initial_rejection,
                        std::chrono::milliseconds timeout) noexcept {
    auto install_or_rejection = wait_for_install_or_rejection(std::move(worker_install), std::move(initial_rejection));
    if (timeout <= std::chrono::milliseconds::zero()) {
        co_return co_await install_or_rejection;
    }

    auto result =
            co_await async::when_any([&install_or_rejection]() { return std::move(install_or_rejection).select(); },
                                     [timeout]() { return async::sleep(timeout); });
    if (result.is<0>()) {
        co_return std::move(result).get<0>();
    }
    result.get<1>();
    co_return InitialConfigGateResult{.status = InitialConfigGateStatus::TimedOut};
}

} // namespace fiber::ai_server
