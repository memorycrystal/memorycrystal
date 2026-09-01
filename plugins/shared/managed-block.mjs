#!/usr/bin/env node
// managed-block.mjs — Managed block writer and remover for agent instructions files.
//
// Writes a removable, integrity-checked block delimited by markers into any
// agent AGENTS.md / CLAUDE.md file. Uninstall removes only the block and
// restores user bytes. Fail-safe on corrupted/truncated markers.
//
// One source: plugins/shared/MEMORY_CRYSTAL_INSTRUCTIONS.md
//
// Marker format:
//   <!-- memory-crystal-managed:start hash=<sha256> -->
//   <instructions>
//   <!-- memory-crystal-managed:end -->
//
// CLI:
//   node managed-block.mjs write <target-path> [instructions-path]
//   node managed-block.mjs render <target-path> [instructions-path]
//   node managed-block.mjs remove <target-path>
//   node managed-block.mjs resolve <platform>

import { readFileSync, writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { dirname, join, basename } from "node:path";


function realpath(url) {
  try { return url.startsWith("file://") ? new URL(url).pathname : url; }
  catch { return url; }
}
export const MARKER_START_OPEN = "<!-- memory-crystal-managed:start";
export const MARKER_START_CLOSE = "-->";
export const MARKER_END = "<!-- memory-crystal-managed:end -->";

const START_RE = /<!--\s*memory-crystal-managed:start(?:\s+hash=([a-f0-9]+))?\s*-->/;
const END_RE = /<!--\s*memory-crystal-managed:end\s*-->/;
const START_RE_G = /<!--\s*memory-crystal-managed:start(?:\s+hash=([a-f0-9]+))?\s*-->/g;
const END_RE_G = /<!--\s*memory-crystal-managed:end\s*-->/g;

/**
 * Check whether `content` contains a managed block.
 * Returns { hasStart, hasEnd, startIndex, endIndex } or null if no block.
 */
export function detectManagedBlock(content) {
  const startMatch = START_RE.exec(content);
  const endMatch = END_RE.exec(content);
  if (!startMatch && !endMatch) return null;
  return {
    hasStart: startMatch !== null,
    hasEnd: endMatch !== null,
    startIndex: startMatch ? startMatch.index : -1,
    endIndex: endMatch ? endMatch.index + endMatch[0].length : -1,
  };
}

/**
 * Validate that a managed block is well-formed.
 * Returns the block info or null if no block present.
 * Throws on marker corruption (start w/o end, end w/o start, duplicates).
 */
export function validateBlock(content) {
  const startMatch = START_RE.exec(content);
  const endMatch = END_RE.exec(content);

  if (startMatch && !endMatch) {
    throw new Error("Corrupted managed block: found start marker without matching end marker");
  }
  if (!startMatch && endMatch) {
    throw new Error("Corrupted managed block: found end marker without matching start marker");
  }

  if (startMatch && endMatch && startMatch.index >= endMatch.index) {
    throw new Error("Corrupted managed block: end marker appears before start marker");
  }

  // Count actual matches using /g so capture groups don't inflate the count
  const startCount = (content.match(START_RE_G) || []).length;
  const endCount = (content.match(END_RE_G) || []).length;
  if (startCount > 1) {
    throw new Error(`Corrupted managed block: ${startCount} start markers found (expected at most 1)`);
  }
  if (endCount > 1) {
    throw new Error(`Corrupted managed block: ${endCount} end markers found (expected at most 1)`);
  }

  if (!startMatch) return null;

  const startIdx = startMatch.index + startMatch[0].length;
  const endIdx = endMatch.index + MARKER_END.length;
  // Include trailing newline after the end marker as part of the block
  let finalEndIdx = endIdx;
  if (finalEndIdx < content.length && (content[finalEndIdx] === "\n" || content[finalEndIdx] === "\r")) {
    finalEndIdx++;
  }
  const inner = content.slice(startIdx, endIdx);

  // inner has no trailing newline (buildBlock adds one after --end->) -- strip one for hash consistency
  const innerForHash = inner;

  return {
    startIndex: startMatch.index,
    endIndex: finalEndIdx,
    inner,
    hash: startMatch[1] || null,
  };
}

/**
 * Build the managed block string from instruction content.
 */
export function buildBlock(instructions) {
  const trimmed = instructions.trimEnd();
  const content = trimmed.endsWith("\n") ? trimmed : `${trimmed}\n`;
  const hash = createHash("sha256").update(content).digest("hex");
  return `${MARKER_START_OPEN} hash=${hash} ${MARKER_START_CLOSE}\n${content}${MARKER_END}\n`;
}

/**
 * Compose the next file contents for `targetPath` without writing.
 * - File missing: content is just the managed block.
 * - Has existing managed block: replace in-place.
 * - Exists without block: append the block without inventing a newline.
 * - Corrupted markers: throw.
 */
export function composeManagedBlock(targetPath, instructions) {
  if (typeof instructions !== "string" || !instructions.trim()) {
    throw new Error("Instructions content must be a non-empty string");
  }

  const block = buildBlock(instructions);

  if (existsSync(targetPath)) {
    const existing = readFileSync(targetPath, "utf-8");
    const existingBlock = validateBlock(existing);
    if (existingBlock) {
      const before = existing.slice(0, existingBlock.startIndex);
      const after = existing.slice(existingBlock.endIndex);
      return { action: "replaced", path: targetPath, content: before + block + after };
    }
    return { action: "appended", path: targetPath, content: existing + block };
  }

  return { action: "created", path: targetPath, content: block };
}

/**
 * Write a managed block into `targetPath`.
 * - File missing: create with just the managed block.
 * - Has existing managed block: replace in-place.
 * - Exists without block: append the block.
 * - Corrupted markers: throw.
 */
export function writeManagedBlock(targetPath, instructions) {
  const composed = composeManagedBlock(targetPath, instructions);
  if (composed.action === "created") {
    mkdirSync(dirname(targetPath), { recursive: true });
  }
  atomicWrite(targetPath, composed.content);
  return { action: composed.action, path: targetPath };
}

/**
 * Remove the managed block from `targetPath`.
 * - If file contains only the block: delete the file.
 * - Otherwise: remove block, preserve user content.
 * - No block present: no-op (idempotent).
 */
export function removeManagedBlock(targetPath) {
  if (!existsSync(targetPath)) {
    return { action: "noop", path: targetPath, reason: "file-not-found" };
  }

  const existing = readFileSync(targetPath, "utf-8");
  const existingBlock = validateBlock(existing);
  if (!existingBlock) {
    return { action: "noop", path: targetPath, reason: "no-managed-block" };
  }

  const before = existing.slice(0, existingBlock.startIndex);
  const after = existing.slice(existingBlock.endIndex);
  const remainder = before + after;

  if (!remainder.trim()) {
    unlinkSync(targetPath);
    return { action: "deleted", path: targetPath };
  }

  atomicWrite(targetPath, remainder);
  return { action: "removed", path: targetPath };
}

function atomicWrite(targetPath, content) {
  const dir = dirname(targetPath);
  mkdirSync(dir, { recursive: true });
  const tmp = `${targetPath}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, targetPath);
}

// ── Resolve agentsFile paths by platform ──

/**
 * Resolve the agentsFile path(s) for a platform.
 *
 * Settled platform path assignments:
 *   claude-code:   ${HOME}/.claude/CLAUDE.md
 *   codex-cli:     ${HOME}/.codex/AGENTS.md
 *   codex-desktop: ${HOME}/.codex/AGENTS.md  (shared with codex-cli)
 *   hermes:        per-profile AGENTS.md files under HERMES_HOME.
 *                  Root AGENTS.md only if it already exists. Never write SOUL.md.
 *   grok:          ${HOME}/.grok/AGENTS.md
 *   openclaw, cursor, claude-desktop, opencode, factory-droid, generic-mcp: null.
 */
export function agentsFilePath(platform, opts = {}) {
  const home = opts.home || process.env.HOME || "/tmp";
  const hermesHome = opts.hermesHome || process.env.HERMES_HOME || join(home, ".hermes");

  switch (platform) {
    case "claude-code":
      return join(home, ".claude", "CLAUDE.md");
    case "codex-cli":
    case "codex-desktop":
      return join(home, ".codex", "AGENTS.md");
    case "grok":
      return join(home, ".grok", "AGENTS.md");
    case "hermes": {
      const paths = [];
      const profileDir = join(hermesHome, "profiles");
      if (existsSync(profileDir)) {
        try {
          const entries = readdirSync(profileDir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isDirectory()) {
              const agentPath = join(profileDir, entry.name, "AGENTS.md");
              if (existsSync(agentPath)) {
                paths.push(agentPath);
              }
            }
          }
        } catch {}
      }
      // Root AGENTS.md if it already exists
      const rootAgent = join(hermesHome, "AGENTS.md");
      if (existsSync(rootAgent)) {
        paths.unshift(rootAgent);
      }
      paths.sort();
      return paths;
    }
    default:
      return null;
  }
}

export function resolvedAgentsFiles(platform, opts = {}) {
  const paths = agentsFilePath(platform, opts);
  if (!paths) return [];
  return Array.isArray(paths) ? paths : [paths];
}

function loadInstructions(instructionsPath) {
  if (instructionsPath && existsSync(instructionsPath)) {
    return readFileSync(instructionsPath, "utf-8");
  }
  const defaultPath = join(process.env.HOME || "/tmp", ".memory-crystal", "instructions.md");
  if (existsSync(defaultPath)) {
    return readFileSync(defaultPath, "utf-8");
  }
  throw new Error("Instructions not found. Provide a path or ensure ~/.memory-crystal/instructions.md exists.");
}

// ── CLI entry point ──

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (command === "write") {
    const targetPath = args[1];
    const instructionsPath = args[2];
    if (!targetPath) {
      console.error("Usage: node managed-block.mjs write <target-path> [instructions-path]");
      process.exit(1);
    }
    const result = writeManagedBlock(targetPath, loadInstructions(instructionsPath));
    console.log(JSON.stringify(result));
    return;
  }

  if (command === "render") {
    const targetPath = args[1];
    const instructionsPath = args[2];
    if (!targetPath) {
      console.error("Usage: node managed-block.mjs render <target-path> [instructions-path]");
      process.exit(1);
    }
    const composed = composeManagedBlock(targetPath, loadInstructions(instructionsPath));
    process.stdout.write(composed.content);
    return;
  }

  if (command === "remove") {
    const targetPath = args[1];
    if (!targetPath) {
      console.error("Usage: node managed-block.mjs remove <target-path>");
      process.exit(1);
    }
    const result = removeManagedBlock(targetPath);
    console.log(JSON.stringify(result));
    return;
  }

  if (command === "resolve") {
    const platform = args[1];
    if (!platform) {
      console.error("Usage: node managed-block.mjs resolve <platform>");
      process.exit(1);
    }
    for (const path of resolvedAgentsFiles(platform)) {
      process.stdout.write(`${path}\n`);
    }
    return;
  }

  console.error("Usage: node managed-block.mjs <write|render|remove|resolve> ...");
  process.exit(1);
}

export { main as cliMain };

  if (process.argv[1] && !process.argv[1].endsWith("install-managed-block.mjs") && (process.argv[1].endsWith("managed-block.mjs") || process.argv[1].endsWith("/managed-block.mjs"))) {
  main().catch((err) => {
    console.error(err?.message ?? String(err));
    process.exit(1);
  });
}
