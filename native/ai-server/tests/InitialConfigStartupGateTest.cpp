#include <gtest/gtest.h>

#include <chrono>
#include <string>
#include <utility>

#include <fiber/async/Spawn.h>
#include <fiber/async/Task.h>
#include <fiber/async/Watch.h>
#include <fiber/event/EventLoop.h>
#include <fiber/event/EventLoopGroup.h>

#include "config/LlmConfigManager.h"
#include "server/InitialConfigStartupGate.h"

namespace {

fiber::ai_server::LlmConfigFailure make_failure(std::string md5 = "invalid-md5") {
    return fiber::ai_server::LlmConfigFailure{
            .data_id = std::string(fiber::ai_server::kModelsDataId),
            .md5 = std::move(md5),
            .error =
                    {
                            .code = fiber::ai_server::LlmConfigErrorCode::InvalidJson,
                            .message = "invalid JSON",
                    },
    };
}

fiber::async::Task<bool> wait_for_worker(fiber::async::Watch<bool>::Subscriber worker) noexcept {
    auto snapshot = worker.current();
    while (!snapshot.value) {
        snapshot = co_await worker.next(snapshot.version);
    }
    co_return *snapshot.value;
}

TEST(InitialConfigStartupGateTest, ReturnsPreexistingRejectionWithoutStartingWorkers) {
    fiber::event::EventLoop loop;
    fiber::async::Watch<bool> worker;
    fiber::async::Watch<fiber::ai_server::LlmConfigFailure> rejection;
    auto rejection_publisher = rejection.acquire_publisher();
    ASSERT_TRUE(rejection_publisher);
    rejection_publisher->publish(make_failure());
    bool completed = false;

    fiber::async::spawn(loop, [&]() -> fiber::async::DetachedTask {
        auto result = co_await fiber::ai_server::wait_for_initial_config(
                wait_for_worker(worker.subscribe()), rejection.subscribe(), std::chrono::seconds(30));
        EXPECT_EQ(result.status, fiber::ai_server::InitialConfigGateStatus::Rejected);
        EXPECT_NE(result.failure, nullptr);
        if (result.failure) {
            EXPECT_EQ(result.failure->md5, "invalid-md5");
        }
        completed = true;
        loop.stop();
    });

    loop.run();
    EXPECT_TRUE(completed);
}

TEST(InitialConfigStartupGateTest, ReturnsInstalledAndUnavailableWorkerResults) {
    fiber::event::EventLoop loop;
    fiber::async::Watch<bool> worker;
    auto worker_publisher = worker.acquire_publisher();
    ASSERT_TRUE(worker_publisher);
    fiber::async::Watch<fiber::ai_server::LlmConfigFailure> rejection;
    bool completed = false;

    fiber::async::spawn(loop, [&]() -> fiber::async::DetachedTask {
        worker_publisher->publish(true);
        auto installed = co_await fiber::ai_server::wait_for_initial_config(
                wait_for_worker(worker.subscribe()), rejection.subscribe(), std::chrono::seconds(30));
        EXPECT_EQ(installed.status, fiber::ai_server::InitialConfigGateStatus::Installed);

        worker_publisher->publish(false);
        auto unavailable = co_await fiber::ai_server::wait_for_initial_config(
                wait_for_worker(worker.subscribe()), rejection.subscribe(), std::chrono::seconds(30));
        EXPECT_EQ(unavailable.status, fiber::ai_server::InitialConfigGateStatus::Unavailable);
        completed = true;
        loop.stop();
    });

    loop.run();
    EXPECT_TRUE(completed);
}

TEST(InitialConfigStartupGateTest, TimesOutWhileConfigurationRemainsPending) {
    fiber::event::EventLoop loop;
    fiber::async::Watch<bool> worker;
    fiber::async::Watch<fiber::ai_server::LlmConfigFailure> rejection;
    bool completed = false;

    fiber::async::spawn(loop, [&]() -> fiber::async::DetachedTask {
        auto result = co_await fiber::ai_server::wait_for_initial_config(
                wait_for_worker(worker.subscribe()), rejection.subscribe(), std::chrono::milliseconds(1));
        EXPECT_EQ(result.status, fiber::ai_server::InitialConfigGateStatus::TimedOut);
        completed = true;
        loop.stop();
    });

    loop.run();
    EXPECT_TRUE(completed);
}

TEST(InitialConfigStartupGateTest, CrossLoopRejectionWakesAnInfiniteStartupWait) {
    fiber::event::EventLoop accept_loop;
    fiber::event::EventLoopGroup nacos_group(1);
    nacos_group.start();
    fiber::async::Watch<bool> worker;
    fiber::async::Watch<fiber::ai_server::LlmConfigFailure> rejection;
    auto rejection_publisher = rejection.acquire_publisher();
    ASSERT_TRUE(rejection_publisher);
    bool completed = false;

    fiber::async::spawn(accept_loop, [&]() -> fiber::async::DetachedTask {
        auto result = co_await fiber::ai_server::wait_for_initial_config(
                wait_for_worker(worker.subscribe()), rejection.subscribe(), std::chrono::milliseconds::zero());
        EXPECT_EQ(result.status, fiber::ai_server::InitialConfigGateStatus::Rejected);
        EXPECT_NE(result.failure, nullptr);
        if (result.failure) {
            EXPECT_EQ(result.failure->md5, "cross-loop");
        }
        completed = true;
        accept_loop.stop();
    });
    fiber::async::spawn(nacos_group.at(0),
                        [publisher = std::move(*rejection_publisher)]() mutable -> fiber::async::DetachedTask {
                            publisher.publish(make_failure("cross-loop"));
                            co_return;
                        });

    accept_loop.run();
    nacos_group.stop();
    nacos_group.join();
    EXPECT_TRUE(completed);
}

} // namespace
