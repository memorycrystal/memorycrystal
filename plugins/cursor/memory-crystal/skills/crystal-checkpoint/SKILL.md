---
name: crystal-checkpoint
description: Milestone ritual for Memory Crystal — create a checkpoint and a durable summary at project milestones, before risky changes, or when the user asks for a backup or checkpoint.
---

# Crystal Checkpoint

Run at milestones (feature shipped, phase complete), before risky or bulk
changes, or on request.

## Procedure

1. `crystal_checkpoint` with a short, specific label ("v0.9 shipped",
   "pre-migration").
2. `crystal_remember` one summary memory: what was accomplished, key decisions
   made and why, and what comes next. Classify it correctly (usually
   episodic/event or semantic/decision) and date it in the content per the
   freshness policy.
3. Verify the checkpoint call succeeded (non-error response). If it failed,
   say so plainly — never report a checkpoint that did not happen.
4. Tell the user in one line what was checkpointed.

Do not checkpoint reflexively after trivial exchanges — a checkpoint marks
state worth returning to.
