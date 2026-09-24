#include "LlmProxyTestSupport.h"

namespace {

TEST(LlmProxyIntegrationTest, RetriesTransportAuthRateLimitAndFallbackFromOriginalJson) {
    FixtureHarness fixture(
            {
                    MockReply{.abort_before_header = true},
                    MockReply{
                            .status = 401,
                            .body = R"({"error":{"type":"authentication_error","code":"invalid_api_key"}})",
                    },
                    MockReply{
                            .status = 429,
                            .body = R"({"error":{"type":"rate_limit_error","code":"rate_limit_exceeded"}})",
                            .retry_after = "120",
                    },
                    MockReply{
                            .status = 200,
                            .body = R"({"id":"ok","usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}})",
                    },
            },
            false, false, fiber::ai_server::kDefaultLlmAuditMaxRecordBytes, true);
    ASSERT_TRUE(fixture.valid());
    const std::string token = issue_token();
    ASSERT_FALSE(token.empty());
    constexpr std::string_view request =
            R"({ "model" : "logical", "stream":false, "unknown":1.2300, "nested":{"x":"y"} })";

    const RawHttpResponse response = post_json(fixture.entry_port(), token, request);

    EXPECT_EQ(response.system_error, 0);
    EXPECT_EQ(response.status, 200);
    EXPECT_TRUE(response.complete);
    EXPECT_EQ(response.body, R"({"id":"ok","usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}})");
    const auto observed = fixture.observed();
    EXPECT_EQ(fixture.entry_calls(), 1);
    ASSERT_EQ(observed.size(), 4u);
    for (std::size_t i = 0; i < 3; ++i) {
        EXPECT_NE(observed[i].body.find(R"("model" : "upstream-primary")"), std::string::npos);
        EXPECT_NE(observed[i].body.find(R"("unknown":1.2300)"), std::string::npos);
    }
    EXPECT_NE(observed[3].body.find(R"("model" : "upstream-fallback")"), std::string::npos);
    EXPECT_NE(observed[3].body.find(R"("unknown":1.2300)"), std::string::npos);

    const std::string auth_failed = bearer_token_name(observed[1].authorization);
    const std::string rate_limited = bearer_token_name(observed[2].authorization);
    EXPECT_FALSE(auth_failed.empty());
    EXPECT_FALSE(rate_limited.empty());
    EXPECT_NE(auth_failed, rate_limited);
    EXPECT_FALSE(fixture.token_available(auth_failed, 121s));
    EXPECT_TRUE(fixture.token_available(rate_limited, 121s));
    EXPECT_TRUE(fixture.wait_for_cat_frame(cat_nt1_type_and_name("LLM.UpstreamError", "read_header")));
    EXPECT_TRUE(fixture.wait_for_cat_frame(cat_nt1_type_and_name("LLM.UpstreamError", "upstream_error")));
}

TEST(LlmProxyIntegrationTest, DnsTimeoutSkipsRemainingTokensAndBacksOffRepeatedLookup) {
    std::uint16_t dns_port = 0;
    const int dns_fd = bind_dropping_dns_socket(dns_port);
    ASSERT_GE(dns_fd, 0);
    ASSERT_NE(dns_port, 0);

    FixtureHarness fixture(
            {
                    MockReply{
                            .status = 200,
                            .body = R"({"id":"first","usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}})",
                    },
                    MockReply{
                            .status = 200,
                            .body = R"({"id":"second","usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}})",
                    },
            },
            false, false, fiber::ai_server::kDefaultLlmAuditMaxRecordBytes, true,
            fiber::ai_server::WorkerDnsService::Options{
                    .nameserver = fiber::net::SocketAddress(fiber::net::IpAddress::loopback_v4(), dns_port),
                    .timeout = 20ms,
                    .transient_failure_ttl = 1s,
                    .attempts = 1,
            },
            true);
    ASSERT_TRUE(fixture.valid());
    const std::string token = issue_token();
    ASSERT_FALSE(token.empty());

    const RawHttpResponse first =
            post_json(fixture.entry_port(), token, R"({"model":"logical","stream":false,"messages":[]})");
    ASSERT_EQ(first.system_error, 0);
    ASSERT_EQ(first.status, 200);
    EXPECT_NE(first.body.find(R"("id":"first")"), std::string::npos);
    EXPECT_EQ(drain_dns_packets(dns_fd), 2u);

    const RawHttpResponse second =
            post_json(fixture.entry_port(), token, R"({"model":"logical","stream":false,"messages":[]})");
    ASSERT_EQ(second.system_error, 0);
    ASSERT_EQ(second.status, 200);
    EXPECT_NE(second.body.find(R"("id":"second")"), std::string::npos);
    EXPECT_EQ(drain_dns_packets(dns_fd), 0u);

    const auto observed = fixture.observed();
    ASSERT_EQ(observed.size(), 2u);
    EXPECT_EQ(bearer_token_name(observed[0].authorization), "token-f");
    EXPECT_EQ(bearer_token_name(observed[1].authorization), "token-f");
    EXPECT_NE(observed[0].body.find("upstream-fallback"), std::string::npos);
    EXPECT_NE(observed[1].body.find("upstream-fallback"), std::string::npos);

    ASSERT_TRUE(fixture.wait_for_audit_records(2));
    const std::string audit = fixture.audit_contents();
    EXPECT_NE(audit.find(R"("schema_version":6)"), std::string::npos);
    EXPECT_NE(audit.find(R"(\"failure_phase\":\"dns\")"), std::string::npos);
    EXPECT_NE(audit.find(R"(\"io_error\":\"timed_out\")"), std::string::npos);
    EXPECT_NE(audit.find(R"(\"failure_source\":\"io\")"), std::string::npos);
    EXPECT_NE(audit.find(R"(\"failure_source\":\"dns_backoff\")"), std::string::npos);
    EXPECT_NE(audit.find(R"(\"retry_target\":\"next_provider\")"), std::string::npos);
    EXPECT_NE(audit.find(R"(\"retry_performed\":true,\"skipped_attempts\":2)"), std::string::npos);
    EXPECT_NE(audit.find(R"("provider_attempt_count":2,"provider_attempt_skipped_count":2)"), std::string::npos);
    EXPECT_TRUE(fixture.wait_for_cat_frame("io_error=timed_out", "failure_source=io"));
    EXPECT_TRUE(fixture.wait_for_cat_frame("failure_source=dns_backoff", "retry_target=next_provider"));
    EXPECT_TRUE(fixture.wait_for_cat_frame("retry_target=next_provider", "skipped_attempts=2"));
    EXPECT_TRUE(fixture.wait_for_cat_frame("retry_performed=true", "skipped_attempts=2"));
    EXPECT_TRUE(fixture.wait_for_cat_frame(cat_nt1_type_and_name("LLM.UpstreamError", "dns")));
    EXPECT_FALSE(fixture.cat_frame_contains("failure_phase="));

    auto metrics = fixture.settlement_metrics();
    ASSERT_TRUE(metrics);
    EXPECT_NE(metrics->find("ai_server_provider_transport_failures_total{protocol=\"openai\",phase=\"dns\"} 2"),
              std::string::npos);
    EXPECT_NE(metrics->find("ai_server_provider_attempts_skipped_total{protocol=\"openai\"} 4"), std::string::npos);
    EXPECT_NE(metrics->find("ai_server_dns_backoff_hits_total{protocol=\"openai\"} 1"), std::string::npos);
    (void) ::close(dns_fd);
}

TEST(LlmProxyIntegrationTest, DnsTimeoutWithoutFallbackReturnsCurrentTransportError) {
    std::uint16_t dns_port = 0;
    const int dns_fd = bind_dropping_dns_socket(dns_port);
    ASSERT_GE(dns_fd, 0);
    ASSERT_NE(dns_port, 0);

    FixtureHarness fixture(
            {}, false, false, fiber::ai_server::kDefaultLlmAuditMaxRecordBytes, false,
            fiber::ai_server::WorkerDnsService::Options{
                    .nameserver = fiber::net::SocketAddress(fiber::net::IpAddress::loopback_v4(), dns_port),
                    .timeout = 20ms,
                    .transient_failure_ttl = 1s,
                    .attempts = 1,
            },
            true, false);
    ASSERT_TRUE(fixture.valid());
    const std::string token = issue_token();
    ASSERT_FALSE(token.empty());

    const RawHttpResponse response =
            post_json(fixture.entry_port(), token, R"({"model":"logical","stream":false,"messages":[]})");
    ASSERT_EQ(response.system_error, 0);
    EXPECT_EQ(response.status, 502);
    EXPECT_NE(response.body.find("provider_transport_error"), std::string::npos);
    EXPECT_TRUE(fixture.observed().empty());
    EXPECT_EQ(drain_dns_packets(dns_fd), 2u);

    ASSERT_TRUE(fixture.wait_for_audit_records(1));
    const std::string audit = fixture.audit_contents();
    EXPECT_NE(audit.find(R"(\"failure_phase\":\"dns\")"), std::string::npos);
    EXPECT_NE(audit.find(R"(\"retry_target\":\"next_provider\",\"retryable\":true,\"retry_performed\":false)"),
              std::string::npos);
    EXPECT_NE(audit.find(R"("provider_attempt_count":1,"provider_attempt_skipped_count":2)"), std::string::npos);
    EXPECT_NE(audit.find(R"("error_json":"transport_error")"), std::string::npos);
    EXPECT_NE(audit.find(R"("usage_json":{"in_cache":null,"in_nocache":null,"out":null})"), std::string::npos);
    (void) ::close(dns_fd);
}

TEST(LlmProxyIntegrationTest, PropagatesCatContextToRemoteLimiterAndEveryProviderAttempt) {
    FixtureHarness fixture(
            {
                    MockReply{
                            .status = 401,
                            .body = R"({"error":{"type":"authentication_error","code":"invalid_api_key"}})",
                    },
                    MockReply{
                            .status = 200,
                            .body = R"({"id":"ok","usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}})",
                    },
            },
            false, false, fiber::ai_server::kDefaultLlmAuditMaxRecordBytes, true);
    ASSERT_TRUE(fixture.valid());
    const std::string token = issue_token();
    ASSERT_FALSE(token.empty());

    const RawHttpResponse auth_error =
            post_json(fixture.entry_port(), "invalid-token", R"({"model":"logical","stream":false})",
                      ClientCatHeaders{
                              .trace_id = "auth-error-root",
                      });
    EXPECT_EQ(auth_error.system_error, 0);
    EXPECT_EQ(auth_error.status, 401);
    EXPECT_TRUE(auth_error.complete);
    EXPECT_EQ(auth_error.trace_id, "auth-error-root");

    const RawHttpResponse response = post_json(fixture.entry_port(), token, R"({"model":"logical","stream":false})",
                                               ClientCatHeaders{
                                                       .trace_id = "upstream-root",
                                                       .parent_span_id = "upstream-parent",
                                                       .span_id = "upstream-span",
                                                       .trace_state = "tenant=blue",
                                               });

    EXPECT_EQ(response.system_error, 0);
    EXPECT_EQ(response.status, 200);
    EXPECT_TRUE(response.complete);
    EXPECT_EQ(response.trace_id, "upstream-root");
    const auto providers = fixture.observed();
    ASSERT_EQ(providers.size(), 2U);
    for (const ObservedProviderRequest &provider: providers) {
        EXPECT_EQ(provider.trace_id, "upstream-root");
        EXPECT_EQ(provider.parent_span_id, "upstream-span");
        EXPECT_FALSE(provider.span_id.empty());
        EXPECT_EQ(provider.trace_state, "tenant=blue");
    }
    EXPECT_NE(providers[0].span_id, providers[1].span_id);
    EXPECT_TRUE(fixture.wait_for_cat_frame("LLM.Provider", "RemoteCall"));

    ASSERT_TRUE(fixture.wait_for_rate_limit_requests(2));
    const auto rate_limits = fixture.observed_rate_limits();
    ASSERT_GE(rate_limits.size(), 2U);
    EXPECT_EQ(rate_limits[0].path, "/internal/llm/rate-limit/check");
    EXPECT_EQ(rate_limits[1].path, "/internal/llm/rate-limit/settle");
    for (const ObservedRateLimitRequest &rate_limit: rate_limits) {
        EXPECT_EQ(rate_limit.trace_id, "upstream-root");
        EXPECT_EQ(rate_limit.parent_span_id, "upstream-span");
        EXPECT_FALSE(rate_limit.span_id.empty());
        EXPECT_EQ(rate_limit.trace_state, "tenant=blue");
        EXPECT_NE(rate_limit.span_id, providers[0].span_id);
        EXPECT_NE(rate_limit.span_id, providers[1].span_id);
    }
    EXPECT_NE(rate_limits[0].span_id, rate_limits[1].span_id);

    const RawHttpResponse internal_error =
            post_json(fixture.entry_port(), {}, "{}", ClientCatHeaders{.trace_id = "internal-error-root"},
                      "/internal/llm/rate-limit/check");
    EXPECT_EQ(internal_error.system_error, 0);
    EXPECT_EQ(internal_error.status, 400);
    EXPECT_TRUE(internal_error.complete);
    EXPECT_EQ(internal_error.trace_id, "internal-error-root");
}

TEST(LlmProxyIntegrationTest, WeightedRendezvousRetryExcludesFailedServiceInstance) {
    FixtureHarness fixture(
            {
                    MockReply{
                            .status = 200,
                            .body = R"({"id":"ok","usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}})",
                    },
            },
            false, true);
    ASSERT_TRUE(fixture.valid());
    const std::string token = issue_token();
    ASSERT_FALSE(token.empty());
    const std::string route_key = fixture.rendezvous_route_key();
    ASSERT_FALSE(route_key.empty());
    const std::string request = R"({"model":"logical","stream":false,"prompt_cache_key":")" + route_key +
                                R"(","messages":[{"role":"user","content":"hello"}]})";

    const RawHttpResponse response = post_json(fixture.entry_port(), token, request);

    EXPECT_EQ(response.system_error, 0);
    EXPECT_EQ(response.status, 200);
    EXPECT_TRUE(response.complete);
    EXPECT_EQ(fixture.failing_provider_calls(), 1);
    const auto observed = fixture.observed();
    ASSERT_EQ(observed.size(), 1u);
    EXPECT_NE(observed[0].body.find(R"("model":"upstream-primary")"), std::string::npos);
}

TEST(LlmProxyIntegrationTest, CatUrlTransactionNamesIncludeAuthorizedModelForBothProtocols) {
    FixtureHarness fixture(
            {
                    MockReply{
                            .status = 200,
                            .body = R"({"id":"openai","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3}})",
                    },
                    MockReply{
                            .status = 200,
                            .content_type = "text/event-stream",
                            .chunks =
                                    {
                                            "event: message_start\n"
                                            "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_"
                                            "tokens\":2,\"output_tokens\":0}}}\n\n",
                                            "event: content_block_start\n"
                                            "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{"
                                            "\"type\":\"text\",\"text\":\"\"}}\n\n"
                                            "event: content_block_delta\n"
                                            "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{"
                                            "\"type\":\"text_delta\",\"text\":\"hello\"}}\n\n",
                                            "event: message_delta\n"
                                            "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":3}}\n\n"
                                            "event: message_stop\n"
                                            "data: {\"type\":\"message_stop\"}\n\n",
                                    },
                            .stream = true,
                    },
                    MockReply{
                            .status = 200,
                            .body = R"({"id":"anthropic-alias","type":"message","role":"assistant","content":[],"model":"upstream-anthropic-primary","stop_reason":"end_turn","usage":{"input_tokens":2,"output_tokens":3}})",
                    },
                    MockReply{
                            .status = 200,
                            .body = R"({"id":"zhangwang","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3}})",
                    },
            },
            false, false, fiber::ai_server::kDefaultLlmAuditMaxRecordBytes, true);
    ASSERT_TRUE(fixture.valid());
    const std::string token = issue_token();
    const std::string zhangwang_token = issue_token("zhangwang");
    const std::string mallory_token = issue_token("mallory");
    ASSERT_FALSE(token.empty());
    ASSERT_FALSE(zhangwang_token.empty());
    ASSERT_FALSE(mallory_token.empty());

    const RawHttpResponse openai =
            post_json(fixture.entry_port(), token, R"({"model":"logical","stream":false,"messages":[]})");
    const RawHttpResponse anthropic =
            post_json(fixture.entry_port(), token, R"({"model":"logical","stream":true,"max_tokens":16,"messages":[]})",
                      {}, "/v1/messages");
    const RawHttpResponse anthropic_alias = post_json(
            fixture.entry_port(), token, R"({"model":"logical","max_tokens":16,"messages":[]})", {}, "/v1/message");
    const RawHttpResponse zhangwang =
            post_json(fixture.entry_port(), zhangwang_token, R"({"model":"logical","stream":false,"messages":[]})");
    const RawHttpResponse mallory =
            post_json(fixture.entry_port(), mallory_token, R"({"model":"logical","stream":false,"messages":[]})");

    EXPECT_EQ(openai.system_error, 0);
    EXPECT_EQ(openai.status, 200);
    EXPECT_TRUE(openai.complete);
    EXPECT_EQ(anthropic.system_error, 0);
    EXPECT_EQ(anthropic.status, 200);
    EXPECT_TRUE(anthropic.complete);
    EXPECT_EQ(anthropic_alias.system_error, 0);
    EXPECT_EQ(anthropic_alias.status, 200);
    EXPECT_TRUE(anthropic_alias.complete);
    EXPECT_EQ(zhangwang.system_error, 0);
    EXPECT_EQ(zhangwang.status, 200);
    EXPECT_TRUE(zhangwang.complete);
    EXPECT_EQ(mallory.system_error, 0);
    EXPECT_EQ(mallory.status, 403);
    EXPECT_TRUE(mallory.complete);
    EXPECT_TRUE(fixture.wait_for_cat_frame("/v1/chat/completions:logical", "stream=false"));
    EXPECT_TRUE(fixture.wait_for_cat_frame("/v1/messages:logical", "stream=true"));
    EXPECT_TRUE(fixture.wait_for_cat_frame("/v1/message:logical", "stream=false"));
    EXPECT_TRUE(fixture.wait_for_cat_frame(cat_nt1_type_name_and_status("Auth", "alice", fiber::cat::status::Success),
                                           "allowed_user_group=integration-users"));
    EXPECT_TRUE(
            fixture.wait_for_cat_frame(cat_nt1_type_name_and_status("Auth", "zhangwang", fiber::cat::status::Success)));
    EXPECT_TRUE(fixture.wait_for_cat_frame(cat_nt1_type_name_and_status("Auth", "mallory", fiber::cat::status::Error)));
    EXPECT_FALSE(fixture.cat_frame_contains(cat_nt1_type_and_name("Auth", "zhangwang"), "allowed_user_group="));
    EXPECT_FALSE(fixture.cat_frame_contains(cat_nt1_type_and_name("Auth", "mallory"), "allowed_user_group="));
    EXPECT_TRUE(fixture.wait_for_cat_frame("LLM.Provider", "time_to_response_header_us="));
    EXPECT_FALSE(fixture.cat_frame_contains("failure_phase="));
    EXPECT_FALSE(fixture.cat_frame_contains("io_error="));
    EXPECT_FALSE(fixture.cat_frame_contains("failure_source="));
    EXPECT_FALSE(fixture.cat_frame_contains("retry_target="));
    EXPECT_FALSE(fixture.cat_frame_contains("retryable="));
    EXPECT_FALSE(fixture.cat_frame_contains("retry_performed="));
    EXPECT_FALSE(fixture.cat_frame_contains("skipped_attempts="));
    EXPECT_FALSE(fixture.cat_frame_contains("response_started="));
    EXPECT_FALSE(fixture.cat_frame_contains("outcome="));
    EXPECT_TRUE(fixture.wait_for_cat_frame("LLM.Provider", "reuse_count=0"));
    EXPECT_TRUE(fixture.wait_for_cat_frame("LLM.Provider", "reuse_count=1"));
    EXPECT_FALSE(fixture.cat_frame_contains("connection_request_count="));
    EXPECT_FALSE(fixture.cat_frame_contains("connection_reuse_count="));
    EXPECT_TRUE(fixture.wait_for_cat_frame("upstream_model=upstream-anthropic-primary", "time_to_first_token_us="));
    EXPECT_FALSE(fixture.cat_frame_contains("upstream_model=upstream-primary", "time_to_first_token_us="));
    EXPECT_TRUE(fixture.wait_for_cat_frame("LLM.Provider", "body_transfer_us="));
    EXPECT_FALSE(fixture.cat_frame_contains("LLM.UpstreamError"));
}

TEST(LlmProxyIntegrationTest, CatUrlTransactionUsesSpaceSeparatedDataAndBoundsUserAgent) {
    FixtureHarness fixture(
            {
                    MockReply{
                            .status = 200,
                            .body = R"({"id":"normal","choices":[]})",
                    },
                    MockReply{
                            .status = 200,
                            .body = R"({"id":"truncated","choices":[]})",
                    },
            },
            false, false, fiber::ai_server::kDefaultLlmAuditMaxRecordBytes, true);
    ASSERT_TRUE(fixture.valid());
    const std::string token = issue_token();
    ASSERT_FALSE(token.empty());
    constexpr std::string_view request = R"({"model":"logical","stream":false,"messages":[]})";
    constexpr std::string_view user_agent = "ai-server-integration/1.0 with spaces";

    const RawHttpResponse normal =
            post_json(fixture.entry_port(), token, request, ClientCatHeaders{.user_agent = std::string(user_agent)});
    std::string oversized_user_agent(fiber::ai_server::kMaxAiServerCatUserAgentBytes + 16, 'u');
    const RawHttpResponse truncated = post_json(fixture.entry_port(), token, request,
                                                ClientCatHeaders{.user_agent = std::move(oversized_user_agent)});

    EXPECT_EQ(normal.status, 200);
    EXPECT_TRUE(normal.complete);
    EXPECT_EQ(truncated.status, 200);
    EXPECT_TRUE(truncated.complete);

    const std::string root_name = cat_nt1_type_and_name("URL", "/v1/chat/completions:logical");
    const std::string root_data =
            "method=POST host=127.0.0.1 content_type=application/json trace_context=new protocol=openai "
            "user=alice kid=test1 stream=false model=logical status=200 user_agent=" +
            std::string(user_agent);
    EXPECT_TRUE(fixture.wait_for_cat_frame(root_name, root_data));
    EXPECT_FALSE(fixture.cat_frame_contains("&host="));
    EXPECT_FALSE(fixture.cat_frame_contains("&protocol="));

    const std::string bounded_user_agent(fiber::ai_server::kMaxAiServerCatUserAgentBytes, 'u');
    EXPECT_TRUE(fixture.wait_for_cat_frame(root_name, "user_agent_truncated=true user_agent=" + bounded_user_agent));
    EXPECT_FALSE(fixture.cat_frame_contains(std::string(fiber::ai_server::kMaxAiServerCatUserAgentBytes + 1, 'u')));
}

TEST(LlmProxyIntegrationTest, CatProviderTransactionOmitsFirstTokenAndBodyTransferForEmptyResponse) {
    FixtureHarness fixture(
            {
                    MockReply{
                            .status = 200,
                    },
            },
            false, false, fiber::ai_server::kDefaultLlmAuditMaxRecordBytes, true);
    ASSERT_TRUE(fixture.valid());
    const std::string token = issue_token();
    ASSERT_FALSE(token.empty());

    const RawHttpResponse response =
            post_json(fixture.entry_port(), token, R"({"model":"logical","stream":false,"messages":[]})");

    EXPECT_EQ(response.system_error, 0);
    EXPECT_EQ(response.status, 200);
    EXPECT_TRUE(response.complete);
    EXPECT_TRUE(response.body.empty());
    EXPECT_TRUE(fixture.wait_for_cat_frame("LLM.Provider", "time_to_response_header_us="));
    EXPECT_FALSE(fixture.cat_frame_contains("LLM.Provider", "time_to_first_token_us="));
    EXPECT_FALSE(fixture.cat_frame_contains("LLM.Provider", "body_transfer_us="));
}

TEST(LlmProxyIntegrationTest, CatRecordsGeneratedResponseErrorAlongsideInvalidProviderResponse) {
    FixtureHarness fixture(
            {
                    MockReply{
                            .status = 200,
                            .content_type = "application/json",
                            .body = R"({"error":"streaming unavailable"})",
                    },
            },
            false, false, fiber::ai_server::kDefaultLlmAuditMaxRecordBytes, true);
    ASSERT_TRUE(fixture.valid());
    const std::string token = issue_token();
    ASSERT_FALSE(token.empty());

    const RawHttpResponse response =
            post_json(fixture.entry_port(), token, R"({"model":"logical","stream":true,"messages":[]})");

    EXPECT_EQ(response.system_error, 0);
    EXPECT_EQ(response.status, 502);
    EXPECT_TRUE(response.complete);
    EXPECT_TRUE(fixture.wait_for_cat_frame(cat_nt1_type_and_name("LLM.UpstreamError", "invalid_response"),
                                           "io_error=invalid&failure_source=io&status=200"));
    EXPECT_TRUE(fixture.wait_for_cat_frame(
            cat_nt1_type_name_and_status("LLM.ResponseError", "upstream_invalid_response", fiber::cat::status::Error),
            "status=502&type=api_error&message=provider did not return an event stream"));
}

TEST(LlmProxyIntegrationTest, RelaysSseBytesUnchangedAndNeverRetriesAfterResponseStart) {
    constexpr std::string_view expected =
            ": ping\r\nid: 7\r\ndata:{\"choices\":[],\"usage\":{\"prompt_tokens\":2"
            ",\"completion_tokens\":3,\"total_tokens\":5}}\r\n\r\ndata: [DONE]\r\n\r\ndata: [DONE]\n\n";
    FixtureHarness fixture(
            {
                    MockReply{
                            .status = 200,
                            .content_type = "text/event-stream",
                            .chunks =
                                    {
                                            ": ping\r\nid: 7\r\ndata:{\"choices\":[],\"usage\":{\"prompt_tokens\":2",
                                            ",\"completion_tokens\":3,\"total_tokens\":5}}\r\n\r\ndata: [DONE]\r\n\r\n"
                                            "data: [DONE]\n\n",
                                    },
                            .stream = true,
                    },
                    MockReply{
                            .status = 200,
                            .content_type = "text/event-stream",
                            .request_id = "req-truncated-1",
                            .chunks =
                                    {
                                            "data: {\"choices\":[]}\n\n",
                                    },
                            .stream = true,
                            .abort_after_chunks = true,
                    },
            },
            false, false, fiber::ai_server::kDefaultLlmAuditMaxRecordBytes, true);
    ASSERT_TRUE(fixture.valid());
    const std::string token = issue_token();
    ASSERT_FALSE(token.empty());
    constexpr std::string_view request =
            R"({"model":"logical","stream":true,"messages":[{"role":"user","content":"hello"}]})";

    const RawHttpResponse success = post_json(fixture.entry_port(), token, request,
                                              ClientCatHeaders{
                                                      .trace_id = "sse-success-root",
                                                      .span_id = "sse-success-span",
                                              });
    EXPECT_EQ(success.status, 200);
    EXPECT_TRUE(success.complete);
    EXPECT_EQ(success.trace_id, "sse-success-root");
    EXPECT_EQ(success.body, expected);

    const RawHttpResponse truncated = post_json(fixture.entry_port(), token, request,
                                                ClientCatHeaders{
                                                        .trace_id = "sse-truncated-root",
                                                        .span_id = "sse-truncated-span",
                                                });
    EXPECT_EQ(truncated.status, 200);
    EXPECT_TRUE(truncated.complete);
    EXPECT_EQ(truncated.trace_id, "sse-truncated-root");
    EXPECT_EQ(truncated.body.find("data: [DONE]"), std::string::npos);
    // The mid-stream upstream failure surfaces as a terminal OpenAI-shaped error event.
    EXPECT_NE(truncated.body.find("\"type\":\"server_error\""), std::string::npos);
    EXPECT_NE(truncated.body.find("io_error="), std::string::npos);
    EXPECT_EQ(fixture.observed().size(), 2u);
    EXPECT_TRUE(fixture.wait_for_cat_frame("upstream_model=upstream-primary", "body_transfer_us="));
    EXPECT_FALSE(fixture.cat_frame_contains("upstream_model=upstream-primary", "time_to_first_token_us="));
}

TEST(LlmProxyIntegrationTest, DrainsSseUsageAfterClientDisconnectAndDoesNotRetry) {
    constexpr std::string_view first_event = "data: {\"choices\":[{\"delta\":{\"content\":\"hello\"}}]}\n\n";
    // Fill one relay read budget so the first event reaches the client before the mock Provider pauses.
    std::string first_chunk = ":";
    first_chunk.append(64 * 1024 - first_event.size() - 2, 'x');
    first_chunk.push_back('\n');
    first_chunk.append(first_event);
    FixtureHarness fixture({
            MockReply{
                    .status = 200,
                    .content_type = "text/event-stream",
                    .chunks =
                            {
                                    std::move(first_chunk),
                                    "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":2,"
                                    "\"completion_tokens\":3,\"total_tokens\":5}}\n\ndata: [DONE]\n\n",
                            },
                    .stream = true,
                    .pause_after_chunks = 1,
            },
            MockReply{
                    .status = 200,
                    .content_type = "text/event-stream",
                    .chunks = {"data: {\"choices\":[]}\n\n"},
                    .stream = true,
            },
    });
    ASSERT_TRUE(fixture.valid());
    const std::string token = issue_token();
    ASSERT_FALSE(token.empty());
    constexpr std::string_view request =
            R"({"model":"logical","stream":true,"messages":[{"role":"user","content":"hello"}]})";

    const int client = open_json_request(fixture.entry_port(), token, request);
    ASSERT_GE(client, 0);
    if (!fixture.wait_for_provider_pause()) {
        reset_http_client(client);
        FAIL() << "Provider did not pause after the first SSE chunk";
    }
    std::string received;
    if (!wait_for_socket_text(client, first_event, received)) {
        reset_http_client(client);
        FAIL() << "did not receive the first SSE event: " << received;
    }
    reset_http_client(client);
    std::this_thread::sleep_for(20ms);
    fixture.release_provider();

    ASSERT_TRUE(fixture.wait_for_completed_entry_calls(1));
    ASSERT_TRUE(fixture.wait_for_rate_limit_requests(2));
    ASSERT_TRUE(fixture.wait_for_audit_records(1));
    EXPECT_EQ(fixture.observed().size(), 1u);

    auto metrics = fixture.settlement_metrics();
    ASSERT_TRUE(metrics);
    EXPECT_NE(metrics->find("ai_server_provider_attempts_total{protocol=\"openai\"} 1"), std::string::npos);
    EXPECT_NE(metrics->find("ai_server_provider_retries_total{protocol=\"openai\"} 0"), std::string::npos);
    EXPECT_NE(metrics->find("ai_server_sse_drains_total{protocol=\"openai\",result=\"completed\"} 1"),
              std::string::npos);
    EXPECT_NE(metrics->find("ai_server_rate_limit_settlements_total{result=\"usage\"} 1"), std::string::npos);
    EXPECT_NE(metrics->find("ai_server_user_token_usage_total{username=\"alice\",token_type=\"in_nocache\"} 2"),
              std::string::npos);
    EXPECT_NE(metrics->find("ai_server_user_token_usage_total{username=\"alice\",token_type=\"out\"} 3"),
              std::string::npos);

    const std::string audit = fixture.audit_contents();
    EXPECT_NE(audit.find(R"("provider_attempt_count":1)"), std::string::npos);
    EXPECT_NE(audit.find(R"(\"response_started\":true,\"outcome\":\"success\")"), std::string::npos);
    EXPECT_NE(audit.find(R"("output_complete":true,"output_canonical_complete":true)"), std::string::npos);
    EXPECT_NE(audit.find(R"("client_aborted":true,"error_json":"conn_reset")"), std::string::npos);
    EXPECT_NE(audit.find(R"("usage_json":{"in_cache":0,"in_nocache":2,"out":3})"), std::string::npos);
}

TEST(LlmProxyIntegrationTest, DoesNotRetryWhenUpstreamFailsWhileDrainingAfterClientDisconnect) {
    constexpr std::string_view first_event = "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n";
    // Fill one relay read budget so the first event reaches the client before the mock Provider pauses.
    std::string first_chunk = ":";
    first_chunk.append(64 * 1024 - first_event.size() - 2, 'x');
    first_chunk.push_back('\n');
    first_chunk.append(first_event);
    std::string drain_chunk = ":";
    drain_chunk.append(64 * 1024 - 2, 'y');
    drain_chunk.push_back('\n');
    FixtureHarness fixture(
            {
                    MockReply{
                            .status = 200,
                            .content_type = "text/event-stream",
                            .chunks = {std::move(first_chunk), std::move(drain_chunk)},
                            .stream = true,
                            .abort_after_chunks = true,
                            .pause_after_chunks = 1,
                    },
                    MockReply{
                            .status = 200,
                            .content_type = "text/event-stream",
                            .chunks = {"data: {\"choices\":[]}\n\n"},
                            .stream = true,
                    },
            },
            false, false, fiber::ai_server::kDefaultLlmAuditMaxRecordBytes, true);
    ASSERT_TRUE(fixture.valid());
    const std::string token = issue_token();
    ASSERT_FALSE(token.empty());
    constexpr std::string_view request =
            R"({"model":"logical","stream":true,"messages":[{"role":"user","content":"hello"}]})";

    const int client = open_json_request(fixture.entry_port(), token, request);
    ASSERT_GE(client, 0);
    if (!fixture.wait_for_provider_pause()) {
        reset_http_client(client);
        FAIL() << "Provider did not pause after the first SSE chunk";
    }
    std::string received;
    if (!wait_for_socket_text(client, first_event, received)) {
        reset_http_client(client);
        FAIL() << "did not receive the first SSE event: " << received;
    }
    reset_http_client(client);
    std::this_thread::sleep_for(20ms);
    fixture.release_provider();

    ASSERT_TRUE(fixture.wait_for_completed_entry_calls(1));
    ASSERT_TRUE(fixture.wait_for_rate_limit_requests(2));
    ASSERT_TRUE(fixture.wait_for_audit_records(1));
    EXPECT_EQ(fixture.observed().size(), 1u);

    auto metrics = fixture.settlement_metrics();
    ASSERT_TRUE(metrics);
    EXPECT_NE(metrics->find("ai_server_provider_attempts_total{protocol=\"openai\"} 1"), std::string::npos);
    EXPECT_NE(metrics->find("ai_server_provider_retries_total{protocol=\"openai\"} 0"), std::string::npos);
    EXPECT_NE(metrics->find("ai_server_provider_failures_total{protocol=\"openai\"} 1"), std::string::npos);
    EXPECT_NE(metrics->find("ai_server_sse_drains_total{protocol=\"openai\",result=\"upstream_error\"} 1"),
              std::string::npos);
    EXPECT_NE(metrics->find("ai_server_rate_limit_settlements_total{result=\"no_usage\"} 1"), std::string::npos);

    const std::string audit = fixture.audit_contents();
    EXPECT_NE(audit.find(R"("provider_attempt_count":1)"), std::string::npos);
    EXPECT_NE(audit.find(R"(\"response_started\":true,\"outcome\":\"stream_error\")"), std::string::npos);
    EXPECT_NE(audit.find(R"("output_complete":false,"output_canonical_complete":false)"), std::string::npos);
    EXPECT_NE(audit.find(R"("client_aborted":true,"error_json":"conn_reset")"), std::string::npos) << audit;
    EXPECT_TRUE(fixture.wait_for_cat_frame("upstream_model=upstream-primary", "time_to_first_token_us="));
    EXPECT_FALSE(fixture.cat_frame_contains("upstream_model=upstream-primary", "body_transfer_us="));
    EXPECT_TRUE(fixture.wait_for_cat_frame(cat_nt1_type_and_name("LLM.UpstreamError", "read_body"),
                                           "response_started=true"));
}

TEST(LlmProxyIntegrationTest, DrainsSseWhenClientDisconnectsBeforeResponseHeader) {
    FixtureHarness fixture({
            MockReply{
                    .status = 200,
                    .content_type = "text/event-stream",
                    .chunks =
                            {
                                    "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":4,"
                                    "\"completion_tokens\":6,\"total_tokens\":10}}\n\ndata: [DONE]\n\n",
                            },
                    .stream = true,
                    .pause_before_header = true,
            },
            MockReply{
                    .status = 200,
                    .content_type = "text/event-stream",
                    .chunks = {"data: {\"choices\":[]}\n\n"},
                    .stream = true,
            },
    });
    ASSERT_TRUE(fixture.valid());
    const std::string token = issue_token();
    ASSERT_FALSE(token.empty());
    constexpr std::string_view request =
            R"({"model":"logical","stream":true,"messages":[{"role":"user","content":"hello"}]})";

    const int client = open_json_request(fixture.entry_port(), token, request);
    ASSERT_GE(client, 0);
    if (!fixture.wait_for_provider_pause()) {
        reset_http_client(client);
        FAIL() << "Provider did not pause before the response header";
    }
    reset_http_client(client);
    std::this_thread::sleep_for(20ms);
    fixture.release_provider();

    ASSERT_TRUE(fixture.wait_for_completed_entry_calls(1));
    ASSERT_TRUE(fixture.wait_for_rate_limit_requests(2));
    ASSERT_TRUE(fixture.wait_for_audit_records(1));
    EXPECT_EQ(fixture.observed().size(), 1u);

    auto metrics = fixture.settlement_metrics();
    ASSERT_TRUE(metrics);
    EXPECT_NE(metrics->find("ai_server_provider_attempts_total{protocol=\"openai\"} 1"), std::string::npos);
    EXPECT_NE(metrics->find("ai_server_provider_retries_total{protocol=\"openai\"} 0"), std::string::npos);
    EXPECT_NE(metrics->find("ai_server_sse_drains_total{protocol=\"openai\",result=\"completed\"} 1"),
              std::string::npos);
    EXPECT_NE(metrics->find("ai_server_rate_limit_settlements_total{result=\"usage\"} 1"), std::string::npos);
    EXPECT_NE(metrics->find("ai_server_user_token_usage_total{username=\"alice\",token_type=\"in_nocache\"} 4"),
              std::string::npos);
    EXPECT_NE(metrics->find("ai_server_user_token_usage_total{username=\"alice\",token_type=\"out\"} 6"),
              std::string::npos);

    const std::string audit = fixture.audit_contents();
    EXPECT_NE(audit.find(R"("provider_attempt_count":1)"), std::string::npos);
    EXPECT_NE(audit.find(R"(\"response_started\":false,\"outcome\":\"success\")"), std::string::npos);
    EXPECT_NE(audit.find(R"("client_aborted":true,"error_json":"conn_reset")"), std::string::npos) << audit;
    EXPECT_NE(audit.find(R"("usage_json":{"in_cache":0,"in_nocache":4,"out":6})"), std::string::npos);
    EXPECT_NE(audit.find(R"("response_header_sent":false)"), std::string::npos);
}

TEST(LlmProxyIntegrationTest, SettlementFailureDoesNotChangeProviderResponse) {
    constexpr std::string_view buffered_body =
            R"({"id":"ok","usage":{"prompt_tokens":2,"completion_tokens":3,"total_tokens":5}})";
    constexpr std::string_view sse_body =
            ": ping\r\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":6,"
            "\"total_tokens\":10}}\r\n\r\n";
    FixtureHarness fixture(
            {
                    MockReply{
                            .status = 200,
                            .body = std::string(buffered_body),
                    },
                    MockReply{
                            .status = 200,
                            .content_type = "text/event-stream",
                            .chunks = {std::string(sse_body)},
                            .stream = true,
                    },
            },
            true);
    ASSERT_TRUE(fixture.valid());
    const std::string token = issue_token();
    ASSERT_FALSE(token.empty());

    const RawHttpResponse buffered =
            post_json(fixture.entry_port(), token, R"({"model":"logical","stream":false,"messages":[]})");
    EXPECT_EQ(buffered.system_error, 0);
    EXPECT_EQ(buffered.status, 200);
    EXPECT_TRUE(buffered.complete);
    EXPECT_EQ(buffered.body, buffered_body);

    const RawHttpResponse streamed =
            post_json(fixture.entry_port(), token, R"({"model":"logical","stream":true,"messages":[]})");
    EXPECT_EQ(streamed.system_error, 0);
    EXPECT_EQ(streamed.status, 200);
    EXPECT_TRUE(streamed.complete);
    EXPECT_EQ(streamed.body, sse_body);

    auto metrics = fixture.settlement_metrics();
    ASSERT_TRUE(metrics);
    EXPECT_NE(metrics->find("ai_server_rate_limit_settlements_total{result=\"error\"} 2"), std::string::npos);
    EXPECT_NE(metrics->find("ai_server_user_token_usage_total{username=\"alice\",token_type=\"in_cache\"} 0"),
              std::string::npos);
    EXPECT_NE(metrics->find("ai_server_user_token_usage_total{username=\"alice\",token_type=\"in_nocache\"} 6"),
              std::string::npos);
    EXPECT_NE(metrics->find("ai_server_user_token_usage_total{username=\"alice\",token_type=\"out\"} 9"),
              std::string::npos);
    EXPECT_NE(metrics->find("ai_server_provider_token_usage_total{provider_name=\"primary\",protocol=\"openai\","
                            "token_type=\"in_nocache\"} 6"),
              std::string::npos);
}

TEST(LlmProxyIntegrationTest, EmitsOneJsonAuditLineWithInputAndOutput) {
    FixtureHarness fixture({
            MockReply{
                    .status = 200,
                    .body = R"({"id":"ok","choices":[{"message":{"role":"assistant","content":"weather is sunny","tool_calls":[{"type":"function","function":{"name":"weather","arguments":"{\"city\":\"Paris\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":8,"completion_tokens":6,"total_tokens":14,"prompt_tokens_details":{"cached_tokens":3}}})",
                    .request_id = "req-audit-42",
            },
    });
    ASSERT_TRUE(fixture.valid());
    const std::string token = issue_token();
    ASSERT_FALSE(token.empty());
    constexpr std::string_view request =
            R"({"model":"logical","stream":false,"messages":[{"role":"system","content":"answer briefly"},{"role":"user","content":[{"type":"text","text":"weather in Paris"},{"type":"image_url","image_url":{"url":"https://example.test/image?signature=SECRET_URL"}},{"type":"input_audio","input_audio":{"data":"SECRET_BASE64"}}]}],"tools":[{"type":"function","function":{"name":"weather","description":"look up weather","parameters":{"type":"object"}}}]})";

    const RawHttpResponse response =
            post_json(fixture.entry_port(), token, request,
                      ClientCatHeaders{.user_agent = "audit-client/1.0", .real_ip = "203.0.113.9"});

    ASSERT_EQ(response.system_error, 0);
    ASSERT_EQ(response.status, 200);
    ASSERT_TRUE(response.complete);
    ASSERT_TRUE(fixture.wait_for_audit_records(1));
    const std::string logs = fixture.audit_contents();
    constexpr std::string_view marker = R"("event":"llm_request")";
    const std::size_t marker_pos = logs.find(marker);
    ASSERT_NE(marker_pos, std::string::npos) << logs;
    EXPECT_EQ(logs.find(marker, marker_pos + marker.size()), std::string::npos);
    ASSERT_FALSE(logs.empty());
    ASSERT_EQ(logs.back(), '\n');
    EXPECT_EQ(logs.find('\n'), logs.size() - 1);
    const std::string_view audit_json(logs.data(), logs.size() - 1);
    EXPECT_EQ(audit_json.find('\n'), std::string_view::npos);

    fiber::mem::BufPool pool;
    fiber::json::JsonParser parser;
    ASSERT_TRUE(parser.feed(audit_json.data(), audit_json.size()));
    parser.finish();
    fiber::json::JsonAny root;
    ASSERT_EQ(fiber::json::parse_document(parser, pool, root,
                                          [](fiber::json::JsonParser &value_parser, fiber::mem::BufPool &value_pool,
                                             fiber::json::JsonAny &value) noexcept {
                                              return fiber::json::parse_any(value_parser, value_pool, value);
                                          }),
              fiber::json::ParseStatus::Done);
    ASSERT_TRUE(root.is_object());
    const auto *attempts_json_field = root.as_object().find("attempts_json");
    ASSERT_NE(attempts_json_field, nullptr);
    ASSERT_TRUE(attempts_json_field->value.is_text());
    const auto *rate_limit_json_field = root.as_object().find("rate_limit_json");
    ASSERT_NE(rate_limit_json_field, nullptr);
    EXPECT_TRUE(rate_limit_json_field->value.is_text());
    const auto *usage_json_field = root.as_object().find("usage_json");
    ASSERT_NE(usage_json_field, nullptr);
    EXPECT_TRUE(usage_json_field->value.is_object());
    EXPECT_EQ(root.as_object().find("request"), nullptr);
    EXPECT_EQ(root.as_object().find("provider_attempts"), nullptr);

    fiber::mem::BufPool attempts_pool;
    fiber::json::JsonParser attempts_parser;
    const std::string_view attempts_text = attempts_json_field->value.as_text();
    ASSERT_TRUE(attempts_parser.feed(attempts_text.data(), attempts_text.size()));
    attempts_parser.finish();
    fiber::json::JsonAny parsed_attempts;
    ASSERT_EQ(fiber::json::parse_document(attempts_parser, attempts_pool, parsed_attempts,
                                          [](fiber::json::JsonParser &value_parser, fiber::mem::BufPool &value_pool,
                                             fiber::json::JsonAny &value) noexcept {
                                              return fiber::json::parse_any(value_parser, value_pool, value);
                                          }),
              fiber::json::ParseStatus::Done);
    ASSERT_TRUE(parsed_attempts.is_array());
    ASSERT_EQ(parsed_attempts.as_array().size(), 1u);
    const fiber::json::JsonAny &attempt = parsed_attempts.as_array()[0];
    ASSERT_TRUE(attempt.is_object());
    const auto *upstream_request_id_field = attempt.as_object().find("upstream_request_id");
    ASSERT_NE(upstream_request_id_field, nullptr);
    ASSERT_TRUE(upstream_request_id_field->value.is_text());
    EXPECT_EQ(upstream_request_id_field->value.as_text(), "req-audit-42");

    EXPECT_NE(audit_json.find("answer briefly"), std::string_view::npos);
    EXPECT_NE(audit_json.find("weather in Paris"), std::string_view::npos);
    EXPECT_NE(audit_json.find("look up weather"), std::string_view::npos);
    EXPECT_NE(audit_json.find("weather is sunny"), std::string_view::npos);
    EXPECT_NE(audit_json.find(R"(\"city\":\"Paris\")"), std::string_view::npos);
    EXPECT_NE(audit_json.find(R"("attempts_json":"[{\")"), std::string_view::npos);
    EXPECT_NE(audit_json.find(R"("schema_version":6)"), std::string_view::npos);
    EXPECT_NE(audit_json.find(R"("requested_model":"logical","client_protocol":"openai")"), std::string_view::npos);
    EXPECT_NE(audit_json.find(R"("content_type":"json_text","stream":false,"message_count":2,"tool_count":1)"),
              std::string_view::npos);
    EXPECT_NE(audit_json.find(R"("request_json":"{)"), std::string_view::npos);
    EXPECT_NE(audit_json.find(R"("response_json":"weather is sunny")"), std::string_view::npos);
    EXPECT_NE(audit_json.find(R"("usage_json":{"in_cache":3,"in_nocache":5,"out":6})"), std::string_view::npos);
    EXPECT_EQ(audit_json.find("promptTokens"), std::string_view::npos);
    EXPECT_EQ(audit_json.find("completionTokens"), std::string_view::npos);
    EXPECT_NE(audit_json.find(R"("user_agent":"audit-client/1.0","host":"127.0.0.1","real_ip":"203.0.113.9")"),
              std::string_view::npos);
    EXPECT_NE(audit_json.find(R"("error_json":"")"), std::string_view::npos);
    const std::size_t secret_url = audit_json.find("SECRET_URL");
    ASSERT_NE(secret_url, std::string_view::npos);
    EXPECT_EQ(audit_json.find("SECRET_URL", secret_url + 1), std::string_view::npos);
    const std::size_t secret_base64 = audit_json.find("SECRET_BASE64");
    ASSERT_NE(secret_base64, std::string_view::npos);
    EXPECT_EQ(audit_json.find("SECRET_BASE64", secret_base64 + 1), std::string_view::npos);
}

TEST(LlmProxyIntegrationTest, AggregatesStreamedContentIntoTheSameOutputField) {
    FixtureHarness fixture({
            MockReply{
                    .status = 200,
                    .content_type = "text/event-stream",
                    .chunks =
                            {
                                    "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"hello "
                                    "\"}}]}\n\n",
                                    "data: "
                                    "{\"choices\":[{\"delta\":{\"content\":\"stream\"},\"finish_reason\":\"stop\"}]}"
                                    "\n\n"
                                    "data: [DONE]\n\n",
                            },
                    .stream = true,
            },
    });
    ASSERT_TRUE(fixture.valid());
    const std::string token = issue_token();
    ASSERT_FALSE(token.empty());

    const RawHttpResponse response =
            post_json(fixture.entry_port(), token,
                      R"({"model":"logical","stream":true,"messages":[{"role":"user","content":"say hello"}]})");

    ASSERT_EQ(response.system_error, 0);
    ASSERT_EQ(response.status, 200);
    ASSERT_TRUE(response.complete);
    ASSERT_TRUE(fixture.wait_for_audit_records(1));
    const std::string audit = fixture.audit_contents();
    ASSERT_FALSE(audit.empty());
    EXPECT_EQ(audit.find('\n'), audit.size() - 1);
    EXPECT_NE(audit.find(R"("content_type":"json_text","stream":true,"message_count":1,"tool_count":0)"),
              std::string::npos);
    EXPECT_NE(audit.find(R"("response_json":"hello stream","finish_reason":"stop")"), std::string::npos);
    EXPECT_NE(
            audit.find(
                    R"("output_role":"assistant","output_complete":true,"output_canonical_complete":true,"output_event_count":2)"),
            std::string::npos);
}

TEST(LlmProxyIntegrationTest, PreservesLargeUtf8OutputWithoutTruncation) {
    std::string content;
    content.reserve(90 * 1024);
    for (std::size_t index = 0; index < 30000; ++index) {
        content.append("你");
    }
    content.append("END");
    const std::string provider_body =
            R"({"choices":[{"message":{"role":"assistant","content":")" + content + R"("},"finish_reason":"stop"}]})";
    FixtureHarness fixture({
            MockReply{
                    .status = 200,
                    .body = provider_body,
            },
    });
    ASSERT_TRUE(fixture.valid());
    const std::string token = issue_token();
    ASSERT_FALSE(token.empty());

    const RawHttpResponse response =
            post_json(fixture.entry_port(), token, R"({"model":"logical","messages":[{"role":"user","content":"x"}]})");

    ASSERT_EQ(response.system_error, 0);
    ASSERT_EQ(response.status, 200);
    ASSERT_TRUE(response.complete);
    ASSERT_TRUE(fixture.wait_for_audit_records(1));
    const std::string audit = fixture.audit_contents();
    EXPECT_NE(audit.find(content), std::string::npos);
    EXPECT_NE(audit.find(R"("output_canonical_complete":true)"), std::string::npos);
    EXPECT_EQ(audit.find("\"truncated\""), std::string::npos);
}

TEST(LlmProxyIntegrationTest, AuditGenerationFailureDoesNotChangeTheResponse) {
    FixtureHarness fixture(
            {
                    MockReply{
                            .status = 200,
                            .body = R"({"id":"ok","choices":[{"message":{"role":"assistant","content":"ok"}}]})",
                    },
            },
            false, false, 256);
    ASSERT_TRUE(fixture.valid());
    const std::string token = issue_token();
    ASSERT_FALSE(token.empty());

    const RawHttpResponse response =
            post_json(fixture.entry_port(), token, R"({"model":"logical","messages":[{"role":"user","content":"x"}]})");

    ASSERT_EQ(response.system_error, 0);
    ASSERT_EQ(response.status, 200);
    ASSERT_TRUE(response.complete);
    EXPECT_EQ(fixture.audit_stats().written_records, 0u);
    EXPECT_TRUE(fixture.audit_contents().empty());
    auto metrics = fixture.settlement_metrics();
    ASSERT_TRUE(metrics);
    EXPECT_NE(metrics->find("ai_server_audit_generation_failures_total 1"), std::string::npos);
}

} // namespace
