#ifndef FIBER_AI_SERVER_PROVIDER_POOL_OPTIONS_H
#define FIBER_AI_SERVER_PROVIDER_POOL_OPTIONS_H

#include <chrono>
#include <cstddef>

namespace fiber::ai_server {

// Idle-connection limits for the provider HTTP/1 pool. The pool is sharded per
// worker event loop (connections are loop-affine) with cross-worker stealing,
// and these values apply to each shard directly: process-wide idle ceilings are
// bounded by these values times the worker count. A zero max_idle_total
// disables idle pooling.
struct ProviderPoolOptions {
    std::size_t max_idle_per_group = 100;
    std::size_t max_idle_total = 10000;
    std::chrono::milliseconds idle_timeout{30000};
};

} // namespace fiber::ai_server

#endif // FIBER_AI_SERVER_PROVIDER_POOL_OPTIONS_H
