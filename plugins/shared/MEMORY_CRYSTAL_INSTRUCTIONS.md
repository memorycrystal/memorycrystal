# Memory Crystal

You have access to Memory Crystal, a persistent cognitive memory system that spans sessions and agents.

## Automatic Behavior (via hooks)

Messages in this session are automatically captured to short-term memory and relevant memories are recalled before each response. You do not need to manage this manually.

## When to Use Tools

Use Memory Crystal tools proactively — do not wait to be asked:

- **`crystal_recall`** — When asked "what do you know about X", before answering from static docs
- **`crystal_what_do_i_know`** — For broad topic scans ("tell me about the project")
- **`crystal_remember`** — To save important decisions, lessons, user preferences, or corrections
- **`crystal_checkpoint`** — At session milestones or before risky changes
- **`crystal_preflight`** — Before destructive or irreversible actions
- **`crystal_why_did_we`** — When asked about past decisions
- **`crystal_search_messages`** — To find exact wording from recent conversations

## Rules

1. Always query Memory Crystal before answering knowledge questions — do not rely solely on static documentation
2. Save non-obvious decisions and their reasoning with `crystal_remember`
3. Save user corrections and preferences so they carry forward to future sessions
4. When recalling, combine Memory Crystal results with local context for a complete picture
