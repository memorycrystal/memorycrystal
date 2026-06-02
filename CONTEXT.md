# Memory Crystal

Memory Crystal is a hosted and self-hosted memory system for capturing, distilling, recalling, and operating on durable user memory.

## Language

**Provider Key**:
A user-owned model provider credential used for memory work that the user pays for directly. A provider key can raise user-paid throughput limits without changing platform-paid defaults.
_Avoid_: API key, OpenRouter key when the provider-agnostic concept is meant

**LTM Extraction Cap**:
The throughput limit for turning recent message activity into durable long-term memories. This is distinct from graph enrichment because it governs memory creation rather than memory graph structure.
_Avoid_: Cap, hourly cap, graph cap

**Graph Enrichment Cap**:
The throughput limit for adding graph structure to existing memories. This is distinct from LTM extraction because it governs relationship extraction and graph coverage rather than durable-memory creation.
_Avoid_: Cap, skipped cap, extraction cap

**Tracked Recall**:
An all-time count of successful long-term memory recalls, meaning durable memories surfaced for use. Message search and recent-message retrieval are retrieval activity, not tracked recall.
_Avoid_: Retrieval activity, search count, windowed recall

**Retrieval Activity**:
Use of retrieval endpoints such as message search or recent-message lookup. Retrieval activity can support diagnostics, but it is not the same as a durable memory being recalled.
_Avoid_: Tracked recall, memory recall

**Admin Directory**:
The operator-facing list of Memory Crystal users and their account state. Sorting in the Admin Directory applies to the full matched user result set, not only to the currently visible page or capped slice.
_Avoid_: User table, visible user list

**Conversation Snapshot**:
A raw conversation transcript record used for traceability and provenance. Conversation snapshots may be created automatically by integrations, but they are not user-facing memory backups.
_Avoid_: Checkpoint, memory backup, restore point

**Memory Checkpoint**:
A user-created labeled milestone that captures a bounded backup of durable memory for later review or recovery planning. Memory checkpoints are intentional user artifacts, not automatic session-end records or raw conversation transcripts.
_Avoid_: Snapshot, transcript, automatic checkpoint, full database backup

**Checkpoint Allowance**:
The number of Memory Checkpoints a user may retain for their plan. The allowance is a retained-artifact limit, not a rate limit on automatic session activity.
_Avoid_: Snapshot limit, checkpoint rate limit, session checkpoint cap

**Checkpoint Scope**:
The memory boundary captured by a Memory Checkpoint. Dashboard-created checkpoints default to account-level durable memory, while agent-created checkpoints default to the active channel or session scope unless the user explicitly asks for a broader checkpoint.
_Avoid_: Snapshot scope, transcript scope

**Legacy Checkpoint Artifact**:
An old integration-created checkpoint row that does not represent an intentional user-created Memory Checkpoint. Legacy Checkpoint Artifacts may remain stored for diagnostics, but they do not belong in the default user checkpoint list.
_Avoid_: User checkpoint, memory backup

## Example Dialogue

Developer: "The user is seeing cap skips even though their provider key is connected."

Domain expert: "Which cap?"

Developer: "The LTM extraction cap. It throttles durable-memory creation. The graph enrichment cap is separate and controls graph structure work."

Domain expert: "Provider keys should be allowed to raise both caps, but the UI must name them separately so users can tell which subsystem is throttled."

Developer: "Tracked recalls look low because the chart includes only the current telemetry window."

Domain expert: "Tracked recall should be all-time successful long-term memory recalls. Put message search and recent-message lookup under retrieval activity instead."

Developer: "Clicking Updated can just sort the visible 250 rows, right?"

Domain expert: "No. Admin Directory sorting should apply to the matched directory result before display limits, so the sorted result represents the directory, not a client-side slice."

Developer: "Hermes ended a session and created a checkpoint with zero memories."

Domain expert: "That should be a conversation snapshot if it is automatic provenance. A memory checkpoint is created intentionally by the user."

Developer: "Free users get one checkpoint, so should every session end consume it?"

Domain expert: "No. The Checkpoint Allowance applies only to user-created Memory Checkpoints."

Developer: "The user reached their Checkpoint Allowance. Should the oldest checkpoint be replaced?"

Domain expert: "No. Memory Checkpoints are deliberate backup milestones. Ask the user to delete one before creating another."

Developer: "A coach session asked for a checkpoint. Should it capture the whole account?"

Domain expert: "No. The Checkpoint Scope should default to that active channel or session unless the user explicitly asks for an account-level checkpoint."

Developer: "There are old external checkpoint rows with zero memories. Should the dashboard show them?"

Domain expert: "No. Treat them as Legacy Checkpoint Artifacts. Hide them from the default user checkpoint list without deleting them."

Developer: "Can an agent create a Memory Checkpoint automatically because a session ended or a task looks important?"

Domain expert: "No. Agents may create Memory Checkpoints only to fulfill explicit user intent. Automatic provenance belongs to Conversation Snapshots."
