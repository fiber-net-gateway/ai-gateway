#include <gtest/gtest.h>

#include <cstring>
#include <string>
#include <string_view>
#include <vector>

#include "protocol/LlmBody.h"

namespace {

using fiber::ai_server::LlmBodyErrorCode;
using fiber::ai_server::LlmWireProtocol;
using fiber::ai_server::ParsedLlmBody;
using fiber::mem::BufPool;
using fiber::mem::IoBuf;
using fiber::mem::IoBufChain;
using fiber::mem::IoBufNodePool;

IoBuf make_body(std::string_view text) {
    IoBuf body = IoBuf::allocate(text.size());
    if (!text.empty()) {
        std::memcpy(body.writable_data(), text.data(), text.size());
        body.commit(text.size());
    }
    return body;
}

std::string flatten(const IoBufChain &chain) {
    std::vector<iovec> parts(chain.size());
    const int count = chain.fill_write_iov(parts.data(), static_cast<int>(parts.size()));
    std::string result;
    result.reserve(chain.readable_bytes());
    for (int i = 0; i < count; ++i) {
        result.append(static_cast<const char *>(parts[i].iov_base), parts[i].iov_len);
    }
    return result;
}

TEST(LlmBodyTest, ExtractsOpenAiRoutingFieldsAndRetainsRawBody) {
    constexpr std::string_view input = R"({
  "model": "chat.public",
  "stream": true,
  "metadata": {"routeKey": "ignored", "route_key": "ignored"},
  "prompt_cache_key": "cache-17",
  "messages": [
    {"role": "system", "content": "be concise"},
    {"role": "user", "content": 42},
    {"role": "assistant", "content": [{"type": "text", "text": "hello"}]}
  ]
})";
    BufPool pool;

    auto body = ParsedLlmBody::parse(LlmWireProtocol::OpenAiChatCompletions, make_body(input), pool);

    ASSERT_TRUE(body) << body.error().message;
    const auto &routing = body->routing();
    ASSERT_TRUE(routing.model.is_present());
    EXPECT_EQ(*routing.model, "chat.public");
    ASSERT_TRUE(routing.stream.is_present());
    EXPECT_TRUE(*routing.stream);
    EXPECT_TRUE(routing.direct_route_key.available);
    EXPECT_EQ(routing.direct_route_key.source, fiber::ai_server::PromptRouteKeySource::OpenAiPromptCacheKey);
    EXPECT_TRUE(routing.prompt_affinity.available);
    EXPECT_EQ(routing.prompt_affinity.source, fiber::ai_server::PromptRouteKeySource::OpenAiSemanticAnchor);
    EXPECT_EQ(routing.messages_count, 3u);
    EXPECT_EQ(body->body_size(), input.size());
    EXPECT_EQ(std::string_view(reinterpret_cast<const char *>(body->raw_body().readable_data()),
                               body->raw_body().readable()),
              input);
}

TEST(LlmBodyTest, OpenAiSemanticAnchorStopsAfterFirstUserMessage) {
    constexpr std::string_view first = R"({
        "tools":[{"type":"function","function":{"name":"weather"}}],
        "messages":[
            {"role":"system","content":"rules"},
            {"role":"user","content":"root"}
        ]
    })";
    constexpr std::string_view second = R"({
        "tools":[{"type":"function","function":{"name":"weather"}}],
        "messages":[
            {"role":"system","content":"rules"},
            {"role":"user","content":"root"},
            {"role":"assistant","content":"answer"},
            {"role":"user","content":"continue"}
        ]
    })";
    BufPool first_pool;
    BufPool second_pool;

    auto first_body = ParsedLlmBody::parse(LlmWireProtocol::OpenAiChatCompletions, make_body(first), first_pool);
    auto second_body = ParsedLlmBody::parse(LlmWireProtocol::OpenAiChatCompletions, make_body(second), second_pool);

    ASSERT_TRUE(first_body) << first_body.error().message;
    ASSERT_TRUE(second_body) << second_body.error().message;
    EXPECT_EQ(first_body->routing().prompt_affinity.source,
              fiber::ai_server::PromptRouteKeySource::OpenAiSemanticAnchor);
    EXPECT_EQ(first_body->routing().prompt_affinity.digest, second_body->routing().prompt_affinity.digest);
}

TEST(LlmBodyTest, ProjectSpecificRouteKeysDoNotOverrideProtocolAffinity) {
    constexpr std::string_view openai = R"({
        "metadata":{"route_key":"custom-a","routeKey":"custom-b"},
        "prompt_cache_key":"",
        "messages":[{"role":"user","content":"root"}]
    })";
    constexpr std::string_view anthropic = R"({
        "metadata":{"route_key":"custom-a","routeKey":"custom-b","user_id":""},
        "container":"session-a",
        "messages":[{"role":"user","content":"root"}]
    })";
    BufPool openai_pool;
    BufPool anthropic_pool;

    auto openai_body = ParsedLlmBody::parse(LlmWireProtocol::OpenAiChatCompletions, make_body(openai), openai_pool);
    auto anthropic_body =
            ParsedLlmBody::parse(LlmWireProtocol::AnthropicMessages, make_body(anthropic), anthropic_pool);

    ASSERT_TRUE(openai_body) << openai_body.error().message;
    ASSERT_TRUE(anthropic_body) << anthropic_body.error().message;
    EXPECT_FALSE(openai_body->routing().direct_route_key.available);
    EXPECT_EQ(openai_body->routing().prompt_affinity.source,
              fiber::ai_server::PromptRouteKeySource::OpenAiSemanticAnchor);
    EXPECT_FALSE(anthropic_body->routing().direct_route_key.available);
    EXPECT_EQ(anthropic_body->routing().prompt_affinity.source,
              fiber::ai_server::PromptRouteKeySource::AnthropicConversationAnchor);
}

TEST(LlmBodyTest, ExtractsAnthropicUserIdAndExplicitCacheAnchor) {
    constexpr std::string_view input = R"({
        "model":"claude.public",
        "container":"session-a",
        "metadata":{"user_id":"user-a_account-b_session-c"},
        "system":[{"type":"text","text":"rules","cache_control":{"type":"ephemeral"}}],
        "messages":[
            {"role":"user","content":"hello"},
            {"role":"assistant","content":{"type":"text","text":"world"}}
        ]
    })";
    BufPool pool;

    auto body = ParsedLlmBody::parse(LlmWireProtocol::AnthropicMessages, make_body(input), pool);

    ASSERT_TRUE(body) << body.error().message;
    const auto &routing = body->routing();
    EXPECT_TRUE(routing.direct_route_key.available);
    EXPECT_EQ(routing.direct_route_key.source, fiber::ai_server::PromptRouteKeySource::AnthropicMetadataUserId);
    EXPECT_TRUE(routing.prompt_affinity.available);
    EXPECT_EQ(routing.prompt_affinity.source, fiber::ai_server::PromptRouteKeySource::AnthropicExplicitCacheAnchor);
    EXPECT_EQ(routing.messages_count, 2u);
}

TEST(LlmBodyTest, AnthropicUserIdRemainsStableAsConversationGrows) {
    constexpr std::string_view first = R"({
        "metadata":{"user_id":"user-a_account-b_session-c"},
        "messages":[{"role":"user","content":"start"}]
    })";
    constexpr std::string_view second = R"({
        "metadata":{"user_id":"user-a_account-b_session-c"},
        "messages":[
            {"role":"user","content":"different start"},
            {"role":"assistant","content":"answer"},
            {"role":"user","content":"continue"}
        ]
    })";
    BufPool first_pool;
    BufPool second_pool;

    auto first_body = ParsedLlmBody::parse(LlmWireProtocol::AnthropicMessages, make_body(first), first_pool);
    auto second_body = ParsedLlmBody::parse(LlmWireProtocol::AnthropicMessages, make_body(second), second_pool);

    ASSERT_TRUE(first_body) << first_body.error().message;
    ASSERT_TRUE(second_body) << second_body.error().message;
    EXPECT_EQ(first_body->routing().direct_route_key.source,
              fiber::ai_server::PromptRouteKeySource::AnthropicMetadataUserId);
    EXPECT_EQ(first_body->routing().direct_route_key.digest, second_body->routing().direct_route_key.digest);
    EXPECT_NE(first_body->routing().prompt_affinity.digest, second_body->routing().prompt_affinity.digest);
}

TEST(LlmBodyTest, AnthropicAutomaticAnchorDoesNotMoveWithConversationSuffix) {
    constexpr std::string_view first = R"({
        "model":"claude.public",
        "cache_control":{"type":"ephemeral"},
        "system":[{"type":"text","text":"rules"}],
        "messages":[{"role":"user","content":[{"type":"text","text":"start"}]}]
    })";
    constexpr std::string_view second = R"({
        "model":"claude.public",
        "cache_control":{"type":"ephemeral"},
        "system":[{"type":"text","text":"rules"}],
        "messages":[
            {"role":"user","content":[{"type":"text","text":"start"}]},
            {"role":"assistant","content":[{"type":"text","text":"answer"}]},
            {"role":"user","content":[{"type":"text","text":"continue"}]}
        ]
    })";
    BufPool first_pool;
    BufPool second_pool;

    auto first_body = ParsedLlmBody::parse(LlmWireProtocol::AnthropicMessages, make_body(first), first_pool);
    auto second_body = ParsedLlmBody::parse(LlmWireProtocol::AnthropicMessages, make_body(second), second_pool);

    ASSERT_TRUE(first_body) << first_body.error().message;
    ASSERT_TRUE(second_body) << second_body.error().message;
    EXPECT_EQ(first_body->routing().prompt_affinity.source,
              fiber::ai_server::PromptRouteKeySource::AnthropicAutomaticCacheAnchor);
    EXPECT_EQ(first_body->routing().prompt_affinity.digest, second_body->routing().prompt_affinity.digest);
}

TEST(LlmBodyTest, AnthropicLaterBreakpointUsesStableConversationAnchor) {
    constexpr std::string_view first = R"({
        "system":"rules",
        "messages":[
            {"role":"user","content":"root"},
            {"role":"assistant","content":[
                {"type":"text","text":"first answer","cache_control":{"type":"ephemeral"}}
            ]}
        ]
    })";
    constexpr std::string_view second = R"({
        "system":"rules",
        "messages":[
            {"role":"user","content":"root"},
            {"role":"assistant","content":"different answer"},
            {"role":"user","content":[
                {"type":"text","text":"moving breakpoint","cache_control":{"type":"ephemeral"}}
            ]}
        ]
    })";
    BufPool first_pool;
    BufPool second_pool;

    auto first_body = ParsedLlmBody::parse(LlmWireProtocol::AnthropicMessages, make_body(first), first_pool);
    auto second_body = ParsedLlmBody::parse(LlmWireProtocol::AnthropicMessages, make_body(second), second_pool);

    ASSERT_TRUE(first_body) << first_body.error().message;
    ASSERT_TRUE(second_body) << second_body.error().message;
    EXPECT_EQ(first_body->routing().prompt_affinity.source,
              fiber::ai_server::PromptRouteKeySource::AnthropicExplicitCacheAnchor);
    EXPECT_EQ(second_body->routing().prompt_affinity.source,
              fiber::ai_server::PromptRouteKeySource::AnthropicExplicitCacheAnchor);
    EXPECT_EQ(first_body->routing().prompt_affinity.digest, second_body->routing().prompt_affinity.digest);
}

TEST(LlmBodyTest, AnthropicBreakpointCanMoveFromFirstToLaterMessage) {
    constexpr std::string_view first = R"({
        "system":"rules",
        "messages":[{
            "role":"user",
            "content":[{"type":"text","text":"root","cache_control":{"type":"ephemeral"}}]
        }]
    })";
    constexpr std::string_view second = R"({
        "system":"rules",
        "messages":[
            {"role":"user","content":[{"type":"text","text":"root"}]},
            {"role":"assistant","content":[
                {"type":"text","text":"answer","cache_control":{"type":"ephemeral"}}
            ]}
        ]
    })";
    BufPool first_pool;
    BufPool second_pool;

    auto first_body = ParsedLlmBody::parse(LlmWireProtocol::AnthropicMessages, make_body(first), first_pool);
    auto second_body = ParsedLlmBody::parse(LlmWireProtocol::AnthropicMessages, make_body(second), second_pool);

    ASSERT_TRUE(first_body) << first_body.error().message;
    ASSERT_TRUE(second_body) << second_body.error().message;
    EXPECT_EQ(first_body->routing().prompt_affinity.source,
              fiber::ai_server::PromptRouteKeySource::AnthropicExplicitCacheAnchor);
    EXPECT_EQ(second_body->routing().prompt_affinity.source,
              fiber::ai_server::PromptRouteKeySource::AnthropicExplicitCacheAnchor);
    EXPECT_EQ(first_body->routing().prompt_affinity.digest, second_body->routing().prompt_affinity.digest);
}

TEST(LlmBodyTest, AnthropicExplicitSystemBreakpointExcludesMessages) {
    constexpr std::string_view first = R"({
        "system":[{"cache_control":{"type":"ephemeral"},"type":"text","text":"rules"}],
        "messages":[{"role":"user","content":"first"}]
    })";
    constexpr std::string_view second = R"({
        "messages":[{"role":"user","content":"different"}],
        "system":[{"type":"text","text":"rules","cache_control":{"type":"ephemeral"}}]
    })";
    BufPool first_pool;
    BufPool second_pool;

    auto first_body = ParsedLlmBody::parse(LlmWireProtocol::AnthropicMessages, make_body(first), first_pool);
    auto second_body = ParsedLlmBody::parse(LlmWireProtocol::AnthropicMessages, make_body(second), second_pool);

    ASSERT_TRUE(first_body) << first_body.error().message;
    ASSERT_TRUE(second_body) << second_body.error().message;
    EXPECT_EQ(first_body->routing().prompt_affinity.digest, second_body->routing().prompt_affinity.digest);
    EXPECT_EQ(first_body->routing().prompt_affinity.source,
              fiber::ai_server::PromptRouteKeySource::AnthropicExplicitCacheAnchor);
}

TEST(LlmBodyTest, AnthropicConversationAnchorUsesFirstMessageWithoutCacheControl) {
    constexpr std::string_view first = R"({
        "messages":[{"role":"user","content":"root"}]
    })";
    constexpr std::string_view second = R"({
        "messages":[
            {"role":"user","content":"root"},
            {"role":"assistant","content":"answer"}
        ]
    })";
    BufPool first_pool;
    BufPool second_pool;

    auto first_body = ParsedLlmBody::parse(LlmWireProtocol::AnthropicMessages, make_body(first), first_pool);
    auto second_body = ParsedLlmBody::parse(LlmWireProtocol::AnthropicMessages, make_body(second), second_pool);

    ASSERT_TRUE(first_body) << first_body.error().message;
    ASSERT_TRUE(second_body) << second_body.error().message;
    EXPECT_EQ(first_body->routing().prompt_affinity.source,
              fiber::ai_server::PromptRouteKeySource::AnthropicConversationAnchor);
    EXPECT_EQ(first_body->routing().prompt_affinity.digest, second_body->routing().prompt_affinity.digest);
}

TEST(LlmBodyTest, CountsMessagesAndToolsWithoutBuildingDuplicatePromptParts) {
    constexpr std::string_view input = R"({
        "model":"claude.public",
        "system":[{"type":"text","text":"system rules"}],
        "messages":[{
            "role":"user",
            "content":[
                {"type":"text","text":"visible prompt"},
                {"type":"image","source":{"type":"base64","data":"SECRET_BASE64"}},
                {"type":"document","source":{"type":"url","url":"https://example.test/a?signature=SECRET"}}
            ]
        }],
        "tools":[{"name":"weather","description":"look up weather","input_schema":{"type":"object"}}]
    })";
    BufPool pool;

    auto body = ParsedLlmBody::parse(LlmWireProtocol::AnthropicMessages, make_body(input), pool);

    ASSERT_TRUE(body) << body.error().message;
    const auto &routing = body->routing();
    EXPECT_EQ(routing.messages_count, 1u);
    EXPECT_EQ(routing.tools_count, 1u);
    EXPECT_EQ(body->body_size(), input.size());
    EXPECT_EQ(std::string_view(reinterpret_cast<const char *>(body->raw_body().readable_data()),
                               body->raw_body().readable()),
              input);
}

TEST(LlmBodyTest, RejectsInvalidBodyAndRoutingFieldTypes) {
    BufPool pool;

    auto malformed = ParsedLlmBody::parse(LlmWireProtocol::OpenAiChatCompletions, make_body(R"({"model":"x")"), pool);
    ASSERT_FALSE(malformed);
    EXPECT_EQ(malformed.error().code, LlmBodyErrorCode::InvalidJson);

    auto array_root = ParsedLlmBody::parse(LlmWireProtocol::OpenAiChatCompletions, make_body(R"(["x"])"), pool);
    ASSERT_FALSE(array_root);
    EXPECT_EQ(array_root.error().code, LlmBodyErrorCode::ExpectedObject);

    auto model_number =
            ParsedLlmBody::parse(LlmWireProtocol::OpenAiChatCompletions, make_body(R"({"model":17})"), pool);
    ASSERT_FALSE(model_number);
    EXPECT_EQ(model_number.error().code, LlmBodyErrorCode::InvalidFieldType);
    EXPECT_EQ(model_number.error().field, "$.model");

    auto stream_string =
            ParsedLlmBody::parse(LlmWireProtocol::AnthropicMessages, make_body(R"({"stream":"yes"})"), pool);
    ASSERT_FALSE(stream_string);
    EXPECT_EQ(stream_string.error().code, LlmBodyErrorCode::InvalidFieldType);
    EXPECT_EQ(stream_string.error().field, "$.stream");
}

TEST(LlmBodyTest, RewritesOnlyExistingFieldsAndPreservesOtherBytes) {
    constexpr std::string_view input =
            R"({ "unknown" : [1e+09, "\u0041"], "model" : "public", "stream" : false, "tail":null })";
    BufPool pool;
    IoBufNodePool nodes;
    auto body = ParsedLlmBody::parse(LlmWireProtocol::OpenAiChatCompletions, make_body(input), pool);
    ASSERT_TRUE(body) << body.error().message;

    auto rewritten = body->rewrite("upstream/\"model", true, nodes);

    ASSERT_TRUE(rewritten) << rewritten.error().message;
    EXPECT_EQ(flatten(*rewritten),
              R"({ "unknown" : [1e+09, "\u0041"], "model" : "upstream/\"model", "stream" : true, "tail":null })");
    EXPECT_EQ(std::string_view(reinterpret_cast<const char *>(body->raw_body().readable_data()),
                               body->raw_body().readable()),
              input);
}

TEST(LlmBodyTest, MissingStreamRemainsAbsent) {
    BufPool pool;
    IoBufNodePool nodes;
    auto body = ParsedLlmBody::parse(LlmWireProtocol::OpenAiChatCompletions,
                                     make_body(R"({"model":"public","temperature":0.25})"), pool);
    ASSERT_TRUE(body) << body.error().message;

    auto rewritten = body->rewrite("provider-model", true, nodes);

    ASSERT_TRUE(rewritten) << rewritten.error().message;
    EXPECT_EQ(flatten(*rewritten), R"({"model":"provider-model","temperature":0.25})");
}

TEST(LlmBodyTest, RewritesEveryDuplicateOccurrenceInInputOrder) {
    BufPool pool;
    IoBufNodePool nodes;
    auto body = ParsedLlmBody::parse(LlmWireProtocol::OpenAiChatCompletions,
                                     make_body(R"({"model":"a","stream":false,"model":"b","stream":true})"), pool);
    ASSERT_TRUE(body) << body.error().message;

    auto rewritten = body->rewrite("target", false, nodes);

    ASSERT_TRUE(rewritten) << rewritten.error().message;
    EXPECT_EQ(flatten(*rewritten), R"({"model":"target","stream":false,"model":"target","stream":false})");
}

TEST(LlmBodyTest, CreatesIndependentBodiesForProviderAttempts) {
    constexpr std::string_view input = R"({"model":"public","stream":true,"messages":[]})";
    BufPool pool;
    IoBufNodePool first_nodes;
    IoBufNodePool second_nodes;
    auto body = ParsedLlmBody::parse(LlmWireProtocol::OpenAiChatCompletions, make_body(input), pool);
    ASSERT_TRUE(body) << body.error().message;

    auto first = body->rewrite("provider-a", std::nullopt, first_nodes);
    auto second = body->rewrite("provider-b", false, second_nodes);

    ASSERT_TRUE(first) << first.error().message;
    ASSERT_TRUE(second) << second.error().message;
    EXPECT_EQ(flatten(*first), R"({"model":"provider-a","stream":true,"messages":[]})");
    EXPECT_EQ(flatten(*second), R"({"model":"provider-b","stream":false,"messages":[]})");
    EXPECT_EQ(std::string_view(reinterpret_cast<const char *>(body->raw_body().readable_data()),
                               body->raw_body().readable()),
              input);
}

TEST(LlmBodyTest, RejectsInvalidUtf8Replacement) {
    BufPool pool;
    IoBufNodePool nodes;
    auto body = ParsedLlmBody::parse(LlmWireProtocol::OpenAiChatCompletions, make_body(R"({"model":"public"})"), pool);
    ASSERT_TRUE(body) << body.error().message;
    constexpr char invalid[] = {'x', static_cast<char>(0x80)};

    auto rewritten = body->rewrite(std::string_view(invalid, sizeof(invalid)), std::nullopt, nodes);

    ASSERT_FALSE(rewritten);
    EXPECT_EQ(rewritten.error().code, LlmBodyErrorCode::InvalidReplacement);
}

} // namespace
