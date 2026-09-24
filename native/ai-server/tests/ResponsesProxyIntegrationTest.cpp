#include "LlmProxyTestSupport.h"

namespace {
constexpr std::string_view kCompleted =
        R"({"id":"resp_sensitive","object":"response","status":"completed","store":false,"background":false,"output":[{"text":"response-sensitive-marker"}],"usage":{"input_tokens":2,"output_tokens":3}})";
RawHttpResponse responses(FixtureHarness &fixture, std::string_view body) {
    return post_json(fixture.entry_port(), issue_token(), body, {}, "/v1/responses");
}
TEST(ResponsesProxyIntegrationTest, ForcesStatelessAndMinimizesAudit) {
    FixtureHarness fixture({MockReply{.body = std::string(kCompleted)}});
    ASSERT_TRUE(fixture.valid());
    auto response = responses(
            fixture,
            R"({"model":"logical","input":"request-sensitive-marker","store":true,"background":true,"previous_response_id":"resp_old","conversation":"conv_old"})");
    ASSERT_EQ(response.status, 200);
    EXPECT_EQ(response.body, kCompleted);
    ASSERT_TRUE(fixture.wait_for_completed_entry_calls(1));
    const auto observed = fixture.observed();
    ASSERT_EQ(observed.size(), 1u);
    EXPECT_EQ(observed[0].path, "/provider/responses");
    EXPECT_NE(observed[0].body.find("upstream-responses-primary"), std::string::npos);
    EXPECT_NE(observed[0].body.find(R"("store":false,"background":false)"), std::string::npos);
    EXPECT_EQ(observed[0].body.find("resp_old"), std::string::npos);
    EXPECT_EQ(observed[0].body.find("conv_old"), std::string::npos);
    ASSERT_TRUE(fixture.wait_for_audit_records(1));
    const auto audit = fixture.audit_contents();
    EXPECT_NE(audit.find("openai-responses"), std::string::npos);
    for (auto secret:
         {"request-sensitive-marker", "response-sensitive-marker", "resp_sensitive", "resp_old", "conv_old"})
        EXPECT_EQ(audit.find(secret), std::string::npos);
    auto metrics = fixture.settlement_metrics();
    ASSERT_TRUE(metrics);
    EXPECT_NE(metrics->find("result=\"completed\"} 1"), std::string::npos);
}
TEST(ResponsesProxyIntegrationTest, RejectsReferenceOnlyInputBeforeProvider) {
    FixtureHarness fixture({});
    ASSERT_TRUE(fixture.valid());
    auto response =
            responses(fixture, R"({"model":"logical","input":[{"type":"item_reference","id":"private-item"}]})");
    EXPECT_EQ(response.status, 400);
    EXPECT_TRUE(fixture.observed().empty());
    EXPECT_NE(response.body.find("stateful_input_reference_unsupported"), std::string::npos);
    EXPECT_EQ(response.body.find("private-item"), std::string::npos);
}
TEST(ResponsesProxyIntegrationTest, Http200ModelFailureIsAuditedAsFailureWithoutRetry) {
    FixtureHarness fixture({MockReply{
            .body = R"({"object":"response","status":"failed","error":{"code":"server_error","message":"provider-private-error"},"usage":{"input_tokens":2,"output_tokens":1}})"}});
    ASSERT_TRUE(fixture.valid());
    auto response = responses(fixture, R"({"model":"logical","input":"hello"})");
    EXPECT_EQ(response.status, 200);
    ASSERT_TRUE(fixture.wait_for_completed_entry_calls(1));
    EXPECT_EQ(fixture.observed().size(), 1u);
    ASSERT_TRUE(fixture.wait_for_audit_records(1));
    auto audit = fixture.audit_contents();
    EXPECT_NE(audit.find("responses_failed"), std::string::npos);
    EXPECT_EQ(audit.find("provider-private-error"), std::string::npos);
    auto metrics = fixture.settlement_metrics();
    ASSERT_TRUE(metrics);
    EXPECT_NE(metrics->find("result=\"failed\"} 1"), std::string::npos);
}
TEST(ResponsesProxyIntegrationTest, RejectsStatefulProviderResponse) {
    FixtureHarness fixture({MockReply{
            .body = R"({"object":"response","status":"completed","store":true,"output":[{"text":"private-output"}]})"}});
    ASSERT_TRUE(fixture.valid());
    auto response = responses(fixture, R"({"model":"logical","input":"hello"})");
    EXPECT_EQ(response.status, 502);
    EXPECT_NE(response.body.find("upstream_state_policy_violation"), std::string::npos);
    EXPECT_EQ(response.body.find("private-output"), std::string::npos);
    EXPECT_EQ(fixture.observed().size(), 1u);
}
TEST(ResponsesProxyIntegrationTest, StreamsOriginalEventsAndTerminalUsage) {
    const std::string delta =
            "event: response.output_text.delta\ndata: "
            "{\"type\":\"response.output_text.delta\",\"sequence_number\":4,\"delta\":\"stream-private\"}\n\n";
    const std::string terminal =
            "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":5,\"response\":" +
            std::string(kCompleted) + "}\n\n";
    FixtureHarness fixture({MockReply{.content_type = "text/event-stream",
                                      .chunks = {delta.substr(0, 9), delta.substr(9), terminal},
                                      .stream = true}});
    ASSERT_TRUE(fixture.valid());
    auto response = responses(fixture, R"({"model":"logical","input":"hello","stream":true})");
    EXPECT_EQ(response.status, 200);
    EXPECT_TRUE(response.complete);
    EXPECT_EQ(response.body, delta + terminal);
    ASSERT_TRUE(fixture.wait_for_audit_records(1));
    EXPECT_EQ(fixture.audit_contents().find("stream-private"), std::string::npos);
}
TEST(ResponsesProxyIntegrationTest, IgnoresChatCompletionsDoneSentinelAfterTerminalEvent) {
    const std::string terminal =
            "event: response.completed\ndata: {\"type\":\"response.completed\",\"sequence_number\":5,\"response\":" +
            std::string(kCompleted) + "}\n\n";
    FixtureHarness fixture({MockReply{.content_type = "text/event-stream",
                                      .chunks = {terminal, "data: [DONE]\n\n"},
                                      .stream = true}});
    ASSERT_TRUE(fixture.valid());
    auto response = responses(fixture, R"({"model":"logical","input":"hello","stream":true})");
    EXPECT_EQ(response.status, 200);
    EXPECT_TRUE(response.complete);
    EXPECT_EQ(response.body, terminal + "data: [DONE]\n\n");
    ASSERT_TRUE(fixture.wait_for_audit_records(1));
    EXPECT_EQ(fixture.audit_contents().find("upstream_invalid_response"), std::string::npos);
    auto metrics = fixture.settlement_metrics();
    ASSERT_TRUE(metrics);
    EXPECT_NE(metrics->find("result=\"completed\"} 1"), std::string::npos);
}
TEST(ResponsesProxyIntegrationTest, MissingTerminalGetsResponsesErrorAtBoundary) {
    FixtureHarness fixture({MockReply{
            .content_type = "text/event-stream",
            .chunks = {"data: {\"type\":\"response.output_text.delta\",\"sequence_number\":9,\"delta\":\"x\"}\n\n"},
            .stream = true}});
    ASSERT_TRUE(fixture.valid());
    auto response = responses(fixture, R"({"model":"logical","input":"hello","stream":true})");
    EXPECT_EQ(response.status, 200);
    EXPECT_NE(response.body.find("upstream_missing_terminal_event"), std::string::npos);
    EXPECT_NE(response.body.find("\"sequence_number\":10"), std::string::npos);
    EXPECT_EQ(response.body.find("[DONE]"), std::string::npos);
    EXPECT_EQ(fixture.observed().size(), 1u);
}
TEST(ResponsesProxyIntegrationTest, PartialEventAbortsWithoutAppendingCorruptJson) {
    const std::string partial = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"partial";
    FixtureHarness fixture({MockReply{.content_type = "text/event-stream",
                                      .chunks = {partial},
                                      .stream = true,
                                      .abort_after_chunks = true,
                                      .pause_after_chunks = 1}});
    ASSERT_TRUE(fixture.valid());
    int client = open_json_request(fixture.entry_port(), issue_token(),
                                   R"({"model":"logical","input":"hello","stream":true})", "/v1/responses");
    ASSERT_GE(client, 0);
    ASSERT_TRUE(fixture.wait_for_provider_pause());
    std::string received;
    ASSERT_TRUE(wait_for_socket_text(client, partial, received));
    fixture.release_provider();
    ASSERT_TRUE(fixture.wait_for_completed_entry_calls(1));
    std::array<char, 1024> tail{};
    for (;;) {
        auto n = ::recv(client, tail.data(), tail.size(), 0);
        if (n <= 0)
            break;
        received.append(tail.data(), static_cast<std::size_t>(n));
    }
    reset_http_client(client);
    EXPECT_EQ(received.find("event: error"), std::string::npos);
    EXPECT_EQ(received.find("0\r\n\r\n"), std::string::npos);
    ASSERT_TRUE(fixture.wait_for_audit_records(1));
    EXPECT_NE(fixture.audit_contents().find("\"client_aborted\":false"), std::string::npos);
}
TEST(ResponsesProxyIntegrationTest, DrainsTerminalUsageAfterClientDisconnect) {
    const std::string first = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"x\"}\n\n";
    const std::string final =
            "data: {\"type\":\"response.completed\",\"response\":" + std::string(kCompleted) + "}\n\n";
    FixtureHarness fixture({MockReply{
            .content_type = "text/event-stream", .chunks = {first, final}, .stream = true, .pause_after_chunks = 1}});
    ASSERT_TRUE(fixture.valid());
    int client = open_json_request(fixture.entry_port(), issue_token(),
                                   R"({"model":"logical","input":"hello","stream":true})", "/v1/responses");
    ASSERT_GE(client, 0);
    ASSERT_TRUE(fixture.wait_for_provider_pause());
    std::string received;
    ASSERT_TRUE(wait_for_socket_text(client, first, received));
    reset_http_client(client);
    std::this_thread::sleep_for(20ms);
    fixture.release_provider();
    ASSERT_TRUE(fixture.wait_for_completed_entry_calls(1));
    ASSERT_TRUE(fixture.wait_for_audit_records(1));
    auto metrics = fixture.settlement_metrics();
    ASSERT_TRUE(metrics);
    EXPECT_NE(metrics->find("ai_server_rate_limit_settlements_total{result=\"usage\"} 1"), std::string::npos);
    EXPECT_NE(metrics->find("ai_server_user_token_usage_total{username=\"alice\",token_type=\"out\"} 3"),
              std::string::npos);
    EXPECT_NE(metrics->find("result=\"aborted\"} 1"), std::string::npos);
    EXPECT_EQ(fixture.observed().size(), 1u);
}
TEST(ResponsesProxyIntegrationTest, RetryUsesOriginalBodyAndOnlyFinalResult) {
    FixtureHarness fixture({MockReply{.status = 401, .body = R"({"error":{"code":"invalid_api_key"}})"},
                            MockReply{.body = std::string(kCompleted)}});
    ASSERT_TRUE(fixture.valid());
    auto response = responses(
            fixture,
            R"({"model":"logical","input":[{"type":"function_call_output","call_id":"call_1","output":"tool-private"}],"store":true})");
    EXPECT_EQ(response.status, 200);
    ASSERT_TRUE(fixture.wait_for_completed_entry_calls(1));
    auto requests = fixture.observed();
    ASSERT_EQ(requests.size(), 2u);
    EXPECT_EQ(requests[0].body, requests[1].body);
    EXPECT_NE(requests[1].body.find("call_1"), std::string::npos);
    auto metrics = fixture.settlement_metrics();
    ASSERT_TRUE(metrics);
    EXPECT_NE(metrics->find("result=\"completed\"} 1"), std::string::npos);
}
} // namespace
