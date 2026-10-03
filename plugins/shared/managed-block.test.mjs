import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildBlock,
  detectManagedBlock,
  validateBlock,
  writeManagedBlock,
  removeManagedBlock,
  agentsFilePath,
} from "./managed-block.mjs";

const TINY_INSTRUCTIONS = "# Memory Crystal\n\nUse the memory tools.\n";
const LONG_INSTRUCTIONS = "# Memory Crystal - Agent Usage Guide\n\n1. crystal_preflight\n2. crystal_query_knowledge_base\n3. crystal_recall\n\n## Rules\n\n- Query memory before answering knowledge questions.\n- Pass explicit agentId.\n- Save non-obvious decisions.\n";

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "mc-managed-block-"));
}

function writeTmp(dir, name, content) {
  const p = join(dir, name);
  writeFileSync(p, content, "utf-8");
  return p;
}

// ── buildBlock ──

test("buildBlock wraps instructions with markers and a SHA-256 hash", () => {
  const block = buildBlock(TINY_INSTRUCTIONS);
  assert.match(block, /^<!-- memory-crystal-managed:start hash=[a-f0-9]{64} -->\n/);
  assert.ok(block.includes(TINY_INSTRUCTIONS));
  assert.ok(block.endsWith("<!-- memory-crystal-managed:end -->\n"));
  const block2 = buildBlock(TINY_INSTRUCTIONS);
  assert.equal(block, block2);
});

test("buildBlock normalises trailing newline", () => {
  const block = buildBlock("line1\nline2");
  assert.ok(block.includes("line1\nline2\n"));
});

test("buildBlock preserves existing trailing newline", () => {
  const block = buildBlock("line1\nline2\n");
  assert.ok(block.includes("line1\nline2\n"));
});

// ── detectManagedBlock ──

test("detectManagedBlock returns null for content without markers", () => {
  assert.equal(detectManagedBlock("# Just a heading\n"), null);
});

test("detectManagedBlock returns null for empty content", () => {
  assert.equal(detectManagedBlock(""), null);
});

test("detectManagedBlock detects start and end markers", () => {
  const result = detectManagedBlock(buildBlock(TINY_INSTRUCTIONS));
  assert.notEqual(result, null);
  assert.equal(result.hasStart, true);
  assert.equal(result.hasEnd, true);
});

test("detectManagedBlock detects solo start marker", () => {
  const result = detectManagedBlock("<!-- memory-crystal-managed:start hash=abc -->\ncontent\n");
  assert.notEqual(result, null);
  assert.equal(result.hasStart, true);
  assert.equal(result.hasEnd, false);
});

test("detectManagedBlock detects solo end marker", () => {
  const result = detectManagedBlock("content\n<!-- memory-crystal-managed:end -->\n");
  assert.notEqual(result, null);
  assert.equal(result.hasStart, false);
  assert.equal(result.hasEnd, true);
});

// ── validateBlock ──

test("validateBlock returns null for content without block", () => {
  assert.equal(validateBlock("just text\n"), null);
});

test("validateBlock returns block info for a valid block", () => {
  const info = validateBlock(buildBlock(TINY_INSTRUCTIONS));
  assert.notEqual(info, null);
  assert.equal(typeof info.startIndex, "number");
  assert.equal(typeof info.endIndex, "number");
  assert.ok(info.inner.includes("Use the memory tools."));
  assert.match(info.hash, /^[a-f0-9]{64}$/);
});

test("validateBlock throws on start without end", () => {
  assert.throws(
    () => validateBlock("<!-- memory-crystal-managed:start hash=abc -->\ncontent"),
    /start marker without matching end/,
  );
});

test("validateBlock throws on end without start", () => {
  assert.throws(
    () => validateBlock("content\n<!-- memory-crystal-managed:end -->"),
    /end marker without matching start/,
  );
});

test("validateBlock throws on end-before-start ordering", () => {
  const content = [
    "<!-- memory-crystal-managed:end -->",
    "middle",
    "<!-- memory-crystal-managed:start hash=abc -->",
    "inner",
    "",
  ].join("\n");
  assert.throws(
    () => validateBlock(content),
    /end marker appears before start/,
  );
});

test("validateBlock throws on duplicate start markers", () => {
  const content = [
    "<!-- memory-crystal-managed:start hash=abc -->",
    "a",
    "<!-- memory-crystal-managed:end -->",
    "<!-- memory-crystal-managed:start hash=def -->",
    "b",
    "<!-- memory-crystal-managed:end -->",
    "",
  ].join("\n");
  assert.throws(
    () => validateBlock(content),
    /2 start markers found/,
  );
});

test("validateBlock throws on duplicate end markers", () => {
  const content = [
    "<!-- memory-crystal-managed:start hash=abc -->",
    "a",
    "<!-- memory-crystal-managed:end -->",
    "<!-- memory-crystal-managed:end -->",
    "",
  ].join("\n");
  assert.throws(
    () => validateBlock(content),
    /2 end markers found/,
  );
});

// ── writeManagedBlock ──

test("writeManagedBlock creates a new file", () => {
  const dir = tmpDir();
  const path = join(dir, "AGENTS.md");
  const result = writeManagedBlock(path, TINY_INSTRUCTIONS);
  assert.equal(result.action, "created");
  assert.equal(result.path, path);
  assert.ok(existsSync(path));
  const content = readFileSync(path, "utf-8");
  assert.match(content, /memory-crystal-managed:start/);
  assert.match(content, /memory-crystal-managed:end/);
});

test("writeManagedBlock appends to existing file without block", () => {
  const dir = tmpDir();
  const path = writeTmp(dir, "AGENTS.md", "# User Content\n\nSome instructions.\n");
  const result = writeManagedBlock(path, TINY_INSTRUCTIONS);
  assert.equal(result.action, "appended");
  const content = readFileSync(path, "utf-8");
  assert.ok(content.startsWith("# User Content\n\nSome instructions.\n"));
  assert.match(content, /memory-crystal-managed:start/);
  assert.match(content, /memory-crystal-managed:end/);
});

test("writeManagedBlock replaces existing block in place", () => {
  const dir = tmpDir();
  const path = writeTmp(dir, "AGENTS.md", "# User\n\nboring\n\n");
  writeManagedBlock(path, TINY_INSTRUCTIONS);
  const result = writeManagedBlock(path, LONG_INSTRUCTIONS);
  assert.equal(result.action, "replaced");
  const content = readFileSync(path, "utf-8");
  assert.ok(content.startsWith("# User\n\nboring\n\n"));
  assert.ok(!content.includes("Use the memory tools."));
  assert.ok(content.includes("crystal_preflight"));
});

test("writeManagedBlock throws on empty instructions", () => {
  assert.throws(() => writeManagedBlock("/tmp/nonexistent", ""), /non-empty string/);
  assert.throws(() => writeManagedBlock("/tmp/nonexistent", "   "), /non-empty string/);
});

test("writeManagedBlock creates parent directories", () => {
  const dir = tmpDir();
  const path = join(dir, "nested", "deep", "dir", "AGENTS.md");
  const result = writeManagedBlock(path, TINY_INSTRUCTIONS);
  assert.equal(result.action, "created");
  assert.ok(existsSync(path));
});

test("writeManagedBlock fail-safe on corrupted markers", () => {
  const dir = tmpDir();
  const corrupted = [
    "# KEEP ME",
    "<!-- memory-crystal-managed:end -->",
    "user middle",
    "<!-- memory-crystal-managed:start hash=abc -->",
    "inner",
    "",
  ].join("\n");
  const path = writeTmp(dir, "AGENTS.md", corrupted);
  assert.throws(() => validateBlock(corrupted), /Corrupted managed block/);
  assert.throws(() => writeManagedBlock(path, TINY_INSTRUCTIONS), /Corrupted managed block/);
  assert.equal(readFileSync(path, "utf-8"), corrupted, "must not modify corrupted file");
});

// ── removeManagedBlock ──

test("removeManagedBlock no-ops on missing file", () => {
  const dir = tmpDir();
  const result = removeManagedBlock(join(dir, "nonexistent.md"));
  assert.equal(result.action, "noop");
  assert.equal(result.reason, "file-not-found");
});

test("removeManagedBlock no-ops on file without block", () => {
  const dir = tmpDir();
  const path = writeTmp(dir, "AGENTS.md", "# User stuff\n");
  const result = removeManagedBlock(path);
  assert.equal(result.action, "noop");
  assert.equal(result.reason, "no-managed-block");
  assert.equal(readFileSync(path, "utf-8"), "# User stuff\n");
});

test("removeManagedBlock deletes file that contains only the block", () => {
  const dir = tmpDir();
  const path = join(dir, "AGENTS.md");
  writeManagedBlock(path, TINY_INSTRUCTIONS);
  const result = removeManagedBlock(path);
  assert.equal(result.action, "deleted");
  assert.equal(existsSync(path), false);
});

test("removeManagedBlock preserves user content and removes block", () => {
  const dir = tmpDir();
  const path = writeTmp(dir, "AGENTS.md", "# User instructions\n\nbe careful\n");
  writeManagedBlock(path, TINY_INSTRUCTIONS);
  const result = removeManagedBlock(path);
  assert.equal(result.action, "removed");
  assert.ok(existsSync(path));
  const content = readFileSync(path, "utf-8");
  assert.ok(content.startsWith("# User instructions\n\nbe careful"));
  assert.ok(!content.includes("memory-crystal-managed"));
});

test("removeManagedBlock is idempotent after first removal", () => {
  const dir = tmpDir();
  const path = join(dir, "AGENTS.md");
  writeManagedBlock(path, TINY_INSTRUCTIONS);
  assert.equal(removeManagedBlock(path).action, "deleted");
  assert.equal(removeManagedBlock(path).action, "noop");
  assert.equal(removeManagedBlock(path).reason, "file-not-found");
});

test("write then remove round-trips user content", () => {
  const dir = tmpDir();
  const userContent = "# My custom AGENTS.md\n\n## Important\n\nDo not modify these instructions.\n";
  const path = writeTmp(dir, "AGENTS.md", userContent);
  writeManagedBlock(path, LONG_INSTRUCTIONS);
  removeManagedBlock(path);
  assert.equal(
    Buffer.compare(readFileSync(path), Buffer.from(userContent, "utf-8")),
    0,
  );
});

test("write then remove is byte-identical when the file has no final newline", () => {
  const dir = tmpDir();
  const userContent = "# My custom AGENTS.md\n\n## Important\n\nDo not modify these instructions.";
  const path = writeTmp(dir, "AGENTS.md", userContent);
  writeManagedBlock(path, LONG_INSTRUCTIONS);
  removeManagedBlock(path);
  assert.equal(
    Buffer.compare(readFileSync(path), Buffer.from(userContent, "utf-8")),
    0,
    "must not invent a terminating newline the user did not have",
  );
});

// ── agentsFilePath ──

test("agentsFilePath resolves settled platform paths and rejects unverified ones", () => {
  const dir = tmpDir();
  for (const id of ["openclaw", "cursor", "claude-desktop", "opencode", "factory-droid", "generic-mcp"]) {
    assert.equal(agentsFilePath(id, { home: dir }), null, id + " must not invent an agentsFile");
  }

  assert.equal(agentsFilePath("claude-code", { home: dir }), join(dir, ".claude", "CLAUDE.md"));
  assert.equal(agentsFilePath("codex-cli", { home: dir }), join(dir, ".codex", "AGENTS.md"));
  assert.equal(agentsFilePath("codex-desktop", { home: dir }), join(dir, ".codex", "AGENTS.md"));
  assert.equal(agentsFilePath("grok", { home: dir }), join(dir, ".grok", "AGENTS.md"));

  const hermesHome = join(dir, ".hermes");
  mkdirSync(join(hermesHome, "profiles", "alpha"), { recursive: true });
  writeFileSync(join(hermesHome, "profiles", "alpha", "AGENTS.md"), "keep\n");
  writeFileSync(join(hermesHome, "SOUL.md"), "soul\n");

  const hermesPaths = agentsFilePath("hermes", { home: dir, hermesHome });
  assert.ok(Array.isArray(hermesPaths));
  assert.ok(hermesPaths.some((p) => p.endsWith("profiles/alpha/AGENTS.md")), "must include profile AGENTS.md");
  assert.ok(!hermesPaths.some((p) => p.endsWith("SOUL.md")), "must never include SOUL.md");
  assert.ok(!hermesPaths.some((p) => p.endsWith(".hermes/AGENTS.md")), "must not create root AGENTS.md");

  writeFileSync(join(hermesHome, "AGENTS.md"), "root\n");
  const withRoot = agentsFilePath("hermes", { home: dir, hermesHome });
  assert.ok(withRoot.some((p) => p.endsWith(".hermes/AGENTS.md")), "must include root AGENTS.md when present");
});

test("writeManagedBlock replacing existing block is idempotent", () => {
  const dir = tmpDir();
  const path = writeTmp(dir, "AGENTS.md", "# User\n\nprefix\n");
  const first = writeManagedBlock(path, TINY_INSTRUCTIONS);
  assert.equal(first.action, "appended");
  const afterFirst = readFileSync(path);
  const second = writeManagedBlock(path, TINY_INSTRUCTIONS);
  assert.equal(second.action, "replaced");
  assert.equal(Buffer.compare(readFileSync(path), afterFirst), 0, "install x2 must be byte-identical");
});
