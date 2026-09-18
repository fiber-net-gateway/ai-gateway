#ifndef FIBER_AI_SERVER_PII_DETECTOR_H
#define FIBER_AI_SERVER_PII_DETECTOR_H

#include <string_view>
#include <vector>

#include "PiiEntity.h"

namespace fiber::ai_server::pii {

// Single-pass detector for deterministic PII entities in plain text:
// mainland-China mobile phone numbers, email addresses, and 18-digit
// resident-ID cards. Detection is regex shape plus checksum/calendar
// confirmation, with score tiers following Presidio's pattern of layered
// evidence. The normative rules and score tiers live in
// docs/pii-detection.md.
//
// Not wired into the request path; this is the detection prototype the
// design document builds on.
class PiiDetector {
public:
    // Returns matches sorted by start offset (then span end); identical
    // spans collapse to the highest score. Thread-safe: compiled programs
    // are function-local statics built once.
    [[nodiscard]] static std::vector<PiiMatch> scan(std::string_view text,
                                                    const PiiScanOptions &options = PiiScanOptions());
};

} // namespace fiber::ai_server::pii

#endif // FIBER_AI_SERVER_PII_DETECTOR_H
