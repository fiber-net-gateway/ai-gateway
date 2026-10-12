#include "LlmBody.h"

#include <cstring>
#include <limits>
#include <utility>

#include <fiber/common/json/JsonEncode.h>

namespace fiber::ai_server {
namespace {

class FixedIoBufSink final : public json::OutputSink {
public:
    explicit FixedIoBufSink(mem::IoBuf &buffer) noexcept : buffer_(&buffer) {}

    [[nodiscard]] bool write(const char *data, std::size_t len) override {
        if (len > buffer_->writable()) {
            return false;
        }
        if (len > 0) {
            std::memcpy(buffer_->writable_data(), data, len);
            buffer_->commit(len);
        }
        return true;
    }

private:
    mem::IoBuf *buffer_ = nullptr;
};

std::expected<mem::IoBuf, LlmBodyError> encode_json_string(std::string_view value) noexcept {
    if (value.size() > (std::numeric_limits<std::size_t>::max() - 2) / 6) {
        return std::unexpected(LlmBodyError{
                .code = LlmBodyErrorCode::InvalidReplacement,
                .message = "replacement string is too large",
        });
    }
    mem::IoBuf encoded = mem::IoBuf::allocate(value.size() * 6 + 2);
    if (!encoded) {
        return std::unexpected(LlmBodyError{
                .code = LlmBodyErrorCode::OutOfMemory,
                .message = "failed to allocate encoded JSON replacement",
        });
    }

    FixedIoBufSink sink(encoded);
    json::Generator generator(sink);
    generator.set_option(json::Generator::Option::ValidateUtf8);
    if (generator.string(value.data(), value.size()) != json::Generator::Result::OK) {
        return std::unexpected(LlmBodyError{
                .code = LlmBodyErrorCode::InvalidReplacement,
                .message = "replacement string is not valid UTF-8",
        });
    }
    return encoded;
}

std::expected<mem::IoBuf, LlmBodyError> encode_json_bool(bool value) noexcept {
    const char *text = value ? "true" : "false";
    const std::size_t len = value ? 4 : 5;
    mem::IoBuf encoded = mem::IoBuf::allocate(len);
    if (!encoded) {
        return std::unexpected(LlmBodyError{
                .code = LlmBodyErrorCode::OutOfMemory,
                .message = "failed to allocate encoded JSON replacement",
        });
    }
    std::memcpy(encoded.writable_data(), text, len);
    encoded.commit(len);
    return encoded;
}

bool append_buffer(mem::IoBufChain &output, mem::IoBuf buffer) noexcept {
    return buffer.readable() == 0 || output.append(std::move(buffer));
}

} // namespace

std::expected<mem::IoBufChain, LlmBodyError> ParsedLlmBody::rewrite(std::string_view upstream_model,
                                                                    std::optional<bool> stream) const noexcept {
    if (!raw_body_) {
        return std::unexpected(LlmBodyError{
                .code = LlmBodyErrorCode::InvalidPatch,
                .message = "request body is unavailable",
        });
    }

    if (protocol_ == LlmWireProtocol::OpenAiResponses && upstream_model.size() > 512) {
        return std::unexpected(LlmBodyError{.code = LlmBodyErrorCode::InvalidReplacement,
                                            .message = "Responses model exceeds 512 bytes"});
    }
    auto encoded_model = encode_json_string(upstream_model);
    if (!encoded_model) {
        return std::unexpected(encoded_model.error());
    }
    std::optional<mem::IoBuf> encoded_stream;
    if (stream || protocol_ == LlmWireProtocol::OpenAiResponses) {
        auto value = encode_json_bool(stream.value_or(false));
        if (!value) {
            return std::unexpected(value.error());
        }
        encoded_stream.emplace(std::move(*value));
    }

    mem::IoBufChain output;
    if (protocol_ == LlmWireProtocol::OpenAiResponses) {
        constexpr std::string_view syntax = "{,\"store\":false,\"background\":false}";
        auto punctuation = mem::IoBuf::allocate(syntax.size());
        if (!punctuation)
            return std::unexpected(LlmBodyError{.code = LlmBodyErrorCode::OutOfMemory});
        std::memcpy(punctuation.writable_data(), syntax.data(), syntax.size());
        punctuation.commit(syntax.size());
        bool first = true;
        if (!output.append(punctuation.retain_slice(0, 1))) {
            return std::unexpected(LlmBodyError{.code = LlmBodyErrorCode::OutOfMemory});
        }
        for (const auto &member: responses_members_) {
            if (member.begin > member.value_begin || member.value_begin > member.end ||
                member.end > raw_body_.readable()) {
                return std::unexpected(LlmBodyError{.code = LlmBodyErrorCode::InvalidPatch});
            }
            if (member.kind == ResponsesMemberKind::Drop)
                continue;
            if (!first && !output.append(punctuation.retain_slice(1, 1))) {
                return std::unexpected(LlmBodyError{.code = LlmBodyErrorCode::OutOfMemory});
            }
            first = false;
            const bool replace =
                    member.kind == ResponsesMemberKind::Model || member.kind == ResponsesMemberKind::Stream;
            const std::size_t end = replace ? member.value_begin : member.end;
            if (!append_buffer(output, raw_body_.retain_slice(member.begin, end - member.begin)) ||
                (replace && !append_buffer(output, member.kind == ResponsesMemberKind::Model ? *encoded_model
                                                                                             : *encoded_stream))) {
                return std::unexpected(LlmBodyError{.code = LlmBodyErrorCode::OutOfMemory});
            }
        }
        const std::size_t start = first ? 2 : 1;
        if (!output.append(punctuation.retain_slice(start, syntax.size() - start))) {
            return std::unexpected(LlmBodyError{.code = LlmBodyErrorCode::OutOfMemory});
        }
        if (output.readable_bytes() > 4 * 1024 * 1024 + 4096) {
            return std::unexpected(LlmBodyError{.code = LlmBodyErrorCode::InvalidReplacement});
        }
        output.mark_complete();
        return output;
    }
    std::size_t cursor = 0;
    for (const LlmBodyPatchSite &site: patch_sites_) {
        const bool replace = site.kind == LlmBodyPatchKind::Model || encoded_stream.has_value();
        if (!replace) {
            continue;
        }
        if (site.begin < cursor || site.end < site.begin || site.end > raw_body_.readable()) {
            return std::unexpected(LlmBodyError{
                    .code = LlmBodyErrorCode::InvalidPatch,
                    .offset = site.begin,
                    .message = "JSON patch spans overlap or exceed the request body",
            });
        }
        if (site.begin > cursor && !append_buffer(output, raw_body_.retain_slice(cursor, site.begin - cursor))) {
            return std::unexpected(LlmBodyError{
                    .code = LlmBodyErrorCode::OutOfMemory,
                    .message = "failed to retain request body slice",
            });
        }

        mem::IoBuf replacement = site.kind == LlmBodyPatchKind::Model ? *encoded_model : *encoded_stream;
        if (!append_buffer(output, std::move(replacement))) {
            return std::unexpected(LlmBodyError{
                    .code = LlmBodyErrorCode::OutOfMemory,
                    .message = "failed to append JSON replacement",
            });
        }
        cursor = site.end;
    }

    if (cursor < raw_body_.readable() &&
        !append_buffer(output, raw_body_.retain_slice(cursor, raw_body_.readable() - cursor))) {
        return std::unexpected(LlmBodyError{
                .code = LlmBodyErrorCode::OutOfMemory,
                .message = "failed to retain request body suffix",
        });
    }
    output.mark_complete();
    return output;
}

} // namespace fiber::ai_server
