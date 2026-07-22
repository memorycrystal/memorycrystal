---
name: crystal-kb
description: Create, import, enumerate, maintain, and share Memory Crystal knowledge bases. Use when importing reference material, syncing a corpus, cleaning or auditing a KB, or managing which agents can read a KB.
---

# Crystal KB

Knowledge-base workflows over the crystal_* MCP tools. KBs hold reference
corpora (books, courses, transcripts, docs); conversational memory does NOT
belong in a KB.

## Import — dedupeKey is mandatory

Every chunk you import via `crystal_import_knowledge` MUST carry a stable
`dedupeKey` (one logical chunk = one key, e.g. a song title, a doc slug, a
file path). Re-importing a chunk with the same key REPLACES it in place.
Without dedupeKey, re-imports append: a production sync once accumulated 32
copies of the same chunk. There is no exception to this rule.

Recommended flow:
1. `crystal_list_knowledge_bases` — find or confirm the KB (note its id).
2. `crystal_create_knowledge_base` only when it truly does not exist.
3. Import in batches with dedupeKeys; keep chunks self-contained and bounded
   (aim well under 12,000 characters per chunk; summaries beat raw dumps).
4. Verify: `crystal_list_knowledge_base_memories` with the kbId — chunk count
   should match your source count exactly on every re-run.

## Maintain

- Enumerate everything: `crystal_list_knowledge_base_memories` (cursor-paginated).
- Edit one chunk in place: `crystal_update` with its id (re-embeds automatically).
- Delete one chunk: `crystal_forget`.
- Reset a KB without losing its id/bindings: `crystal_empty_knowledge_base`,
  then re-import with dedupeKeys.

## Access and priorities

- Who can read a KB is an agentIds allowlist. Manage it with
  `crystal_set_knowledge_base_access` (actions: add, remove, set, open —
  add/remove default to this agent's own identity). Never open a KB holding
  per-client or private notes to every agent; when unsure, ask the user first.
- `crystal_list_knowledge_bases` output includes `agentPriorities` and your
  `resolvedAgentPriority`: a value below 1.0 means this KB is deliberately
  down-weighted for you in ambient recall. Deliberate `crystal_query_knowledge_base`
  calls are always full strength — use them for on-demand reads. Priorities are
  owner-managed; report a misweighting to the user instead of trying to change it.

## Query

For targeted reference lookups use `crystal_query_knowledge_base` with
`knowledgeBaseName` (or id) — not broad recall. Broad recall is for
conversational memory; named-KB queries are for reference material.
