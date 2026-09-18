#include <gtest/gtest.h>

#include <string>
#include <string_view>
#include <vector>

#include "pii/PiiDetector.h"
#include "pii/PiiEntity.h"

namespace {

using fiber::ai_server::pii::PiiDetector;
using fiber::ai_server::pii::PiiEntityType;
using fiber::ai_server::pii::PiiMatch;
using fiber::ai_server::pii::PiiScanOptions;

struct ExpectedMatch {
    PiiEntityType type;
    std::size_t start;
    std::size_t end;
    float score;
};

void expect_matches(std::string_view text, const std::vector<ExpectedMatch> &expected,
                    const PiiScanOptions &options = PiiScanOptions{}) {
    const std::vector<PiiMatch> matches = PiiDetector::scan(text, options);
    ASSERT_EQ(matches.size(), expected.size()) << "text=" << text;
    for (std::size_t i = 0; i < expected.size(); ++i) {
        EXPECT_EQ(matches[i].type, expected[i].type) << "text=" << text << " index=" << i;
        EXPECT_EQ(matches[i].start, expected[i].start) << "text=" << text << " index=" << i;
        EXPECT_EQ(matches[i].end, expected[i].end) << "text=" << text << " index=" << i;
        EXPECT_FLOAT_EQ(matches[i].score, expected[i].score) << "text=" << text << " index=" << i;
    }
}

void expect_empty(std::string_view text, const PiiScanOptions &options = PiiScanOptions{}) {
    expect_matches(text, {}, options);
}

TEST(PiiDetectorPhone, BareNumber) { expect_matches("13812345678", {{PiiEntityType::ChinaMobilePhone, 0, 11, 0.5F}}); }

TEST(PiiDetectorPhone, PrefixedWithCountryCode) {
    expect_matches("+8613812345678", {{PiiEntityType::ChinaMobilePhone, 0, 14, 0.85F}});
    expect_matches("8613812345678", {{PiiEntityType::ChinaMobilePhone, 0, 13, 0.85F}});
}

TEST(PiiDetectorPhone, SeparatorVariants) {
    expect_matches("138 1234 5678", {{PiiEntityType::ChinaMobilePhone, 0, 13, 0.5F}});
    expect_matches("138-1234-5678", {{PiiEntityType::ChinaMobilePhone, 0, 13, 0.5F}});
    expect_matches("+86 138 1234 5678", {{PiiEntityType::ChinaMobilePhone, 0, 17, 0.85F}});
    expect_matches("86-138-1234-5678", {{PiiEntityType::ChinaMobilePhone, 0, 16, 0.85F}});
}

TEST(PiiDetectorPhone, InsideChineseSentence) {
    // 前缀 6 个汉字 = 18 字节；标点字节都不是 ASCII 数字，边界检查天然通过。
    expect_matches("我的手机号是13812345678，请联系", {{PiiEntityType::ChinaMobilePhone, 18, 29, 0.5F}});
}

TEST(PiiDetectorPhone, FollowedByPunctuation) {
    expect_matches("call 13812345678.", {{PiiEntityType::ChinaMobilePhone, 5, 16, 0.5F}});
    // 分隔符只接受 '-' 和 ' '，括号形式的号码不识别。
    expect_empty("(138)12345678");
}

TEST(PiiDetectorPhone, RejectsDigitAdjacentRuns) {
    // 12 位和 13 位裸数字串：号段可能命中但左右邻是数字，必须弃置。
    expect_empty("913812345678");
    expect_empty("138123456789");
    expect_empty("0138123456789012345678");
}

TEST(PiiDetectorPhone, RejectsInvalidSegmentPrefix) {
    // 第二位限定 [3-9]：12x 不是大陆手机号（13x-19x 均为合法号段）。
    expect_empty("12812345678");
    expect_empty("12345678901");
}

TEST(PiiDetectorPhone, ResidentIdDigitsAreNotAPhone) {
    // 18 位身份证内部不存在通过数字边界检查的 11 位窗口。
    expect_matches("11010519491231002X", {{PiiEntityType::ChinaResidentId, 0, 18, 0.95F}});
}

TEST(PiiDetectorPhone, MultiplePhonesInOrder) {
    expect_matches("13812345678 then +8613912345678",
                   {{PiiEntityType::ChinaMobilePhone, 0, 11, 0.5F}, {PiiEntityType::ChinaMobilePhone, 17, 31, 0.85F}});
}

TEST(PiiDetectorEmail, BasicAndSubdomains) {
    expect_matches("user@example.com", {{PiiEntityType::EmailAddress, 0, 16, 0.8F}});
    expect_matches("a.b@sub.example.co.uk", {{PiiEntityType::EmailAddress, 0, 21, 0.8F}});
}

TEST(PiiDetectorEmail, LocalPartVariants) {
    expect_matches("User+Tag@Mail.Example.COM", {{PiiEntityType::EmailAddress, 0, 25, 0.8F}});
    expect_matches("first_last%foo@x-y.example.org", {{PiiEntityType::EmailAddress, 0, 30, 0.8F}});
}

TEST(PiiDetectorEmail, TrailingPunctuationExcluded) {
    expect_matches("reach me at a@b.com.", {{PiiEntityType::EmailAddress, 12, 19, 0.8F}});
    expect_matches("邮箱a.b@example.com结束", {{PiiEntityType::EmailAddress, 6, 21, 0.8F}});
}

TEST(PiiDetectorEmail, RejectsMalformed) {
    expect_empty("@example.com");
    expect_empty("user@");
    expect_empty("a@@b.com");
    expect_empty("a@b.c");
    expect_empty("hello world");
}

TEST(PiiDetectorResidentId, KnownValidSample) {
    // GB 11643-1999 公开样例，校验码 X。
    expect_matches("11010519491231002X", {{PiiEntityType::ChinaResidentId, 0, 18, 0.95F}});
}

TEST(PiiDetectorResidentId, LowercaseCheckDigit) {
    expect_matches("11010519491231002x", {{PiiEntityType::ChinaResidentId, 0, 18, 0.95F}});
}

TEST(PiiDetectorResidentId, AnotherValidSample) {
    // 序号 001，校验码 1（权重和 165 % 11 == 0）。
    expect_matches("110105194912310011", {{PiiEntityType::ChinaResidentId, 0, 18, 0.95F}});
}

TEST(PiiDetectorResidentId, ChecksumFailureKeptAsWeakSignal) {
    // 结构与日期合法、校验码错误：保留为 0.4 弱信号（Presidio validate_result 语义）。
    expect_matches("110105194912310012", {{PiiEntityType::ChinaResidentId, 0, 18, 0.4F}});
}

TEST(PiiDetectorResidentId, CalendarValidation) {
    // 2023-02-30 不存在于任何年份。
    expect_empty("110105202302300021");
    // 1900 不是闰年，02-29 非法；2000 是闰年，合法。
    expect_empty("110105190002290021");
    expect_matches("110105200002290021", {{PiiEntityType::ChinaResidentId, 0, 18, 0.95F}});
}

TEST(PiiDetectorResidentId, LeadingZeroAndBoundaries) {
    // 地址码首位 0 非法。
    expect_empty("010105194912310021");
    // 左邻/右邻数字或 X 的候选一律弃置。
    expect_empty("9110105194912310021X");
    expect_empty("11010519491231002X8");
}

TEST(PiiDetectorResidentId, MultipleIdsInText) {
    expect_matches("id1: 110105194912310011 id2: 11010519491231002X",
                   {{PiiEntityType::ChinaResidentId, 5, 23, 0.95F}, {PiiEntityType::ChinaResidentId, 29, 47, 0.95F}});
}

TEST(PiiDetector, MixedEntitiesSortedByStart) {
    // 每个汉字 3 字节："发到 " = 7 字节，" 或 " = 5 字节。
    expect_matches("发到 user@example.com 或 13812345678 或 11010519491231002X",
                   {{PiiEntityType::EmailAddress, 7, 23, 0.8F},
                    {PiiEntityType::ChinaMobilePhone, 28, 39, 0.5F},
                    {PiiEntityType::ChinaResidentId, 44, 62, 0.95F}});
}

TEST(PiiDetector, Utf8ByteOffsetsAreExact) {
    // "联系方式" 4 个汉字 = 12 字节，电话号从第 12 字节开始。
    expect_matches("联系方式13812345678谢谢", {{PiiEntityType::ChinaMobilePhone, 12, 23, 0.5F}});
}

TEST(PiiDetector, EmptyAndHarmlessInputs) {
    expect_empty("");
    expect_empty("hello world 12345");
    expect_empty("这段中文没有任何敏感信息");
}

TEST(PiiDetector, MinScoreFilters) {
    PiiScanOptions options;
    options.min_score = 0.6F;
    expect_empty("13812345678", options);
    expect_matches("11010519491231002X", {{PiiEntityType::ChinaResidentId, 0, 18, 0.95F}}, options);
    // 校验码失败的身份证（0.4）被阈值挡住。
    expect_empty("110105194912310012", options);
}

TEST(PiiDetector, EntityToggles) {
    PiiScanOptions no_phone;
    no_phone.phone = false;
    expect_matches("13812345678 user@example.com", {{PiiEntityType::EmailAddress, 12, 28, 0.8F}}, no_phone);

    PiiScanOptions id_only;
    id_only.phone = false;
    id_only.email = false;
    expect_matches("13812345678 user@example.com 11010519491231002X", {{PiiEntityType::ChinaResidentId, 29, 47, 0.95F}},
                   id_only);
}

TEST(PiiDetector, AllTogglesOffYieldsNothing) {
    PiiScanOptions options;
    options.phone = false;
    options.email = false;
    options.resident_id = false;
    expect_empty("13812345678 user@example.com 11010519491231002X", options);
}

TEST(PiiDetector, LargeInputScan) {
    // 约 1MB 文本，3 类实体各嵌入 12000 个；无计时断言，规模本身即冒烟。
    constexpr int kRepeats = 12000;
    const std::string block =
            "contact john.doe+9@example.org or 13812345678 / id 110105194912310011; lorem ipsum dolor ";
    std::string text;
    text.reserve(block.size() * kRepeats);
    for (int i = 0; i < kRepeats; ++i) {
        text += block;
    }
    const std::vector<PiiMatch> matches = PiiDetector::scan(text);
    EXPECT_EQ(matches.size(), static_cast<std::size_t>(kRepeats) * 3);
    // 抽查第一个块与最后一个块的偏移："contact " 8 字节后是邮箱，
    // 邮箱后 " or " 4 字节是手机号，再 " / id " 6 字节是身份证。
    ASSERT_GE(matches.size(), 3);
    EXPECT_EQ(matches[0].type, PiiEntityType::EmailAddress);
    EXPECT_EQ(matches[0].start, 8);
    EXPECT_EQ(matches[1].type, PiiEntityType::ChinaMobilePhone);
    EXPECT_EQ(matches[1].start, 34);
    EXPECT_EQ(matches[2].type, PiiEntityType::ChinaResidentId);
    EXPECT_EQ(matches[2].start, 51);
    EXPECT_EQ(matches.back().type, PiiEntityType::ChinaResidentId);
    EXPECT_EQ(matches.back().start, text.size() - block.size() + 51);
}

} // namespace
