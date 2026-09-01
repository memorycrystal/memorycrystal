---
name: crystal-brief
description: Session bootstrap for Memory Crystal. Use at the start of a session, when asked to "load memory", "brief yourself", or whenever Memory Crystal tools seem unused or unresponsive. Verifies the MCP server, loads context, and applies the mandatory memory discipline.
---

# Crystal Brief

Bootstrap this session on Memory Crystal, then work under its discipline.

## 1. Verify the tools respond

Call `crystal_status` (fall back to `crystal_stats`). If the memory-crystal MCP
server is missing or errors:
- Do NOT hand-edit any agent config file.
- If any Memory Crystal config in reach points at a legacy host
  (`rightful-mockingbird-389.convex.cloud`/`.convex.site`, `loyal-mongoose-173`,
  or any raw `*.convex.cloud` base), the fix is a base-URL migration to
  `https://convex.memorycrystal.ai` — re-run the official installer, which
  migrates it: `curl -fsSL https://memorycrystal.ai/crystal | bash`
  (Windows: `iwr https://memorycrystal.ai/install.ps1 -OutFile install.ps1; .\install.ps1`).
  A 500 from a legacy host means the deployment is decommissioned, not broken.
- Otherwise re-run the installer and read its output. Then stop and report.

## 2. Load context

Call `crystal_wake` (or `crystal_what_do_i_know` with the current project/topic)
and skim the result before doing anything else. Mention nothing about this
mechanical step to the user; just use what you learn.

## 3. Mandatory discipline — every session, not optional

<!-- discipline:start -->
- **Recall (read):** call crystal_recall (crystal_what_do_i_know for broad topics) when the task depends on past work, decisions, people, projects, or preferences. Never answer from vague recollection. Skip self-contained requests.
- Need exact past wording, quotes, commands, or code? crystal_search_messages.
- **Remember (write):** after learning any durable fact, decision, preference, lesson, or goal: save it with crystal_remember immediately, without being asked. Correct existing memories with crystal_update; replace outdated ones with crystal_supersede.
- BEFORE config changes, deletions, or external sends: crystal_preflight for the rules and lessons that apply.
- Reference material lives in knowledge bases: crystal_list_knowledge_bases to discover them, crystal_query_knowledge_base with the KB name for targeted lookups.
- Before changing something you did not build: crystal_why_did_we / crystal_who_owns / crystal_explain_connection.
- At major milestones, or when the user asks for a backup: crystal_checkpoint.
<!-- discipline:end -->

Only skip these tools for greetings, small talk, or questions fully answered
inside the current conversation.

## 4. Write-time validation (before every crystal_remember)

Ask three questions before saving:
1. Durable? (Useful in a future session — not ephemeral chatter.)
2. Correctly classified? (Right store and category; see the tool schema.)
3. Consistent? If the write response reports `contradiction.detected: true`,
   surface the conflict to the user and offer: update the old memory, supersede
   it, keep both with clarified scope, or cancel.

Classify every fact per `references/freshness-policy.md`: timeless, dated, or a
pointer — dated facts carry their date in the content; contradictions are
resolved with `crystal_supersede`, never silent deletion.
