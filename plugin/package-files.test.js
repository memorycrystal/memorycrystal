"use strict";

const { execFileSync } = require("node:child_process");
const { test } = require("node:test");
const assert = require("node:assert/strict");

function dryRunPackFileList() {
  const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: __dirname,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const [pack] = JSON.parse(output);
  return new Set(pack.files.map((entry) => entry.path));
}

test("published plugin package includes runtime modules and excludes tests", () => {
  const files = dryRunPackFileList();

  for (const runtimePath of [
    "index.js",
    "handler.js",
    "capture-hook.js",
    "recall-hook.js",
    "compaction/crystal-assembler.js",
    "compaction/crystal-compaction.js",
    "compaction/crystal-summarizer.js",
    "store/crystal-local-store.js",
    "tools/crystal-local-tools.js",
    "utils/crystal-utils.js",
    // ESM type markers so the lazily-imported submodules resolve without
    // Node's typeless-package reparse warning in published installs.
    "compaction/package.json",
    "store/package.json",
    "tools/package.json",
  ]) {
    assert.ok(files.has(runtimePath), `missing runtime file from npm package: ${runtimePath}`);
  }

  for (const path of files) {
    assert.ok(!path.endsWith(".test.js"), `test file should not be published: ${path}`);
    assert.ok(!path.startsWith("__tests__/"), `test directory should not be published: ${path}`);
  }
});
