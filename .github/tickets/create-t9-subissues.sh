#!/usr/bin/env bash
#
# File the T9 sub-issues (9a-9g) as GitHub sub-issues of #9, plus the two
# related issues that sit outside T9. Bodies live beside this script.
#
# Usage:
#   REPO=medic/cht-ui-builder bash .github/tickets/create-t9-subissues.sh
# Dry run (prints without creating):
#   DRY=1 REPO=medic/cht-ui-builder bash .github/tickets/create-t9-subissues.sh
#
# Requires gh authenticated with issue write access. Sub-issue linking uses the
# REST sub_issues endpoint, which takes the child's numeric id, not its number.

set -euo pipefail
: "${REPO:?set REPO, e.g. REPO=medic/cht-ui-builder}"
DRY="${DRY:-}"
PARENT="${PARENT:-9}"
DIR="$(dirname "$0")"

create() {
  local title="$1" file="$2"; shift 2
  local args=(--repo "$REPO" --title "$title" --body-file "$DIR/$file")
  for l in "$@"; do args+=(--label "$l"); done
  if [ -n "$DRY" ]; then
    printf 'DRY: gh issue create --title %q --body-file %q labels=[%s]\n' "$title" "$file" "$*" >&2
    echo 0; return
  fi
  local url; url=$(gh issue create "${args[@]}")
  echo "$url" >&2
  echo "${url##*/}"
}

link_child() {
  local num="$1"
  [ "$num" = 0 ] && { echo "DRY: link child under #$PARENT" >&2; return; }
  local id; id=$(gh api "repos/$REPO/issues/$num" --jq .id)
  gh api -X POST "repos/$REPO/issues/$PARENT/sub_issues" -F sub_issue_id="$id" --silent
  echo "  linked #$num as a sub-issue of #$PARENT" >&2
}

echo "Filing T9 sub-issues in $REPO under #$PARENT"

link_child "$(create "T9a: Parser reads real rules: . as subject, ../field alias, function forms" t9a.md "Type: Feature" mvp must-have)"
link_child "$(create "T9b: Rules the builder writes can be reopened (ruleToClause defects)"        t9b.md "Type: Bug" mvp must-have "Quick win")"
link_child "$(create "T9c: Searchable, grouped field picker; technical rows hidden; choice labels" t9c.md "Type: Feature" mvp must-have "UI/UX")"
link_child "$(create "T9d: Add-question configure step; insert after current row; scroll and highlight" t9d.md "Type: Feature" mvp must-have "UI/UX")"
link_child "$(create "T9e: Validation panel: presets per type, messages per language, no-normalise recogniser" t9e.md "Type: Feature" mvp must-have)"
link_child "$(create "T9f: Sentence-shaped inline rule editor for relevant and choice_filter; advanced panel regrouped" t9f.md "Type: Feature" mvp must-have "UI/UX")"
link_child "$(create "T9g: Audit and close the original T9 scope: four-builder e2e, runtime match on a live instance" t9g.md "Type: Feature" mvp must-have)"

echo
echo "Related issues outside T9"
create "Function catalogue and expression checks in every expression field" t-function-catalogue.md "Type: Improvement" >/dev/null
create "Project picker: Forget all missing; no toast for a stale last-opened path" t-project-picker-forget-missing.md "Type: Improvement" "Quick win" >/dev/null
