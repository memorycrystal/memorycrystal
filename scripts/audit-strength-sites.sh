#!/usr/bin/env bash
# Pre-merge audit: catch new strength-write sites that bypass M7 buildStrengthDelta wiring.
# Expected count: 6 wired + ≤2 already-known unwired (covered by M7.5 drift check) = max 8.
# Source: .omc/plans/memorycrystal-cost-reduction-followups.md F12.

set -euo pipefail

cd "$(dirname "$0")/.."

COUNT=$(grep -rn 'db\.patch' convex/crystal/ --include="*.ts" -A 5 \
  | grep -B 5 'strength' \
  | grep 'db\.patch' \
  | grep -v '__tests__' \
  | grep -v '\.test\.' \
  | wc -l | tr -d ' ')

THRESHOLD=8

if [ "$COUNT" -gt "$THRESHOLD" ]; then
  echo "ERROR: $COUNT strength-write sites detected (expected ≤$THRESHOLD)."
  echo "A new strength-write site has been added without buildStrengthDelta wiring."
  echo "Either: (a) wire buildStrengthDelta at the new site, or (b) update THRESHOLD here with rationale."
  echo ""
  echo "Details:"
  grep -rn 'db\.patch' convex/crystal/ --include="*.ts" -A 5 \
    | grep -B 5 'strength' \
    | grep 'db\.patch' \
    | grep -v '__tests__' \
    | grep -v '\.test\.'
  exit 1
fi

echo "OK: $COUNT strength-write sites (≤$THRESHOLD)."
