#ifndef FIBER_AI_SERVER_LOOP_TEST_SUPPORT_H
#define FIBER_AI_SERVER_LOOP_TEST_SUPPORT_H

#include <utility>

#include <fiber/async/Spawn.h>
#include <fiber/event/EventLoop.h>

namespace fiber::ai_server::test {

// Runs a synchronous test body inside a running EventLoop, so IoBufChain node
// allocation/release — which resolves the CURRENT thread's loop per operation —
// has a loop to resolve. ASSERT_* inside `body` only returns from the lambda;
// the loop still stops. Chains created in the body must be destroyed before it
// returns: after run_in_loop() the thread has no current loop again.
template<typename F>
void run_in_loop(F &&body) {
    fiber::event::EventLoop loop;
    fiber::async::spawn(loop, [&]() -> fiber::async::DetachedTask {
        body();
        loop.stop();
        co_return;
    });
    loop.run();
}

} // namespace fiber::ai_server::test

#endif // FIBER_AI_SERVER_LOOP_TEST_SUPPORT_H
