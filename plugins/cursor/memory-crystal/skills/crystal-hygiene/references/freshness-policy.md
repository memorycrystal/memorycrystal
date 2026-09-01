# Freshness Policy

Adapted for Memory Crystal from the Open Knowledge Metabolism (OKM) idea in
eugeniughelbur/obsidian-second-brain (MIT) — rewritten for Memory Crystal's
stores, supersession lineage, and knowledge bases.

Every stored fact is exactly one of:

1. **Timeless** — preferences, identities, standing rules, lessons.
   ("Andy prefers direct answers." "Never cut releases unprompted.")
   Stays until contradicted; contradiction is resolved by supersession.

2. **Dated** — true as of a moment, expected to drift.
   ("As of 2026-07, production runs on Railway self-hosted Convex.")
   The date lives IN the content, not only in metadata. When a dated fact is
   contradicted by newer information, `crystal_supersede` it with the new
   dated fact — lineage preserved, history queryable, nothing silently lost.

3. **Pointer** — a reference to where truth lives.
   ("The canonical episode list is the 'Podcast Library' knowledge base.")
   Pointers beat copies: reference corpora belong in knowledge bases with
   dedupeKeys; conversational memory should point at them, not mirror them.

Rules of thumb:
- Never edit a dated fact into a different claim — supersede it.
- Never store a copy when a pointer will do.
- A fact that cannot be classified is usually not durable — do not save it.
