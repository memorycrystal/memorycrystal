#!/usr/bin/env bash
set -euo pipefail

CONVEX_URL="${CRYSTAL_CONVEX_URL:-https://convex.memorycrystal.ai}"
CAPTURE_URL="$CONVEX_URL/api/mcp/capture"
API_KEY="${CRYSTAL_API_KEY:-}"
OPENCLAW_DIR="${OPENCLAW_DIR:-$HOME/.openclaw}"
WORKSPACE_DIR="${WORKSPACE_DIR:-$HOME}"
DRY_RUN=0
SKIP_DAILY=0

usage() {
  cat <<'EOF'
Usage: migrate-openclaw-memory.sh [options]

Options:
  --api-key KEY         Memory Crystal API key (or set CRYSTAL_API_KEY)
  --openclaw-dir DIR    OpenClaw config dir (default: ~/.openclaw)
  --workspace-dir DIR   Workspace/home dir to scan (default: ~)
  --dry-run             Show what would be imported without calling the API
  --skip-daily          Skip OpenClaw daily log files
  -h, --help            Show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --api-key)
      [ $# -ge 2 ] || { echo "✗ --api-key requires a value" >&2; exit 1; }
      API_KEY="$2"
      shift 2
      ;;
    --openclaw-dir)
      [ $# -ge 2 ] || { echo "✗ --openclaw-dir requires a value" >&2; exit 1; }
      OPENCLAW_DIR="$2"
      shift 2
      ;;
    --workspace-dir)
      [ $# -ge 2 ] || { echo "✗ --workspace-dir requires a value" >&2; exit 1; }
      WORKSPACE_DIR="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --skip-daily)
      SKIP_DAILY=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "✗ Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ "$DRY_RUN" -ne 1 ] && [ -z "$API_KEY" ]; then
  echo "✗ API key required. Use --api-key or set CRYSTAL_API_KEY." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js is required but was not found." >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

FILES_LIST="$TMP_DIR/files.txt"
TASKS_JSON="$TMP_DIR/tasks.json"
: > "$FILES_LIST"

SKIPPED_TEMPLATES=0
IMPORTED=0
FAILED=0
TOTAL=0

add_file_if_exists() {
  local path="$1"
  local base
  [ -f "$path" ] || return 0
  base="$(basename "$path")"
  case "$base" in
    _template*)
      SKIPPED_TEMPLATES=$((SKIPPED_TEMPLATES + 1))
      return 0
      ;;
  esac
  printf '%s\n' "$path" >> "$FILES_LIST"
}

scan_directory_for_markdown() {
  local dir="$1"
  [ -d "$dir" ] || return 0
  while IFS= read -r path; do
    [ -n "$path" ] || continue
    add_file_if_exists "$path"
  done < <(find "$dir" -type f -name '*.md' | sort)
}

scan_memory_files() {
  scan_directory_for_markdown "$OPENCLAW_DIR/memory/tacit/preferences"
  scan_directory_for_markdown "$OPENCLAW_DIR/memory/tacit/policies"
  scan_directory_for_markdown "$OPENCLAW_DIR/memory/tacit/boundaries"

  if [ "$SKIP_DAILY" -ne 1 ]; then
    scan_directory_for_markdown "$OPENCLAW_DIR/memory/daily"
  fi

  if [ -f "$WORKSPACE_DIR/MEMORY.md" ]; then
    add_file_if_exists "$WORKSPACE_DIR/MEMORY.md"
  elif [ -f "$OPENCLAW_DIR/MEMORY.md" ]; then
    add_file_if_exists "$OPENCLAW_DIR/MEMORY.md"
  fi

  scan_directory_for_markdown "$WORKSPACE_DIR/memory"
}

scan_memory_files

node - "$FILES_LIST" "$TASKS_JSON" "$OPENCLAW_DIR" "$WORKSPACE_DIR" "$SKIP_DAILY" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const filesListPath = process.argv[2];
const tasksPath = process.argv[3];
const openclawDir = process.argv[4];
const workspaceDir = process.argv[5];
const skipDaily = process.argv[6] === '1';

const files = fs.existsSync(filesListPath)
  ? fs.readFileSync(filesListPath, 'utf8').split(/\r?\n/).filter(Boolean)
  : [];

function normalize(p) {
  return String(p || '').replace(/\\/g, '/');
}

function parseMarkdown(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  let frontmatter = {};
  let body = raw;

  if (raw.startsWith('---\n') || raw.startsWith('---\r\n')) {
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (match) {
      const fmRaw = match[1];
      body = raw.slice(match[0].length);
      for (const line of fmRaw.split(/\r?\n/)) {
        const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
        if (m) frontmatter[m[1]] = m[2].trim();
      }
    }
  }

  return { raw, frontmatter, body };
}

function firstHeading(text) {
  const match = text.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : '';
}

function titleFromFile(filePath, parsed, fallbackPrefix = 'Memory') {
  return (
    parsed.frontmatter.title ||
    parsed.frontmatter.name ||
    parsed.frontmatter.id ||
    firstHeading(parsed.body) ||
    path.basename(filePath, path.extname(filePath)) ||
    fallbackPrefix
  ).trim();
}

function contentWithoutTitle(parsed) {
  return parsed.body.replace(/^#\s+.+\r?\n+/, '').trim();
}

function splitMemorySections(filePath, parsed) {
  const body = parsed.body.trim();
  const introTitle = firstHeading(body) || parsed.frontmatter.title || 'Memory';
  const normalized = body.replace(/\r\n/g, '\n');
  const sectionMatches = [...normalized.matchAll(/^##\s+(.+)$/gm)];
  const sections = [];

  if (sectionMatches.length === 0) {
    sections.push({
      source: filePath,
      title: introTitle,
      category: 'fact',
      text: contentWithoutTitle(parsed) || body,
    });
    return sections;
  }

  const firstIndex = sectionMatches[0].index;
  const intro = normalized.slice(0, firstIndex).trim();
  if (intro) {
    sections.push({
      source: filePath,
      title: introTitle,
      category: 'fact',
      text: intro.replace(/^#\s+.+\n+/, '').trim(),
    });
  }

  for (let i = 0; i < sectionMatches.length; i += 1) {
    const start = sectionMatches[i].index;
    const end = i + 1 < sectionMatches.length ? sectionMatches[i + 1].index : normalized.length;
    const block = normalized.slice(start, end).trim();
    const title = sectionMatches[i][1].trim();
    const text = block.replace(/^##\s+.+\n+/, '').trim();
    if (!text) continue;
    sections.push({
      source: filePath,
      title,
      category: 'fact',
      text,
    });
  }

  return sections;
}

const tasks = [];
for (const filePath of files) {
  const normalized = normalize(filePath);
  const parsed = parseMarkdown(filePath);

  if (normalized.includes('/memory/tacit/preferences/')) {
    const text = contentWithoutTitle(parsed);
    if (text) tasks.push({ source: filePath, title: titleFromFile(filePath, parsed), category: 'preference', text });
    continue;
  }

  if (normalized.includes('/memory/tacit/policies/')) {
    const text = contentWithoutTitle(parsed);
    if (text) tasks.push({ source: filePath, title: titleFromFile(filePath, parsed), category: 'lesson', text });
    continue;
  }

  if (normalized.includes('/memory/tacit/boundaries/')) {
    const text = contentWithoutTitle(parsed);
    if (text) tasks.push({ source: filePath, title: titleFromFile(filePath, parsed), category: 'preference', text });
    continue;
  }

  if (!skipDaily && normalized.includes('/memory/daily/')) {
    const text = contentWithoutTitle(parsed) || parsed.body.trim();
    if (text) tasks.push({ source: filePath, title: titleFromFile(filePath, parsed, path.basename(filePath, '.md')), category: 'fact', text });
    continue;
  }

  const workspaceMemory = normalize(path.join(workspaceDir, 'MEMORY.md'));
  const openclawMemory = normalize(path.join(openclawDir, 'MEMORY.md'));
  if (normalized === workspaceMemory || normalized === openclawMemory) {
    tasks.push(...splitMemorySections(filePath, parsed));
    continue;
  }

  if (normalized.startsWith(normalize(path.join(workspaceDir, 'memory')) + '/')) {
    const text = contentWithoutTitle(parsed) || parsed.body.trim();
    if (text) tasks.push({ source: filePath, title: titleFromFile(filePath, parsed), category: 'fact', text });
  }
}

fs.writeFileSync(tasksPath, `${JSON.stringify(tasks, null, 2)}\n`);
NODE

TOTAL="$(node -e "const fs=require('fs'); const tasks=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); process.stdout.write(String(tasks.length));" "$TASKS_JSON")"

if [ "$TOTAL" -eq 0 ]; then
  echo "No memories found to import."
  echo "Imported 0 memories. Skipped $SKIPPED_TEMPLATES templates. Failed 0 imports."
  exit 0
fi

import_task() {
  local index="$1"
  local task_json="$2"
  local source title category text payload http_code body_file

  source="$(printf '%s' "$task_json" | node -e "const fs=require('fs'); const task=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(task.source || '');")"
  title="$(printf '%s' "$task_json" | node -e "const fs=require('fs'); const task=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(task.title || '');")"
  category="$(printf '%s' "$task_json" | node -e "const fs=require('fs'); const task=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(task.category || 'fact');")"
  text="$(printf '%s' "$task_json" | node -e "const fs=require('fs'); const task=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(task.text || '');")"

  printf 'Importing %s/%s: %s...\n' "$index" "$TOTAL" "$(basename "$source")"

  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  [dry-run] %s | %s | %s\n' "$category" "$title" "$source"
    IMPORTED=$((IMPORTED + 1))
    return 0
  fi

  payload="$(printf '%s' "$task_json" | node -e "const fs=require('fs'); const task=JSON.parse(fs.readFileSync(0,'utf8')); process.stdout.write(JSON.stringify({text:task.text,title:task.title,category:task.category,store:'semantic'}));")"
  body_file="$TMP_DIR/response-${index}.txt"
  http_code="$(curl -sS -o "$body_file" -w '%{http_code}' -X POST "$CAPTURE_URL" \
    -H "Authorization: Bearer $API_KEY" \
    -H 'Content-Type: application/json' \
    --data "$payload" || true)"

  if [ "$http_code" = "200" ] || [ "$http_code" = "201" ]; then
    IMPORTED=$((IMPORTED + 1))
  else
    FAILED=$((FAILED + 1))
    echo "  ✗ Failed ($http_code): $source" >&2
    if [ -s "$body_file" ]; then
      sed 's/^/    /' "$body_file" >&2
    fi
  fi

  sleep 0.3
}

INDEX=0
while IFS= read -r task; do
  [ -n "$task" ] || continue
  INDEX=$((INDEX + 1))
  import_task "$INDEX" "$task"
done < <(node -e "const fs=require('fs'); const tasks=JSON.parse(fs.readFileSync(process.argv[1],'utf8')); for (const task of tasks) console.log(JSON.stringify(task));" "$TASKS_JSON")

echo "Imported $IMPORTED memories. Skipped $SKIPPED_TEMPLATES templates. Failed $FAILED imports."
