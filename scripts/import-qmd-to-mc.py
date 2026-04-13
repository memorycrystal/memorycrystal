#!/usr/bin/env python3
"""Import QMD-exported chunks into Memory Crystal knowledge bases via bulk-insert API.

Usage:
  python3 import-qmd-to-mc.py

Reads JSON files from /tmp/qmd-import/ and imports into MC knowledge bases.
Uses the bulk-insert endpoint (no embedding/enrichment -- backfill separately).
Supports resume via state file.
"""
import json
import os
import sys
import time
import urllib.request
import urllib.error

API_URL = "https://rightful-mockingbird-389.convex.site"
API_KEY = "047293850b6ca51765deaeb29d73296205281afd4cd58d478d0979fde0c67bcf"
IMPORT_DIR = "/tmp/qmd-import"
STATE_FILE = "/tmp/qmd-bulk-import-state.json"
SENTINEL_FILE = "/tmp/qmd-bulk-import-done.txt"
BATCH_SIZE = 50  # bulk-insert supports up to 100

# Existing KB IDs (from Morrow's MC account)
EXISTING_KBS = {
    "podcast-episodes": "qn75h0qq3k69hwgc02ahex259x8437sz",
    "social-posts": "qn72t4hzhzyvrwzjaqteq1v0ed842n9e",
    "course": "qn728cybdjsk7ynaf06zv0d8k5843y3r",
    "book": "qn771sz1vpax6rs05g3w39sah5843tgh",
    "zoom-calls": "qn73t8vyt98h045cqjc55ybbdx845rxq",
}

# New KBs to create
NEW_KBS = {
    "client-notes": {
        "name": "Client Notes",
        "description": "Per-client coaching notes, conversation summaries, and progress tracking.",
        "sourceType": "client-data",
    },
    "lookup-indexes": {
        "name": "Lookup Indexes",
        "description": "Cross-reference indexes for podcasts, social posts, courses, and zoom calls.",
        "sourceType": "index",
    },
}

AGENT_IDS = [
    "ask-cass", "ask-kathryn", "coach", "comment-replies", "copywriting",
    "dm-replies", "heartbeat", "main", "marco", "seo-aeo-geo",
    "social-media", "web-dev"
]

MAX_RETRIES = 3


def api_call(method, path, body=None):
    """Make an API call to the MC backend."""
    url = API_URL + path
    data = json.dumps(body).encode("utf-8") if body else None
    headers = {
        "Authorization": "Bearer %s" % API_KEY,
        "Content-Type": "application/json",
    }

    for attempt in range(MAX_RETRIES):
        try:
            req = urllib.request.Request(url, data=data, headers=headers, method=method)
            with urllib.request.urlopen(req, timeout=300) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            status = e.code
            body_text = ""
            try:
                body_text = e.read().decode("utf-8")
            except Exception:
                pass
            if status == 429:
                wait = 5 * (attempt + 1)
                print("  Rate limited (429), waiting %ds..." % wait)
                time.sleep(wait)
                continue
            if status >= 500:
                wait = 3 * (attempt + 1)
                print("  Server error (%d), retrying in %ds... %s" % (status, wait, body_text[:200]))
                time.sleep(wait)
                continue
            raise Exception("HTTP %d: %s" % (status, body_text[:500]))
        except Exception as e:
            if attempt < MAX_RETRIES - 1:
                wait = 3 * (attempt + 1)
                print("  Error: %s, retrying in %ds..." % (str(e)[:100], wait))
                time.sleep(wait)
                continue
            raise

    raise Exception("Max retries exceeded")


def load_state():
    """Load resume state."""
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE, "r") as f:
            return json.load(f)
    return {"completed_categories": [], "current_category": None, "current_offset": 0, "kb_ids": {}}


def save_state(state):
    """Save resume state."""
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)


def create_kb(category, config):
    """Create a new knowledge base."""
    result = api_call("POST", "/api/knowledge-bases", {
        "name": config["name"],
        "description": config["description"],
        "agentIds": AGENT_IDS,
        "sourceType": config.get("sourceType", "markdown"),
    })
    kb_id = result.get("knowledgeBaseId")
    print("Created KB '%s': %s" % (config["name"], kb_id))
    return kb_id


def import_category(category, kb_id, chunks, start_offset=0):
    """Import all chunks for a category using bulk-insert."""
    total = len(chunks)
    imported = start_offset
    failed = 0

    for i in range(start_offset, total, BATCH_SIZE):
        batch = chunks[i:i + BATCH_SIZE]
        payload = []
        for c in batch:
            payload.append({
                "content": c["text"],
                "title": c.get("file_id", ""),
                "sourceType": c.get("sourceType", category),
                "chunkIndex": c.get("ci"),
                "totalChunks": c.get("tc"),
            })

        try:
            result = api_call("POST", "/api/knowledge-bases/%s/bulk-insert" % kb_id, {
                "chunks": payload,
            })
            count = result.get("importedCount", 0)
            imported += count
            if count < len(batch):
                failed += len(batch) - count
        except Exception as e:
            print("  BATCH FAILED at offset %d: %s" % (i, str(e)[:200]))
            failed += len(batch)

        if (i // BATCH_SIZE) % 10 == 0 or i + BATCH_SIZE >= total:
            print("  %s: %d/%d imported (%d failed)" % (category, imported, total, failed))

        # Throttle to stay under 60 req/min rate limit
        time.sleep(1.2)

        # Save state after every batch
        state = load_state()
        state["current_category"] = category
        state["current_offset"] = imported
        save_state(state)

    return imported, failed


def main():
    state = load_state()
    completed = set(state.get("completed_categories", []))
    kb_ids = state.get("kb_ids", {})

    # Merge existing KB IDs
    for cat, kid in EXISTING_KBS.items():
        if cat not in kb_ids:
            kb_ids[cat] = kid

    # Create new KBs if needed
    for cat, config in NEW_KBS.items():
        if cat not in kb_ids:
            kb_ids[cat] = create_kb(cat, config)
        else:
            print("KB for '%s' already exists: %s" % (cat, kb_ids[cat]))

    state["kb_ids"] = kb_ids
    save_state(state)

    # Import order: smallest first (for quick wins), largest last
    import_order = [
        "lookup-indexes",
        "zoom-calls",
        "book",
        "course",
        "social-posts",
        "client-notes",
        "podcast-episodes",
    ]

    total_imported = 0
    total_failed = 0

    for category in import_order:
        if category in completed:
            print("SKIP %s (already completed)" % category)
            continue

        json_file = os.path.join(IMPORT_DIR, category + ".json")
        if not os.path.exists(json_file):
            print("SKIP %s (no JSON file)" % category)
            continue

        kb_id = kb_ids.get(category)
        if not kb_id:
            print("SKIP %s (no KB ID)" % category)
            continue

        with open(json_file, "r") as f:
            chunks = json.load(f)

        start_offset = 0
        if state.get("current_category") == category:
            start_offset = state.get("current_offset", 0)
            if start_offset > 0:
                print("RESUME %s at offset %d/%d" % (category, start_offset, len(chunks)))

        print("IMPORTING %s: %d chunks -> KB %s" % (category, len(chunks), kb_id))
        imported, failed = import_category(category, kb_id, chunks, start_offset)
        total_imported += imported
        total_failed += failed

        completed.add(category)
        state["completed_categories"] = list(completed)
        state["current_category"] = None
        state["current_offset"] = 0
        save_state(state)

        print("DONE %s: %d imported, %d failed\n" % (category, imported, failed))

    # Write sentinel
    with open(SENTINEL_FILE, "w") as f:
        f.write("QMD bulk import completed at %s\n" % time.strftime("%Y-%m-%d %H:%M:%S"))
        f.write("Total imported: %d\n" % total_imported)
        f.write("Total failed: %d\n" % total_failed)

    print("\n=== COMPLETE ===")
    print("Total imported: %d" % total_imported)
    print("Total failed: %d" % total_failed)


if __name__ == "__main__":
    main()
