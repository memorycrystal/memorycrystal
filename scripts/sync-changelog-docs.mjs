#!/usr/bin/env node
/**
 * sync-changelog-docs.mjs
 *
 * Reads CHANGELOG.md and writes a formatted changelog.mdx for the Mintlify docs site.
 * Runs automatically via the update-docs GitHub Action on pushes to stable that touch CHANGELOG.md.
 * Can also be run manually: node scripts/sync-changelog-docs.mjs
 */

import { readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

async function main() {

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const changelogSrc = join(root, "CHANGELOG.md");
const changelogDest = join(root, "apps/docs/changelog.mdx");

function parseChangelog(md) {
  const lines = md.split("\n");
  const releases = [];
  let current = null;

  for (const line of lines) {
    // Match version headers: ## [0.7.1] — 2026-04-03
    const versionMatch = line.match(/^##\s+\[([^\]]+)\]\s*[—-]?\s*(.*)/);
    if (versionMatch) {
      if (current) releases.push(current);
      current = {
        version: versionMatch[1],
        date: versionMatch[2].trim(),
        lines: [],
      };
      continue;
    }
    if (current) {
      current.lines.push(line);
    }
  }
  if (current) releases.push(current);
  return releases;
}

function buildMdx(releases) {
  const header = `---
title: Changelog
description: What changed in each release of Memory Crystal.
---

`;

  const body = releases
    .map((r) => {
      const title =
        r.version === "Unreleased"
          ? "## Unreleased"
          : `## ${r.version}${r.date ? ` — ${r.date}` : ""}`;

      const content = r.lines
        .join("\n")
        // trim excess blank lines
        .replace(/\n{3,}/g, "\n\n")
        .trim();

      return content ? `${title}\n\n${content}` : title;
    })
    .join("\n\n---\n\n");

  return header + body + "\n";
}

const src = readFileSync(changelogSrc, "utf8");
const releases = parseChangelog(src);
const mdx = buildMdx(releases);

writeFileSync(changelogDest, mdx);
console.log(
  `Synced ${releases.length} releases from CHANGELOG.md to apps/docs/changelog.mdx`
);
}

if (isDirectRun()) {
  await main();
}
