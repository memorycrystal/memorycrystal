#!/usr/bin/env python3
"""Export all QMD index chunks from the coach SQLite into JSON files for MC import.

Runs on the Railway container. Outputs one JSON file per KB category to /tmp/qmd-export/.
Each file contains an array of {text, path, start_line, end_line, chunk_index, total_chunks_in_file}.
"""
import sqlite3
import json
import os

DB_PATH = "/data/.openclaw/memory/coach.sqlite"
OUTPUT_DIR = "/tmp/qmd-export"

def categorize(path):
    if "/episodes/" in path:
        return "podcast-episodes"
    if "/social-posts/" in path:
        return "social-posts"
    if path.startswith("memory/clients/"):
        return "client-notes"
    if "disrupting-divorce" in path:
        return "book"
    if "marriage-reset" in path:
        return "course"
    if "zoom-call" in path:
        return "zoom-calls"
    if "/lookup/" in path:
        return "lookup-indexes"
    if path.startswith("memory/2026-") or path == "MEMORY.md":
        return "daily-memory"
    return "other"

def extract_file_id(path):
    """Extract a human-readable file identifier from the path."""
    basename = os.path.basename(path)
    if basename.endswith(".md"):
        basename = basename[:-3]
    return basename

def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    # Get all chunks ordered by path and start_line
    cursor.execute("""
        SELECT id, path, start_line, end_line, text, LENGTH(text) as text_len
        FROM chunks
        ORDER BY path, start_line
    """)
    
    # Group by file to compute chunk_index and total_chunks
    file_chunks = {}
    for row in cursor.fetchall():
        chunk_id, path, start_line, end_line, text, text_len = row
        if path not in file_chunks:
            file_chunks[path] = []
        file_chunks[path].append({
            "id": chunk_id,
            "path": path,
            "start_line": start_line,
            "end_line": end_line,
            "text": text,
            "text_len": text_len
        })
    
    conn.close()
    
    # Categorize and add chunk_index/total_chunks metadata
    categories = {}
    for path, chunks in file_chunks.items():
        cat = categorize(path)
        if cat not in categories:
            categories[cat] = []
        
        total_chunks = len(chunks)
        file_id = extract_file_id(path)
        
        for idx, chunk in enumerate(chunks):
            categories[cat].append({
                "text": chunk["text"],
                "file_id": file_id,
                "path": chunk["path"],
                "chunk_index": idx,
                "total_chunks": total_chunks,
                "start_line": chunk["start_line"],
                "end_line": chunk["end_line"],
                "text_len": chunk["text_len"]
            })
    
    # Write each category to a JSON file
    total = 0
    for cat, chunks in sorted(categories.items(), key=lambda x: -len(x[1])):
        output_path = os.path.join(OUTPUT_DIR, "%s.json" % cat)
        with open(output_path, "w") as f:
            json.dump(chunks, f)
        total += len(chunks)
        print("%s: %d chunks, %d files -> %s" % (
            cat, len(chunks), len(set(c["file_id"] for c in chunks)), output_path
        ))
    
    print("\nTotal: %d chunks exported to %s" % (total, OUTPUT_DIR))

if __name__ == "__main__":
    main()
