#ifndef FIBER_AI_SERVER_TESTS_FAKE_NACOS_SERVICES_H
#define FIBER_AI_SERVER_TESTS_FAKE_NACOS_SERVICES_H

#include <gtest/gtest.h>

#include <map>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>

#include <fiber/async/Task.h>
#include <fiber/common/IoError.h>
#include <fiber/nacos/ConfigService.h>
#include <fiber/nacos/NamingService.h>
#include <fiber/nacos/Subscription.h>

#include "../../../tests/NacosSnapshotTestBuilder.h"
#include "../../../tests/NacosSubscriptionStub.h"
#include "config/LlmConfigSnapshot.h"

namespace fiber::tests {

// In-memory ConfigService/NamingService fakes: Data IDs and services publish only through
// push() on the loop that owns the LlmConfigManager, matching the Watch threading contract.
class FakeConfigService final : public fiber::nacos::ConfigService {
public:
    using Result = fiber::nacos::SubscriptionResult<fiber::nacos::ConfigData>;

    fiber::common::IoResult<void> start() noexcept override { return {}; }

    fiber::async::Task<void> shutdown() noexcept override { co_return; }

    StatusSubscriber subscribe_status() override { return status_.subscribe(); }

    fiber::async::Task<std::expected<std::shared_ptr<const fiber::nacos::ConfigData>, fiber::nacos::ConfigServiceError>>
    get_config(std::string, std::string) noexcept override {
        co_return fiber::tests::make_config_data(fiber::nacos::ConfigState::NotFound);
    }

    fiber::async::Task<std::expected<void, fiber::nacos::ConfigServiceError>>
    publish(std::string, std::string, std::string, fiber::nacos::ConfigType,
            std::optional<std::string>) noexcept override {
        co_return std::expected<void, fiber::nacos::ConfigServiceError>{};
    }

    fiber::async::Task<std::expected<void, fiber::nacos::ConfigServiceError>>
    remove_config(std::string, std::string) noexcept override {
        co_return std::expected<void, fiber::nacos::ConfigServiceError>{};
    }

    std::expected<fiber::nacos::Subscription<fiber::nacos::ConfigData>, fiber::nacos::ConfigServiceError>
    subscribe(std::string_view data_id, std::string_view group,
              fiber::nacos::Subscription<fiber::nacos::ConfigData>::NotifyCallback on_notify, void *ctx) override {
        const std::string key = make_key(data_id, group);
        auto [it, inserted] = entries_.try_emplace(key, std::make_unique<Entry>());
        (void) inserted;
        return it->second->subscriptions.subscribe(on_notify, ctx);
    }

    void push(std::string_view data_id, std::string content, std::string md5) {
        const auto it = entries_.find(make_key(data_id, fiber::ai_server::kLlmConfigGroup));
        ASSERT_NE(it, entries_.end());
        it->second->subscriptions.publish(Result{
                .kind = fiber::nacos::ResultKind::Success,
                .data = fiber::tests::make_config_data(fiber::nacos::ConfigState::Present, std::move(md5),
                                                       std::move(content)),
        });
    }

    void push_not_found(std::string_view data_id) {
        const auto it = entries_.find(make_key(data_id, fiber::ai_server::kLlmConfigGroup));
        ASSERT_NE(it, entries_.end());
        it->second->subscriptions.publish(Result{
                .kind = fiber::nacos::ResultKind::Success,
                .data = fiber::tests::make_config_data(fiber::nacos::ConfigState::NotFound),
        });
    }

private:
    struct Entry {
        fiber::tests::NacosSubscriptionStub<fiber::nacos::ConfigData> subscriptions;
    };

    static std::string make_key(std::string_view data_id, std::string_view group) {
        std::string key(data_id);
        key.push_back('\n');
        key.append(group);
        return key;
    }

    fiber::async::Watch<fiber::nacos::ConfigServiceStatus> status_{fiber::nacos::ConfigServiceStatus{}};
    std::map<std::string, std::unique_ptr<Entry>, std::less<>> entries_;
};

class FakeNamingService final : public fiber::nacos::NamingService {
public:
    using Result = fiber::nacos::SubscriptionResult<fiber::nacos::ServiceInfo>;

    fiber::common::IoResult<void> start() noexcept override { return {}; }

    fiber::async::Task<void> shutdown() noexcept override { co_return; }

    StatusSubscriber subscribe_status() override { return status_.subscribe(); }

    fiber::async::Task<
            std::expected<std::shared_ptr<const fiber::nacos::ServiceInfo>, fiber::nacos::NamingServiceError>>
    get(std::string, std::string) noexcept override {
        co_return std::unexpected(fiber::nacos::NamingServiceError{
                .code = fiber::nacos::NamingServiceErrorCode::Server,
                .message = "not implemented by fake naming service",
        });
    }

    std::expected<fiber::nacos::Subscription<fiber::nacos::ServiceInfo>, fiber::nacos::NamingServiceError>
    subscribe(std::string_view service_name, std::string_view group,
              fiber::nacos::Subscription<fiber::nacos::ServiceInfo>::NotifyCallback on_notify, void *ctx) override {
        const std::string key = make_key(service_name, group);
        auto [it, inserted] = entries_.try_emplace(key, std::make_unique<Entry>());
        (void) inserted;
        return it->second->subscriptions.subscribe(on_notify, ctx);
    }

    std::expected<fiber::nacos::InstanceRegistration, fiber::nacos::NamingServiceError>
    registry(std::string_view, std::string_view, fiber::nacos::Instance) override {
        return std::unexpected(fiber::nacos::NamingServiceError{
                .code = fiber::nacos::NamingServiceErrorCode::Server,
                .message = "not implemented by fake naming service",
        });
    }

    void push(std::string_view service_name, fiber::tests::ServiceInfoTestData info) {
        const auto it = entries_.find(make_key(service_name, fiber::ai_server::kDefaultNamingGroup));
        ASSERT_NE(it, entries_.end());
        it->second->subscriptions.publish(Result{
                .kind = fiber::nacos::ResultKind::Success,
                .data = fiber::tests::make_service_info(std::move(info)),
        });
    }

private:
    struct Entry {
        fiber::tests::NacosSubscriptionStub<fiber::nacos::ServiceInfo> subscriptions;
    };

    static std::string make_key(std::string_view service_name, std::string_view group) {
        std::string key(service_name);
        key.push_back('\n');
        key.append(group);
        return key;
    }

    fiber::async::Watch<fiber::nacos::NamingServiceStatus> status_{fiber::nacos::NamingServiceStatus{}};
    std::map<std::string, std::unique_ptr<Entry>, std::less<>> entries_;
};

} // namespace fiber::tests

#endif // FIBER_AI_SERVER_TESTS_FAKE_NACOS_SERVICES_H
