#!/usr/bin/env bash
# Guard the GitHub lane-claim files for parallel delivery.
set -euo pipefail

fail() {
  printf 'workflow skill check failed: %s\n' "$1" >&2
  exit 1
}

require_file() {
  [ -f "$1" ] || fail "missing $1"
}

require_line() {
  grep -Fqx "$2" "$1" || fail "$1 is missing canonical line: $2"
}

require_fragment() {
  grep -Fq "$2" "$1" || fail "$1 is missing required metadata: $2"
}

SKILLS_ROOT=".agents/skills"
PARALLEL_REFERENCE="$SKILLS_ROOT/deliver-ready-issue/references/parallel-delivery.md"
LANE_SCRIPT="$SKILLS_ROOT/deliver-ready-issue/scripts/issue-lane.sh"
SKILL_FILE="$SKILLS_ROOT/deliver-ready-issue/SKILL.md"

require_file "$PARALLEL_REFERENCE"
require_file "$LANE_SCRIPT"
[ -x "$LANE_SCRIPT" ] || fail "$LANE_SCRIPT is not executable"
require_fragment "$SKILL_FILE" "references/parallel-delivery.md"
require_fragment "$SKILL_FILE" "scripts/issue-lane.sh"
require_line "docs/work-lifecycle.md" "## Parallel delivery lanes"
require_fragment "docs/work-lifecycle.md" "issue-lane.sh claim"
grep -Fq "/.worktrees/" .gitignore || fail ".gitignore does not ignore the /.worktrees/ lane directory"

printf 'workflow skill check passed\n'
