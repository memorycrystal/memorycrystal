#!/usr/bin/env python3
"""
Resume Morrow migration from where it left off.
Picks up existing KBs by name and skips already-imported chunks.

Usage:
  MEMORY_CRYSTAL_API_KEY=<key> nohup python3 -u scripts/migrate-morrow-resume.py > /tmp/morrow-migration-resume.log 2>&1 &
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

API_KEY = os.environ.get("MEMORY_CRYSTAL_API_KEY", "")
API_URL = os.environ.get("MEMORY_CRYSTAL_API_URL", "https://convex.memorycrystal.ai")
WORK_DIR = Path("/tmp/morrow-migration")
BATCH_SIZE = 3
CHUNK_MAX_CHARS = 4000
MAX_RETRIES = 3
STATE_FILE = Path("/tmp/morrow-migration-state.json")

AGENT_IDS = [
    "ask-cass", "ask-kathryn", "coach", "comment-replies", "copywriting",
    "dm-replies", "heartbeat", "main", "marco", "seo-aeo-geo",
    "social-media", "web-dev"
]


def load_state():
    if STATE_FILE.exists():
        return json.loads(STATE_FILE.read_text())
    return {}


def save_state(state):
    STATE_FILE.write_text(json.dumps(state, indent=2))


def api_call(method, path, body=None):
    url = "%s%s" % (API_URL, path)
    data = json.dumps(body).encode() if body else None
    for attempt in range(MAX_RETRIES):
        req = urllib.request.Request(url, data=data, method=method)
        req.add_header("Authorization", "Bearer %s" % API_KEY)
        req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=180) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            error_body = e.read().decode() if e.fp else ""
            if e.code in (429, 500, 502, 503) and attempt < MAX_RETRIES - 1:
                wait = (attempt + 1) * 10
                print("  RETRY (%d/%d): HTTP %d, waiting %ds..." % (attempt+1, MAX_RETRIES, e.code, wait), flush=True)
                time.sleep(wait)
                continue
            print("  ERROR: %s %s -> HTTP %d: %s" % (method, path, e.code, error_body), flush=True)
            raise
        except Exception as e:
            if attempt < MAX_RETRIES - 1:
                wait = (attempt + 1) * 10
                print("  RETRY (%d/%d): %s, waiting %ds..." % (attempt+1, MAX_RETRIES, e, wait), flush=True)
                time.sleep(wait)
                continue
            raise
    return {}


def get_or_create_kb(name, description, source_type="markdown"):
    # Check existing KBs
    result = api_call("GET", "/api/knowledge-bases")
    for kb in result.get("knowledgeBases", []):
        if kb.get("name") == name and kb.get("isActive", False):
            print("  Found existing KB: %s (count: %d)" % (kb["_id"], kb.get("memoryCount", 0)), flush=True)
            return kb["_id"], kb.get("memoryCount", 0)

    print("  Creating new KB: %s" % name, flush=True)
    result = api_call("POST", "/api/knowledge-bases", {
        "name": name,
        "description": description,
        "sourceType": source_type,
        "agentIds": AGENT_IDS,
    })
    kb_id = result.get("knowledgeBaseId", "")
    print("  KB ID: %s" % kb_id, flush=True)
    return kb_id, 0


def import_chunks(kb_id, chunks):
    if not chunks:
        return 0
    result = api_call("POST", "/api/knowledge-bases/%s/import" % kb_id, {"chunks": chunks})
    return result.get("importedCount", 0)


def parse_dump_file(dump_path):
    if not dump_path.exists():
        return []
    text = dump_path.read_text(encoding="utf-8", errors="replace")
    entries = []
    parts = text.split("===FILE:")
    for part in parts[1:]:
        if "===" not in part:
            continue
        filename, content = part.split("===", 1)
        content = content.strip()
        if content:
            entries.append((filename.strip(), content))
    return entries


def chunk_large_text(text, source):
    paragraphs = text.split("\n\n")
    chunks = []
    current = ""
    chunk_idx = 0
    for para in paragraphs:
        if len(current) + len(para) + 2 > CHUNK_MAX_CHARS and current:
            chunks.append({
                "content": current.strip(),
                "metadata": {"sourceType": source, "chunkIndex": chunk_idx}
            })
            chunk_idx += 1
            current = para
        else:
            current = "%s\n\n%s" % (current, para) if current else para
    if current.strip():
        chunks.append({
            "content": current.strip(),
            "metadata": {"sourceType": source, "chunkIndex": chunk_idx}
        })
    return chunks


def import_entries_resumable(kb_id, entries, source_label, state_key, state):
    already_done = state.get(state_key, 0)
    total = len(entries)
    if already_done >= total:
        print("  Already complete (%d/%d)" % (already_done, total), flush=True)
        return already_done

    print("  Resuming from %d/%d..." % (already_done, total), flush=True)
    imported = already_done
    remaining = entries[already_done:]

    batch = []
    for i, (filename, content) in enumerate(remaining):
        file_id = filename.replace(".md", "")
        batch.append({
            "content": content,
            "metadata": {"title": file_id, "sourceType": source_label}
        })
        if len(batch) >= BATCH_SIZE:
            count = import_chunks(kb_id, batch)
            imported += count
            state[state_key] = imported
            save_state(state)
            print("  Imported %d/%d..." % (imported, total), flush=True)
            batch = []
            time.sleep(1)
    if batch:
        count = import_chunks(kb_id, batch)
        imported += count
        state[state_key] = imported
        save_state(state)

    print("  Done: %d/%d" % (imported, total), flush=True)
    return imported


def import_large_file_resumable(kb_id, filepath, source_label, state_key, state):
    if not filepath.exists():
        print("  WARNING: %s not found" % filepath, flush=True)
        return 0
    text = filepath.read_text(encoding="utf-8", errors="replace")
    chunks = chunk_large_text(text, source_label)
    total = len(chunks)
    already_done = state.get(state_key, 0)
    if already_done >= total:
        print("  Already complete (%d/%d chunks)" % (already_done, total), flush=True)
        return already_done

    print("  File: %d chars, %d chunks, resuming from %d..." % (len(text), total, already_done), flush=True)
    imported = already_done
    remaining = chunks[already_done:]
    for i in range(0, len(remaining), BATCH_SIZE):
        batch = remaining[i:i + BATCH_SIZE]
        count = import_chunks(kb_id, batch)
        imported += count
        state[state_key] = imported
        save_state(state)
        print("  Imported %d/%d chunks..." % (imported, total), flush=True)
        time.sleep(1)
    print("  Done: %d chunks" % imported, flush=True)
    return imported


def main():
    if not API_KEY:
        print("ERROR: Set MEMORY_CRYSTAL_API_KEY", flush=True)
        sys.exit(1)

    state = load_state()
    print("=" * 58, flush=True)
    print("  Morrow Migration (resumable)", flush=True)
    print("=" * 58, flush=True)
    print("State: %s" % json.dumps(state), flush=True)

    episodes = parse_dump_file(WORK_DIR / "episodes-dump.txt")
    social = parse_dump_file(WORK_DIR / "social-dump.txt")
    zoom = parse_dump_file(WORK_DIR / "zoom-dump.txt")

    # 1. Podcast Library
    print("\n-- 1. Podcast Library (%d episodes) --" % len(episodes), flush=True)
    kb_id, existing = get_or_create_kb(
        "Podcast Library",
        "Morrow Relationship Science podcast episodes -- 410+ episodes of actionable coaching content.",
    )
    state["podcast_kb_id"] = kb_id
    import_entries_resumable(kb_id, episodes, "youtube-podcast", "podcast_imported", state)

    # 2. Disrupting Divorce
    print("\n-- 2. Disrupting Divorce --", flush=True)
    kb_id, existing = get_or_create_kb(
        "Disrupting Divorce",
        "Full text of 'Disrupting Divorce' -- foundational book on relationship science methodology.",
        "book",
    )
    state["book_kb_id"] = kb_id
    import_large_file_resumable(kb_id, WORK_DIR / "disrupting-divorce.md", "disrupting-divorce", "book_imported", state)

    # 3. Marriage Reset Course
    print("\n-- 3. Marriage Reset Course V4 --", flush=True)
    kb_id, existing = get_or_create_kb(
        "Marriage Reset Course",
        "Marriage Reset V4 -- structured coaching course with modules, exercises, and frameworks.",
        "course",
    )
    state["course_kb_id"] = kb_id
    import_large_file_resumable(kb_id, WORK_DIR / "marriage-reset-v4.md", "marriage-reset-v4", "course_imported", state)

    # 4. Social Posts
    print("\n-- 4. Social Posts (%d posts) --" % len(social), flush=True)
    kb_id, existing = get_or_create_kb(
        "Social Posts",
        "400 social media posts -- voice, messaging, and content patterns for the Morrow brand.",
        "social-media",
    )
    state["social_kb_id"] = kb_id
    import_entries_resumable(kb_id, social, "social-post", "social_imported", state)

    # 5. Zoom Calls
    print("\n-- 5. Zoom Call Transcripts --", flush=True)
    kb_id, existing = get_or_create_kb(
        "Zoom Calls",
        "Recorded coaching/strategy zoom call transcripts.",
        "transcript",
    )
    state["zoom_kb_id"] = kb_id
    zoom_done = state.get("zoom_imported", 0)
    if zoom_done < len(zoom):
        for idx, (filename, content) in enumerate(zoom):
            if idx < zoom_done:
                continue
            print("  Processing %s..." % filename, flush=True)
            chunks = chunk_large_text(content, "zoom-%s" % filename.replace(".md", ""))
            for i in range(0, len(chunks), BATCH_SIZE):
                batch = chunks[i:i + BATCH_SIZE]
                import_chunks(kb_id, batch)
                time.sleep(1)
            print("  %s: %d chunks" % (filename, len(chunks)), flush=True)
            state["zoom_imported"] = idx + 1
            save_state(state)

    # Write sentinel
    Path("/tmp/morrow-migration-done.txt").write_text("DONE at %s\n" % time.strftime("%Y-%m-%d %H:%M:%S"))

    print("\n" + "=" * 58, flush=True)
    print("  MIGRATION COMPLETE", flush=True)
    print("=" * 58, flush=True)
    save_state(state)
    print("Final state: %s" % json.dumps(state, indent=2), flush=True)


if __name__ == "__main__":
    main()
