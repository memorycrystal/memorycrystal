// ILL-91 — skill-suite integrity checks (node --test, zero deps).
//
// 1. Every crystal_* tool referenced by a skill exists in the canonical tool
//    contract (plugin/openclaw.plugin.json contracts.tools).
// 2. crystal-brief's mandatory-discipline block is byte-identical to the
//    homepage GENERIC_AGENT_PROMPT's STEP 3 bullets (single-source lockstep —
//    drift fails loudly).
// 3. skills/ and apps/web/public/install-assets/skills/ are identical, so the
//    CDN payload can never lag the authored suite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repo = join(fileURLToPath(import.meta.url), "..", "..");
const skillsRoot = join(repo, "skills");
const mirrorRoot = join(repo, "apps", "web", "public", "install-assets", "skills");

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out.sort();
}

test("every crystal_* tool referenced by a skill exists in the plugin tool contract", () => {
  const manifest = JSON.parse(readFileSync(join(repo, "plugin", "openclaw.plugin.json"), "utf8"));
  const known = new Set(manifest.contracts.tools);
  // memory_search / memory_get aliases also exist; skills use crystal_* names only.
  const referenced = new Set();
  for (const file of walk(skillsRoot).filter((f) => f.endsWith(".md"))) {
    for (const match of readFileSync(file, "utf8").matchAll(/crystal_[a-z_]+/g)) {
      referenced.add(match[0]);
    }
  }
  assert.ok(referenced.size >= 15, `expected a rich tool surface, saw ${referenced.size}`);
  const unknown = [...referenced].filter((tool) => !known.has(tool));
  assert.deepEqual(unknown, [], `skills reference unknown tools: ${unknown.join(", ")}`);
});

test("crystal-brief discipline is in lockstep with the homepage GENERIC_AGENT_PROMPT", () => {
  const tsx = readFileSync(
    join(repo, "apps", "web", "app", "components", "TabbedInstallCommand.tsx"),
    "utf8",
  );
  const step3 = tsx.split("STEP 3 - USE MEMORY CRYSTAL")[1];
  assert.ok(step3, "homepage prompt STEP 3 section not found");
  const homepageBullets = step3
    .split("Only skip these tools")[0]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "));

  const brief = readFileSync(join(skillsRoot, "crystal-brief", "SKILL.md"), "utf8");
  const block = brief.split("<!-- discipline:start -->")[1]?.split("<!-- discipline:end -->")[0];
  assert.ok(block, "crystal-brief discipline markers not found");
  const skillBullets = block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "));

  assert.ok(homepageBullets.length >= 5, "homepage bullets missing");
  assert.deepEqual(
    skillBullets,
    homepageBullets,
    "crystal-brief discipline diverged from the homepage GENERIC_AGENT_PROMPT — update both together",
  );
});

test("install-assets mirror is identical to the authored skills/", () => {
  const authored = walk(skillsRoot).map((f) => relative(skillsRoot, f));
  const mirrored = walk(mirrorRoot).map((f) => relative(mirrorRoot, f));
  assert.deepEqual(mirrored, authored, "mirror file list drifted");
  for (const rel of authored) {
    assert.equal(
      readFileSync(join(mirrorRoot, rel), "utf8"),
      readFileSync(join(skillsRoot, rel), "utf8"),
      `mirror content drifted: ${rel}`,
    );
  }
});
