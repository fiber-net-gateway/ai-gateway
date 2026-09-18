#ifndef FIBER_AI_SERVER_PII_REGEX_H
#define FIBER_AI_SERVER_PII_REGEX_H

#include <array>
#include <cstddef>
#include <cstdint>
#include <expected>
#include <string>
#include <string_view>
#include <vector>

namespace fiber::ai_server::pii {

// Leftmost-longest regular expression engine over bytes.
//
// The pattern is compiled to a Thompson NFA and simulated in lockstep over
// the input (the approach RE2 uses, see .temp/re2/re2/nfa.cc), so matching
// costs O(len(text) * states) with no backtracking and no exponential
// blowup. Supported syntax:
//   - literals, '.', \d \D \s \S \w \W \n \t \r \f \v, escaped metacharacters
//   - byte classes [...] and [^...] with ranges
//   - groups (...) and (?:...) (groups are not capturing)
//   - alternation '|'
//   - quantifiers * + ? {n} {n,} {n,m} (leftmost-longest semantics make
//     greedy vs. lazy the same match, so only greedy is provided)
// Not supported: anchors, captures, lookaround, backreferences, Unicode
// classes. Patterns that can match the empty string are rejected. The
// engine matches raw bytes; UTF-8 text is safe because every multi-byte
// sequence contains only bytes >= 0x80, which ASCII-only patterns never
// match (see docs/pii-detection.md).
class Regex {
public:
    struct Match {
        std::size_t start = 0;
        std::size_t end = 0;
    };

    Regex() noexcept = default;

    Regex(const Regex &) = delete;
    Regex &operator=(const Regex &) = delete;
    Regex(Regex &&) noexcept = default;
    Regex &operator=(Regex &&) noexcept = default;

    [[nodiscard]] static std::expected<Regex, std::string> compile(std::string_view pattern);

    [[nodiscard]] bool valid() const noexcept { return !program_.empty(); }

    // Finds the leftmost match with the longest span among matches starting
    // at or after `from` (RE2 POSIX semantics, not leftmost-first like PCRE).
    // Returns false when there is no match. `from` may point inside a
    // previously reported match so callers can rescan overlapping candidates.
    [[nodiscard]] bool search(std::string_view text, std::size_t from, Match &out) const noexcept;

private:
    enum class OpCode : std::uint8_t {
        Byte, // consume one byte present in mask, continue at x
        Split, // epsilon: continue at both x and y
        Accept, // epsilon: match complete for the thread reaching this pc
    };

    struct Inst {
        OpCode op = OpCode::Accept;
        std::uint32_t x = 0;
        std::uint32_t y = 0;
        std::array<std::uint64_t, 4> mask{};
    };

    struct Compiler;

    // Program instructions; program_[0] is the entry point.
    std::vector<Inst> program_;
    // Bytes that can begin a match; positions outside this set are skipped
    // when no thread is alive (RE2's prefix accelerator).
    std::array<std::uint64_t, 4> first_{};
};

} // namespace fiber::ai_server::pii

#endif // FIBER_AI_SERVER_PII_REGEX_H
