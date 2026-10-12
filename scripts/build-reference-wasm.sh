#!/usr/bin/env bash
# Build the upstream-reference libghostty-vt WASM for tests/regression/reference.
#
# The reference is the same pinned, unpatched target as the shipping engine
# (ghostty-build.json targets["libghostty-vt"]); this wrapper keeps the reference
# lane's CLI and output contract on top of scripts/build-wasm.sh.
#
# Usage:
#   scripts/build-reference-wasm.sh <work-dir>
#
# <work-dir> must be outside the ghostty-web checkout or under
# <repo>/.regression-reference/, and missing, empty or previously created by
# these scripts (.ghostty-reference-workdir marker). Symlinked components and
# concurrent builds of the same work dir (.lock) are rejected.
#
# Environment:
#   ZIG_REFERENCE_BIN   Zig binary (exact manifest zigVersion; default: ZIG_0_16_BIN or `zig`).
#   GHOSTTY_REFERENCE_GIT_URL  Remote that serves the pinned SHA (default: manifest gitUrl).
#   GHOSTTY_REFERENCE_EXPECTED_WASM_SHA256  Optional; must agree with the manifest
#                       wasmSha256 (when set) and with the built artifact.
#
# Outputs (published atomically after every check):
#   <work-dir>/out/ghostty-vt.wasm
#   <work-dir>/out/build-info.json
#   <work-dir>/out/reference.env   (bash-sourceable, %q-quoted GHOSTTY_REFERENCE_* vars)
#   <work-dir>/logs/libghostty-vt.log
set -euo pipefail

die() {
  echo "build-reference-wasm: error: $*" >&2
  exit 1
}

[[ $# -eq 1 && -n "$1" ]] ||
  die "usage: $0 <work-dir>   (an explicit scratch/artifact directory is required)"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

if [[ -n "${ZIG_REFERENCE_BIN:-}" ]]; then
  export ZIG_0_16_BIN="$ZIG_REFERENCE_BIN"
fi
if [[ -n "${GHOSTTY_REFERENCE_GIT_URL:-}" ]]; then
  export GHOSTTY_GIT_URL="$GHOSTTY_REFERENCE_GIT_URL"
fi
args=(libghostty-vt --work-dir "$1" --bundle "${1%/}/out")
if [[ -n "${GHOSTTY_REFERENCE_EXPECTED_WASM_SHA256:-}" ]]; then
  args+=(--expect-sha256 "$GHOSTTY_REFERENCE_EXPECTED_WASM_SHA256")
fi
exec "$script_dir/build-wasm.sh" "${args[@]}"
