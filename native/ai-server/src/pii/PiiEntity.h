#ifndef FIBER_AI_SERVER_PII_ENTITY_H
#define FIBER_AI_SERVER_PII_ENTITY_H

#include <cstddef>
#include <cstdint>

namespace fiber::ai_server::pii {

enum class PiiEntityType : std::uint8_t {
    ChinaMobilePhone,
    EmailAddress,
    ChinaResidentId,
};

struct PiiMatch {
    PiiEntityType type = PiiEntityType::ChinaMobilePhone;
    // Byte offsets into the scanned text, span is [start, end). Offsets are
    // relative to the single content string passed to scan(), not to a JSON
    // document.
    std::size_t start = 0;
    std::size_t end = 0;
    // [0, 1] confidence; tier semantics are normative in docs/pii-detection.md:
    // 0.4 weak (checksum failed), 0.5 plausible (shape only), 0.8..0.85
    // likely, 0.95 confirmed (checksum passed).
    float score = 0.0F;
};

struct PiiScanOptions {
    bool phone = true;
    bool email = true;
    bool resident_id = true;
    // Matches scoring below this threshold are dropped (Presidio's
    // score_threshold semantics). 0 keeps everything.
    float min_score = 0.0F;
};

} // namespace fiber::ai_server::pii

#endif // FIBER_AI_SERVER_PII_ENTITY_H
