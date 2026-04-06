# Memory Crystal — Project Overview

## The Problem

AI assistants forget everything. Every conversation starts from zero. You repeat yourself constantly. Context built over weeks vanishes between sessions.

## The Solution

Memory Crystal is a persistent memory layer for AI assistants. It runs silently alongside your AI, capturing what matters and recalling it when relevant. Your AI stops being amnesiac and starts being coherent.

## The Product

### For OpenClaw users (self-hosted)
Install Memory Crystal as a plugin. Your conversations are captured automatically, stored in Convex, synced to Obsidian, and recalled before every AI response. Free to run on your own Convex + OpenAI accounts.

### For everyone (SaaS — coming soon)
Sign up at memorycrystal.io, connect your AI assistant, get a dashboard.

Starting with OpenClaw. Expanding to ChatGPT, Claude.ai, and others via browser extension.

---

## How Memory Works

Memory Crystal uses a two-layer model:

### Short-term memory (STM)
- Every message in and out, verbatim
- Stored in Convex with vector embeddings
- Tier-based TTL (Free 7d / Pro 30d / Ultra 90d)
- Used for "what did we just talk about" recall
- Also written to Obsidian as daily transcript logs

### Long-term memory (LTM)
- Distilled facts, decisions, preferences, lessons
- Extracted by GPT-4o-mini from each conversation turn
- Stored permanently in Convex + Obsidian
- Organised into 5 cognitive stores (see below)
- Vector-indexed for semantic search

### The 5 Memory Stores

| Store | What goes here |
|---|---|
| **Episodic** | Things that happened ("We decided to pivot to SaaS on Feb 27") |
| **Semantic** | Facts and knowledge ("Railway is our deployment target") |
| **Procedural** | How to do things ("Use Codex spark for coding agents") |
| **Prospective** | Plans and intentions ("Need to wire Convex Auth to dashboard") |
| **Sensory** | Preferences and observations ("Andy likes concise responses") |

---

## The Obsidian Vault

Your Obsidian vault gets two things from Memory Crystal:

1. **Daily logs** (`logs/YYYY-MM-DD.md`) — full verbatim transcript of every conversation, every day, forever
2. **Memory notes** (`episodic/`, `semantic/`, etc.) — one file per extracted memory, with metadata

This gives you a permanent human-readable archive independent of Convex. Even if you cancel Memory Crystal, your memories stay in Obsidian.

---

## Tech Stack

| Layer | Tech |
|---|---|
| Memory store | Convex (cloud, real-time, vector search) |
| Embeddings | OpenAI text-embedding-3-small (1536d) |
| Extraction | GPT-4o-mini |
| Human-readable archive | Obsidian (markdown files) |
| OpenClaw integration | Internal hooks + JavaScript plugin API |
| Web dashboard | Next.js 15 + Convex React + Tailwind 4 |
| Billing | Polar.sh |
| Deployment | Railway |

---

## What Makes Memory Crystal Different

Most "AI memory" products are RAG bolted onto a notes app. Memory Crystal is a cognitive model:

- **Two-layer architecture** (STM + LTM) mirrors how human memory works
- **5 specialised stores** instead of one undifferentiated blob
- **Automatic extraction** — you don't manually tag or save anything
- **Dual-write** — Convex for machine recall, Obsidian for human reading
- **Non-blocking** — capture runs after responses, never slows your AI down
- **Graceful degradation** — if embedding fails, text is saved; retry runs via cron
