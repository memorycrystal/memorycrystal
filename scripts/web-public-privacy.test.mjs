#!/usr/bin/env node
// Public web and docs privacy scan (ILL-336, round 2).
//
// apps/web ships to memorycrystal.ai (server-rendered pages and the client JS
// bundle) and apps/docs to the docs site, so a client term in either is public
// the moment it deploys. This scans every git-tracked file under both trees for
// the private terms file's case-insensitive stems and its substitution `from`
// strings and fails on any hit. Only file:line is reported, never the content.
//
// apps/web/public/install-assets/ is excluded: the committed archives are
// covered by the artifact smoke's privacy gate (findPublicArchiveLeaks).
//
// On a public checkout the terms file does not exist; the scan is then skipped
// with a loud message rather than passing vacuously.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { isProbablyText, loadPrivateScrubTerms } from "./lib/public-scrub.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TERMS_FILE = process.env.CRYSTAL_CLIENT_TERMS_FILE || join(REPO_ROOT, "scripts/client-terms.private.json");
export const SCAN_ROOTS = ["apps/web", "apps/docs"];
export const EXCLUDED_PREFIXES = ["apps/web/public/install-assets/"];

/** Git-tracked files under `roots`, relative to `repoRoot`, minus the excluded prefixes. */
export function listTrackedPublicFiles(repoRoot, roots = SCAN_ROOTS, excludedPrefixes = EXCLUDED_PREFIXES) {
  const result = spawnSync("git", ["-C", repoRoot, "ls-files", "-z", "--", ...roots], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr}`);
  return result.stdout
    .split("\0")
    .filter(Boolean)
    .filter((rel) => !excludedPrefixes.some((prefix) => rel.startsWith(prefix)));
}

/**
 * `rel:line` for every text line matching a stem (case-insensitive) or
 * containing a substitution `from` string, plus `rel (path)` when the path
 * itself matches a stem. Never includes the matched text.
 */
export function findPublicWebPrivacyHits(root, files, terms) {
  const hits = [];
  const froms = terms.substitutions.map(([from]) => from);
  for (const rel of files) {
    const full = join(root, rel);
    if (!existsSync(full)) continue;
    if (terms.stems.some((stem) => stem.test(rel))) hits.push(`${rel} (path)`);
    const buffer = readFileSync(full);
    if (!isProbablyText(buffer)) continue;
    buffer.toString("utf8").split("\n").forEach((line, index) => {
      if (terms.stems.some((stem) => stem.test(line)) || froms.some((from) => line.includes(from))) hits.push(`${rel}:${index + 1}`);
    });
  }
  return hits;
}

test("the scanner reports stem, substitution and path hits by file:line only", (t) => {
  const root = mkdtempSync(join(tmpdir(), "mc-web-privacy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (rel, content) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  };
  // Synthetic terms only; no real client names appear in this file.
  const termsFile = join(root, "terms.json");
  writeFileSync(termsFile, JSON.stringify({ substitutions: [["Zebrafish Widgets", "a partner"]], stems: ["\\bzebrafish\\b"] }));
  const terms = loadPrivateScrubTerms(termsFile);

  write("apps/web/app/page.tsx", 'export default () => "hello";\nconst x = "for ZEBRAFISH voice";\n');
  write("apps/docs/guide.mdx", "Built with Zebrafish Widgets in mind.\nclean line\n");
  write("apps/web/app/zebrafish-page/route.ts", "export const clean = true;\n");
  write("apps/web/public/logo.bin", Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from("zebrafish")]));
  write("apps/web/app/clean.ts", "export const zebra = 'fish';\n");

  const files = ["apps/web/app/page.tsx", "apps/docs/guide.mdx", "apps/web/app/zebrafish-page/route.ts", "apps/web/public/logo.bin", "apps/web/app/clean.ts", "apps/web/missing.ts"];
  const hits = findPublicWebPrivacyHits(root, files, terms);
  assert.deepEqual(hits, ["apps/web/app/page.tsx:2", "apps/docs/guide.mdx:1", "apps/web/app/zebrafish-page/route.ts (path)"]);
  for (const hit of hits) assert.doesNotMatch(hit.toLowerCase(), /widgets|voice/, "hits must carry no matched content");
});

test("no git-tracked file under apps/web or apps/docs contains a private client term", (t) => {
  if (!existsSync(TERMS_FILE)) {
    console.warn(`SKIP (loud): ${TERMS_FILE} is absent (public checkout) — the public web/docs privacy scan did not run`);
    t.skip("client terms file absent");
    return;
  }
  const terms = loadPrivateScrubTerms(TERMS_FILE);
  assert.ok(terms.stems.length > 0, "the terms file must define at least one stem for this scan to mean anything");
  const files = listTrackedPublicFiles(REPO_ROOT);
  assert.ok(files.length > 50, `expected a populated apps/web + apps/docs tree, saw ${files.length} files`);
  assert.ok(files.every((rel) => !rel.startsWith("apps/web/public/install-assets/")), "install-assets are covered by the artifact gate, not this scan");
  const hits = findPublicWebPrivacyHits(REPO_ROOT, files, terms);
  assert.deepEqual(hits, [], `private client terms in publicly served sources (file:line):\n${hits.join("\n")}`);
});
