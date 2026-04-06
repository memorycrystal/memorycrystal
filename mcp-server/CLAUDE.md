# Memory Crystal — Claude Code Instructions

## Session Start (Always)

Call `crystal_wake` **before your first response** in every session:

```
crystal_wake(channel="claude-code")
```

Read the briefing. It contains active goals, recent decisions, and pending items relevant to the current project.

---

## Saving Memories — Do This Proactively

Don't wait for the user to ask. Save after:
- Architecture or tech stack decisions
- Bug fixes with non-obvious root causes
- API behavior discoveries
- Lessons from failed approaches
- New project goals or scope changes
- Deployment procedures established

### Store + Category Guide

| What | Store | Category |
|------|-------|----------|
| Tech stack / API choices | `semantic` | `fact` |
| Architecture decisions | `semantic` | `decision` |
| Session summaries | `episodic` | `conversation` |
| Build / deploy procedures | `procedural` | `workflow` |
| Project goals, TODOs | `prospective` | `goal` |
| Bugs fixed, lessons learned | `semantic` | `lesson` |
| Rules / constraints | `semantic` | `rule` |

### Title Format — Be Specific

```
✅ "Chose PostgreSQL over SQLite for session storage — needs concurrent writes"
✅ "crystal_recall returns stale results when cache not flushed after upsert"
✅ "Deploy to DigitalOcean via docker-compose, not bare node"

❌ "database decision"
❌ "bug fix"
❌ "deployment"
```

### Example

```
crystal_remember(
  title="Chose Convex mutations over HTTP actions for memory writes",
  content="Using Convex mutations (not HTTP actions) for crystal_remember because mutations are transactional and automatically retried. HTTP actions don't get the same guarantees.",
  store="semantic",
  category="decision",
  tags=["convex", "architecture", "reliability"]
)
```

---

## Recalling Memories

**Before starting a new feature or refactor**, search for related past decisions:

```
crystal_recall(query="session storage architecture decision")
```

**When user asks about project history:**

```
crystal_what_do_i_know(topic="Memory Crystal embedding pipeline")
```

**When user asks why something was done:**

```
crystal_why_did_we(decision="use Convex instead of Supabase")
```

---

## Session End

After a significant session, save a checkpoint:

```
crystal_checkpoint(label="Implemented Obsidian adapter. Fixed embedding cache bug.", description="Next: write integration tests and update docs.")
```

---

## Don't

- Skip `crystal_wake` at session start
- Save trivial info ("ran npm install")
- Use vague titles
- Recall on every message — only when past context is relevant
- Duplicate memories you've already saved this session
