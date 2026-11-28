import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertQueryPathOutsideRepo } from "./bench-recall-live.mjs";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  PASS_GAP_MS,
  readGroundTruth,
  runRecallAudit,
  scoreRecallAudit,
  thresholdMisses,
} from "./recall-audit-eval.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scriptPath = path.join(repoRoot, "scripts/recall-audit-eval.mjs");

function memory(title, content) {
  return { title, content };
}

test("a memory is relevant when its title and content match the key, case-insensitively", () => {
  const report = scoreRecallAudit([{
    id: "q1",
    cat: "fact",
    key: "quartz\\s+orchard",
    memories: [memory("unrelated", "nothing here"), memory("Note", "The Quartz   Orchard ledger")],
  }]);
  assert.equal(report.recallAt1, 0);
  assert.equal(report.recallAt5, 1);
  assert.equal(report.mrr, 0.5);
  assert.equal(report.precisionAt5, 0.5);
  assert.deepEqual(report.misses, []);
  assert.equal(report.perCategory.fact.hitAt5, 1);
});

test("precision at 5 divides relevant hits by every returned memory", () => {
  const report = scoreRecallAudit([{
    id: "q1",
    cat: "fact",
    key: "alpha",
    memories: [memory("alpha", ""), memory("beta", ""), memory("alpha two", ""), memory("gamma", "")],
  }]);
  assert.equal(report.precisionAt5, 0.5);
  assert.equal(report.recallAt5, 1);
});

test("an empty answerable result is a miss and does not count as precision", () => {
  const report = scoreRecallAudit([
    { id: "hit", cat: "fact", key: "alpha", memories: [memory("alpha", "")] },
    { id: "miss", cat: "person", key: "beta", memories: [] },
  ]);
  assert.equal(report.recallAt5, 0.5);
  assert.equal(report.mrr, 0.5);
  assert.equal(report.precisionAt5, 1);
  assert.deepEqual(report.misses, ["miss"]);
  assert.equal(report.perCategory.person.hitAt5, 0);
  assert.equal(report.perCategory.person.count, 1);
});

test("expectEmpty counts an empty result and names a noisy return", () => {
  const report = scoreRecallAudit([
    { id: "quiet", cat: "channel", expectEmpty: true, memories: [] },
    { id: "noisy", cat: "channel", expectEmpty: true, memories: [memory("leaked", "private")] },
    { id: "also-quiet", cat: "channel", expectEmpty: true, memories: [] },
  ]);
  assert.equal(report.negativeEmptyRate, 2 / 3);
  assert.deepEqual(report.noisyEmpties, ["noisy"]);
  assert.equal(report.recallAt5, null);
  assert.equal(report.perCategory.channel, undefined);
});

test("the composite score averages the four rates and is zero when nothing is answerable", () => {
  const mixed = scoreRecallAudit([
    { id: "hit", cat: "fact", key: "alpha", memories: [memory("alpha", "")] },
    { id: "quiet", cat: "channel", expectEmpty: true, memories: [] },
  ]);
  assert.equal(mixed.score, 100);
  const empty = scoreRecallAudit([]);
  assert.equal(empty.score, 0);
  assert.equal(empty.negativeEmptyRate, null);
});

test("an invalid key fails instead of matching everything", () => {
  assert.throws(
    () => scoreRecallAudit([{ id: "bad", cat: "fact", key: "(", memories: [] }]),
    /invalid key/,
  );
});

test("thresholds miss only the bounds that were set", () => {
  const report = { score: 80, latency: { server: { p50: 700, p95: 2100 } } };
  assert.deepEqual(thresholdMisses(report, {}), []);
  assert.deepEqual(
    thresholdMisses(report, { minScore: 90, maxP50: 600, maxP95: 3000 }).sort(),
    ["p50", "score"],
  );
  assert.deepEqual(thresholdMisses(report, { maxP95: 2100 }), []);
});

test("the command refuses an in-repo ground-truth path before any request", () => {
  const inside = path.join(repoRoot, "scripts/recall-audit-eval.test.mjs");
  assert.throws(() => assertQueryPathOutsideRepo(inside, repoRoot), /in-repo/);
  const result = spawnSync(process.execPath, [scriptPath, inside, "--account", "coach"], {
    encoding: "utf8",
    env: { ...process.env, MC_BENCH_KEY_COACH: "not-sent" },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /in-repo/);
  assert.equal(result.stdout, "");
});

test("an evaluation sends read-only recall calls, gaps its passes, and scores the first pass", async () => {
  const sent = [];
  const sleeps = [];
  let clock = 0;
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push({ url: String(url), authorization: init.headers.authorization, body });
    clock += 50;
    const memories = body.query === "empty question" ? [] : [memory("alpha note", "MEMORY_TEXT_SHOULD_NOT_PRINT"), memory("other", "no")];
    return new Response(JSON.stringify({ memories, diagnostics: { timings: { total: sent.length * 100 } } }), { status: 200 });
  };
  const report = await runRecallAudit({
    queries: [
      { id: "hit", cat: "fact", q: "QUERY_TEXT_SHOULD_NOT_PRINT", key: "alpha", mode: "people" },
      { id: "quiet", cat: "negative", q: "empty question", expectEmpty: true },
    ],
    account: "coach",
    passes: 2,
    env: { MC_BENCH_KEY_COACH: "key-1", MC_BENCH_BASE_URL: "http://fixture.test" },
    fetch,
    sleep: async (ms) => { sleeps.push(ms); },
    now: () => clock,
  });
  assert.equal(sent.length, 4);
  assert.deepEqual(sleeps, [PASS_GAP_MS]);
  assert.equal(sent[0].url, "http://fixture.test/api/mcp/recall");
  assert.equal(sent[0].authorization, "Bearer key-1");
  assert.deepEqual(sent[0].body, { query: "QUERY_TEXT_SHOULD_NOT_PRINT", limit: 5, messageLimit: 0, recordAccess: false, mode: "people" });
  assert.equal(sent[1].body.mode, undefined);
  assert.equal(report.score, 100 * (1 + 1 + 0.5 + 1) / 4);
  assert.deepEqual(report.latency.server, { p50: 200, p95: 400, max: 400 });
  assert.deepEqual(report.latency.wall, { p50: 50, p95: 50, max: 50 });
  const printed = JSON.stringify(report);
  assert.doesNotMatch(printed, /QUERY_TEXT_SHOULD_NOT_PRINT|MEMORY_TEXT_SHOULD_NOT_PRINT/);
});

test("a failed recall call aborts the evaluation", async () => {
  await assert.rejects(
    runRecallAudit({
      queries: [{ id: "hit", cat: "fact", q: "question", key: "alpha" }],
      account: "coach",
      passes: 1,
      env: { MC_BENCH_KEY_COACH: "key-1" },
      fetch: async () => new Response("{}", { status: 429 }),
      sleep: async () => {},
      now: () => 0,
    }),
    /HTTP 429/,
  );
});

test("answerable queries that all come back empty score zero precision", () => {
  const report = scoreRecallAudit([
    { id: "miss", cat: "fact", key: "alpha", memories: [] },
    { id: "quiet", cat: "negative", expectEmpty: true, memories: [] },
  ]);
  assert.equal(report.precisionAt5, 0);
  assert.equal(report.score, 25);
});

test("wall time includes reading the response body", async () => {
  let clock = 0;
  const report = await runRecallAudit({
    queries: [{ id: "hit", cat: "fact", q: "question", key: "alpha" }],
    account: "coach",
    passes: 1,
    env: { MC_BENCH_KEY_COACH: "key-1" },
    fetch: async () => {
      clock += 50;
      return { ok: true, status: 200, json: async () => { clock += 2000; return { memories: [], diagnostics: { timings: { total: 10 } } }; } };
    },
    sleep: async () => {},
    now: () => clock,
  });
  assert.equal(report.latency.wall.p50, 2050);
});

test("a response recalled without a query embedding aborts the evaluation", async () => {
  await assert.rejects(
    runRecallAudit({
      queries: [{ id: "hit", cat: "fact", q: "question", key: "alpha" }],
      account: "coach",
      passes: 1,
      env: { MC_BENCH_KEY_COACH: "key-1" },
      fetch: async () => new Response(JSON.stringify({
        memories: [],
        degradation: { code: "embedding_unavailable" },
        diagnostics: { timings: { total: 10 } },
      }), { status: 200 }),
      sleep: async () => {},
      now: () => 0,
    }),
    /embedding_unavailable/,
  );
});

test("ground truth is checked before any call and never echoed", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "recall-audit-"));
  const malformed = path.join(dir, "malformed.json");
  writeFileSync(malformed, '{"queries":[{"id":"q","q":"PRIVATE_QUERY_TEXT" x}]}');
  assert.throws(() => readGroundTruth(malformed), (error) => {
    assert.match(error.message, /not readable JSON/);
    assert.doesNotMatch(error.message, /PRIVATE_QUERY_TEXT/);
    return true;
  });
  const emptyKey = path.join(dir, "empty-key.json");
  writeFileSync(emptyKey, JSON.stringify({ queries: [{ id: "q", q: "question", key: "" }] }));
  assert.throws(() => readGroundTruth(emptyKey), /missing key/);
  const badKey = path.join(dir, "bad-key.json");
  writeFileSync(badKey, JSON.stringify({ queries: [{ id: "q", q: "question", key: "(" }] }));
  assert.throws(() => readGroundTruth(badKey), /invalid key/);
});
