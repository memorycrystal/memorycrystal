import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  aggregateScopeReport,
  parseScopeReportArgs,
} from "./operator-scope-report.mjs";

function fakePages(pages) {
  const calls = [];
  const fetchPage = async (args) => {
    calls.push(args);
    const index = args.cursor ? Number(args.cursor.slice(2)) : 0;
    const page = pages[index];
    const last = index === pages.length - 1;
    return { done: last, cursor: last ? null : `c:${index + 1}`, page };
  };
  return { fetchPage, calls };
}

test("sums counts across pages and sorts labels; never emits row content", async () => {
  const { fetchPage, calls } = fakePages([
    {
      scannedMemories: 2,
      scannedMessages: 3,
      byClass: { global: 1, work: 2, private: 2 },
      messagesByClass: { global: 1, work: 1, private: 1 },
      bareLabels: [{ label: "zeta", count: 1 }, { label: "alpha", count: 2 }],
      devSessionFamilies: [{ family: "claude-code", count: 1 }],
      privateBuckets: { peerMessaging: 1, group: 0 },
      allowlistRejectedCount: 2,
    },
    {
      scannedMemories: 0,
      scannedMessages: 4,
      byClass: { global: 0, work: 1, private: 3 },
      messagesByClass: { global: 0, work: 1, private: 3 },
      bareLabels: [{ label: "alpha", count: 1 }],
      devSessionFamilies: [{ family: "codex", count: 2 }],
      privateBuckets: { peerMessaging: 2, group: 1 },
      allowlistRejectedCount: 2,
    },
  ]);

  const report = await aggregateScopeReport(fetchPage, {
    userId: "acct-1",
    allowlist: ["alpha"],
    pageSize: 50,
  });

  assert.equal(report.userId, "acct-1");
  assert.equal(report.pages, 2);
  assert.equal(report.scannedMemories, 2);
  assert.equal(report.scannedMessages, 7);
  assert.deepEqual(report.byClass, { global: 1, work: 3, private: 5 });
  assert.deepEqual(report.messagesByClass, { global: 1, work: 2, private: 4 });
  assert.equal(report.privateMessagesHidden, 4);
  assert.deepEqual(report.bareLabels, [
    { label: "alpha", count: 3 },
    { label: "zeta", count: 1 },
  ]);
  assert.deepEqual(report.devSessionFamilies, [
    { family: "claude-code", count: 1 },
    { family: "codex", count: 2 },
  ]);
  assert.deepEqual(report.privateBuckets, { peerMessaging: 3, group: 1 });
  assert.equal(report.allowlistRejectedCount, 2, "per-call count is not summed");

  assert.deepEqual(calls[0], { pageSize: 50, userId: "acct-1", allowlist: ["alpha"] });
  assert.deepEqual(calls[1], {
    pageSize: 50,
    cursor: "c:1",
    userId: "acct-1",
    allowlist: ["alpha"],
  });
  assert.equal(JSON.stringify(report).includes("content"), false);
});

test("all-tenant run omits userId and labels the report accordingly", async () => {
  const { fetchPage, calls } = fakePages([
    { scannedMemories: 1, scannedMessages: 1, byClass: { global: 2, work: 0, private: 0 } },
  ]);
  const report = await aggregateScopeReport(fetchPage);
  assert.equal(report.userId, "(all tenants)");
  assert.equal("userId" in calls[0], false);
  assert.equal(calls[0].pageSize, 100);
  assert.deepEqual(report.messagesByClass, { global: 0, work: 0, private: 0 });
  // All-tenant runs are aggregate counts only: no bareLabels key at all.
  assert.equal("bareLabels" in report, false);
});

test("all-tenant run omits bareLabels even when pages carry them; a per-user run keeps them", async () => {
  const pages = [
    {
      readMemories: 4,
      readMessages: 6,
      scannedMemories: 4,
      scannedMessages: 6,
      byClass: { global: 2, work: 3, private: 5 },
      messagesByClass: { global: 1, work: 2, private: 3 },
      bareLabels: [{ label: "alpha", count: 2 }],
      devSessionFamilies: [{ family: "codex", count: 2 }],
    },
    {
      readMemories: 0,
      readMessages: 3,
      scannedMemories: 0,
      scannedMessages: 1,
      byClass: { global: 1, work: 0, private: 0 },
      messagesByClass: { global: 1, work: 0, private: 0 },
      bareLabels: [{ label: "beta", count: 1 }],
    },
  ];
  const allTenants = await aggregateScopeReport(fakePages(pages).fetchPage);
  assert.equal(allTenants.userId, "(all tenants)");
  assert.equal("bareLabels" in allTenants, false);
  assert.deepEqual(allTenants.devSessionFamilies, []);
  assert.equal(JSON.stringify(allTenants).includes("alpha"), false);
  assert.equal(JSON.stringify(allTenants).includes("beta"), false);
  assert.equal(allTenants.readMemories, 4);
  assert.equal(allTenants.readMessages, 9);
  assert.equal(allTenants.scannedMemories, 4);
  assert.equal(allTenants.scannedMessages, 7);

  const perUser = await aggregateScopeReport(fakePages(pages).fetchPage, { userId: "acct-9" });
  assert.deepEqual(perUser.bareLabels, [
    { label: "alpha", count: 2 },
    { label: "beta", count: 1 },
  ]);
  assert.deepEqual(perUser.devSessionFamilies, [{ family: "codex", count: 2 }]);
  assert.equal(perUser.readMessages, 9);
  assert.equal(perUser.scannedMessages, 7);
});

test("fails loudly when a page reports more work without a cursor", async () => {
  const fetchPage = async () => ({ done: false, cursor: null, page: {} });
  await assert.rejects(() => aggregateScopeReport(fetchPage), /without a cursor/);
});

test("stops after maxPages instead of looping forever", async () => {
  const fetchPage = async () => ({ done: false, cursor: "c:1", page: {} });
  await assert.rejects(
    () => aggregateScopeReport(fetchPage, { maxPages: 3 }),
    /exceeded 3 pages/,
  );
});

test("parses --userId and --allowlist", () => {
  assert.deepEqual(parseScopeReportArgs([]), { userId: undefined, allowlist: undefined });
  assert.deepEqual(parseScopeReportArgs(["--userId", "u1"]), { userId: "u1", allowlist: undefined });
  assert.deepEqual(parseScopeReportArgs(["--allowlist", " a, b ,,c "]), {
    userId: undefined,
    allowlist: ["a", "b", "c"],
  });
  assert.deepEqual(parseScopeReportArgs(["--userId"]), { userId: undefined, allowlist: undefined });
});


test("R6 CLI suppresses secret-bearing fetch errors and exits nonzero", () => {
  const dir = mkdtempSync(join(tmpdir(), "scope-report-error-"));
  const marker = "SYNTHETIC_TRANSPORT_SECRET_R6";
  const hook = join(dir, "fetch-error.mjs");
  writeFileSync(hook, `globalThis.fetch = async () => { throw new Error(${JSON.stringify(marker)}); };`);
  try {
    const result = spawnSync(process.execPath, ["--import", hook,
      fileURLToPath(new URL("./operator-scope-report.mjs", import.meta.url))], {
      encoding: "utf8", timeout: 20_000,
      env: { ...process.env, CONVEX_SELF_HOSTED_URL: "https://synthetic.invalid",
        CONVEX_SELF_HOSTED_ADMIN_KEY: "synthetic-test-only" },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout.includes(marker), false);
    assert.equal(result.stderr.includes(marker), false);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim(), "Scope report failed.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
