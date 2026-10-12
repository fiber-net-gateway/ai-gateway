#include <algorithm>
#include <cstring>
#include <gtest/gtest.h>
#include <string>
#include <vector>

#include "LoopTestSupport.h"
#include "protocol/EmbeddingObservation.h"
#include "provider/ExecutionPlan.h"

namespace {
using namespace fiber::ai_server;
fiber::mem::IoBuf buffer(std::string_view text) {
    auto result = fiber::mem::IoBuf::allocate(std::max<std::size_t>(1, text.size()));
    std::memcpy(result.writable_data(), text.data(), text.size());
    result.commit(text.size());
    return result;
}
std::string response(std::string_view data, std::string_view usage = R"({"prompt_tokens":7,"total_tokens":7})") {
    return std::string(R"({"object":"list","model":"vendor","data":)") + std::string(data) +
           ",\"usage\":" + std::string(usage) + "}";
}
constexpr auto kVector = R"([{"object":"embedding","index":0,"embedding":[0.25,-1.0,3e-4]}])";

TEST(EmbeddingProtocolTest, AcceptsAllInputShapesAndRewritesOnlyModel) {
    test::run_in_loop([&] {
        for (auto input: {R"("hello")", R"(["hello","world"])", "[1,2,3]", "[[1,2],[3]]"}) {
            fiber::mem::BufPool pool;
            const auto original = std::string(R"({ "model":"logical","input":)") + input +
                                  R"(,"dimensions":3,"encoding_format":"base64","user":"u","extra":1.2300 })";
            auto body = ParsedLlmBody::parse(LlmWireProtocol::OpenAiEmbedding, buffer(original), pool);
            ASSERT_TRUE(body) << input;
            EXPECT_FALSE(body->routing().prompt_affinity.available);
            EXPECT_FALSE(body->routing().stream.is_present());
            EXPECT_EQ(body->routing().embedding.dimensions, 3);
            EXPECT_TRUE(body->routing().embedding.base64);
            const auto expected_count =
                    std::string_view(input).starts_with("[\"") || std::string_view(input).starts_with("[[") ? 2 : 1;
            EXPECT_EQ(body->routing().embedding.input_count, expected_count);
            for (auto model: {"first", "second"}) {
                auto rewritten = body->rewrite(model, {});
                ASSERT_TRUE(rewritten);
                std::vector<iovec> parts(rewritten->size());
                const auto size = rewritten->fill_write_iov(parts.data(), static_cast<int>(parts.size()));
                std::string actual;
                for (int i = 0; i < size; ++i)
                    actual.append(static_cast<const char *>(parts[i].iov_base), parts[i].iov_len);
                auto expected = original;
                expected.replace(expected.find("logical"), 7, model);
                EXPECT_EQ(actual, expected);
            }
        }
    });
}
TEST(EmbeddingProtocolTest, RejectsInvalidInputAndCriticalDuplicates) {
    for (auto input: {"null", "true", "{}", "[]", "\"\"", "[\"\"]", "[[]]", "[-1]", "[1.5]", "[1,\"a\"]", "[\"a\",[1]]",
                      "[[1],[]]", "[[true]]"}) {
        fiber::mem::BufPool pool;
        auto body = ParsedLlmBody::parse(LlmWireProtocol::OpenAiEmbedding,
                                         buffer(std::string(R"({"model":"logical","input":)") + input + "}"), pool);
        ASSERT_FALSE(body) << input;
        EXPECT_EQ(body.error().field, "input");
    }
    for (auto fields: {R"("stream":false)", R"("dimensions":0)", R"("dimensions":1.5)", R"("user":null)",
                       R"("encoding_format":"other")", R"("inpu\u0074":"again")", R"("model":"again")"}) {
        fiber::mem::BufPool pool;
        EXPECT_FALSE(ParsedLlmBody::parse(LlmWireProtocol::OpenAiEmbedding,
                                          buffer(std::string(R"({"model":"logical","input":"hello",)") + fields + "}"),
                                          pool))
                << fields;
    }
    for (auto input: {"{}", R"({"input":"hello"})", R"({"model":"logical"})", R"({"model":null,"input":"hello"})"}) {
        fiber::mem::BufPool pool;
        EXPECT_FALSE(ParsedLlmBody::parse(LlmWireProtocol::OpenAiEmbedding, buffer(input), pool));
    }
}
TEST(EmbeddingProtocolTest, BatchBoundDoesNotLimitSingleTokenSequenceTo2048Tokens) {
    const std::string prefix = R"({"model":"logical","input":[)";
    for (auto item: {"1", "\"x\"", "[1]"}) {
        std::string input = prefix;
        for (std::size_t i = 0; i < 2048; ++i) {
            if (i)
                input += ',';
            input += item;
        }
        fiber::mem::BufPool pool;
        EXPECT_TRUE(ParsedLlmBody::parse(LlmWireProtocol::OpenAiEmbedding, buffer(input + "]}"), pool));
        input += ',';
        input += item;
        EXPECT_EQ(ParsedLlmBody::parse(LlmWireProtocol::OpenAiEmbedding, buffer(input + "]}"), pool).has_value(),
                  std::string_view(item) == "1");
    }
}
TEST(EmbeddingProtocolTest, CountsInputOnlyAndValidatesVectorShape) {
    const EmbeddingRequestInfo request{.input_count = 1, .dimensions = 3};
    const auto result = observe_embedding(response(kVector), request);
    ASSERT_FALSE(result.invalid_response);
    ASSERT_TRUE(result.usage);
    EXPECT_EQ(result.usage->in_cache, 0);
    EXPECT_EQ(result.usage->in_nocache, 7);
    EXPECT_EQ(result.usage->out, 0);
    EXPECT_EQ(result.usage->sum(), 7);
    for (auto data:
         {"[]", R"([{"index":0,"embedding":[1,2,3]}])", R"([{"object":"embedding","index":1,"embedding":[1,2,3]}])",
          R"([{"object":"embedding","index":0,"embedding":[1,2]}])",
          R"([{"object":"embedding","index":0,"embedding":[1,null,3]}])",
          R"([{"object":"embedding","index":0,"index":0,"embedding":[1,2,3]}])"})
        EXPECT_TRUE(observe_embedding(response(data), request).invalid_response) << data;
    EXPECT_TRUE(observe_embedding(response(kVector) + "trailing", request).invalid_response);
    auto truncated = response(kVector);
    truncated.pop_back();
    EXPECT_TRUE(observe_embedding(truncated, request).invalid_response);
}
TEST(EmbeddingProtocolTest, BoundsRootFieldsAndExtensionNesting) {
    for (const std::size_t depth: {64u, 65u}) {
        const auto input = std::string(R"({"model":"logical","input":"hello","extra":)") + std::string(depth, '[') +
                           "0" + std::string(depth, ']') + "}";
        fiber::mem::BufPool pool;
        EXPECT_EQ(ParsedLlmBody::parse(LlmWireProtocol::OpenAiEmbedding, buffer(input), pool).has_value(), depth == 64);
    }
    for (const std::size_t fields: {4096u, 4097u}) {
        std::string input = R"({"model":"logical","input":"hello")";
        for (std::size_t i = 2; i < fields; ++i)
            input += ",\"extra\":0";
        input += '}';
        fiber::mem::BufPool pool;
        auto parsed = ParsedLlmBody::parse(LlmWireProtocol::OpenAiEmbedding, buffer(input), pool);
        EXPECT_EQ(parsed.has_value(), fields == 4096);
        if (fields > 4096)
            EXPECT_EQ(parsed.error().code, LlmBodyErrorCode::TooManyFields);
    }
}
TEST(EmbeddingProtocolTest, RequiresConsistentBatchDimensionsAndFiniteVectors) {
    for (auto data:
         {R"([{"object":"embedding","index":0,"embedding":[1,2]},{"object":"embedding","index":1,"embedding":[3]}])",
          R"([{"object":"embedding","index":0,"embedding":[]},{"object":"embedding","index":1,"embedding":[]}])",
          R"([{"object":"embedding","index":0,"embedding":[1e999]},{"object":"embedding","index":1,"embedding":[2]}])"})
        EXPECT_TRUE(observe_embedding(response(data), {.input_count = 2}).invalid_response) << data;
}
TEST(EmbeddingProtocolTest, UnknownUsageNeverFabricatesZeroConsumption) {
    for (auto usage:
         {"null", "{}", R"({"prompt_tokens":7})", R"({"prompt_tokens":7,"total_tokens":8})",
          R"({"prompt_tokens":-1,"total_tokens":-1})", R"({"prompt_tokens":7,"prompt_tokens":7,"total_tokens":7})",
          R"({"prompt_tokens":9223372036854775808,"total_tokens":9223372036854775808})"}) {
        auto result = observe_embedding(response(kVector, usage), {.input_count = 1});
        EXPECT_FALSE(result.invalid_response) << usage;
        EXPECT_FALSE(result.usage) << usage;
    }
}
TEST(EmbeddingProtocolTest, ValidatesBase64WithoutDecodingAndPreservesIndexOrder) {
    auto data =
            R"([{"object":"embedding","index":1,"embedding":"AACAPw=="},{"object":"embedding","index":0,"embedding":"AAAAAA=="}])";
    EXPECT_FALSE(
            observe_embedding(response(data), {.input_count = 2, .dimensions = 1, .base64 = true}).invalid_response);
    EXPECT_TRUE(
            observe_embedding(response(data), {.input_count = 2, .dimensions = 2, .base64 = true}).invalid_response);
    EXPECT_TRUE(observe_embedding(response(data), {.input_count = 2}).invalid_response);
    for (auto encoded: {"", "!!!=", "AAA=", "AAAAAB==", "AA==AAAA", "AAAAAAA"}) {
        const auto item = std::string(R"([{"object":"embedding","index":0,"embedding":")") + encoded + "\"}]";
        EXPECT_TRUE(observe_embedding(response(item), {.input_count = 1, .base64 = true}).invalid_response);
    }
    EXPECT_TRUE(
            observe_embedding(
                    response(
                            R"([{"object":"embedding","index":0,"embedding":[1]},{"object":"embedding","index":0,"embedding":[2]}])"),
                    {.input_count = 2})
                    .invalid_response);
}
TEST(EmbeddingProtocolTest, ExecutionPlanRejectsIncompatibleModelsEvenWhenCandidateIsUnavailable) {
    auto config = std::make_shared<ProviderConfigSnapshot>();
    config->name = "one";
    config->protocols.push_back({.type = ProviderProtocolType::OpenAiEmbedding, .path = "/embeddings", .model = "a"});
    auto first = std::make_shared<ProjectProvider>();
    first->name = "one";
    first->config = config;
    auto other = std::make_shared<ProviderConfigSnapshot>(*config);
    other->name = "two";
    other->protocols[0].model = "b";
    auto second = std::make_shared<ProjectProvider>();
    second->name = "two";
    second->config = other;
    CompiledModelRoute route;
    route.providers = {first};
    route.fallback_provider = second;
    AuthorizedModel model;
    model.route = &route;
    ProviderRuntimeRegistry runtime;
    runtime.state_for("two").mark_provider_unavailable({}, std::chrono::seconds(30));
    fiber::mem::BufPool pool;
    auto result = resolve_execution_plan(model, LlmWireProtocol::OpenAiEmbedding, {}, runtime, {}, pool);
    ASSERT_FALSE(result);
    EXPECT_EQ(result.error().code, ExecutionPlanErrorCode::IncompatibleEmbeddingModels);
    route.load_balance.fallback_enabled = false;
    result = resolve_execution_plan(model, LlmWireProtocol::OpenAiEmbedding, {}, runtime, {}, pool);
    ASSERT_TRUE(result);
    ASSERT_EQ(result->attempts.size(), 1u);
    EXPECT_EQ(result->attempts[0].protocol->type, ProviderProtocolType::OpenAiEmbedding);
    auto unsupported = resolve_execution_plan(model, LlmWireProtocol::OpenAiChatCompletions, {}, runtime, {}, pool);
    ASSERT_FALSE(unsupported);
    EXPECT_EQ(unsupported.error().code, ExecutionPlanErrorCode::ProviderProtocolUnsupported);
}
} // namespace
