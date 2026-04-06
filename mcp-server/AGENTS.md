# MCP Server AGENTS

## Package Identity

- Purpose: MCP tool surface exposed as `crystal_*` and all Convex/embedding/Obsidian adapters.
- Scope: `mcp-server/src`.

## Setup Commands

- Install deps: `cd mcp-server && npm install`
- Build server: `cd mcp-server && npm run build`
- Run locally: `cd mcp-server && npm run start`
## Conventions

- Follow `typescript` strict typing (`mcp-server/tsconfig.json`).
- Keep tool schemas explicit and deterministic (`Tool` input schemas).
- Validate incoming arguments before calling Convex actions.
- Prefer small single-purpose handlers in `src/tools`.
- Keep shared client/embed/obsidian adapters in `src/lib`.

### ✅ DO / ❌ DON'T

- ✅ `src/tools/remember.ts`
- ✅ `src/tools/recall.ts`
- ✅ `src/index.ts`
- ❌ `src` code that catches and swallows errors without operator feedback.

## Touch Points / Key Files

- `./src/index.ts` — server entry, tool registration + transport (stdio / SSE)
- `./src/tools/remember.ts`
- `./src/tools/recall.ts`
- `./src/tools/recent.ts`
- `./src/tools/search-messages.ts`
- `./src/tools/what-do-i-know.ts`
- `./src/tools/why-did-we.ts`
- `./src/tools/who-owns.ts`
- `./src/tools/explain-connection.ts`
- `./src/tools/dependency-chain.ts`
- `./src/tools/preflight.ts`
- `./src/tools/forget.ts`
- `./src/tools/stats.ts`
- `./src/tools/checkpoint.ts`
- `./src/tools/wake.ts`
- `./src/lib/convex-client.ts`
- `./src/lib/convexClient.ts`
- `./src/lib/embed.ts`
- `./package.json`

## JIT Index Hints

- Search tool names: `rg -n "name: \"crystal_" src/tools`
- Find input schemas: `rg -n "inputSchema|required" src/tools`
- Validate Convex calls: `rg -n "mutation\\(|query\\(|action\\(" src`

## Common Gotchas

- `scripts/crystal-enable.sh` writes command maps based on `mcp-server/dist/index.js`; rebuild before enable when tool logic changes.
- Embedding provider behavior should remain explicit; keep `EMBEDDING_PROVIDER` in env for defaults.

## Pre-PR Checks

- `cd mcp-server && npm run build`
- `npm run test:smoke`

---

# Memory Crystal — Agent Session Guide

Instructions for AI agents (Codex, Claude, etc.) using Memory Crystal tools during coding sessions.

## Session Lifecycle

**1. Wake** — call `crystal_wake` before your first action in any session:
```
crystal_wake(channel="<your-channel>")
```
Read the briefing: active goals, recent decisions, pending work.

**2. Work** — save memories as you go (proactively, without being asked).

**3. Checkpoint** — at the end of significant sessions:
```
crystal_checkpoint(label="What was done. What comes next.")
```

---

## Memory Taxonomy for Code Projects

| What to remember | Store | Category |
|-----------------|-------|----------|
| Tech stack / API choices | `semantic` | `fact` |
| Architecture decisions | `semantic` | `decision` |
| Rules / constraints | `semantic` | `rule` |
| Bugs fixed, lessons | `semantic` | `lesson` |
| Session summaries | `episodic` | `conversation` |
| Build / deploy procedures | `procedural` | `workflow` |
| Project goals, TODOs | `prospective` | `goal` |

---

## When to Recall vs When to Remember

**Recall before:**
- Starting a new feature ("has this been decided before?")
- Revisiting a past decision
- User asks "do you remember..." or "why did we..."

```
crystal_recall(query="session storage approach")
crystal_what_do_i_know(topic="embedding pipeline")
crystal_why_did_we(decision="use Convex mutations over HTTP actions")
```

**Remember after:**
- Any architectural or tech decision made
- A bug fixed with a non-obvious root cause
- A new project goal or constraint
- A workflow or procedure established
- End of a significant working session (as a summary)

---

## Quality Standards

### Titles — specific and searchable:
```
✅ "Chose PostgreSQL over SQLite — needs concurrent write support"
✅ "Fixed stale embedding cache bug in crystal_recall"
✅ "Deploy via docker-compose on DigitalOcean, not bare node"

❌ "database"  ❌ "bug fix"  ❌ "deployment notes"
```

### Content — include context:
- Decisions: what was decided, why, what alternatives were rejected
- Lessons: what went wrong, what the fix was, how to avoid it next time
- Goals: the target, timeline, key milestones

### Tags — 3–6, consistent:
- Mix specific (`convex`, `embedding`) and general (`architecture`, `decision`)
- Pick a term and stick with it (`deploy` vs `deployment` — choose one)

---

## Don't

- Skip `crystal_wake` — always wake first
- Save trivial info ("ran npm install", "opened the file")
- Use vague titles — useless for future recall
- Call `crystal_recall` on every message — only when past context is relevant
- Save duplicate memories — if something similar already exists, the old one may need archiving
- Spam `crystal_remember` on minor actions — quality over quantity
