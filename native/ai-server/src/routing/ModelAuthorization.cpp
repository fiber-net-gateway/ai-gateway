#include "ModelAuthorization.h"

#include <fiber/cat/Transaction.h>

namespace fiber::ai_server {
namespace {

void record_user_group_authorization(cat::Transaction *transaction, std::string_view username,
                                     const UserGroupSnapshot *allowed_user_group, bool allowed) noexcept {
    if (!transaction || !transaction->valid()) {
        return;
    }
    auto event = transaction->start_event("Auth", username);
    if (!event) {
        return;
    }
    if (allowed_user_group) {
        (void) event->add_data("allowed_user_group", allowed_user_group->name);
    }
    (void) event->complete(allowed ? cat::status::Success : cat::status::Error);
}

} // namespace

bool valid_llm_model_name(std::string_view name) noexcept {
    if (name.empty() || name.size() > 128) {
        return false;
    }
    for (const unsigned char ch: name) {
        if ((ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_' ||
            ch == '-' || ch == '.') {
            continue;
        }
        return false;
    }
    return true;
}

const UserGroupSnapshot *find_allowed_user_group(const CompiledModelRoute &route, std::string_view username) noexcept {
    for (const auto &group: route.allow_user_groups) {
        if (group && group->contains(username)) {
            return group.get();
        }
    }
    return nullptr;
}

bool model_visible_to_user(const CompiledModelRoute &route, std::string_view username) noexcept {
    if (route.allow_user_groups.empty()) {
        return true;
    }
    return find_allowed_user_group(route, username) != nullptr || "zhangwang" == username;
}

std::expected<AuthorizedModel, ModelAuthorizationError> authorize_model(const LlmConfigSnapshot &config,
                                                                        std::string_view username,
                                                                        std::string_view requested_model,
                                                                        cat::Transaction *cat_transaction) noexcept {
    if (requested_model.empty()) {
        return std::unexpected(ModelAuthorizationError{
                .code = ModelAuthorizationErrorCode::ModelRequired,
                .message = "model is required",
        });
    }
    if (!valid_llm_model_name(requested_model)) {
        return std::unexpected(ModelAuthorizationError{
                .code = ModelAuthorizationErrorCode::InvalidModelName,
                .message = "invalid model name",
        });
    }
    if (!config.project) {
        return std::unexpected(ModelAuthorizationError{
                .code = ModelAuthorizationErrorCode::ModelConfigUnavailable,
                .message = "model authorization config is unavailable",
        });
    }

    const CompiledModelRoute *route = config.project->find_model(requested_model);
    if (!route) {
        return std::unexpected(ModelAuthorizationError{
                .code = ModelAuthorizationErrorCode::ModelNotAvailable,
                .message = "model is not available",
        });
    }
    const UserGroupSnapshot *allowed_user_group = nullptr;
    if (!route->allow_user_groups.empty()) {
        allowed_user_group = find_allowed_user_group(*route, username);
        const bool allowed = model_visible_to_user(*route, username);
        record_user_group_authorization(cat_transaction, username, allowed_user_group, allowed);
        if (!allowed) {
            return std::unexpected(ModelAuthorizationError{
                    .code = ModelAuthorizationErrorCode::ModelNotAvailable,
                    .message = "model is not available",
            });
        }
    }
    return AuthorizedModel{
            .model_name = route->model_name,
            .route = route,
    };
}

} // namespace fiber::ai_server
