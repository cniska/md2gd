#!/usr/bin/env bash
# Smoke-test the compiled binary: it must start, report itself, and fail cleanly
# on an unconfigured run. No network or Google auth involved.
set -euo pipefail

BIN="${1:-./md2gd}"

[ -x "$BIN" ] || { echo "smoke: binary not found or not executable: $BIN"; exit 1; }

# --version prints "md2gd v<version>"
"$BIN" --version | grep -q "md2gd v" || { echo "smoke: --version output unexpected"; exit 1; }

# --help and a bare invocation both exit 0 and show usage
"$BIN" --help | grep -qi "Usage:" || { echo "smoke: --help missing usage"; exit 1; }
"$BIN" >/dev/null || { echo "smoke: bare invocation did not exit 0"; exit 1; }

# A conversion with no stored credentials must fail non-zero with a clear message.
set +e
err="$("$BIN" /nonexistent/does-not-exist.md 2>&1 >/dev/null)"
code=$?
set -e
[ "$code" -ne 0 ] || { echo "smoke: expected non-zero exit for unconfigured convert"; exit 1; }
echo "$err" | grep -qi "md2gd:" || { echo "smoke: expected a clear md2gd error, got: $err"; exit 1; }

echo "smoke: ok ($BIN)"
