#include <cstring>
#include <gtest/gtest.h>
#include <string>
#include <vector>
#include "config/LlmConfigCodec.h"
#include "protocol/LlmBody.h"
#include "protocol/ResponsesObservation.h"
#include "protocol/SseParser.h"
#include "provider/ExecutionPlan.h"

namespace {
using namespace fiber::ai_server;
fiber::mem::IoBuf buffer(std::string_view text) {
    auto value = fiber::mem::IoBuf::allocate(std::max<std::size_t>(1, text.size()));
    std::memcpy(value.writable_data(), text.data(), text.size());
    value.commit(text.size());
    return value;
}
std::string flatten(const fiber::mem::IoBufChain &chain) {
    std::vector<iovec> parts(chain.size());
    auto count = chain.fill_write_iov(parts.data(), static_cast<int>(parts.size()));
    std::string value;
    for (int i = 0; i < count; ++i)
        value.append(static_cast<const char *>(parts[i].iov_base), parts[i].iov_len);
    return value;
}
TEST(ResponsesProtocolTest, RewritesEveryStateFieldAndRetriesFromOriginalSlices) {
    fiber::mem::BufPool pool;
    auto body = ParsedLlmBody::parse(
            LlmWireProtocol::OpenAiResponses,
            buffer(R"({ "model":"logical","input":[{"type":"function_call_output","call_id":"call_1","output":"tool-secret"}],"store":true,"st\u006fre":null,"background":true,"previous_response_id":{"anything":1},"conversation":"conv_1","stream":null,"unknown":1.2300 })"),
            pool);
    ASSERT_TRUE(body);
    EXPECT_TRUE(body->responses_policy().store_was_true);
    EXPECT_TRUE(body->responses_policy().conversation_removed);
    fiber::mem::IoBufNodePool nodes;
    for (auto model: {"first", "second"}) {
        auto rewritten = body->rewrite(model, false, nodes);
        ASSERT_TRUE(rewritten);
        auto text = flatten(*rewritten);
        EXPECT_EQ(text.find("previous_response_id"), std::string::npos);
        EXPECT_EQ(text.find("conversation"), std::string::npos);
        EXPECT_EQ(text.find("st\\u006fre"), std::string::npos);
        EXPECT_NE(text.find(R"("store":false,"background":false)"), std::string::npos);
        EXPECT_NE(text.find(R"("call_id":"call_1","output":"tool-secret")"), std::string::npos);
        EXPECT_NE(text.find(R"("unknown":1.2300)"), std::string::npos);
        EXPECT_NE(text.find(std::string("\"model\":\"") + model + "\""), std::string::npos);
    }
    EXPECT_FALSE(body->rewrite(std::string(513, 'x'), false, nodes));
}
TEST(ResponsesProtocolTest, RejectsAmbiguousOrStateOnlyRequests) {
    for (std::string_view text:
         {R"({"model":"m"})", R"({"model":"m","input":null})", R"({"model":"","input":"x"})",
          R"({"model":"m","input":"x","store":1})", R"({"model":"m","input":"x","background":"true"})",
          R"({"model":"m","input":"x","m\u006fdel":"n"})", R"({"model":"m","input":"x","input":[]})",
          R"({"model":"m","input":[{"type":"item_reference","id":"item_1"}]})",
          R"({"model":"m","input":[{"type":"message","type":"item_reference"}]})",
          R"({"model":"m","input":"x","stream":1})"}) {
        fiber::mem::BufPool pool;
        EXPECT_FALSE(ParsedLlmBody::parse(LlmWireProtocol::OpenAiResponses, buffer(text), pool)) << text;
    }
}
TEST(ResponsesProtocolTest, AcceptsSelfContainedHistoryAndBoundsMemberMetadata) {
    fiber::mem::BufPool pool;
    EXPECT_TRUE(ParsedLlmBody::parse(
            LlmWireProtocol::OpenAiResponses,
            buffer(R"({"model":"m","input":[{"type":"reasoning","id":"rs_1","encrypted_content":"opaque"},{"type":"message","id":"msg_1","role":"assistant","content":[]},{"type":"function_call","call_id":"c1","arguments":"{}"}]})"),
            pool));
    std::string oversized = R"({"model":"m","input":"x")";
    for (int i = 0; i < 4095; ++i)
        oversized += ",\"x\":0";
    oversized += '}';
    auto bad = ParsedLlmBody::parse(LlmWireProtocol::OpenAiResponses, buffer(oversized), pool);
    ASSERT_FALSE(bad);
    EXPECT_EQ(bad.error().code, LlmBodyErrorCode::TooManyFields);
}
TEST(ResponsesProtocolTest, ObservesTerminalUsageAndPolicyWithoutOutputMaterialization) {
    auto result = observe_responses(
            R"({"object":"response","status":"completed","store":false,"output":[{"text":"opaque"}],"usage":{"input_tokens":12,"output_tokens":5,"input_tokens_details":{"cached_tokens":3}}})",
            false);
    ASSERT_FALSE(result.invalid_json_or_shape);
    ASSERT_TRUE(result.usage);
    EXPECT_EQ(result.terminal, ResponsesTerminal::Completed);
    EXPECT_EQ(result.usage->in_cache, 3);
    EXPECT_EQ(result.usage->in_nocache, 9);
    EXPECT_EQ(result.usage->sum(), 17);
    for (auto field:
         {R"("store":true)", R"("background":true)", R"("conversation":"conv")", R"("previous_response_id":"resp")"}) {
        auto text = std::string(R"({"object":"response","status":"completed",)") + field + "}";
        EXPECT_TRUE(observe_responses(text, false).state_policy_violation);
    }
    for (auto text: {R"({"object":"response","status":"in_progress"})", R"({"status":"completed"})",
                     R"({"object":"response","status":"completed","status":"failed"})", "{} trailing"}) {
        EXPECT_TRUE(observe_responses(text, false).invalid_json_or_shape);
    }
}
TEST(ResponsesProtocolTest, InvalidAndMissingUsageNeverFabricateTotal) {
    for (auto usage: {R"({"input_tokens":2,"output_tokens":1,"input_tokens_details":{"cached_tokens":3}})",
                      R"({"input_tokens":-1,"output_tokens":1})",
                      R"({"input_tokens":2,"output_tokens":1,"input_tokens_details":null})"}) {
        auto result = observe_responses(
                std::string(R"({"object":"response","status":"incomplete","usage":)") + usage + "}", false);
        ASSERT_TRUE(result.usage);
        EXPECT_FALSE(result.usage->sum());
    }
}
TEST(ResponsesProtocolTest, StreamRequiresDelimitedTerminalAndCountsUsageOnce) {
    constexpr auto terminal =
            R"({"type":"response.completed","sequence_number":7,"response":{"object":"response","status":"completed","usage":{"input_tokens":2,"output_tokens":3}}})";
    ResponsesStreamState state;
    EXPECT_TRUE(state.observe(
            observe_responses(
                    R"({"type":"response.created","response":{"object":"response","status":"in_progress","usage":{"input_tokens":100}}})",
                    true),
            true));
    EXPECT_FALSE(state.usage);
    EXPECT_TRUE(state.observe(observe_responses(terminal, true), true));
    EXPECT_TRUE(state.observe(observe_responses(terminal, true), true));
    EXPECT_TRUE(state.finish());
    ASSERT_TRUE(state.usage);
    EXPECT_EQ(state.usage->sum(), 5);
    EXPECT_EQ(state.max_sequence, 7);
    EXPECT_FALSE(
            state.observe(observe_responses(R"({"type":"response.output_text.delta","delta":"late"})", true), true));
    ResponsesStreamState truncated;
    EXPECT_FALSE(truncated.observe(observe_responses(terminal, true), false));
    ResponsesStreamState missing;
    EXPECT_FALSE(missing.finish());
    EXPECT_EQ(missing.failure, "upstream_missing_terminal_event");
}
TEST(ResponsesProtocolTest, SseDelimitersSurviveEveryByteBoundaryAndEofIsNotDelimiter) {
    for (auto suffix: {"\n\n", "\r\n\r\n", "\r\r", ""}) {
        const std::string text = std::string("data: {\"type\":\"error\"}") + suffix;
        for (std::size_t split = 1; split < text.size(); ++split) {
            SseParser parser;
            int events = 0;
            auto drain = [&] {
                SseParseStatus status;
                while ((status = parser.next()) == SseParseStatus::Event) {
                    ++events;
                    EXPECT_EQ(parser.event().ended_by_delimiter, suffix[0] != '\0');
                    EXPECT_EQ(parser.event().data, R"({"type":"error"})");
                }
                EXPECT_NE(status, SseParseStatus::Error);
            };
            auto first = buffer(std::string_view(text).substr(0, split));
            ASSERT_TRUE(parser.feed(first));
            drain();
            auto second = buffer(std::string_view(text).substr(split));
            ASSERT_TRUE(parser.feed(second));
            drain();
            ASSERT_TRUE(parser.finish());
            drain();
            EXPECT_EQ(events, 1);
        }
    }
}
TEST(ResponsesProtocolTest, ConfigurationAndRoutingKeepProtocolsIndependent) {
    auto config = parse_provider_config(
            R"({"data":{"provider":"p","baseurl":"https://provider.invalid","protocol":[{"type":"openai-responses","path":"/v1/responses","model":"upstream"}]}})",
            "md5", "p");
    ASSERT_TRUE(config);
    EXPECT_NE(config->find_protocol(ProviderProtocolType::OpenAiResponses), nullptr);
    EXPECT_EQ(config->find_protocol(ProviderProtocolType::OpenAiChatCompletions), nullptr);
    auto provider = std::make_shared<ProjectProvider>();
    provider->name = "p";
    provider->config = std::make_shared<ProviderConfigSnapshot>(std::move(*config));
    CompiledModelRoute route{.model_name = "logical", .providers = {provider}};
    ProviderRuntimeRegistry runtime;
    fiber::mem::BufPool pool;
    const AuthorizedModel authorized{.model_name = "logical", .route = &route};
    auto responses = resolve_execution_plan(authorized, LlmWireProtocol::OpenAiResponses, {}, runtime, {}, pool);
    ASSERT_TRUE(responses);
    ASSERT_EQ(responses->attempts.size(), 1u);
    EXPECT_EQ(responses->attempts[0].protocol->path, "/v1/responses");
    auto chat = resolve_execution_plan(authorized, LlmWireProtocol::OpenAiChatCompletions, {}, runtime, {}, pool);
    ASSERT_FALSE(chat);
    EXPECT_EQ(chat.error().code, ExecutionPlanErrorCode::ProviderProtocolUnsupported);
    const auto long_model =
            std::string(
                    R"({"data":{"provider":"p","baseurl":"https://provider.invalid","protocol":[{"type":"openai-responses","path":"/v1/responses","model":")") +
            std::string(513, 'x') + R"("}]}})";
    EXPECT_FALSE(parse_provider_config(long_model, "md5", "p"));
}
TEST(ResponsesProtocolTest, AffinityRemainsStableAcrossClientManagedTurns) {
    const std::string first = R"({"model":"m","instructions":"system","input":[{"role":"user","content":"question"}]})";
    const std::string next =
            R"({ "model": "m", "instructions": "system", "store":true,"input":[{"role":"user","content":"question"},{"role":"assistant","content":"answer"},{"role":"user","content":"follow-up"}]})";
    fiber::mem::BufPool first_pool, next_pool;
    auto a = ParsedLlmBody::parse(LlmWireProtocol::OpenAiResponses, buffer(first), first_pool);
    auto b = ParsedLlmBody::parse(LlmWireProtocol::OpenAiResponses, buffer(next), next_pool);
    ASSERT_TRUE(a);
    ASSERT_TRUE(b);
    EXPECT_TRUE(a->routing().prompt_affinity.available);
    EXPECT_EQ(a->routing().prompt_affinity.digest, b->routing().prompt_affinity.digest);
    EXPECT_EQ(a->routing().prompt_affinity.source, PromptRouteKeySource::ResponsesSemanticAnchor);
}
TEST(ResponsesProtocolTest, SemanticDeltaFamiliesAndErrorClassification) {
    for (auto type: {"response.output_text.delta", "response.refusal.delta", "response.function_call_arguments.delta",
                     "response.custom_tool_call_input.delta", "response.reasoning_text.delta",
                     "response.reasoning_summary_text.delta"}) {
        auto result = observe_responses(std::string("{\"type\":\"") + type + "\",\"delta\":\"x\"}", true);
        EXPECT_TRUE(result.output_token_observed);
    }
    EXPECT_FALSE(observe_responses(R"({"type":"response.output_text.delta","delta":""})", true).output_token_observed);
    EXPECT_FALSE(observe_responses(R"({"type":"future.event","opaque":{}})", true).invalid_json_or_shape);
    auto error = observe_responses(
            R"({"type":"error","code":"rate_limit_exceeded","sequence_number":9223372036854775807})", true);
    EXPECT_EQ(error.terminal, ResponsesTerminal::Error);
    EXPECT_EQ(error.error_kind, ResponsesErrorKind::RateLimit);
    EXPECT_TRUE(observe_responses(R"({"type":"response.completed","response":{"object":"response","status":"failed"}})",
                                  true)
                        .invalid_json_or_shape);
}
} // namespace
