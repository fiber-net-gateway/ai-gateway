#!/usr/bin/env bash

set -euo pipefail

# Prefer a recent clang-format. The repo targets C++23, and older versions
# (especially anything < 17) mangle the formatting. Search highest-first; fall
# back to whatever `clang-format` resolves to on PATH only if no suffixed
# binary is found.
CLANG_FORMAT=""
FORMAT_ALL=0
CODE_PATHS=(
    ":(glob)native/ai-server/**/*.c"
    ":(glob)native/ai-server/**/*.cc"
    ":(glob)native/ai-server/**/*.cpp"
    ":(glob)native/ai-server/**/*.cxx"
    ":(glob)native/ai-server/**/*.h"
    ":(glob)native/ai-server/**/*.hh"
    ":(glob)native/ai-server/**/*.hpp"
    ":(glob)native/ai-server/**/*.hxx"
)

usage() {
    cat <<'EOF'
Usage: ./format_code.sh [-a]

Formats changed native ai-server code files by default.

Options:
  -a    Format all native ai-server code files, including unchanged files.
EOF
}

while getopts ":ah" opt; do
    case "${opt}" in
        a)
            FORMAT_ALL=1
            ;;
        h)
            usage
            exit 0
            ;;
        \?)
            echo "format_code.sh: unknown option: -${OPTARG}" >&2
            usage >&2
            exit 2
            ;;
    esac
done
shift $((OPTIND - 1))

if (( $# != 0 )); then
    echo "format_code.sh: unexpected argument: $1" >&2
    usage >&2
    exit 2
fi

for version in 22 21 20 19 18 17; do
    if command -v "clang-format-${version}" >/dev/null 2>&1; then
        CLANG_FORMAT="clang-format-${version}"
        break
    fi
done

if [[ -z "${CLANG_FORMAT}" ]]; then
    if ! command -v clang-format >/dev/null 2>&1; then
        echo "format_code.sh: no clang-format binary found on PATH" >&2
        exit 1
    fi
    CLANG_FORMAT="clang-format"
fi

echo "format_code.sh: using $(${CLANG_FORMAT} --version)"

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "${REPO_ROOT}"

declare -A seen=()
files=()

add_file() {
    local path="$1"

    if [[ -f "${path}" ]] && [[ -z "${seen[${path}]+x}" ]]; then
        seen["${path}"]=1
        files+=("${path}")
    fi
}

if (( FORMAT_ALL == 1 )); then
    while IFS= read -r -d '' path; do
        add_file "${path}"
    done < <(git ls-files -z -- "${CODE_PATHS[@]}")
else
    while IFS= read -r -d '' path; do
        add_file "${path}"
    done < <(git diff --name-only -z --diff-filter=ACMRT HEAD -- "${CODE_PATHS[@]}")
fi

while IFS= read -r -d '' path; do
    add_file "${path}"
done < <(git ls-files --others --exclude-standard -z -- "${CODE_PATHS[@]}")

if (( ${#files[@]} == 0 )); then
    if (( FORMAT_ALL == 1 )); then
        echo "format_code.sh: no native ai-server code files to format"
    else
        echo "format_code.sh: no changed native ai-server code files to format"
    fi
    exit 0
fi

if (( FORMAT_ALL == 1 )); then
    printf 'format_code.sh: formatting %d native ai-server code file(s)\n' "${#files[@]}"
else
    printf 'format_code.sh: formatting %d changed native ai-server code file(s)\n' "${#files[@]}"
fi
printf '  %s\n' "${files[@]}"

"${CLANG_FORMAT}" -i -- "${files[@]}"
