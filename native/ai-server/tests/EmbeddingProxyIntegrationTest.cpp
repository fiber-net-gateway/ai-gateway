#include "LlmProxyTestSupport.h"

namespace {
constexpr std::string_view kEmbedding =
        R"({"object":"list","model":"upstream-embedding","data":[{"object":"embedding","index":0,"embedding":[0.123456789,0.25]}],"usage":{"prompt_tokens":7,"total_tokens":7}})";
RawHttpResponse embeddings(FixtureHarness &fixture, std::string_view body) {
    return post_json(fixture.entry_port(), issue_token(), body, {}, "/v1/embeddings");
}
TEST(EmbeddingProxyIntegrationTest, RewritesModelAndSettlesInputOnlyWithoutCapturingBodies) {
    FixtureHarness fixture({MockReply{.body = std::string(kEmbedding)}});
    ASSERT_TRUE(fixture.valid());
    const auto response = embeddings(
            fixture,
            R"({"model":"logical","input":"embedding-private-input","dimensions":2,"encoding_format":"float"})");
    ASSERT_EQ(response.status, 200);
    EXPECT_EQ(response.body, kEmbedding);
    ASSERT_TRUE(fixture.wait_for_completed_entry_calls(1));
    const auto requests = fixture.observed();
    ASSERT_EQ(requests.size(), 1u);
    EXPECT_EQ(requests[0].path, "/provider/embeddings");
    EXPECT_NE(requests[0].body.find("upstream-embedding"), std::string::npos);
    EXPECT_NE(requests[0].body.find("embedding-private-input"), std::string::npos);
    EXPECT_EQ(requests[0].body.find("\"stream\""), std::string::npos);
    ASSERT_TRUE(fixture.wait_for_audit_records(1));
    const auto audit = fixture.audit_contents();
    EXPECT_NE(audit.find("openai-embedding"), std::string::npos);
    EXPECT_EQ(audit.find("embedding-private-input"), std::string::npos);
    EXPECT_EQ(audit.find("0.123456789"), std::string::npos);
    const auto metrics = fixture.settlement_metrics();
    ASSERT_TRUE(metrics);
    EXPECT_NE(metrics->find("ai_server_rate_limit_settlements_total{result=\"usage\"} 1"), std::string::npos);
    EXPECT_NE(metrics->find("ai_server_user_token_usage_total{username=\"alice\",token_type=\"in_nocache\"} 7"),
              std::string::npos);
    EXPECT_NE(metrics->find("ai_server_embedding_usage_total{result=\"known\"} 1"), std::string::npos);
}
TEST(EmbeddingProxyIntegrationTest, RejectsMalformedRequestsBeforeCallingProvider) {
    FixtureHarness fixture({});
    ASSERT_TRUE(fixture.valid());
    for (auto input: {R"({"model":"logical","input":"private","stream":true})", R"({"model":"logical","input":[]})",
                      R"({"model":"logical","input":"a","input":"b"})"}) {
        const auto response = embeddings(fixture, input);
        EXPECT_EQ(response.status, 400);
        EXPECT_NE(response.body.find("\"param\":"), std::string::npos);
        EXPECT_EQ(response.body.find("private"), std::string::npos);
    }
    EXPECT_TRUE(fixture.observed().empty());
}
TEST(EmbeddingProxyIntegrationTest, RejectsInvalidSuccessWithoutRetryOrUsage) {
    FixtureHarness fixture({MockReply{
            .body = R"({"object":"list","model":"vendor","data":[{"object":"embedding","index":4,"embedding":[1,2]}],"usage":{"prompt_tokens":9,"total_tokens":9}})"}});
    ASSERT_TRUE(fixture.valid());
    auto response = embeddings(fixture, R"({"model":"logical","input":"hello"})");
    EXPECT_EQ(response.status, 502);
    EXPECT_NE(response.body.find("upstream_invalid_response"), std::string::npos);
    ASSERT_TRUE(fixture.wait_for_completed_entry_calls(1));
    EXPECT_EQ(fixture.observed().size(), 1u);
    const auto metrics = fixture.settlement_metrics();
    ASSERT_TRUE(metrics);
    EXPECT_NE(metrics->find("ai_server_rate_limit_settlements_total{result=\"no_usage\"} 1"), std::string::npos);
}
TEST(EmbeddingProxyIntegrationTest, PreservesBase64BatchAndUnknownUsage) {
    const std::string body =
            R"({"object":"list","model":"vendor","data":[{"object":"embedding","index":1,"embedding":"AACAPw=="},{"object":"embedding","index":0,"embedding":"AAAAAA=="}]})";
    FixtureHarness fixture({MockReply{.body = body}});
    ASSERT_TRUE(fixture.valid());
    const auto response =
            embeddings(fixture, R"({"model":"logical","input":[[1,2],[3]],"encoding_format":"base64","dimensions":1})");
    EXPECT_EQ(response.status, 200);
    EXPECT_EQ(response.body, body);
    ASSERT_TRUE(fixture.wait_for_completed_entry_calls(1));
    const auto metrics = fixture.settlement_metrics();
    ASSERT_TRUE(metrics);
    EXPECT_NE(metrics->find("ai_server_embedding_usage_total{result=\"unknown\"} 1"), std::string::npos);
}
TEST(EmbeddingProxyIntegrationTest, RetriesTokenFailuresWithOriginalInputAndOneSettlement) {
    FixtureHarness fixture({MockReply{.status = 429, .body = R"({"error":{"code":"rate_limit_exceeded"}})"},
                            MockReply{.body = std::string(kEmbedding)}});
    ASSERT_TRUE(fixture.valid());
    auto response = embeddings(fixture, R"({"model":"logical","input":[1,2,3]})");
    EXPECT_EQ(response.status, 200);
    ASSERT_TRUE(fixture.wait_for_completed_entry_calls(1));
    auto observed = fixture.observed();
    ASSERT_EQ(observed.size(), 2u);
    EXPECT_EQ(observed[0].body, observed[1].body);
    auto metrics = fixture.settlement_metrics();
    ASSERT_TRUE(metrics);
    EXPECT_NE(metrics->find("ai_server_rate_limit_settlements_total{result=\"usage\"} 1"), std::string::npos);
}
TEST(EmbeddingProxyIntegrationTest, OversizedResponseDoesNotReplayBatch) {
    FixtureHarness fixture({MockReply{.body = std::string(32 * 1024 * 1024 + 1, ' ')}});
    ASSERT_TRUE(fixture.valid());
    auto response = embeddings(fixture, R"({"model":"logical","input":"hello"})");
    EXPECT_EQ(response.status, 502);
    EXPECT_NE(response.body.find("provider_response_too_large"), std::string::npos);
    ASSERT_TRUE(fixture.wait_for_completed_entry_calls(1));
    EXPECT_EQ(fixture.observed().size(), 1u);
}
TEST(EmbeddingProxyIntegrationTest, CompletesSettlementAfterDownstreamDisconnect) {
    const std::string body(kEmbedding);
    FixtureHarness fixture({MockReply{.content_type = "application/json",
                                      .chunks = {body.substr(0, 20), body.substr(20)},
                                      .stream = true,
                                      .pause_after_chunks = 1}});
    ASSERT_TRUE(fixture.valid());
    int client = open_json_request(fixture.entry_port(), issue_token(), R"({"model":"logical","input":"hello"})",
                                   "/v1/embeddings");
    ASSERT_GE(client, 0);
    ASSERT_TRUE(fixture.wait_for_provider_pause());
    reset_http_client(client);
    fixture.release_provider();
    ASSERT_TRUE(fixture.wait_for_completed_entry_calls(1));
    ASSERT_TRUE(fixture.wait_for_audit_records(1));
    const auto metrics = fixture.settlement_metrics();
    ASSERT_TRUE(metrics);
    EXPECT_NE(metrics->find("ai_server_rate_limit_settlements_total{result=\"usage\"} 1"), std::string::npos);
    EXPECT_EQ(fixture.observed().size(), 1u);
}

TEST(EmbeddingProxyIntegrationTest, RequestBodyLimitRejectsBeforeProvider) {
    FixtureHarness fixture({});
    ASSERT_TRUE(fixture.valid());
    // The server rejects the declared size before reading the body. Read its
    // response immediately rather than continuing an upload after that rejection.
    const int client =
            open_json_request(fixture.entry_port(), issue_token(), {}, "/v1/embeddings", 4 * 1024 * 1024 + 1);
    ASSERT_GE(client, 0);
    std::string response;
    const bool received = wait_for_socket_text(client, "request_too_large", response);
    (void) ::close(client);
    ASSERT_TRUE(received);
    EXPECT_TRUE(response.starts_with("HTTP/1.1 413 "));
    EXPECT_TRUE(fixture.observed().empty());
}
TEST(EmbeddingProxyIntegrationTest, InvalidJsonContentTypeAndDimensionMismatchAreNotRetried) {
    const std::string body(kEmbedding);
    for (const auto &reply: {MockReply{.body = body.substr(0, body.size() - 1)},
                             MockReply{.content_type = "text/event-stream", .body = body}, MockReply{.body = body}}) {
        FixtureHarness fixture({reply});
        ASSERT_TRUE(fixture.valid());
        auto result = embeddings(fixture, R"({"model":"logical","input":"hello","dimensions":3})");
        EXPECT_EQ(result.status, 502);
        EXPECT_EQ(fixture.observed().size(), 1u);
    }
}
TEST(EmbeddingProxyIntegrationTest, ProviderParameterErrorIsNotRetried) {
    const std::string error =
            R"({"error":{"code":"invalid_dimensions","type":"invalid_request_error","param":"dimensions"}})";
    FixtureHarness fixture({MockReply{.status = 400, .body = error}});
    ASSERT_TRUE(fixture.valid());
    auto result = embeddings(fixture, R"({"model":"logical","input":"hello","dimensions":3})");
    EXPECT_EQ(result.status, 400);
    EXPECT_EQ(result.body, error);
    EXPECT_EQ(fixture.observed().size(), 1u);
}
TEST(EmbeddingProxyIntegrationTest, RetryExhaustionReleasesTicketOnce) {
    const MockReply failure{.status = 429, .body = R"({"error":{"code":"rate_limit_exceeded"}})"};
    // Three primary tokens followed by one fallback token exhaust the plan.
    FixtureHarness fixture({failure, failure, failure, failure});
    ASSERT_TRUE(fixture.valid());
    const auto response = embeddings(fixture, R"({"model":"logical","input":"hello"})");
    EXPECT_EQ(response.status, 429);
    ASSERT_TRUE(fixture.wait_for_completed_entry_calls(1));
    EXPECT_EQ(fixture.observed().size(), 4u);
    const auto metrics = fixture.settlement_metrics();
    ASSERT_TRUE(metrics);
    EXPECT_NE(metrics->find("ai_server_rate_limit_settlements_total{result=\"no_usage\"} 1"), std::string::npos);
}
TEST(EmbeddingProxyIntegrationTest, ConcurrentLargeResponsesKeepBodiesAndAccountingIndependent) {
    std::string data = R"([{"object":"embedding","index":0,"embedding":[0.25)";
    for (std::size_t i = 1; i < 262144; ++i)
        data += ",0.25";
    data += "]}]";
    const auto body = std::string(R"({"object":"list","model":"vendor","data":)") + data +
                      R"(,"usage":{"prompt_tokens":7,"total_tokens":7}})";
    FixtureHarness fixture({MockReply{.body = body}, MockReply{.body = body}});
    ASSERT_TRUE(fixture.valid());
    auto first = std::async(std::launch::async, [&fixture] {
        return embeddings(fixture, R"({"model":"logical","input":"first","dimensions":262144})");
    });
    auto second = std::async(std::launch::async, [&fixture] {
        return embeddings(fixture, R"({"model":"logical","input":"second","dimensions":262144})");
    });
    for (auto *pending: {&first, &second}) {
        const auto response = pending->get();
        EXPECT_EQ(response.status, 200);
        EXPECT_TRUE(response.complete);
        EXPECT_EQ(response.body, body);
    }
    ASSERT_TRUE(fixture.wait_for_completed_entry_calls(2));
    EXPECT_EQ(fixture.observed().size(), 2u);
    const auto metrics = fixture.settlement_metrics();
    ASSERT_TRUE(metrics);
    EXPECT_NE(metrics->find("ai_server_rate_limit_settlements_total{result=\"usage\"} 2"), std::string::npos);
    EXPECT_NE(metrics->find("ai_server_user_token_usage_total{username=\"alice\",token_type=\"in_nocache\"} 14"),
              std::string::npos);
}
TEST(EmbeddingProxyIntegrationTest, ListenerStopDuringBufferedResponseReportsSettlementFailureOnce) {
    const std::string body(kEmbedding);
    FixtureHarness fixture({MockReply{.content_type = "application/json",
                                      .chunks = {body.substr(0, 20), body.substr(20)},
                                      .stream = true,
                                      .pause_after_chunks = 1}});
    ASSERT_TRUE(fixture.valid());
    const int client = open_json_request(fixture.entry_port(), issue_token(), R"({"model":"logical","input":"hello"})",
                                         "/v1/embeddings");
    ASSERT_GE(client, 0);
    const bool paused = fixture.wait_for_provider_pause();
    if (paused)
        EXPECT_TRUE(fixture.stop_entry());
    (void) ::close(client);
    fixture.release_provider();
    ASSERT_TRUE(paused);
    ASSERT_TRUE(fixture.wait_for_completed_entry_calls(1));
    const auto metrics = fixture.settlement_metrics();
    ASSERT_TRUE(metrics);
    // This listener also hosts the fake limiter. Stopping it makes the settle
    // delivery fail, but collection still finishes and records the known usage.
    EXPECT_NE(metrics->find("ai_server_rate_limit_settlements_total{result=\"error\"} 1"), std::string::npos);
    EXPECT_NE(metrics->find("ai_server_embedding_usage_total{result=\"known\"} 1"), std::string::npos);
    EXPECT_NE(metrics->find("ai_server_user_token_usage_total{username=\"alice\",token_type=\"in_nocache\"} 7"),
              std::string::npos);
    EXPECT_EQ(fixture.observed().size(), 1u);
}
} // namespace
