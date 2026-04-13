#!/usr/bin/env bash
# Migration script: Morrow Marriage training data from Railway → Memory Crystal Knowledge Bases
#
# Phase 1: Download all training data from Railway in bulk (tar)
# Phase 2: Create KBs and batch-import via MC HTTP API
#
# Usage: MEMORY_CRYSTAL_API_KEY=<key> ./scripts/migrate-morrow.sh [--dry-run]

set -euo pipefail

API_KEY="${MEMORY_CRYSTAL_API_KEY:?Set MEMORY_CRYSTAL_API_KEY}"
API_URL="${MEMORY_CRYSTAL_API_URL:-https://rightful-mockingbird-389.convex.site}"
DRY_RUN=false
BATCH_SIZE=10
CHUNK_MAX_CHARS=4000
WORK_DIR="/tmp/morrow-migration"

AGENT_IDS='["ask-cass","ask-kathryn","coach","comment-replies","copywriting","dm-replies","heartbeat","main","marco","seo-aeo-geo","social-media","web-dev"]'

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "[DRY RUN] No API calls will be made."
fi

# ── Helpers ──────────────────────────────────────────────────────────────────

api_call() {
  local method="$1" path="$2" body="${3:-}"
  local url="${API_URL}${path}"
  
  if [[ "$DRY_RUN" == true ]]; then
    echo "[DRY RUN] $method $path" >&2
    echo '{"knowledgeBaseId":"dry-run-id","importedCount":0}'
    return 0
  fi

  local args=(-s -w "\n%{http_code}" -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json")
  if [[ "$method" == "POST" && -n "$body" ]]; then
    args+=(-X POST -d "$body")
  fi
  
  local response http_code response_body
  response=$(curl "${args[@]}" "$url")
  http_code=$(echo "$response" | tail -1)
  response_body=$(echo "$response" | sed '$d')
  
  if [[ "$http_code" -ge 400 ]]; then
    echo "ERROR: $method $path → HTTP $http_code" >&2
    echo "$response_body" >&2
    return 1
  fi
  
  echo "$response_body"
}

create_kb() {
  local name="$1" description="$2" source_type="${3:-markdown}"
  local body
  body=$(jq -n \
    --arg name "$name" \
    --arg desc "$description" \
    --arg src "$source_type" \
    --argjson agents "$AGENT_IDS" \
    '{name: $name, description: $desc, sourceType: $src, agentIds: $agents}')
  
  echo "Creating KB: $name" >&2
  local result
  result=$(api_call POST "/api/knowledge-bases" "$body")
  echo "$result" | jq -r '.knowledgeBaseId // empty'
}

import_dir_as_chunks() {
  # Import all .md files in a local directory as individual chunks into a KB
  local kb_id="$1" dir="$2" source_label="$3"
  local total imported=0 batch_count=0
  local batch_chunks="[]"
  
  total=$(ls "$dir"/*.md 2>/dev/null | wc -l | tr -d ' ')
  [[ "$total" -eq 0 ]] && { echo "  No .md files in $dir" >&2; return; }
  
  for file in "$dir"/*.md; do
    local content file_id chunk_json
    content=$(cat "$file")
    [[ -z "$content" ]] && continue
    
    file_id=$(basename "$file" .md)
    chunk_json=$(jq -n \
      --arg content "$content" \
      --arg fid "$file_id" \
      --arg src "$source_label" \
      '{content: $content, metadata: {id: $fid, source: $src}}')
    
    batch_chunks=$(echo "$batch_chunks" | jq --argjson chunk "$chunk_json" '. + [$chunk]')
    batch_count=$((batch_count + 1))
    
    if [[ $batch_count -ge $BATCH_SIZE ]]; then
      local result imported_batch
      result=$(api_call POST "/api/knowledge-bases/${kb_id}/import" \
        "$(jq -n --argjson chunks "$batch_chunks" '{chunks: $chunks}')")
      imported_batch=$(echo "$result" | jq -r '.importedCount // 0')
      imported=$((imported + imported_batch))
      echo "  Imported $imported / $total..." >&2
      batch_chunks="[]"
      batch_count=0
      sleep 0.5
    fi
  done
  
  if [[ $batch_count -gt 0 ]]; then
    local result imported_batch
    result=$(api_call POST "/api/knowledge-bases/${kb_id}/import" \
      "$(jq -n --argjson chunks "$batch_chunks" '{chunks: $chunks}')")
    imported_batch=$(echo "$result" | jq -r '.importedCount // 0')
    imported=$((imported + imported_batch))
  fi
  
  echo "  Done: $imported / $total imported" >&2
}

import_large_file() {
  # Chunk a large file and import into a KB
  local kb_id="$1" file="$2" source_label="$3"
  local content file_size
  content=$(cat "$file")
  file_size=${#content}
  echo "  File size: $file_size chars" >&2
  
  # Use python to chunk at paragraph boundaries
  local chunks_json
  chunks_json=$(python3 -c "
import json, sys

text = open('$file', 'r').read()
source = '$source_label'
max_chars = $CHUNK_MAX_CHARS
chunks = []
paragraphs = text.split('\n\n')
current = ''
chunk_idx = 0

for para in paragraphs:
    if len(current) + len(para) + 2 > max_chars and current:
        chunks.append({'content': current.strip(), 'metadata': {'source': source, 'chunk_index': chunk_idx}})
        chunk_idx += 1
        current = para
    else:
        current = current + '\n\n' + para if current else para

if current.strip():
    chunks.append({'content': current.strip(), 'metadata': {'source': source, 'chunk_index': chunk_idx}})

json.dump(chunks, sys.stdout)
")
  
  local chunk_count
  chunk_count=$(echo "$chunks_json" | jq 'length')
  echo "  Chunked into $chunk_count pieces" >&2
  
  local imported=0
  for i in $(seq 0 $BATCH_SIZE $((chunk_count - 1))); do
    local batch batch_len result imported_batch
    batch=$(echo "$chunks_json" | jq ".[$i:$((i + BATCH_SIZE))]")
    batch_len=$(echo "$batch" | jq 'length')
    [[ "$batch_len" -eq 0 ]] && continue
    result=$(api_call POST "/api/knowledge-bases/${kb_id}/import" \
      "$(jq -n --argjson chunks "$batch" '{chunks: $chunks}')")
    imported_batch=$(echo "$result" | jq -r '.importedCount // 0')
    imported=$((imported + imported_batch))
    echo "  Imported $imported / $chunk_count chunks..." >&2
    sleep 0.5
  done
  
  echo "  Done: $imported chunks" >&2
}

# ── Phase 1: Download ───────────────────────────────────────────────────────

echo "══════════════════════════════════════════════════════════"
echo "  Morrow Marriage → Memory Crystal Migration"
echo "══════════════════════════════════════════════════════════"
echo ""
echo "Phase 1: Downloading training data from Railway..."

mkdir -p "$WORK_DIR"
cd /tmp

# Download episodes (from ask-cass — most complete set: 413)
if [[ ! -d "$WORK_DIR/episodes" ]]; then
  echo "  Downloading episodes..."
  railway ssh -- 'tar czf - /data/workspace-ask-cass/memory/episodes' 2>/dev/null \
    | tar xzf - -C "$WORK_DIR" --strip-components=4 2>/dev/null \
    || {
      # Fallback: download one by one if tar fails
      echo "  tar failed, falling back to individual downloads..."
      mkdir -p "$WORK_DIR/episodes"
      railway ssh -- 'ls /data/workspace-ask-cass/memory/episodes' 2>/dev/null | while read -r f; do
        railway ssh -- "cat /data/workspace-ask-cass/memory/episodes/$f" > "$WORK_DIR/episodes/$f" 2>/dev/null
      done
    }
  echo "  Downloaded $(ls "$WORK_DIR/episodes"/*.md 2>/dev/null | wc -l | tr -d ' ') episodes"
else
  echo "  Episodes already downloaded ($(ls "$WORK_DIR/episodes"/*.md 2>/dev/null | wc -l | tr -d ' '))"
fi

# Download social posts
if [[ ! -d "$WORK_DIR/social-posts" ]]; then
  echo "  Downloading social posts..."
  railway ssh -- 'tar czf - /data/workspace-coach/memory/training/social-posts' 2>/dev/null \
    | tar xzf - -C "$WORK_DIR" --strip-components=5 2>/dev/null \
    || {
      echo "  tar failed, falling back..."
      mkdir -p "$WORK_DIR/social-posts"
      railway ssh -- 'ls /data/workspace-coach/memory/training/social-posts' 2>/dev/null | while read -r f; do
        railway ssh -- "cat /data/workspace-coach/memory/training/social-posts/$f" > "$WORK_DIR/social-posts/$f" 2>/dev/null
      done
    }
  echo "  Downloaded $(ls "$WORK_DIR/social-posts"/*.md 2>/dev/null | wc -l | tr -d ' ') social posts"
else
  echo "  Social posts already downloaded"
fi

# Download book
if [[ ! -f "$WORK_DIR/disrupting-divorce.md" ]]; then
  echo "  Downloading book..."
  railway ssh -- 'cat /data/workspace-coach/memory/training/disrupting-divorce.md' > "$WORK_DIR/disrupting-divorce.md" 2>/dev/null
  echo "  Downloaded ($(wc -c < "$WORK_DIR/disrupting-divorce.md" | tr -d ' ') bytes)"
else
  echo "  Book already downloaded"
fi

# Download course
if [[ ! -f "$WORK_DIR/marriage-reset-v4.md" ]]; then
  echo "  Downloading course..."
  railway ssh -- 'cat /data/workspace-coach/memory/training/marriage-reset-v4.md' > "$WORK_DIR/marriage-reset-v4.md" 2>/dev/null
  echo "  Downloaded ($(wc -c < "$WORK_DIR/marriage-reset-v4.md" | tr -d ' ') bytes)"
else
  echo "  Course already downloaded"
fi

# Download zoom calls
if [[ ! -d "$WORK_DIR/zoom-calls" ]]; then
  echo "  Downloading zoom calls..."
  mkdir -p "$WORK_DIR/zoom-calls"
  railway ssh -- 'ls /data/workspace-coach/memory/training/zoom-calls' 2>/dev/null | while read -r f; do
    railway ssh -- "cat /data/workspace-coach/memory/training/zoom-calls/$f" > "$WORK_DIR/zoom-calls/$f" 2>/dev/null
  done
  echo "  Downloaded $(ls "$WORK_DIR/zoom-calls"/* 2>/dev/null | wc -l | tr -d ' ') zoom calls"
else
  echo "  Zoom calls already downloaded"
fi

echo ""
echo "Phase 1 complete. Local data at: $WORK_DIR"
echo ""

# ── Phase 2: Create KBs and Import ──────────────────────────────────────────

echo "Phase 2: Creating Knowledge Bases and importing..."
echo ""

# 1. Podcast Library
echo "── 1. Podcast Library ──"
KB_PODCASTS=$(create_kb \
  "Podcast Library" \
  "Morrow Relationship Science podcast episodes — marriage, divorce, relationship psychology. 410+ episodes of actionable coaching content." \
  "markdown")
echo "  KB: $KB_PODCASTS"
import_dir_as_chunks "$KB_PODCASTS" "$WORK_DIR/episodes" "youtube-podcast"

# 2. Disrupting Divorce
echo ""
echo "── 2. Disrupting Divorce ──"
KB_BOOK=$(create_kb \
  "Disrupting Divorce" \
  "Full text of 'Disrupting Divorce' by Morrow — foundational book on relationship science methodology, attachment theory, and practical frameworks." \
  "book")
echo "  KB: $KB_BOOK"
import_large_file "$KB_BOOK" "$WORK_DIR/disrupting-divorce.md" "disrupting-divorce"

# 3. Marriage Reset Course
echo ""
echo "── 3. Marriage Reset Course V4 ──"
KB_COURSE=$(create_kb \
  "Marriage Reset Course" \
  "Marriage Reset V4 — structured coaching course. Modules, exercises, and frameworks for relationship transformation." \
  "course")
echo "  KB: $KB_COURSE"
import_large_file "$KB_COURSE" "$WORK_DIR/marriage-reset-v4.md" "marriage-reset-v4"

# 4. Social Posts
echo ""
echo "── 4. Social Posts ──"
KB_SOCIAL=$(create_kb \
  "Social Posts" \
  "400 social media posts — voice, messaging, and content patterns for Morrow brand. Used by copywriting, social-media, and comment-replies agents." \
  "social-media")
echo "  KB: $KB_SOCIAL"
import_dir_as_chunks "$KB_SOCIAL" "$WORK_DIR/social-posts" "social-post"

# 5. Zoom Calls
echo ""
echo "── 5. Zoom Call Transcripts ──"
KB_ZOOM=$(create_kb \
  "Zoom Calls" \
  "Recorded coaching/strategy zoom call transcripts — real conversation examples and coaching methodology in action." \
  "transcript")
echo "  KB: $KB_ZOOM"
if ls "$WORK_DIR/zoom-calls"/*.md &>/dev/null; then
  for zf in "$WORK_DIR/zoom-calls"/*.md; do
    echo "  Processing $(basename "$zf")..."
    import_large_file "$KB_ZOOM" "$zf" "zoom-$(basename "$zf" .md)"
  done
else
  echo "  No zoom call files found"
fi

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "══════════════════════════════════════════════════════════"
echo "  Migration Complete"
echo "══════════════════════════════════════════════════════════"
echo ""
echo "Knowledge Bases:"
echo "  1. Podcast Library    → $KB_PODCASTS"
echo "  2. Disrupting Divorce → $KB_BOOK"
echo "  3. Marriage Reset     → $KB_COURSE"
echo "  4. Social Posts       → $KB_SOCIAL"
echo "  5. Zoom Calls         → $KB_ZOOM"
echo ""
echo "Shared across agents: $AGENT_IDS"
echo ""
if [[ "$DRY_RUN" == true ]]; then
  echo "[DRY RUN] Re-run without --dry-run to execute."
fi
