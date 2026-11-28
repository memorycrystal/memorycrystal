#!/usr/bin/env node
import { readFileSync, writeFileSync, renameSync } from "fs";
import { randomBytes } from "crypto";

function usage() {
  console.error("usage: node ensure-codex-hooks-flag.mjs <config-path>");
  process.exit(1);
}

const [, , configPath] = process.argv;
if (!configPath) usage();

const raw = readFileSync(configPath, "utf-8");
const lines = raw.split(/\r?\n/);

// Walk the file line-by-line with a minimal TOML state machine so we only match
// `[features]` headers and `codex_hooks = ...` assignments that are actually top-level
// declarations — NOT substrings inside strings, comments, or nested table keys.
let inMultilineBasic = false;   // """..."""
let inMultilineLiteral = false; // '''...'''
let hasCodexHooks = false;
let featuresIndex = -1;

const MULTILINE_BASIC_RE = /"""/g;
const MULTILINE_LITERAL_RE = /'''/g;

function stripInlineSingleLineStringsAndComments(source) {
  // Strip inline strings ("..." or '...') and a trailing comment so we can safely
  // match the bare line content. Not a full TOML parser — good enough for the
  // very small set of shapes we care about: `[features]` headers and `codex_hooks`.
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '"' || c === "'") {
      const close = source.indexOf(c, i + 1);
      if (close === -1) break;
      i = close + 1;
      continue;
    }
    if (c === "#") break;
    out += c;
    i++;
  }
  return out;
}

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];

  // Handle multiline strings: toggle state on every `"""` / `'''` we see on this line.
  const basicMatches = line.match(MULTILINE_BASIC_RE)?.length ?? 0;
  const literalMatches = line.match(MULTILINE_LITERAL_RE)?.length ?? 0;
  const startedInString = inMultilineBasic || inMultilineLiteral;

  if (basicMatches > 0 && !inMultilineLiteral) {
    if (basicMatches % 2 === 1) inMultilineBasic = !inMultilineBasic;
  }
  if (literalMatches > 0 && !inMultilineBasic && !startedInString) {
    if (literalMatches % 2 === 1) inMultilineLiteral = !inMultilineLiteral;
  }

  if (startedInString) continue;

  const scrubbed = stripInlineSingleLineStringsAndComments(line).trim();
  if (!scrubbed) continue;

  if (/^\[features\](\s|$)/.test(scrubbed) && featuresIndex === -1) {
    featuresIndex = i;
  }
  if (/^codex_hooks\s*=/.test(scrubbed)) {
    hasCodexHooks = true;
  }
}

if (hasCodexHooks) {
  process.exit(0);
}

if (featuresIndex >= 0) {
  lines.splice(featuresIndex + 1, 0, "codex_hooks = true");
} else {
  const suffix = raw.endsWith("\n") ? "" : "\n";
  writeFileAtomic(configPath, `${raw}${suffix}\n[features]\ncodex_hooks = true\n`);
  process.exit(0);
}

writeFileAtomic(configPath, `${lines.join("\n")}\n`);

function writeFileAtomic(targetPath, content) {
  // Atomic write so a Ctrl-C or OS kill mid-write cannot truncate the user's
  // entire Codex config. .tmp suffix is randomised so two concurrent runs
  // (unlikely but possible) do not stomp each other.
  const tmp = `${targetPath}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, content);
  renameSync(tmp, targetPath);
}
