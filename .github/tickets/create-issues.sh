#!/usr/bin/env bash
#
# File the must-have MVP tickets as GitHub issues.
#
# Prerequisites:
#   1. gh installed        winget install --id GitHub.cli
#   2. authenticated       gh auth login
#   3. labels exist        see the commands printed at the end
#
# Usage:
#   REPO=medic/cht-ui-builder bash .github/tickets/create-issues.sh
#
# Dry run (prints without creating):
#   DRY=1 REPO=medic/cht-ui-builder bash .github/tickets/create-issues.sh

set -euo pipefail
: "${REPO:?set REPO, e.g. REPO=medic/cht-ui-builder}"
DRY="${DRY:-}"

run() {
  if [ -n "$DRY" ]; then printf %s\\n "DRY: $*"; else "$@"; fi
}

echo "Filing issues in $REPO"

run gh issue create \
  --repo "$REPO" \
  --title "T1: Form editor: the restricted safe edit subset" \
  --label mvp --label must-have \
  --body-file ".github/tickets/t1.md"

run gh issue create \
  --repo "$REPO" \
  --title "T2: Edit beyond the sheet: properties, resources, translations" \
  --label mvp --label must-have \
  --body-file ".github/tickets/t2.md"

run gh issue create \
  --repo "$REPO" \
  --title "T3: Add a simple new form, and assign it to a persona" \
  --label mvp --label must-have \
  --body-file ".github/tickets/t3.md"

run gh issue create \
  --repo "$REPO" \
  --title "T4: Basic hierarchy" \
  --label mvp --label must-have \
  --body-file ".github/tickets/t4.md"

run gh issue create \
  --repo "$REPO" \
  --title "T5: Basic contacts" \
  --label mvp --label must-have \
  --body-file ".github/tickets/t5.md"

run gh issue create \
  --repo "$REPO" \
  --title "T6: Basic task creation" \
  --label mvp --label must-have \
  --body-file ".github/tickets/t6.md"

run gh issue create \
  --repo "$REPO" \
  --title "T7: Safety tests: synthetic patients" \
  --label mvp --label must-have \
  --body-file ".github/tickets/t7.md"

run gh issue create \
  --repo "$REPO" \
  --title "T8: Round-trip safety and determinism" \
  --label mvp --label must-have \
  --body-file ".github/tickets/t8.md"

run gh issue create \
  --repo "$REPO" \
  --title "T9: Complex logic: calculation, relevance, constraint" \
  --label mvp --label must-have \
  --body-file ".github/tickets/t9.md"

run gh issue create \
  --repo "$REPO" \
  --title "T10: AI-assisted authoring (must start)" \
  --label mvp --label must-start \
  --body-file ".github/tickets/t10.md"

echo
echo "If a label was missing, create them and re-run:"
echo "  gh label create mvp        --repo $REPO --color 0E8A16 --description \"MVP scope\""
echo "  gh label create must-have  --repo $REPO --color B60205 --description \"Must have for MVP\""
echo "  gh label create must-start --repo $REPO --color FBCA04 --description \"Must be started in MVP\""
