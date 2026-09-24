#ifndef FIBER_AI_SERVER_MODEL_AUTHORIZATION_H
#define FIBER_AI_SERVER_MODEL_AUTHORIZATION_H

#include "../config/LlmConfigSnapshot.h"

#include <cstdint>
#include <expected>
#include <string_view>

namespace fiber::cat {
class Transaction;
}

namespace fiber::ai_server {

enum class ModelAuthorizationErrorCode : std::uint8_t {
    ModelRequired,
    InvalidModelName,
    ModelConfigUnavailable,
    ModelNotAvailable,
};

struct ModelAuthorizationError {
    ModelAuthorizationErrorCode code = ModelAuthorizationErrorCode::ModelRequired;
    const char *message = nullptr;
};

struct AuthorizedModel {
    std::string_view model_name;
    const CompiledModelRoute *route = nullptr;
};

[[nodiscard]] bool valid_llm_model_name(std::string_view name) noexcept;

// Shared visibility predicate: a model with no allow-user-groups is visible to every
// authenticated user; otherwise the user must belong to one of the groups. Must stay in
// lockstep with authorize_model so model listing and model calls agree on access.
[[nodiscard]] const UserGroupSnapshot *find_allowed_user_group(const CompiledModelRoute &route,
                                                               std::string_view username) noexcept;

[[nodiscard]] bool model_visible_to_user(const CompiledModelRoute &route, std::string_view username) noexcept;

[[nodiscard]] std::expected<AuthorizedModel, ModelAuthorizationError>
authorize_model(const LlmConfigSnapshot &config, std::string_view username, std::string_view requested_model,
                cat::Transaction *cat_transaction = nullptr) noexcept;

} // namespace fiber::ai_server

#endif // FIBER_AI_SERVER_MODEL_AUTHORIZATION_H
