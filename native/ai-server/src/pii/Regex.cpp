#include "pii/Regex.h"

#include <limits>
#include <optional>

#include <fiber/common/Assert.h>

namespace fiber::ai_server::pii {
namespace {

using ByteSet = std::array<std::uint64_t, 4>;

constexpr void byte_set_add(ByteSet &set, unsigned char byte) noexcept {
    set[byte >> 6] |= (std::uint64_t{1} << (byte & 63));
}

constexpr void byte_set_add_range(ByteSet &set, unsigned char lo, unsigned char hi) noexcept {
    for (unsigned byte = lo; byte <= hi; ++byte) {
        byte_set_add(set, static_cast<unsigned char>(byte));
    }
}

constexpr bool byte_set_has(const ByteSet &set, unsigned char byte) noexcept {
    return ((set[byte >> 6] >> (byte & 63)) & 1) != 0;
}

constexpr ByteSet byte_set_union(const ByteSet &left, const ByteSet &right) noexcept {
    return ByteSet{left[0] | right[0], left[1] | right[1], left[2] | right[2], left[3] | right[3]};
}

constexpr bool byte_set_empty(const ByteSet &set) noexcept { return (set[0] | set[1] | set[2] | set[3]) == 0; }

constexpr void byte_set_negate(ByteSet &set) noexcept {
    for (std::uint64_t &word: set) {
        word = ~word;
    }
}

constexpr ByteSet kDigitSet = [] {
    ByteSet set{};
    byte_set_add_range(set, '0', '9');
    return set;
}();

constexpr ByteSet kSpaceSet = [] {
    ByteSet set{};
    byte_set_add_range(set, '\t', '\r');
    byte_set_add(set, ' ');
    return set;
}();

constexpr ByteSet kWordSet = [] {
    ByteSet set{};
    byte_set_add_range(set, '0', '9');
    byte_set_add_range(set, 'A', 'Z');
    byte_set_add_range(set, 'a', 'z');
    byte_set_add(set, '_');
    return set;
}();

// '.' matches any byte except '\n', matching RE2 and PCRE.
constexpr ByteSet kDotSet = [] {
    ByteSet set{};
    byte_set_add_range(set, 0, 255);
    set['\n' >> 6] &= ~(std::uint64_t{1} << ('\n' & 63));
    return set;
}();

constexpr std::uint32_t kUnbounded = std::numeric_limits<std::uint32_t>::max();
constexpr std::uint32_t kMaxRepeat = 1000;
constexpr std::size_t kMaxProgramSize = 100000;

bool is_ascii_digit(char value) noexcept { return value >= '0' && value <= '9'; }

bool is_ascii_alnum(char value) noexcept {
    return is_ascii_digit(value) || (value >= 'a' && value <= 'z') || (value >= 'A' && value <= 'Z');
}

struct Ast {
    enum class Kind : std::uint8_t {
        Bytes, // leaf: match one byte from set
        Cat, // children in order
        Alt, // children as branches
        Star, // child repeated 0.. times
        Plus, // child repeated 1.. times
        Quest, // child repeated 0..1 times
        Repeat, // child repeated min..max (kUnbounded for open-ended)
    };

    Kind kind = Kind::Bytes;
    ByteSet set{};
    std::uint32_t min = 0;
    std::uint32_t max = 0;
    std::vector<Ast> children;
};

struct FirstInfo {
    ByteSet set{};
    bool nullable = false;
};

FirstInfo first_info(const Ast &node) {
    switch (node.kind) {
        case Ast::Kind::Bytes:
            return FirstInfo{node.set, false};
        case Ast::Kind::Cat: {
            FirstInfo info;
            info.nullable = true;
            for (const Ast &child: node.children) {
                const FirstInfo child_info = first_info(child);
                info.set = byte_set_union(info.set, child_info.set);
                if (!child_info.nullable) {
                    info.nullable = false;
                    break;
                }
            }
            return info;
        }
        case Ast::Kind::Alt: {
            FirstInfo info;
            for (const Ast &child: node.children) {
                const FirstInfo child_info = first_info(child);
                info.set = byte_set_union(info.set, child_info.set);
                info.nullable = info.nullable || child_info.nullable;
            }
            return info;
        }
        case Ast::Kind::Star:
        case Ast::Kind::Quest:
            return FirstInfo{first_info(node.children.front()).set, true};
        case Ast::Kind::Plus:
            return first_info(node.children.front());
        case Ast::Kind::Repeat: {
            const FirstInfo child_info = first_info(node.children.front());
            return FirstInfo{child_info.set, node.min == 0 ? true : child_info.nullable};
        }
    }
    return FirstInfo{};
}

class Parser {
public:
    explicit Parser(std::string_view pattern) noexcept : pattern_(pattern) {}

    std::expected<Ast, std::string> parse() {
        auto alternation = parse_alternation();
        if (!alternation.has_value()) {
            return std::unexpected(std::move(alternation).error());
        }
        if (pos_ != pattern_.size()) {
            return fail<Ast>("unmatched ')'");
        }
        return alternation;
    }

private:
    std::string_view pattern_;
    std::size_t pos_ = 0;

    template<typename T>
    std::expected<T, std::string> fail(std::string_view message) {
        return std::unexpected(std::string{message} + " at byte " + std::to_string(pos_));
    }

    bool at_end() const noexcept { return pos_ >= pattern_.size(); }

    char peek() const noexcept { return pattern_[pos_]; }

    void advance() noexcept { ++pos_; }

    std::expected<Ast, std::string> parse_alternation() {
        std::vector<Ast> branches;
        auto first_branch = parse_concatenation();
        if (!first_branch.has_value()) {
            return std::unexpected(std::move(first_branch).error());
        }
        branches.push_back(std::move(*first_branch));
        while (!at_end() && peek() == '|') {
            advance();
            auto next_branch = parse_concatenation();
            if (!next_branch.has_value()) {
                return std::unexpected(std::move(next_branch).error());
            }
            branches.push_back(std::move(*next_branch));
        }
        if (branches.size() == 1) {
            return std::move(branches.front());
        }
        Ast node;
        node.kind = Ast::Kind::Alt;
        node.children = std::move(branches);
        return node;
    }

    std::expected<Ast, std::string> parse_concatenation() {
        std::vector<Ast> items;
        while (!at_end() && peek() != '|' && peek() != ')') {
            auto item = parse_quantified();
            if (!item.has_value()) {
                return std::unexpected(std::move(item).error());
            }
            items.push_back(std::move(*item));
        }
        if (items.empty()) {
            return fail<Ast>("empty branch");
        }
        if (items.size() == 1) {
            return std::move(items.front());
        }
        Ast node;
        node.kind = Ast::Kind::Cat;
        node.children = std::move(items);
        return node;
    }

    std::expected<Ast, std::string> parse_quantified() {
        auto atom = parse_atom();
        if (!atom.has_value()) {
            return std::unexpected(std::move(atom).error());
        }
        for (;;) {
            if (at_end()) {
                break;
            }
            const char token = peek();
            if (token == '*') {
                advance();
                atom = wrap(Ast::Kind::Star, std::move(*atom));
            } else if (token == '+') {
                advance();
                atom = wrap(Ast::Kind::Plus, std::move(*atom));
            } else if (token == '?') {
                advance();
                atom = wrap(Ast::Kind::Quest, std::move(*atom));
            } else if (token == '{') {
                auto counted = parse_counted();
                if (!counted.has_value()) {
                    return std::unexpected(std::move(counted).error());
                }
                counted->children.push_back(std::move(*atom));
                atom = std::move(counted);
            } else {
                break;
            }
        }
        return atom;
    }

    static Ast wrap(Ast::Kind kind, Ast child) {
        Ast node;
        node.kind = kind;
        node.children.push_back(std::move(child));
        return node;
    }

    std::expected<Ast, std::string> parse_counted() {
        // positioned at '{'
        advance();
        auto minimum = parse_bound();
        if (!minimum.has_value()) {
            return std::unexpected(std::move(minimum).error());
        }
        Ast node;
        node.kind = Ast::Kind::Repeat;
        node.min = *minimum;
        node.max = *minimum;
        if (at_end()) {
            return fail<Ast>("unterminated '{...}'");
        }
        if (peek() == '}') {
            advance();
            return node;
        }
        if (peek() != ',') {
            return fail<Ast>("expected ',' or '}' in repetition");
        }
        advance();
        if (!at_end() && peek() == '}') {
            advance();
            node.max = kUnbounded;
            return node;
        }
        auto maximum = parse_bound();
        if (!maximum.has_value()) {
            return std::unexpected(std::move(maximum).error());
        }
        if (at_end() || peek() != '}') {
            return fail<Ast>("expected '}' in repetition");
        }
        advance();
        if (*minimum > *maximum) {
            return fail<Ast>("repetition minimum exceeds maximum");
        }
        node.max = *maximum;
        return node;
    }

    std::expected<std::uint32_t, std::string> parse_bound() {
        if (at_end() || !is_ascii_digit(peek())) {
            return fail<std::uint32_t>("expected repetition bound");
        }
        std::uint64_t value = 0;
        while (!at_end() && is_ascii_digit(peek())) {
            value = value * 10 + static_cast<std::uint64_t>(peek() - '0');
            if (value > kMaxRepeat) {
                return fail<std::uint32_t>("repetition bound exceeds 1000");
            }
            advance();
        }
        return static_cast<std::uint32_t>(value);
    }

    std::expected<Ast, std::string> parse_atom() {
        if (at_end()) {
            return fail<Ast>("unexpected end of pattern");
        }
        const char token = peek();
        if (token == '(') {
            advance();
            if (!at_end() && peek() == '?') {
                if (pos_ + 1 < pattern_.size() && pattern_[pos_ + 1] == ':') {
                    pos_ += 2;
                } else {
                    return fail<Ast>("unsupported group syntax (groups are not capturing; only (?:...) exists)");
                }
            }
            auto inner = parse_alternation();
            if (!inner.has_value()) {
                return std::unexpected(std::move(inner).error());
            }
            if (at_end() || peek() != ')') {
                return fail<Ast>("missing ')'");
            }
            advance();
            return inner;
        }
        if (token == '[') {
            return parse_class();
        }
        if (token == '.') {
            advance();
            return literal_atom(kDotSet);
        }
        if (token == '\\') {
            return parse_escape();
        }
        if (token == '*' || token == '+' || token == '?' || token == '{') {
            return fail<Ast>("quantifier has nothing to repeat");
        }
        advance();
        ByteSet set{};
        byte_set_add(set, static_cast<unsigned char>(token));
        return literal_atom(set);
    }

    struct ClassItem {
        ByteSet set{};
        bool rangeable = false;
        unsigned char byte = 0;
    };

    std::expected<Ast, std::string> parse_class() {
        // positioned at '['
        advance();
        ByteSet set{};
        bool negated = false;
        if (!at_end() && peek() == '^') {
            negated = true;
            advance();
        }
        bool first = true;
        for (;;) {
            if (at_end()) {
                return fail<Ast>("unterminated '[' class");
            }
            if (peek() == ']' && !first) {
                advance();
                break;
            }
            first = false;
            auto item = parse_class_item();
            if (!item.has_value()) {
                return std::unexpected(std::move(item).error());
            }
            ByteSet piece = item->set;
            if (item->rangeable && !at_end() && peek() == '-' && pos_ + 1 < pattern_.size() &&
                pattern_[pos_ + 1] != ']') {
                advance();
                auto upper = parse_class_item();
                if (!upper.has_value()) {
                    return std::unexpected(std::move(upper).error());
                }
                if (!upper->rangeable) {
                    return fail<Ast>("invalid range endpoint");
                }
                if (item->byte > upper->byte) {
                    return fail<Ast>("class range is out of order");
                }
                piece = ByteSet{};
                byte_set_add_range(piece, item->byte, upper->byte);
            }
            set = byte_set_union(set, piece);
        }
        if (byte_set_empty(set)) {
            return fail<Ast>("empty '[' class");
        }
        if (negated) {
            byte_set_negate(set);
        }
        return literal_atom(set);
    }

    std::expected<ClassItem, std::string> parse_class_item() {
        if (at_end()) {
            return fail<ClassItem>("unterminated '[' class");
        }
        const char token = peek();
        if (token != '\\') {
            advance();
            ClassItem item;
            byte_set_add(item.set, static_cast<unsigned char>(token));
            item.rangeable = true;
            item.byte = static_cast<unsigned char>(token);
            return item;
        }
        advance();
        if (at_end()) {
            return fail<ClassItem>("trailing backslash");
        }
        const char escaped = peek();
        advance();
        switch (escaped) {
            case 'd':
            case 'D':
            case 's':
            case 'S':
            case 'w':
            case 'W': {
                const bool negated = escaped == 'D' || escaped == 'S' || escaped == 'W';
                ByteSet base = escaped == 'd' || escaped == 'D'   ? kDigitSet
                               : escaped == 's' || escaped == 'S' ? kSpaceSet
                                                                  : kWordSet;
                if (negated) {
                    byte_set_negate(base);
                }
                ClassItem item;
                item.set = base;
                return item;
            }
            case 'n':
                return literal_class_item('\n');
            case 't':
                return literal_class_item('\t');
            case 'r':
                return literal_class_item('\r');
            case 'f':
                return literal_class_item('\f');
            case 'v':
                return literal_class_item('\v');
            default:
                if (is_ascii_alnum(escaped)) {
                    return fail<ClassItem>(std::string{"unsupported escape '\\"} + escaped + "'");
                }
                return literal_class_item(escaped);
        }
    }

    static std::expected<ClassItem, std::string> literal_class_item(unsigned char byte) {
        ClassItem item;
        byte_set_add(item.set, byte);
        item.rangeable = true;
        item.byte = byte;
        return item;
    }

    std::expected<Ast, std::string> parse_escape() {
        // positioned at '\'
        advance();
        if (at_end()) {
            return fail<Ast>("trailing backslash");
        }
        const char escaped = peek();
        advance();
        switch (escaped) {
            case 'd':
            case 'D':
            case 's':
            case 'S':
            case 'w':
            case 'W': {
                const bool negated = escaped == 'D' || escaped == 'S' || escaped == 'W';
                ByteSet base = escaped == 'd' || escaped == 'D'   ? kDigitSet
                               : escaped == 's' || escaped == 'S' ? kSpaceSet
                                                                  : kWordSet;
                if (negated) {
                    byte_set_negate(base);
                }
                return literal_atom(base);
            }
            case 'n':
                return literal_atom('\n');
            case 't':
                return literal_atom('\t');
            case 'r':
                return literal_atom('\r');
            case 'f':
                return literal_atom('\f');
            case 'v':
                return literal_atom('\v');
            default:
                if (is_ascii_alnum(escaped)) {
                    return fail<Ast>(std::string{"unsupported escape '\\"} + escaped + "'");
                }
                ByteSet set{};
                byte_set_add(set, static_cast<unsigned char>(escaped));
                return literal_atom(set);
        }
    }

    static std::expected<Ast, std::string> literal_atom(ByteSet set) {
        Ast node;
        node.kind = Ast::Kind::Bytes;
        node.set = set;
        return node;
    }

    static std::expected<Ast, std::string> literal_atom(unsigned char byte) {
        ByteSet set{};
        byte_set_add(set, byte);
        return literal_atom(set);
    }
};

} // namespace

// Compiles the parsed AST into a Thompson NFA program using patch-list
// fragment emission (the technique described in Russ Cox's articles and
// used by RE2, .temp/re2/re2/compile.cc). Every instruction carries an
// explicit successor: Byte continues at x after consuming, Split branches
// to both x and y, Accept terminates. No instruction relies on
// fall-through, so fragment exits are always expressible as patch slots.
struct Regex::Compiler {
    struct Frag {
        std::uint32_t entry = kNoEntry;
        std::vector<std::uint32_t> exits;
    };

    static constexpr std::uint32_t kNoEntry = 0xFFFFFFFF;

    std::vector<Inst> program;
    std::string error;

    std::uint32_t emit(Inst inst) {
        program.push_back(inst);
        return static_cast<std::uint32_t>(program.size() - 1);
    }

    // Points every slot in `slots` at `target` and clears the list: a slot
    // is Split.y or Byte.x (and Jump.x if it existed), each must be patched
    // exactly once.
    void patch(std::vector<std::uint32_t> &slots, std::uint32_t target) {
        for (const std::uint32_t pc: slots) {
            if (program[pc].op == OpCode::Split) {
                program[pc].y = target;
            } else {
                program[pc].x = target;
            }
        }
        slots.clear();
    }

    void concat_into(Frag &into, Frag next) {
        if (into.entry == kNoEntry) {
            into = std::move(next);
            return;
        }
        patch(into.exits, next.entry);
        into.exits.insert(into.exits.end(), next.exits.begin(), next.exits.end());
    }

    std::optional<Frag> emit_ast(const Ast &node) {
        if (program.size() > kMaxProgramSize) {
            error = "pattern compiles to more than 100000 instructions";
            return std::nullopt;
        }
        switch (node.kind) {
            case Ast::Kind::Bytes: {
                Inst inst;
                inst.op = OpCode::Byte;
                inst.mask = node.set;
                const std::uint32_t pc = emit(inst);
                return Frag{pc, {pc}};
            }
            case Ast::Kind::Cat: {
                Frag result;
                for (const Ast &child: node.children) {
                    auto child_frag = emit_ast(child);
                    if (!child_frag.has_value()) {
                        return std::nullopt;
                    }
                    concat_into(result, std::move(*child_frag));
                }
                return result;
            }
            case Ast::Kind::Alt: {
                // Chain: Split(branch_i, Split(branch_i+1, ... , branch_last)).
                // Each branch's exits flow to the alternation's continuation.
                Frag result;
                std::vector<std::uint32_t> split_pcs;
                for (std::size_t i = 0; i + 1 < node.children.size(); ++i) {
                    Inst split;
                    split.op = OpCode::Split;
                    const std::uint32_t split_pc = emit(split);
                    if (i == 0) {
                        result.entry = split_pc;
                    } else {
                        program[split_pcs.back()].y = split_pc;
                    }
                    split_pcs.push_back(split_pc);
                    auto branch = emit_ast(node.children[i]);
                    if (!branch.has_value()) {
                        return std::nullopt;
                    }
                    program[split_pc].x = branch->entry;
                    result.exits.insert(result.exits.end(), branch->exits.begin(), branch->exits.end());
                }
                auto last = emit_ast(node.children.back());
                if (!last.has_value()) {
                    return std::nullopt;
                }
                if (split_pcs.empty()) {
                    result.entry = last->entry;
                } else {
                    program[split_pcs.back()].y = last->entry;
                }
                result.exits.insert(result.exits.end(), last->exits.begin(), last->exits.end());
                return result;
            }
            case Ast::Kind::Star: {
                Inst split;
                split.op = OpCode::Split;
                const std::uint32_t split_pc = emit(split);
                auto body = emit_ast(node.children.front());
                if (!body.has_value()) {
                    return std::nullopt;
                }
                program[split_pc].x = body->entry;
                patch(body->exits, split_pc);
                return Frag{split_pc, {split_pc}};
            }
            case Ast::Kind::Plus: {
                auto body = emit_ast(node.children.front());
                if (!body.has_value()) {
                    return std::nullopt;
                }
                const std::uint32_t body_entry = body->entry;
                Inst split;
                split.op = OpCode::Split;
                const std::uint32_t split_pc = emit(split);
                program[split_pc].x = body_entry;
                patch(body->exits, split_pc);
                return Frag{body_entry, {split_pc}};
            }
            case Ast::Kind::Quest: {
                Inst split;
                split.op = OpCode::Split;
                const std::uint32_t split_pc = emit(split);
                auto body = emit_ast(node.children.front());
                if (!body.has_value()) {
                    return std::nullopt;
                }
                program[split_pc].x = body->entry;
                Frag result{split_pc, {split_pc}};
                result.exits.insert(result.exits.end(), body->exits.begin(), body->exits.end());
                return result;
            }
            case Ast::Kind::Repeat: {
                // {min,max}: min copies, then (max - min) optional copies.
                // {min,}: min copies, then a Star covering the rest.
                Frag result;
                const std::uint32_t copies = node.min;
                for (std::uint32_t i = 0; i < copies; ++i) {
                    auto copy = emit_ast(node.children.front());
                    if (!copy.has_value()) {
                        return std::nullopt;
                    }
                    concat_into(result, std::move(*copy));
                }
                if (node.max == kUnbounded) {
                    Ast star;
                    star.kind = Ast::Kind::Star;
                    star.children.push_back(node.children.front());
                    auto star_frag = emit_ast(star);
                    if (!star_frag.has_value()) {
                        return std::nullopt;
                    }
                    concat_into(result, std::move(*star_frag));
                } else {
                    for (std::uint32_t i = node.min; i < node.max; ++i) {
                        Ast quest;
                        quest.kind = Ast::Kind::Quest;
                        quest.children.push_back(node.children.front());
                        auto quest_frag = emit_ast(quest);
                        if (!quest_frag.has_value()) {
                            return std::nullopt;
                        }
                        concat_into(result, std::move(*quest_frag));
                    }
                }
                return result;
            }
        }
        error = "internal error: unknown AST kind";
        return std::nullopt;
    }
};

std::expected<Regex, std::string> Regex::compile(std::string_view pattern) {
    if (pattern.empty()) {
        return std::unexpected("pattern is empty");
    }
    Parser parser(pattern);
    auto ast = parser.parse();
    if (!ast.has_value()) {
        return std::unexpected(std::move(ast).error());
    }
    const FirstInfo info = first_info(*ast);
    if (info.nullable) {
        return std::unexpected("pattern can match the empty string");
    }
    Compiler compiler;
    auto root = compiler.emit_ast(*ast);
    if (!root.has_value()) {
        return std::unexpected(std::move(compiler.error));
    }
    Inst accept;
    accept.op = OpCode::Accept;
    const std::uint32_t accept_pc = compiler.emit(accept);
    compiler.patch(root->exits, accept_pc);

    Regex regex;
    regex.program_ = std::move(compiler.program);
    regex.first_ = info.set;
    FIBER_ASSERT(regex.program_.front().op == OpCode::Byte || regex.program_.front().op == OpCode::Split);
    return regex;
}

namespace {

struct Thread {
    std::uint32_t pc;
    std::size_t start;
};

struct Scratch {
    std::vector<Thread> current;
    std::vector<Thread> next;
    std::vector<std::uint32_t> stack;
    std::vector<std::uint32_t> marks;
    std::uint32_t generation = 0;
};

} // namespace

bool Regex::search(std::string_view text, std::size_t from, Match &out) const noexcept {
    if (program_.empty() || from > text.size()) {
        return false;
    }
    thread_local Scratch scratch;
    if (scratch.marks.size() != program_.size()) {
        scratch.marks.assign(program_.size(), 0);
        scratch.generation = 0;
    }
    // Threads left over from a previous search would carry starts from
    // outside [from, text.size()] and could report phantom matches.
    scratch.current.clear();
    scratch.next.clear();

    const auto add_thread = [&](std::vector<Thread> &list, std::uint32_t pc, std::size_t start) {
        scratch.stack.clear();
        scratch.stack.push_back(pc);
        while (!scratch.stack.empty()) {
            const std::uint32_t at = scratch.stack.back();
            scratch.stack.pop_back();
            if (scratch.marks[at] == scratch.generation) {
                continue;
            }
            scratch.marks[at] = scratch.generation;
            const Inst &inst = program_[at];
            switch (inst.op) {
                case OpCode::Split:
                    scratch.stack.push_back(inst.x);
                    scratch.stack.push_back(inst.y);
                    break;
                case OpCode::Byte:
                case OpCode::Accept:
                    list.push_back(Thread{at, start});
                    break;
            }
        }
    };

    const std::size_t length = text.size();
    std::size_t position = from;
    bool has_best = false;
    Match best;

    for (;;) {
        if (position >= length && scratch.current.empty()) {
            break;
        }
        if (scratch.current.empty()) {
            // No thread is alive, so no match with an earlier start can
            // appear: an already-found best match is final.
            if (has_best) {
                break;
            }
            // Positions whose byte cannot begin a match are skipped without
            // adding a start thread (RE2's prefix accelerator idea).
            while (position < length && !byte_set_has(first_, static_cast<unsigned char>(text[position]))) {
                ++position;
            }
            if (position >= length) {
                break;
            }
        }

        if (position < length) {
            ++scratch.generation;
            add_thread(scratch.current, 0, position);
        }

        // Threads are appended in nondecreasing start order, and a pc is
        // claimed by the earliest start first, so the surviving candidate
        // is always the leftmost, extended to the longest span.
        for (const Thread &thread: scratch.current) {
            if (program_[thread.pc].op != OpCode::Accept) {
                continue;
            }
            if (!has_best || thread.start < best.start || (thread.start == best.start && position > best.end)) {
                best = Match{thread.start, position};
                has_best = true;
            }
        }

        if (position >= length) {
            break;
        }

        scratch.next.clear();
        ++scratch.generation;
        const unsigned char byte = static_cast<unsigned char>(text[position]);
        for (const Thread &thread: scratch.current) {
            const Inst &inst = program_[thread.pc];
            if (inst.op == OpCode::Byte && byte_set_has(inst.mask, byte)) {
                add_thread(scratch.next, inst.x, thread.start);
            }
        }
        scratch.current.swap(scratch.next);
        ++position;
    }

    if (!has_best) {
        return false;
    }
    out = best;
    return true;
}

} // namespace fiber::ai_server::pii
