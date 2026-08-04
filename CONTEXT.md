# Memory Crystal

Memory Crystal is a hosted and self-hosted memory system for capturing, distilling, recalling, and operating on durable user memory.

## Language

**Provider Key**:
A user-owned model provider credential used for memory work that the user pays for directly. A provider key can raise user-paid throughput limits without changing platform-paid defaults.
_Avoid_: API key, OpenRouter key when the provider-agnostic concept is meant

**Native Memory Provider**:
An agent-runtime integration role that makes memory automatic: relevant context appears before the agent responds, and completed turns can be captured without the user calling a tool. A Native Memory Provider is the background memory substrate, not the broad manual toolbox.
_Avoid_: MCP tool surface, plugin tools, explicit tools

**Explicit Tool Surface**:
The user- or agent-invoked commands for deliberate memory operations such as recall, remember, update, search, diagnostics, knowledge-base work, and maintenance. The Explicit Tool Surface is for intentional actions, not the automatic memory substrate.
_Avoid_: Native provider, automatic memory, background memory

**Automatic Capture Coverage**:
The default integration posture where every completed turn from every installed agent and supported channel is captured without an explicit tool call, then stored under the natural scope for that conversation. Automatic Capture Coverage is broad by event coverage, not global by storage boundary.
_Avoid_: Global memory bucket, manual capture, private-memory blending

**Group Memory Scope**:
The shared memory boundary for a public or multi-person conversation. Group Memory Scope is captured by default under Automatic Capture Coverage, but it remains isolated to the group channel or thread and must not include private direct-message or user-profile memory unless the user explicitly requests and authorizes that broader boundary.
_Avoid_: Shared channel memory when private memory is meant, user memory

**Peer Memory Scope**:
The one-to-one memory boundary between an agent profile and a specific external person or peer. Peer Memory Scope is narrower than account memory and should not blend conversations with different peers.
_Avoid_: Account memory, group memory, global profile memory

**Agent Scope**:
The agent/profile/workspace boundary used to separate one running agent persona or workspace from another. Agent Scope can narrow Peer Memory Scope further so the same external person does not automatically share memory across unrelated agent profiles.
_Avoid_: User account, provider key, session key

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

### Integration and Onboarding

**Integration Contract**:
The layered set of guarantees a supported platform must satisfy: credentials registered, Native Memory Provider active, Explicit Tool Surface registered, discipline layer delivered, Declared Agent Identity set, and the whole thing proven by a verification pass. The Integration Contract is one contract for every platform, not a per-platform install recipe.
_Avoid_: Install script, setup steps, onboarding flow

**Support Tier**:
The publicly declared portion of the Integration Contract that a platform actually satisfies. A Support Tier is bounded by what the harness can really do, never by what we intend it to do, so a platform that cannot recall automatically must not be advertised as if it can.
_Avoid_: Supported, officially supported, full support

**Context Injection**:
The harness capability of accepting a hook's output back into the model's context before it answers. Context Injection is what separates a platform that can recall automatically from one that can only capture.
_Avoid_: Hooks, hook support, additional context

**Declared Agent Identity**:
The identity an agent presents when it recalls. Declared Agent Identity is what the agent asserts; Agent Scope is the boundary it lands in. An agent that declares nothing falls back to the catch-all identity and reaches far more than it should.
_Avoid_: Agent scope, session key, platform name

**Managed Block**:
A delimited region inside a user-owned file that the installer owns and may rewrite or remove without touching the rest of the file. A Managed Block is how the discipline layer reaches platforms that lack Context Injection.
_Avoid_: Config file, generated file, our section

**Universal Agent Prompt**:
The single instruction handed to any agent that makes it install Memory Crystal into its own harness and then prove the install worked. The Universal Agent Prompt drives the installer and verifies the result; it is not itself the installation mechanism.
_Avoid_: Install prompt, setup prompt, agent instructions

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

Developer: "Hermes has a Memory Crystal plugin and MCP tools. Which one should Hermes prefer?"

Domain expert: "Use the Native Memory Provider for automatic memory behavior. Use the Explicit Tool Surface for deliberate advanced memory operations."

Developer: "A Hermes group chat has memory enabled. Can it recall private one-to-one memories?"

Domain expert: "No. Group Memory Scope is separate from Peer Memory Scope and private user memory unless the user explicitly broadens the boundary."

Developer: "Grok Build has hooks, so we can list it as fully supported like Claude Code, right?"

Domain expert: "No. Grok ignores hook output on passive events, so it has no Context Injection. It can capture but it cannot recall automatically. Give it the Support Tier that matches, and say so on the page."

Developer: "Then how does a Grok agent learn the memory rules if we can't inject them?"

Domain expert: "Through a Managed Block in its AGENTS.md. That is the fallback delivery for the discipline layer wherever Context Injection is missing."

Developer: "Should the Universal Agent Prompt just tell the agent to write its own hook config?"

Domain expert: "No. The Universal Agent Prompt runs the installer and then verifies. Agents editing the harness config they are running inside is how installs get corrupted."

Developer: "The installer never sets an agentId, and recall still works. Is that fine?"

Domain expert: "No. With no Declared Agent Identity the agent recalls as the catch-all and reaches nearly every knowledge base on the account. Set the identity at install, and report which knowledge bases it can actually reach so the narrowing is visible."
