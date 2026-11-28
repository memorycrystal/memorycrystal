#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  scripts/convex-snapshot-audit.sh audit SNAPSHOT.zip MANIFEST.json
  scripts/convex-snapshot-audit.sh compare SOURCE.json TARGET.json

The audit streams a Convex snapshot without extracting it, normalizes JSONL
documents, and records deterministic counts and SHA-256 digests. The comparison
fails if any table, system document, or stored file differs.
EOF
}

need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 1; }; }
sha256_file() { shasum -a 256 "$1" | awk '{print $1}'; }
file_size() {
  if stat -c %s "$1" >/dev/null 2>&1; then
    stat -c %s "$1"
  else
    stat -f %z "$1"
  fi
}

audit_snapshot() {
  local snapshot=$1 manifest=$2 work entries relative count bytes digest type hash_mode multiset
  [[ -f "$snapshot" ]] || { echo "Snapshot not found: $snapshot" >&2; exit 1; }
  [[ ! -e "$manifest" ]] || { echo "Manifest already exists: $manifest" >&2; exit 1; }

  work=$(mktemp -d "${TMPDIR:-/tmp}/memorycrystal-snapshot.XXXXXX")
  trap 'rm -rf "$work"' RETURN
  trap 'rm -rf "$work"; exit 130' INT TERM
  entries="$work/entries.jsonl"
  : > "$entries"

  while IFS= read -r entry; do
    [[ -n "$entry" ]] || continue
    [[ "$entry" != /* && "/$entry/" != *"/../"* ]] || {
      echo "Unsafe ZIP entry: $entry" >&2
      exit 1
    }
  done < <(unzip -Z1 "$snapshot")

  while IFS= read -r relative; do
    [[ -n "$relative" && "$relative" != */ ]] || continue
    bytes=$(unzip -Z -l "$snapshot" "$relative" | awk 'NR == 1 { print $4 }')
    count=0
    type=binary
    hash_mode=sha256
    if [[ "$relative" == *.jsonl ]]; then
      type=jsonl
      hash_mode=jsonl-multiset-v1
      multiset=$(unzip -p "$snapshot" "$relative" | jq -cS . | node "$SCRIPT_DIR/convex-snapshot-multiset-hash.mjs")
      count=${multiset%%$'\t'*}
      digest=${multiset#*$'\t'}
    else
      digest=$(unzip -p "$snapshot" "$relative" | shasum -a 256 | awk '{print $1}')
    fi
    jq -nc \
      --arg path "$relative" --arg type "$type" --arg hashMode "$hash_mode" --arg sha256 "$digest" \
      --argjson records "$count" --argjson bytes "$bytes" \
      '{path:$path,type:$type,hashMode:$hashMode,records:$records,bytes:$bytes,sha256:$sha256}' >> "$entries"
  done < <(unzip -Z1 "$snapshot" | LC_ALL=C sort)

  jq -s \
    --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg snapshot "$(basename "$snapshot")" \
    --arg snapshotSha256 "$(sha256_file "$snapshot")" \
    --argjson snapshotBytes "$(file_size "$snapshot")" \
    '{schemaVersion:1,createdAt:$createdAt,snapshot:$snapshot,snapshotSha256:$snapshotSha256,snapshotBytes:$snapshotBytes,entries:.,totals:{entries:length,jsonlRecords:(map(.records)|add),storedFiles:(map(select((.path|startswith("_storage/")) and ((.path|endswith("documents.jsonl"))|not)))|length),storedFileBytes:(map(select((.path|startswith("_storage/")) and ((.path|endswith("documents.jsonl"))|not))|.bytes)|add // 0)}}' \
    "$entries" > "$manifest.tmp"
  chmod 600 "$manifest.tmp"
  mv "$manifest.tmp" "$manifest"
  jq '{snapshot,snapshotBytes,snapshotSha256,totals}' "$manifest"
}

compare_manifests() {
  local source=$1 target=$2 left right
  [[ -f "$source" && -f "$target" ]] || { echo "Both manifest files are required" >&2; exit 1; }
  left=$(mktemp "${TMPDIR:-/tmp}/memorycrystal-source.XXXXXX")
  right=$(mktemp "${TMPDIR:-/tmp}/memorycrystal-target.XXXXXX")
  trap 'rm -f "$left" "$right"' RETURN
  # JSONL fingerprints are order-independent, so raw byte length is
  # intentionally not part of equality. Stored-file bytes remain exact because
  # binary payloads must be byte-for-byte identical.
  jq -S '[.entries[] | if .type == "jsonl" then {path,type,hashMode,records,sha256} else {path,type,hashMode,bytes,sha256} end]' "$source" > "$left"
  jq -S '[.entries[] | if .type == "jsonl" then {path,type,hashMode,records,sha256} else {path,type,hashMode,bytes,sha256} end]' "$target" > "$right"
  if ! diff -u "$left" "$right"; then
    echo "Snapshot reconciliation failed" >&2
    exit 1
  fi
  jq -n --arg source "$(basename "$source")" --arg target "$(basename "$target")" \
    --argjson totals "$(jq '.totals' "$source")" \
    '{status:"match",source:$source,target:$target,totals:$totals}'
}

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

for cmd in jq node unzip shasum stat sort awk diff; do need "$cmd"; done

case "${1:-}" in
  audit)
    [[ $# -eq 3 ]] || { usage >&2; exit 2; }
    audit_snapshot "$2" "$3"
    ;;
  compare)
    [[ $# -eq 3 ]] || { usage >&2; exit 2; }
    compare_manifests "$2" "$3"
    ;;
  *) usage >&2; exit 2 ;;
esac
