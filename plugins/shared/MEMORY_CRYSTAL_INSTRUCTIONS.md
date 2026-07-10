# Memory Crystal — Agent Usage Guide

You have access to Memory Crystal, a persistent cognitive memory system that
spans sessions and agents. This file is the canonical guide for how an agent
should use it.

## Automatic behavior (via hooks)

On supported hosts, messages in this session are automatically captured to
short-term memory and relevant memories are recalled before each response. You
do not manage that pipeline manually. The tools below are for *deliberate*
recall, saving, and scoping on top of the automatic layer.

## The core loop: preflight → KB query → recall → remember/import

Work through these in order when you need memory:

1. **`crystal_preflight`** — call *before* destructive, irreversible, or
   high-stakes actions (deletes, migrations, releases, spend). It surfaces prior
   decisions, rules, and warnings that should gate the action.
2. **`crystal_query_knowledge_base`** — query named corpora first: manuals, voice
   guides, transcripts, imported repo docs, persona guardrails. KBs are curated
   and high-signal, so hit them before general recall for anything that lives in
   a named reference set. Use `crystal_list_knowledge_bases` to discover names.
3. **`crystal_recall`** — blended durable recall across extracted facts,
   decisions, and lessons. Use this for "what do I know about X" once KBs are
   checked. Prefer `crystal_what_do_i_know` for broad topic scans.
4. **`crystal_remember`** (and **`crystal_import_knowledge`**) — persist the
   outcome. Save non-obvious decisions and their reasoning, user corrections, and
   preferences with `crystal_remember`. Use `crystal_import_knowledge` to load a
   document/corpus into a knowledge base for future KB queries.

Supporting tools:

- **`crystal_search_messages`** — exact prior wording / transcript evidence only.
- **`crystal_checkpoint`** — only when the user explicitly asks for a checkpoint or backup.
- **`crystal_why_did_we`** — when asked about the rationale of a past decision.

## Always-visible core set (tool-search hosts)

Some hosts hide tools behind a search/discovery layer — notably the **Hermes
agent** and any **Codex build with `tool_search.enabled: auto`**. On those hosts
the full ~22 `crystal_*` tools are not surfaced up front; the agent must search
for them by name. If tools appear "missing," that is the discovery layer, not a
broken install.

Keep this core set reachable regardless of the search layer, and mention it in
the agent's system prompt:

- `crystal_recall`
- `crystal_remember`
- `crystal_preflight`

The remaining tools stay available via search.

## Isolation model (who can see what)

Memory Crystal scopes visibility by three inputs. Understand what each gates:

- **`agentId`** — gates **knowledge-base** visibility. A KB with
  `agentIds: ["coach"]` is only visible to callers resolving to `agentId:
  "coach"`. If you omit `agentId`, the backend derives one from the channel
  prefix, which can mismatch and silently return **0 KB hits**. Always pass an
  explicit, resolved `agentId` on `recall` / `wake` / `preflight` /
  `query_knowledge_base` when the host knows it.
- **`channel` / scope** — gates **non-KB** memory (raw messages and extracted
  memories). Channels isolate conversations (e.g. per Telegram/Discord peer).
  KBs are deliberately **not** channel-filtered — channel affects non-KB memory
  only.
- **`peerScopePolicy`** — controls how peer-scoped channels (multi-user bots)
  partition memory between individual users within one account.

**Hard privacy boundary:** `agentId` / `channel` / `peerScopePolicy` partition
visibility *within a single account*. They are not a hard security boundary. For
true cross-agent or cross-tenant privacy (e.g. separate customers who must never
see each other's memories), use **separate Memory Crystal accounts / API keys**,
not just distinct `agentId`s.

## Rules

1. Query Memory Crystal (KB then recall) before answering knowledge questions —
   do not rely solely on static documentation.
2. Pass an explicit resolved `agentId` whenever the host knows it, so
   agent-scoped KBs surface reliably.
3. Save non-obvious decisions and their reasoning with `crystal_remember`.
4. Save user corrections and preferences so they carry forward to future
   sessions.
5. When recalling, combine Memory Crystal results with local context for a
   complete picture.

## Host / hook installation note

The shared hook installers (`install-hook-config.mjs`, `remove-hook-config.mjs`)
recognize the hosts `codex`, `claude`, and `factory`. **Codex Desktop needs no
separate host key**: it shares `~/.codex/config.toml` and `~/.codex/hooks.json`
with the Codex CLI, so the `codex` host wiring configures both. Adding a distinct
`codex-desktop` host to the hook installers is unnecessary and would only
duplicate the same file writes.
