#!/usr/bin/env node
/**
 * soak-recall.mjs — ILL-272 warm recall SLO gate against live Railway.
 *
 * Warms `/api/mcp/recall`, then sends 100 authenticated recalls and prints:
 *   - HTTP status histogram
 *   - wall-clock p50 / p95 / max
 *   - per-stage p50 / p95 from diagnostics.timings
 *
 * Auth is read from the environment only. Never commit keys.
 *
 *   MEMORY_CRYSTAL_API_KEY   required
 *   MEMORY_CRYSTAL_API_URL   optional, default https://convex.memorycrystal.ai
 *   MEMORY_CRYSTAL_URL       optional alias for the API URL
 *
 * Warm SLO (after warmup, 100 requests):
 *   p50 ≤ 2.5s, p95 ≤ 7.0s, max ≤ 16.0s
 *   HTTP 200 ≥ 98, 499 ≤ 2, 5xx = 0
 *
 * Baseline without a live run: 2026-08-21 8h Railway window on digest
 * 941c6660 — 47/64 HTTP 200, 17/64 499, p50 ~6.7s, p95 ~17s, max ~32s.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_URL = "https://convex.memorycrystal.ai";
const CLIENT_TIMEOUT_MS = 16_000;
const WARMUP_MIN = 20;
const WARMUP_MAX = 40;
const SOAK_COUNT = 100;
const WARM_P50_MS = 2_500;
const WARM_P95_MS = 7_000;
const WARM_MAX_MS = 16_000;
const STAGE_KEYS = [
  "embed",
  "vectorSearch",
  "lexical",
  "kb",
  "messages",
  "graph",
  "compose",
  "total",
];

const PRODUCTION_SHAPED_QUERIES = [
  "what do we know about the current recall timeout",
  "who owns memory crystal production",
  "what decisions did we make about railway ram",
  "how does crystal_recall work",
  "what is the hermes auto recall default",
  "recent production incidents",
  "what is the convex backend url",
  "how do we deploy convex to railway",
  "what are the memory crystal store types",
  "why did recall return 499",
  "what is the gold set recall gate",
  "how do hooks inject recalled context",
  "what is includeGraphContext default",
  "how does vector search work on crystalMemories",
  "what is the STM TTL by tier",
  "how do we install the hermes plugin",
  "what changelog notes cover recall",
  "who should I ask about billing",
  "what is the workflow for plugin deploy",
  "remind me of the design system colors",
];

function printHelp() {
  process.stdout.write(
    [
      "soak-recall — warm 100-request SLO gate for POST /api/mcp/recall",
      "",
      "USAGE",
      "  MEMORY_CRYSTAL_API_KEY=... node scripts/soak-recall.mjs",
      "  MEMORY_CRYSTAL_API_KEY=... MEMORY_CRYSTAL_API_URL=https://convex.memorycrystal.ai \\",
      "    node scripts/soak-recall.mjs",
      "",
      "ENV",
      "  MEMORY_CRYSTAL_API_KEY   required bearer key",
      "  MEMORY_CRYSTAL_API_URL   optional backend origin (default https://convex.memorycrystal.ai)",
      "  MEMORY_CRYSTAL_URL       optional alias for MEMORY_CRYSTAL_API_URL",
      "",
      "BEHAVIOR",
      "  1. Warm up with at least 20 discarded requests (cap 40) until the last 10",
      "     have p50 < 8s, or the cap is hit. Cold 28–36s archive-cache hits are",
      "     recorded separately and excluded from the warm SLO.",
      "  2. Send 100 authenticated recalls (limit=12, production graph default).",
      "     Queries are the committed gold-set wordings plus 20 production-shaped",
      "     prompts. Response bodies, query text, and secrets are not printed.",
      "  3. Print status histogram, wall p50/p95/max, and per-stage p50/p95.",
      "  4. Exit 1 if the warm SLO fails. Exit 2 if auth env is missing.",
      "",
      "WARM SLO",
      "  p50 ≤ 2.5s, p95 ≤ 7.0s, max ≤ 16.0s, HTTP 200 ≥ 98, 499 ≤ 2, 5xx = 0",
      "",
      "See docs/recall-soak.md.",
      "",
    ].join("\n"),
  );
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

function loadGoldQueries() {
  const gold = JSON.parse(
    readFileSync(resolve(repoRoot, "convex/crystal/eval/goldset.json"), "utf8"),
  );
  const queries = (gold.cases ?? [])
    .map((entry) => (typeof entry?.query === "string" ? entry.query.trim() : ""))
    .filter((query) => query.length > 0);
  return queries;
}

function mixQueries() {
  const gold = loadGoldQueries();
  return [...gold, ...PRODUCTION_SHAPED_QUERIES];
}

function pickQuery(queries, index) {
  return queries[index % queries.length] ?? "what do I know";
}

function backendOrigin() {
  const raw =
    process.env.MEMORY_CRYSTAL_API_URL ||
    process.env.MEMORY_CRYSTAL_URL ||
    DEFAULT_URL;
  return String(raw).replace(/\/+$/, "");
}

async function postRecall(origin, apiKey, query) {
  const started = Date.now();
  let status = 0;
  let timings = null;
  try {
    const response = await fetch(`${origin}/api/mcp/recall`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ query, limit: 12 }),
      signal: AbortSignal.timeout(CLIENT_TIMEOUT_MS),
    });
    status = response.status;
    if (response.ok) {
      const payload = await response.json().catch(() => null);
      const rawTimings = payload?.diagnostics?.timings;
      if (rawTimings && typeof rawTimings === "object") {
        timings = {};
        for (const key of STAGE_KEYS) {
          const value = Number(rawTimings[key]);
          timings[key] = Number.isFinite(value) ? value : null;
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/abort|timeout/i.test(message)) status = 499;
    else status = 0;
  }
  return { status, latencyMs: Date.now() - started, timings };
}

function histogram(statuses) {
  const counts = new Map();
  for (const status of statuses) {
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => a[0] - b[0]);
}

function stageStats(rows) {
  const stats = {};
  for (const key of STAGE_KEYS) {
    const values = rows
      .map((row) => row.timings?.[key])
      .filter((value) => typeof value === "number" && Number.isFinite(value));
    stats[key] = {
      n: values.length,
      p50: percentile(values, 50),
      p95: percentile(values, 95),
    };
  }
  return stats;
}

function printTable(title, rows) {
  process.stdout.write(`\n${title}\n`);
  for (const row of rows) process.stdout.write(`${row}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  const apiKey = process.env.MEMORY_CRYSTAL_API_KEY ?? "";
  if (!apiKey) {
    process.stderr.write(
      "soak-recall: MEMORY_CRYSTAL_API_KEY is required. Auth is env-only; no keys in git.\n",
    );
    printHelp();
    process.exit(2);
  }

  const origin = backendOrigin();
  const queries = mixQueries();
  process.stdout.write(`soak-recall target=${origin} warmup=${WARMUP_MIN}-${WARMUP_MAX} soak=${SOAK_COUNT}\n`);

  const warmup = [];
  let queryIndex = 0;
  while (warmup.length < WARMUP_MAX) {
    const result = await postRecall(origin, apiKey, pickQuery(queries, queryIndex));
    queryIndex += 1;
    warmup.push(result);
    const recent = warmup.slice(-10).map((row) => row.latencyMs);
    const warmEnough =
      warmup.length >= WARMUP_MIN && percentile(recent, 50) < 8_000;
    process.stdout.write(
      `warmup ${warmup.length} status=${result.status} latencyMs=${result.latencyMs}\n`,
    );
    if (warmEnough) break;
  }

  const soak = [];
  for (let i = 0; i < SOAK_COUNT; i += 1) {
    const result = await postRecall(origin, apiKey, pickQuery(queries, queryIndex));
    queryIndex += 1;
    soak.push(result);
    process.stdout.write(
      `#${String(i + 1).padStart(3, "0")} status=${result.status} latencyMs=${result.latencyMs}\n`,
    );
  }

  const statuses = soak.map((row) => row.status);
  const latencies = soak.map((row) => row.latencyMs);
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const max = Math.max(0, ...latencies);
  const count200 = statuses.filter((status) => status === 200).length;
  const count499 = statuses.filter((status) => status === 499).length;
  const count5xx = statuses.filter((status) => status >= 500 && status <= 599).length;
  const stages = stageStats(soak);

  printTable("status histogram", histogram(statuses).map(([status, count]) => `  ${status}: ${count}`));
  printTable("warm wall clock", [
    `  n=${soak.length}`,
    `  p50=${p50}ms`,
    `  p95=${p95}ms`,
    `  max=${max}ms`,
    `  http200=${count200}`,
    `  http499=${count499}`,
    `  http5xx=${count5xx}`,
  ]);
  printTable(
    "per-stage (ms)",
    STAGE_KEYS.map((key) => {
      const stat = stages[key];
      return `  ${key.padEnd(14)} n=${stat.n} p50=${stat.p50} p95=${stat.p95}`;
    }),
  );

  const cold = warmup.filter((row) => row.latencyMs >= 8_000);
  if (cold.length > 0) {
    process.stdout.write(
      `\ncold/warmup excluded from SLO: ${cold.length} request(s) ≥ 8s (max ${Math.max(...cold.map((row) => row.latencyMs))}ms)\n`,
    );
  }

  const failed =
    p50 > WARM_P50_MS ||
    p95 > WARM_P95_MS ||
    max > WARM_MAX_MS ||
    count200 < 98 ||
    count499 > 2 ||
    count5xx > 0;

  if (failed) {
    process.stderr.write("\nsoak-recall: warm SLO failed\n");
    process.exit(1);
  }
  process.stdout.write("\nsoak-recall: warm SLO passed\n");
}

main().catch((error) => {
  process.stderr.write(`soak-recall: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
