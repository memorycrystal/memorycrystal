---
name: crystal-hygiene
description: Clean up Memory Crystal conversational memory — find and resolve duplicates, stale claims, and contradictions using supersession. Use when memory feels noisy, recall surfaces outdated facts, or the user asks to clean/audit memory.
---

# Crystal Hygiene

A user-level hygiene pass over conversational memory (LTM). Uses only MCP
tools; server-side bulk cleanup belongs to the operator, not this skill.

## Freshness policy (the core rule)

Apply `references/freshness-policy.md`: every stored fact is **timeless**,
**dated**, or a **pointer**.
- Timeless facts (preferences, identities, rules) stay as-is until contradicted.
- Dated facts must carry their date in the content ("As of 2026-07, ...").
  A dated fact contradicted by newer information is superseded, not edited
  into a different claim.
- Pointers ("the canonical list lives in KB X") beat copies. Prefer storing a
  pointer over duplicating reference content into conversational memory.

## Procedure

1. Scope with the user: which topic/project, or a full pass?
2. Survey: `crystal_what_do_i_know` on the topic, then `crystal_recall` on its
   main entities. Note near-duplicates, stale claims, contradictions.
3. Before any bulk change: `crystal_checkpoint` (label it, e.g. "pre-hygiene").
4. Resolve, smallest change first:
   - Same fact, worse copy → keep the best row, `crystal_forget` the copies.
   - Outdated fact with a live successor → `crystal_supersede` (preserves
     lineage; never silently delete a fact that was once true).
   - Right fact, wrong details/tags → `crystal_update` in place.
   - Genuine conflict you cannot adjudicate → ask the user; do not guess.
5. Report what changed: counts of forgotten/superseded/updated, and anything
   you deliberately left alone.

## Boundaries

- Never touch knowledge-base chunks here (that is crystal-kb's domain).
- Never bulk-delete: hygiene is one considered decision per memory.
- If you find what looks like another user's or another agent's private data,
  STOP and report it to the user verbatim-free (describe, do not quote).
