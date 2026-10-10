// Regression guard for the plugin update-integrity contract.
//
// plugin/checksums.txt must describe EXACTLY the files plugin/update.sh
// downloads. Listing extra files breaks every client:
//   - package-lock.json is rewritten on the client by update.sh's own
//     `npm install better-sqlite3` step, so its hash can never match and
//     verification exits 1 ("Files may be corrupted or tampered with")
//     before the gateway restart;
//   - *.test.js files are never downloaded and produce noisy warnings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { managedPluginFiles, buildChecksums } from "./generate-plugin-checksums.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const checksumsPath = join(repoRoot, "plugin", "checksums.txt");

function listedFiles() {
  return readFileSync(checksumsPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => {
      const match = line.match(/^([a-f0-9]{64})\s{2}(.+)$/i);
      assert.ok(match, `malformed checksum line: ${line}`);
      return match[2].trim();
    })
    .sort();
}

test("checksums.txt covers exactly the files update.sh downloads", () => {
  const managed = managedPluginFiles();
  const listed = listedFiles();
  const extra = listed.filter((f) => !managed.includes(f));
  const missing = managed.filter((f) => !listed.includes(f));
  assert.deepEqual(extra, [], `checksums.txt lists files update.sh never downloads: ${extra.join(", ")}`);
  assert.deepEqual(missing, [], `checksums.txt is missing managed files: ${missing.join(", ")}`);
});

test("package-lock.json is never checksummed (update.sh mutates it on the client)", () => {
  assert.ok(!listedFiles().includes("package-lock.json"));
});

test("checksums.txt is current for the committed plugin files", () => {
  const expected = `${buildChecksums()}\n`;
  assert.equal(
    readFileSync(checksumsPath, "utf8"),
    expected,
    "plugin/checksums.txt is stale — run: node scripts/generate-plugin-checksums.mjs",
  );
});
