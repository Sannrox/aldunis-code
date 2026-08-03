#!/usr/bin/env bash
# Synchronize and verify the project-local Sekai ontology database.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
ontology_path="$repo_root/docs/ontology.json"
database_path="$repo_root/knowledge.db"
temporary_dir=""

usage() {
  cat <<'EOF'
Usage: scripts/ontology.sh <sync|check>

sync   Rebuild knowledge.db from docs/ontology.json.
check  Verify knowledge.db represents docs/ontology.json.
EOF
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

cleanup() {
  if [[ -n "$temporary_dir" && -d "$temporary_dir" ]]; then
    rm -rf "$temporary_dir"
  fi
}
trap cleanup EXIT

canonicalize() {
  jq -S '
    def normalize:
      .classes |= map(. + {
        superclasses: ((.superclasses // []) | sort),
        properties: ((.properties // []) | sort_by(.name))
      })
      | .classes |= sort_by(.name)
      | .relations |= map(. + {
        cardinality: (.cardinality // {min: 0, max: null}),
        transitive: (.transitive // false)
      })
      | .relations |= sort_by(.name)
      | .provenance |= sort_by(.subject, .source, .locator, .confidence);
    normalize
  '
}

create_database() {
  local target_database="$1"
  sekai --db "$target_database" init >/dev/null
  sekai --db "$target_database" import "$ontology_path" >/dev/null
}

sync_ontology() {
  require_command sekai
  [[ -f "$ontology_path" ]] || {
    echo "Ontology source is missing: docs/ontology.json" >&2
    exit 1
  }
  if [[ -d "$database_path" || -L "$database_path" ]]; then
    echo "Refusing to replace non-file knowledge.db" >&2
    exit 1
  fi

  temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/aldunis-code-ontology.XXXXXX")"
  create_database "$temporary_dir/knowledge.db"
  mv -f "$temporary_dir/knowledge.db" "$database_path"
  echo "Synchronized knowledge.db from docs/ontology.json"
}

check_ontology() {
  require_command jq
  require_command sekai
  [[ -f "$ontology_path" ]] || {
    echo "Ontology source is missing: docs/ontology.json" >&2
    exit 1
  }
  [[ -f "$database_path" ]] || {
    echo "knowledge.db is missing; run npm run ontology:sync" >&2
    exit 1
  }

  temporary_dir="$(mktemp -d "${TMPDIR:-/tmp}/aldunis-code-ontology.XXXXXX")"
  sekai --db "$database_path" --json validate
  canonicalize < "$ontology_path" > "$temporary_dir/source.json"
  sekai --db "$database_path" export | canonicalize > "$temporary_dir/database.json"

  if ! cmp -s "$temporary_dir/source.json" "$temporary_dir/database.json"; then
    echo "knowledge.db is stale or does not represent docs/ontology.json; run npm run ontology:sync" >&2
    exit 1
  fi
  echo "knowledge.db matches docs/ontology.json"
}

case "${1:-}" in
  sync)
    sync_ontology
    ;;
  check)
    check_ontology
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
