import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertQueryPathOutsideRepo,
  runLiveBenchmark,
  LiveBenchmarkInvalid,
} from "./bench-recall-live.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const QUERY = "UNIQUE_QUERY_TEXT_zzz";
const MEMORY = "UNIQUE_MEMORY_BODY_zzz";

function clock() {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms) => {
      current += ms;
    },
  };
}

test("refuses an in-repo query path before any request", async () => {
  let calls = 0;
  const inside = path.join(repoRoot, "benchmarks/results/recall-v2/queries.jsonl");
  assert.throws(() => assertQueryPathOutsideRepo(inside, repoRoot), /in-repo/);
  await assert.rejects(
    () => runLiveBenchmark({
      rows: [{ id: "1", account: "illumin8", class: "negative", query: QUERY, expected: { none: true } }],
      queryPath: inside,
      repoRoot,
      fetch: async () => {
        calls += 1;
        return new Response("{}");
      },
      sleep: async () => {},
      now: () => 0,
      env: { MC_BENCH_KEY_ILLUMIN8: "test-key" },
    }),
    /in-repo/,
  );
  assert.equal(calls, 0);
});

test("report omits query text and memory content", async () => {
  const time = clock();
  let recalls = 0;
  const report = await runLiveBenchmark({
    rows: [{
      id: "case-1",
      account: "morrow",
      class: "identifier",
      query: QUERY,
      expected: { memoryIds: ["mem-1"] },
      expectedAbsent: ["mem-hidden"],
    }],
    queryPath: path.join(tmpdir(), "outside-repo-queries.jsonl"),
    repoRoot,
    baseUrl: "http://fixture.test",
    fetch: async (url) => {
      const href = String(url);
      if (href.endsWith("/api/mcp/health")) {
        return Response.json({
          build: { commit: "abc", dirty: false, builtAt: null, source: "generated" },
          costLedger: { global: { recall: "ok" }, user: { recall: "ok" } },
        });
      }
      recalls += 1;
      return Response.json({
        memories: [{ _id: "mem-1", title: "nope", content: MEMORY }],
        // Exact finalizeRecallTimings output at convex/crystal/recallTimings.ts;
        // mcpRecall places this under diagnostics.timings (convex/crystal/mcp.ts).
        diagnostics: { coverage: { quality: "strong" }, timings: {
          embed: recalls <= 5 ? 40 : 4, vectorSearch: 9, lexical: 2,
          kb: 0, messages: 1, compose: 3, total: recalls <= 5 ? 55 : 19, parallel: true,
        } },
      });
    },
    sleep: time.sleep,
    now: time.now,
    env: { MC_BENCH_KEY_MORROW: "test-key" },
  });
  const text = JSON.stringify(report);
  assert.equal(text.includes(QUERY), false);
  assert.equal(text.includes(MEMORY), false);
  assert.equal(report.complete, true);
  assert.equal(report.perAccount.morrow.cold, 5);
  assert.equal(report.metrics.overall.hitAt1, 1);
  assert.equal(report.metrics.overall.expectedAbsentViolations, 0);
  assert.equal(report.perAccount.morrow.labelViolations, 0);
  assert.ok(recalls >= 5);
  const latency = report.perAccount.morrow.latency;
  assert.equal(latency.cold.embed.p50, 40);
  assert.equal(latency.warm.embed.p50, 4);
  assert.equal(latency.cold.total.p95, 55);
  assert.equal(latency.warm.total.p95, 19);
  assert.equal(latency.warm.parallel, undefined);
});

function fixtureFetch(byQuery) {
  return async (url, init) => {
    const href = String(url);
    if (href.endsWith("/api/mcp/health")) {
      return Response.json({
        build: { commit: "abc", dirty: false, builtAt: null, source: "generated" },
        costLedger: { global: { recall: "ok" }, user: { recall: "ok" } },
      });
    }
    const body = JSON.parse(init.body);
    const answer = byQuery[body.query];
    return Response.json({
      memories: answer.ids.map((id) => ({ _id: id })),
      diagnostics: { coverage: { quality: answer.quality }, timings: { total: 10 } },
    });
  };
}

test("reports per-account and per-class quality with strong precision and recall", async () => {
  const time = clock();
  const rows = [
    { id: "a1", account: "illumin8", class: "identifier", query: "q-a1", expected: { memoryIds: ["m1"] } },
    { id: "a2", account: "illumin8", class: "negative", query: "q-a2", expected: { none: true } },
    { id: "b1", account: "morrow", class: "identifier", query: "q-b1", expected: { memoryIds: ["m9"] } },
    { id: "b2", account: "morrow", class: "people", query: "q-b2", expected: { memoryIds: ["p1"] } },
  ];
  const report = await runLiveBenchmark({
    rows,
    queryPath: path.join(tmpdir(), "outside-repo-queries.jsonl"),
    repoRoot,
    baseUrl: "http://fixture.test",
    fetch: fixtureFetch({
      "q-a1": { ids: ["m1"], quality: "strong" },
      "q-a2": { ids: ["x"], quality: "strong" },
      "q-b1": { ids: ["x", "y", "z", "m9"], quality: "weak" },
      "q-b2": { ids: ["p1"], quality: "strong" },
    }),
    sleep: time.sleep,
    now: time.now,
    env: { MC_BENCH_KEY_ILLUMIN8: "k1", MC_BENCH_KEY_MORROW: "k2" },
  });
  const ill = report.perAccount.illumin8.metrics;
  assert.equal(ill.perClass.identifier.hitAt3, 1);
  assert.equal(ill.perClass.negative.strongRate, 1);
  assert.equal(ill.perClass.negative.hitAt3, null);
  assert.equal(ill.overall.strongPrecision, 0.5);
  const mor = report.perAccount.morrow.metrics;
  assert.equal(mor.perClass.identifier.hitAt3, 0);
  assert.equal(mor.perClass.identifier.hitAt5, 1);
  assert.equal(mor.perClass.people.strongRecall, 1);
  assert.equal(report.metrics.perClass.identifier.caseCount, 2);
  assert.equal(report.metrics.perClass.identifier.hitAt3, 0.5);
  assert.equal(report.metrics.overall.strongRecall, 2 / 3);
  assert.equal(report.metrics.overall.strongPrecision, 2 / 3);
});

test("latency labels come from measured gaps: an oversleeping warm call is flagged, not counted", async () => {
  const time = clock();
  let warmCalls = 0;
  const report = await runLiveBenchmark({
    rows: [
      { id: "w1", account: "coach", class: "scope", query: "q-w1", expected: { memoryIds: ["m1"] } },
      { id: "w2", account: "coach", class: "scope", query: "q-w2", expected: { memoryIds: ["m1"] } },
    ],
    queryPath: path.join(tmpdir(), "outside-repo-queries.jsonl"),
    repoRoot,
    baseUrl: "http://fixture.test",
    fetch: fixtureFetch({ "q-w1": { ids: ["m1"], quality: "strong" }, "q-w2": { ids: ["m1"], quality: "strong" } }),
    // Spacing sleeps 1-5 precede the warmups; sleep 7 precedes the second warm row.
    // It overshoots by 20 s to simulate a stalled scheduler.
    sleep: async (ms) => {
      if (ms > 0 && ms <= 1100) warmCalls += 1;
      await time.sleep(ms <= 1100 && warmCalls === 7 ? ms + 20_000 : ms);
    },
    now: time.now,
    env: { MC_BENCH_KEY_COACH: "k3" },
  });
  const coach = report.perAccount.coach;
  assert.equal(coach.labelViolations, 1);
  assert.equal(coach.warm, 1);
  assert.equal(coach.metrics.overall.caseCount, 2);
  assert.equal(coach.cold, 5);
});

test("aborts on HTTP 429 and on ledger warn before recall", async () => {
  const time = clock();
  let recalls = 0;
  await assert.rejects(
    () => runLiveBenchmark({
      rows: [{ id: "1", account: "coach", class: "negative", query: QUERY, expected: { none: true } }],
      queryPath: path.join(tmpdir(), "outside.jsonl"),
      repoRoot,
      baseUrl: "http://fixture.test",
      fetch: async (url) => {
        if (String(url).endsWith("/health")) {
          return Response.json({ build: { commit: "unknown", dirty: false, builtAt: null, source: "unknown" }, costLedger: { global: { recall: "ok" }, user: { recall: "ok" } } });
        }
        recalls += 1;
        return new Response(JSON.stringify({ error: QUERY, content: MEMORY }), { status: 429 });
      },
      sleep: time.sleep,
      now: time.now,
      env: { MC_BENCH_KEY_COACH: "test-key" },
    }),
    (error) => {
      assert.ok(error instanceof LiveBenchmarkInvalid);
      assert.match(error.message, /429/);
      assert.equal(error.message.includes(QUERY), false);
      assert.equal(error.message.includes(MEMORY), false);
      return true;
    },
  );
  assert.equal(recalls, 1);

  let calls = 0;
  await assert.rejects(
    () => runLiveBenchmark({
      rows: [{ id: "1", account: "illumin8", class: "negative", query: QUERY, expected: { none: true } }],
      queryPath: path.join(tmpdir(), "outside.jsonl"),
      repoRoot,
      baseUrl: "http://fixture.test",
      fetch: async () => {
        calls += 1;
        return Response.json({
          build: { source: "generated", commit: "abc", dirty: false, builtAt: null },
          costLedger: { global: { recall: "warn", kb: "ok" } },
        });
      },
      sleep: async () => {},
      now: () => 0,
      env: { MC_BENCH_KEY_ILLUMIN8: "test-key" },
    }),
    /warn or emergency/,
  );
  assert.equal(calls, 1);

  const outside = path.join(mkdtempSync(path.join(tmpdir(), "mc-live-")), "rows.jsonl");
  writeFileSync(outside, `${JSON.stringify({ id: "1", account: "illumin8", query: QUERY })}\n`);
  assert.doesNotThrow(() => assertQueryPathOutsideRepo(outside, repoRoot));
});

const validHealth = () => ({
  build: { commit: "abc", dirty: false, builtAt: "2026-09-26T00:00:00.000Z", source: "generated" },
  costLedger: { global: { recall: "ok" }, user: { recall: "ok" } },
});
function options(fetch) {
  const time = clock();
  return { rows: [{ id: "1", account: "coach", query: QUERY }], fetch,
    sleep: time.sleep, now: time.now, env: { MC_BENCH_KEY_COACH: "key" } };
}
for (const [name, health, status] of [
  ["non-2xx", validHealth(), 503], ["unauthorized", {}, 401],
  ["missing build", { costLedger: validHealth().costLedger }, 200],
  ["missing global", { ...validHealth(), costLedger: { user: { recall: "ok" } } }, 200],
  ["normal key missing user", { ...validHealth(), costLedger: { global: { recall: "ok" } } }, 200],
  ["empty ledger", { ...validHealth(), costLedger: { global: {}, user: {} } }, 200],
  ["user warn", { ...validHealth(), costLedger: { global: { recall: "ok" }, user: { recall: "warn" } } }, 200],
  ["global emergency", { ...validHealth(), costLedger: { global: { recall: "emergency" }, user: { recall: "ok" } } }, 200],
]) test(`health fails closed: ${name}`, async () => {
  let recalls = 0;
  await assert.rejects(() => runLiveBenchmark(options(async url => {
    if (String(url).endsWith("/health")) return Response.json(health, { status });
    recalls++;
    return Response.json({});
  })), LiveBenchmarkInvalid);
  assert.equal(recalls, 0);
});

test("checks every account before any recall", async () => {
  let recalls = 0;
  const seen = [];
  const opts = options(async (url, init) => {
    if (String(url).endsWith("/health")) {
      seen.push(init.headers.authorization);
      return Response.json(seen.length === 1 ? validHealth() : {}, { status: 200 });
    }
    recalls++;
    return Response.json({});
  });
  opts.rows.push({ id: "2", account: "morrow", query: QUERY });
  opts.env.MC_BENCH_KEY_MORROW = "second";
  await assert.rejects(() => runLiveBenchmark(opts), LiveBenchmarkInvalid);
  assert.deepEqual(seen, ["Bearer key", "Bearer second"]);
  assert.equal(recalls, 0);
});

for (const status of [400, 401, 403, 429, 500, 503]) test(`recall HTTP ${status} invalidates the run immediately`, async () => {
  let recalls = 0;
  await assert.rejects(() => runLiveBenchmark(options(async url => {
    if (String(url).endsWith("/health")) return Response.json(validHealth());
    recalls++;
    return Response.json({ error: QUERY }, { status });
  })), new RegExp(`HTTP ${status}`));
  assert.equal(recalls, 1);
});

// mcpRecall's existing fallback contract plus additive cap reason. Multiple
// degradations are retained in relatedDegradations by markDegraded in mcp.ts.
for (const degradation of [
  { code: "embedding_unavailable", recoverable: true, affectedStage: "embedding", message: "Embedding generation failed; fallback retrieval was used." },
  { code: "embedding_unavailable", reason: "embedding_cap_exceeded", recoverable: true, affectedStage: "embedding" },
  { code: "cost_budget_exceeded", relatedDegradations: [{ code: "embedding_unavailable" }] },
]) test(`embedding failure invalidates live run: ${JSON.stringify(degradation)}`, async () => {
  let recalls = 0;
  await assert.rejects(() => runLiveBenchmark(options(async url => {
    if (String(url).endsWith("/health")) return Response.json(validHealth());
    recalls++;
    return Response.json({ memories: [], degradation, diagnostics: { coverage: { quality: "none" } } });
  })), /embedding_unavailable/);
  assert.equal(recalls, 1);
});
