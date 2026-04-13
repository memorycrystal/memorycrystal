#!/usr/bin/env python3
"""
Morrow Marriage -> Memory Crystal Knowledge Base Migration

Reads pre-downloaded training data from /tmp/morrow-migration/ and imports
into MC Knowledge Bases via the HTTP API.

Usage:
  MEMORY_CRYSTAL_API_KEY=<key> python3 scripts/migrate-morrow.py [--dry-run]
"""

import json
import os
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

API_KEY = os.environ.get("MEMORY_CRYSTAL_API_KEY", "")
API_URL = os.environ.get("MEMORY_CRYSTAL_API_URL", "https://rightful-mockingbird-389.convex.site")
WORK_DIR = Path("/tmp/morrow-migration")
DRY_RUN = "--dry-run" in sys.argv
BATCH_SIZE = 3  # Small batches - each chunk triggers embed + salience + graph
CHUNK_MAX_CHARS = 4000
MAX_RETRIES = 3

AGENT_IDS = [
    "ask-cass", "ask-kathryn", "coach", "comment-replies", "copywriting",
    "dm-replies", "heartbeat", "main", "marco", "seo-aeo-geo",
    "social-media", "web-dev"
]


def api_call(method, path, body=None):
    if DRY_RUN:
        print("  [DRY RUN] %s %s" % (method, path))
        return {"knowledgeBaseId": "dry-run-id", "importedCount": 0}

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
                wait = (attempt + 1) * 5
                print("  RETRY (%d/%d): HTTP %d, waiting %ds..." % (attempt+1, MAX_RETRIES, e.code, wait), file=sys.stderr)
                time.sleep(wait)
                continue
            print("  ERROR: %s %s -> HTTP %d: %s" % (method, path, e.code, error_body), file=sys.stderr)
            raise
        except Exception as e:
            if attempt < MAX_RETRIES - 1:
                wait = (attempt + 1) * 5
                print("  RETRY (%d/%d): %s, waiting %ds..." % (attempt+1, MAX_RETRIES, e, wait), file=sys.stderr)
                time.sleep(wait)
                continue
            raise
    return {}


def create_kb(name, description, source_type="markdown"):
    print("Creating KB: %s" % name)
    result = api_call("POST", "/api/knowledge-bases", {
        "name": name,
        "description": description,
        "sourceType": source_type,
        "agentIds": AGENT_IDS,
    })
    kb_id = result.get("knowledgeBaseId", "")
    print("  KB ID: %s" % kb_id)
    return kb_id


def import_chunks(kb_id, chunks):
    if not chunks:
        return 0
    result = api_call("POST", "/api/knowledge-bases/%s/import" % kb_id, {"chunks": chunks})
    return result.get("importedCount", 0)


def parse_dump_file(dump_path):
    if not dump_path.exists():
        print("  WARNING: %s not found" % dump_path, file=sys.stderr)
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


def import_entries_as_chunks(kb_id, entries, source_label):
    total = len(entries)
    imported = 0
    batch = []
    for i, (filename, content) in enumerate(entries):
        file_id = filename.replace(".md", "")
        batch.append({
            "content": content,
            "metadata": {"title": file_id, "sourceType": source_label}
        })
        if len(batch) >= BATCH_SIZE:
            count = import_chunks(kb_id, batch)
            imported += count
            print("  Imported %d/%d..." % (imported, total))
            batch = []
            time.sleep(1)
    if batch:
        count = import_chunks(kb_id, batch)
        imported += count
    print("  Done: %d/%d imported" % (imported, total))
    return imported


def import_large_file(kb_id, filepath, source_label):
    if not filepath.exists():
        print("  WARNING: %s not found" % filepath, file=sys.stderr)
        return 0
    text = filepath.read_text(encoding="utf-8", errors="replace")
    print("  File size: %d chars" % len(text))
    chunks = chunk_large_text(text, source_label)
    print("  Chunked into %d pieces" % len(chunks))
    imported = 0
    for i in range(0, len(chunks), BATCH_SIZE):
        batch = chunks[i:i + BATCH_SIZE]
        count = import_chunks(kb_id, batch)
        imported += count
        print("  Imported %d/%d chunks..." % (imported, len(chunks)))
        time.sleep(1)
    print("  Done: %d chunks" % imported)
    return imported


def main():
    if not API_KEY:
        print("ERROR: Set MEMORY_CRYSTAL_API_KEY", file=sys.stderr)
        sys.exit(1)

    print("=" * 58)
    print("  Morrow Marriage -> Memory Crystal Migration")
    print("=" * 58)
    print()
    if DRY_RUN:
        print("[DRY RUN] No API calls will be made.\n")

    episodes = parse_dump_file(WORK_DIR / "episodes-dump.txt")
    social = parse_dump_file(WORK_DIR / "social-dump.txt")
    zoom = parse_dump_file(WORK_DIR / "zoom-dump.txt")
    book_exists = (WORK_DIR / "disrupting-divorce.md").exists()
    course_exists = (WORK_DIR / "marriage-reset-v4.md").exists()

    print("Data inventory:")
    print("  Episodes:     %d" % len(episodes))
    print("  Social posts: %d" % len(social))
    print("  Zoom calls:   %d" % len(zoom))
    print("  Book:         %s" % ("yes" if book_exists else "MISSING"))
    print("  Course:       %s" % ("yes" if course_exists else "MISSING"))
    print()

    results = {}

    # 1. Podcast Library
    print("-- 1. Podcast Library --")
    kb_id = create_kb(
        "Podcast Library",
        "Morrow Relationship Science podcast episodes -- 410+ episodes of actionable coaching content on marriage, divorce, and relationship psychology.",
        "markdown"
    )
    results["podcasts"] = kb_id
    if episodes:
        import_entries_as_chunks(kb_id, episodes, "youtube-podcast")
    print()

    # 2. Disrupting Divorce
    print("-- 2. Disrupting Divorce --")
    kb_id = create_kb(
        "Disrupting Divorce",
        "Full text of 'Disrupting Divorce' by Morrow -- foundational book on relationship science methodology, attachment theory, and practical frameworks.",
        "book"
    )
    results["book"] = kb_id
    if book_exists:
        import_large_file(kb_id, WORK_DIR / "disrupting-divorce.md", "disrupting-divorce")
    print()

    # 3. Marriage Reset Course
    print("-- 3. Marriage Reset Course V4 --")
    kb_id = create_kb(
        "Marriage Reset Course",
        "Marriage Reset V4 -- structured coaching course with modules, exercises, and frameworks for relationship transformation.",
        "course"
    )
    results["course"] = kb_id
    if course_exists:
        import_large_file(kb_id, WORK_DIR / "marriage-reset-v4.md", "marriage-reset-v4")
    print()

    # 4. Social Posts
    print("-- 4. Social Posts --")
    kb_id = create_kb(
        "Social Posts",
        "400 social media posts -- voice, messaging, and content patterns for the Morrow brand.",
        "social-media"
    )
    results["social"] = kb_id
    if social:
        import_entries_as_chunks(kb_id, social, "social-post")
    print()

    # 5. Zoom Calls
    print("-- 5. Zoom Call Transcripts --")
    kb_id = create_kb(
        "Zoom Calls",
        "Recorded coaching/strategy zoom call transcripts -- real conversation examples and coaching methodology in action.",
        "transcript"
    )
    results["zoom"] = kb_id
    if zoom:
        for filename, content in zoom:
            print("  Processing %s..." % filename)
            chunks = chunk_large_text(content, "zoom-%s" % filename.replace(".md", ""))
            imported = 0
            for i in range(0, len(chunks), BATCH_SIZE):
                batch = chunks[i:i + BATCH_SIZE]
                count = import_chunks(kb_id, batch)
                imported += count
                time.sleep(1)
            print("  %s: %d chunks" % (filename, imported))
    print()

    # Summary
    print("=" * 58)
    print("  Migration Complete")
    print("=" * 58)
    print()
    for label, kb_id in results.items():
        print("  %-20s -> %s" % (label, kb_id))
    print()
    print("  Shared across agents: %s" % ", ".join(AGENT_IDS))
    print()


if __name__ == "__main__":
    main()
