#!/usr/bin/env bash
# Fail loudly if the vendored chain registry has drifted from its canonical source.
#
# src/chains.ts is a copy of universal-blockchain-mcp/src/chains.ts with a vendoring
# header prepended. Compare everything from the shared marker onward so the header
# itself is not treated as drift.
set -euo pipefail

CANONICAL="../universal-blockchain-mcp/src/chains.ts"
VENDORED="src/chains.ts"
MARKER=" * Chain registry — the single source of truth"

cd "$(dirname "$0")/.."

if [[ ! -f "$CANONICAL" ]]; then
  echo "check:registry — canonical source not found at $CANONICAL" >&2
  echo "  (expected universal-blockchain-mcp to be a sibling checkout)" >&2
  exit 1
fi

strip_to_marker() {
  awk -v m="$MARKER" 'index($0, m) { found=1 } found { print }' "$1"
}

if diff -u <(strip_to_marker "$CANONICAL") <(strip_to_marker "$VENDORED") > /tmp/registry-drift.diff; then
  echo "check:registry — vendored chain registry is in sync with $CANONICAL"
else
  echo "check:registry — DRIFT DETECTED between $CANONICAL and $VENDORED" >&2
  cat /tmp/registry-drift.diff >&2
  echo >&2
  echo "Fix: edit the canonical file, then run 'npm run sync:registry'." >&2
  exit 1
fi
