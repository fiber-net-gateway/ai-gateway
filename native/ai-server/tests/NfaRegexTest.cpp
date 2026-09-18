#include <gtest/gtest.h>

#include <string>
#include <string_view>

#include "pii/Regex.h"

namespace {

using fiber::ai_server::pii::Regex;

Regex compile_or_die(std::string_view pattern) {
    auto compiled = Regex::compile(pattern);
    EXPECT_TRUE(compiled.has_value());
    if (!compiled.has_value()) {
        return Regex{};
    }
    return std::move(*compiled);
}

void expect_match(std::string_view pattern, std::string_view text, std::size_t start, std::size_t end) {
    const Regex regex = compile_or_die(pattern);
    ASSERT_TRUE(regex.valid());
    Regex::Match match;
    ASSERT_TRUE(regex.search(text, 0, match)) << "pattern=" << pattern << " text=" << text;
    EXPECT_EQ(match.start, start) << "pattern=" << pattern << " text=" << text;
    EXPECT_EQ(match.end, end) << "pattern=" << pattern << " text=" << text;
}

void expect_no_match(std::string_view pattern, std::string_view text) {
    const Regex regex = compile_or_die(pattern);
    ASSERT_TRUE(regex.valid());
    Regex::Match match;
    EXPECT_FALSE(regex.search(text, 0, match)) << "pattern=" << pattern << " text=" << text;
}

void expect_compile_error(std::string_view pattern) {
    auto compiled = Regex::compile(pattern);
    EXPECT_FALSE(compiled.has_value()) << "pattern=" << pattern;
}

TEST(NfaRegex, FindsLiteralInsideText) {
    expect_match("abc", "xxabcxx", 2, 5);
    expect_match("abc", "abc", 0, 3);
    expect_no_match("abc", "abx");
}

TEST(NfaRegex, EmptyProgramNeverMatches) {
    const Regex regex;
    EXPECT_FALSE(regex.valid());
    Regex::Match match;
    EXPECT_FALSE(regex.search("abc", 0, match));
}

TEST(NfaRegex, DotMatchesAnyByteExceptNewline) {
    expect_match("a.c", "abc", 0, 3);
    expect_match("a.c", "a c", 0, 3);
    expect_no_match("a.c", "a\nc");
}

TEST(NfaRegex, ByteClassWithRanges) {
    expect_match("[a-c]+", "zzabccq", 2, 6);
    expect_match("[0-9]{4}", "x12345", 1, 5);
    expect_no_match("[0-9]", "xyz");
}

TEST(NfaRegex, NegatedByteClass) {
    expect_match("[^0-9]+", "12ab3", 2, 4);
    expect_match("[^a]", "\n", 0, 1);
}

TEST(NfaRegex, NegatedClassEscapeOutsideClass) {
    expect_match("\\D+", "12ab", 2, 4);
    expect_no_match("\\d", "abc");
}

TEST(NfaRegex, AlternationPicksLeftmostLongest) {
    // PCRE leftmost-first would return "a"; leftmost-longest returns "ab".
    expect_match("a|ab", "ab", 0, 2);
    expect_match("ab|a", "ab", 0, 2);
    expect_match("abc|b", "zabc", 1, 4);
    expect_match("bc|de", "ade", 1, 3);
    expect_match("a|b|c", "tbq", 1, 2);
}

TEST(NfaRegex, Quantifiers) {
    expect_match("a+", "baaab", 1, 4);
    expect_match("a*b", "b", 0, 1);
    expect_match("a*b", "aaab", 0, 4);
    expect_match("ab?c", "ac", 0, 2);
    expect_match("ab?c", "abc", 0, 3);
    expect_match("a{3}", "aaaa", 0, 3);
    expect_match("a{2,3}", "aaaa", 0, 3);
    expect_match("a{2,}", "aaaaa", 0, 5);
    expect_match("a{2,}", "baab", 1, 3);
    expect_no_match("a{2,3}", "ab");
    // {n,} 的下界就是 n：单个 a 不构成 a{2,}。
    expect_no_match("a{2,}", "xa");
    expect_no_match("a{3}", "xa");
}

TEST(NfaRegex, StackedQuantifiers) {
    expect_match("a{2}+", "aaaa", 0, 4);
    expect_match("a{2,}+", "aaaa", 0, 4);
}

TEST(NfaRegex, GroupsAreNotCapturingButGroup) {
    expect_match("(?:ab|cd)+", "abcd", 0, 4);
    expect_match("(ab)(cd)", "zabcd", 1, 5);
    expect_match("(a(b))+", "abab", 0, 4);
    expect_match("(?:a|b)c", "bc", 0, 2);
}

TEST(NfaRegex, Escapes) {
    expect_match("\\d{3}", "x123", 1, 4);
    expect_match("\\w+@\\w+", "user@host", 0, 9);
    expect_match("a\\sb", "a b", 0, 3);
    expect_match("a\\tb", "a\tb", 0, 3);
    expect_match("a\\.b", "a.b", 0, 3);
    expect_no_match("a\\.b", "axb");
    expect_match("\\+86", "+86", 0, 3);
    expect_match("\\[x\\]", "[x]", 0, 3);
}

TEST(NfaRegex, ClassEscapesAndEdgeCases) {
    expect_match("[\\d]+", "ab123", 2, 5);
    expect_match("[\\w.]+", "ab.c", 0, 4);
    expect_match("[-a]+", "x-a", 1, 3);
    expect_match("[a-]+", "xa-", 1, 3);
    expect_match("[]]+", "a]]", 1, 3);
    expect_match("[^\\d]+", "12xy", 2, 4);
}

TEST(NfaRegex, SearchResumesFromOffset) {
    const Regex regex = compile_or_die("ab");
    Regex::Match match;
    ASSERT_TRUE(regex.search("abab", 0, match));
    EXPECT_EQ(match.start, 0);
    EXPECT_EQ(match.end, 2);
    ASSERT_TRUE(regex.search("abab", 2, match));
    EXPECT_EQ(match.start, 2);
    EXPECT_EQ(match.end, 4);
    EXPECT_FALSE(regex.search("abab", 3, match));
    // Leftmost wins even when a later occurrence is longer.
    const Regex alts = compile_or_die("b|ab");
    ASSERT_TRUE(alts.search("zab", 0, match));
    EXPECT_EQ(match.start, 1);
    EXPECT_EQ(match.end, 3);
}

TEST(NfaRegex, SearchFromBeyondEndFails) {
    const Regex regex = compile_or_die("a");
    Regex::Match match;
    EXPECT_FALSE(regex.search("a", 2, match));
    EXPECT_FALSE(regex.search("", 0, match));
}

TEST(NfaRegex, FirstSetSkipFindsLaterMatches) {
    // Exercises the prefix accelerator: whole stretches of text hold no
    // possible start byte.
    expect_match("bc|de", "xxxxxbcy", 5, 7);
    expect_match("bc|de", "xxxaxxxdex", 7, 9);
    expect_no_match("bc|de", "abxdyf");
}

TEST(NfaRegex, LongestAcrossAlternationBranches) {
    expect_match("(?:a|ab)(?:c|bcd)", "abcd", 0, 4);
    expect_match("a+|b+", "xxbbbb", 2, 6);
}

TEST(NfaRegex, CompileRejectsMalformedPatterns) {
    expect_compile_error("");
    expect_compile_error("(");
    expect_compile_error("(a");
    expect_compile_error("a)");
    expect_compile_error("[");
    expect_compile_error("[a");
    expect_compile_error("[]");
    expect_compile_error("*a");
    expect_compile_error("a|");
    expect_compile_error("|a");
    expect_compile_error("a{3,2}");
    expect_compile_error("a{2,");
    expect_compile_error("a{,2}");
    expect_compile_error("a{1001}");
    expect_compile_error("a\\");
    expect_compile_error("a\\q");
    expect_compile_error("(?=a)");
    expect_compile_error("(?<name>a)");
    expect_compile_error("a\\b");
}

TEST(NfaRegex, CompileRejectsNullablePatterns) {
    expect_compile_error("a*");
    expect_compile_error("a?");
    expect_compile_error("a{0,3}");
    expect_compile_error("(?:a?)*");
}

TEST(NfaRegex, AcceptsPiiDetectorPatterns) {
    EXPECT_TRUE(compile_or_die("(?:\\+?86[- ]?)?1[3-9][0-9][- ]?[0-9]{4}[- ]?[0-9]{4}").valid());
    EXPECT_TRUE(compile_or_die("[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}").valid());
    EXPECT_TRUE(compile_or_die("[1-9][0-9]{5}(?:18|19|20)[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])"
                               "[0-9]{3}[0-9Xx]")
                        .valid());
}

TEST(NfaRegex, Utf8TextWithAsciiPattern) {
    // 多字节 UTF-8 序列的每个字节都 >= 0x80，纯 ASCII 模式永远不会命中它们。
    expect_match("[0-9]+", "订单号12345已生成", 9, 14);
    expect_no_match("[a-z]+", "中文文本");
}

} // namespace
