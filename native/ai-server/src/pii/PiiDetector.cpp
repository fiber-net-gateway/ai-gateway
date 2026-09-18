#include "pii/PiiDetector.h"

#include <algorithm>
#include <utility>

#include <fiber/common/Assert.h>
#include "Regex.h"

namespace fiber::ai_server::pii {
namespace {

// Normative patterns from docs/pii-detection.md. Boundaries (adjacent
// digits) are checked in code because the engine has no lookaround; this
// also rejects an 11-digit phone embedded inside an 18-digit resident ID,
// where every interior neighbor is a digit.
constexpr std::string_view kPhonePattern = "(?:\\+?86[- ]?)?1[3-9][0-9][- ]?[0-9]{4}[- ]?[0-9]{4}";
constexpr std::string_view kEmailPattern = "[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)*\\.[A-Za-z]{2,}";
constexpr std::string_view kResidentIdPattern =
        "[1-9][0-9]{5}(?:18|19|20)[0-9]{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12][0-9]|3[01])"
        "[0-9]{3}[0-9Xx]";

constexpr float kPhoneBareScore = 0.5F;
constexpr float kPhonePrefixedScore = 0.85F;
constexpr float kEmailScore = 0.8F;
constexpr float kResidentIdStructureScore = 0.5F;
constexpr float kResidentIdWeakScore = 0.4F;
constexpr float kResidentIdChecksumScore = 0.95F;

const Regex &phone_program() {
    static const Regex program = [] {
        auto compiled = Regex::compile(kPhonePattern);
        FIBER_ASSERT(compiled.has_value());
        return std::move(*compiled);
    }();
    return program;
}

const Regex &email_program() {
    static const Regex program = [] {
        auto compiled = Regex::compile(kEmailPattern);
        FIBER_ASSERT(compiled.has_value());
        return std::move(*compiled);
    }();
    return program;
}

const Regex &resident_id_program() {
    static const Regex program = [] {
        auto compiled = Regex::compile(kResidentIdPattern);
        FIBER_ASSERT(compiled.has_value());
        return std::move(*compiled);
    }();
    return program;
}

bool is_digit(unsigned char byte) noexcept { return byte >= '0' && byte <= '9'; }

std::size_t count_digits(std::string_view span) noexcept {
    std::size_t count = 0;
    for (const char value: span) {
        if (is_digit(static_cast<unsigned char>(value))) {
            ++count;
        }
    }
    return count;
}

void scan_phones(std::string_view text, std::vector<PiiMatch> &out) {
    const Regex &program = phone_program();
    std::size_t from = 0;
    for (;;) {
        Regex::Match match;
        if (!program.search(text, from, match)) {
            return;
        }
        const unsigned char before = match.start == 0 ? '\0' : static_cast<unsigned char>(text[match.start - 1]);
        const unsigned char after = match.end >= text.size() ? '\0' : static_cast<unsigned char>(text[match.end]);
        if (!is_digit(before) && !is_digit(after)) {
            // 11 digits: bare number. 13 digits: +86/86 prefix present, a
            // stronger signal because the prefix is country-code shaped.
            const std::size_t digits = count_digits(text.substr(match.start, match.end - match.start));
            const float score = digits > 11 ? kPhonePrefixedScore : kPhoneBareScore;
            out.push_back(PiiMatch{PiiEntityType::ChinaMobilePhone, match.start, match.end, score});
            from = match.end;
        } else {
            from = match.start + 1;
        }
    }
}

void scan_emails(std::string_view text, std::vector<PiiMatch> &out) {
    const Regex &program = email_program();
    std::size_t from = 0;
    for (;;) {
        Regex::Match match;
        if (!program.search(text, from, match)) {
            return;
        }
        out.push_back(PiiMatch{PiiEntityType::EmailAddress, match.start, match.end, kEmailScore});
        from = match.end;
    }
}

// GB 11643-1999 check digit: ISO 7064 MOD 11-2 over the first 17 digits.
constexpr std::int8_t kResidentIdWeights[17] = {7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2};
constexpr std::string_view kResidentIdCheckMap = "10X98765432";

bool resident_id_checksum_ok(std::string_view id) noexcept {
    int sum = 0;
    for (int i = 0; i < 17; ++i) {
        sum += (id[static_cast<std::size_t>(i)] - '0') * kResidentIdWeights[i];
    }
    const char expected = kResidentIdCheckMap[static_cast<std::size_t>(sum % 11)];
    const char actual = id[17];
    return actual == expected || (actual == 'x' && expected == 'X');
}

// The regex only constrains the date shape; a real calendar check decides
// whether the span is ID-shaped at all (2023-02-30 is not).
bool resident_id_date_ok(std::string_view id) noexcept {
    constexpr int kDaysPerMonth[12] = {31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31};
    const int year = (id[6] - '0') * 1000 + (id[7] - '0') * 100 + (id[8] - '0') * 10 + (id[9] - '0');
    const int month = (id[10] - '0') * 10 + (id[11] - '0');
    const int day = (id[12] - '0') * 10 + (id[13] - '0');
    if (month < 1 || month > 12 || day < 1) {
        return false;
    }
    int limit = kDaysPerMonth[static_cast<std::size_t>(month - 1)];
    const bool leap = (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0);
    if (leap && month == 2) {
        limit = 29;
    }
    return day <= limit;
}

void scan_resident_ids(std::string_view text, std::vector<PiiMatch> &out) {
    const Regex &program = resident_id_program();
    std::size_t from = 0;
    for (;;) {
        Regex::Match match;
        if (!program.search(text, from, match)) {
            return;
        }
        const unsigned char before = match.start == 0 ? '\0' : static_cast<unsigned char>(text[match.start - 1]);
        const unsigned char after = match.end >= text.size() ? '\0' : static_cast<unsigned char>(text[match.end]);
        // X/x after the span would extend the sequence, so it also fails
        // the boundary.
        const bool boundary_ok = !is_digit(before) && !is_digit(after) && after != 'X' && after != 'x';
        if (boundary_ok && resident_id_date_ok(text.substr(match.start, 18))) {
            const std::string_view id = text.substr(match.start, 18);
            const float score = resident_id_checksum_ok(id) ? kResidentIdChecksumScore : kResidentIdWeakScore;
            out.push_back(PiiMatch{PiiEntityType::ChinaResidentId, match.start, match.end, score});
            from = match.end;
        } else {
            from = match.start + 1;
        }
    }
}

} // namespace

std::vector<PiiMatch> PiiDetector::scan(std::string_view text, const PiiScanOptions &options) {
    std::vector<PiiMatch> matches;
    if (options.phone) {
        scan_phones(text, matches);
    }
    if (options.email) {
        scan_emails(text, matches);
    }
    if (options.resident_id) {
        scan_resident_ids(text, matches);
    }
    std::sort(matches.begin(), matches.end(), [](const PiiMatch &left, const PiiMatch &right) {
        if (left.start != right.start) {
            return left.start < right.start;
        }
        if (left.end != right.end) {
            return left.end < right.end;
        }
        return left.score > right.score;
    });

    std::vector<PiiMatch> result;
    result.reserve(matches.size());
    for (const PiiMatch &candidate: matches) {
        if (!result.empty() && result.back().start == candidate.start && result.back().end == candidate.end) {
            continue;
        }
        if (candidate.score < options.min_score) {
            continue;
        }
        result.push_back(candidate);
    }
    return result;
}

} // namespace fiber::ai_server::pii
