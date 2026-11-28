#!/usr/bin/env node
/**
 * Score recall against a private ground-truth file, as one account.
 * Prints the composite score and latency percentiles. Query text and memory
 * text are not printed. An evaluation call asks recall not to record access.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ACCOUNT_ENV,
  LiveBenchmarkInvalid,
  assertQueryPathOutsideRepo,
  embeddingDegraded,
  mean,
  summarizeLatency,
} from "./bench-recall-live.mjs";

/** Longer than the 5-minute per-isolate query-embedding cache, so no pass reuses an earlier pass's embedding. */
export const PASS_GAP_MS = 6 * 60 * 1000;
export const RECALL_TIMEOUT_MS = 30_000;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function memoryText(memory) {
  return `${memory?.title ?? ""}\n${memory?.content ?? ""}`;
}

function relevant(memory, pattern) {
  return pattern.test(memoryText(memory));
}

/**
 * Quality over one pass. `key` is a case-insensitive regex over title and
 * content. expectEmpty queries are not answerable and do not enter Recall,
 * MRR, or Precision. An empty answerable result counts as a miss and is left
 * out of the precision denominator.
 */
export function scoreRecallAudit(cases) {
  const answerable = cases.filter((item) => item.expectEmpty !== true);
  const empties = cases.filter((item) => item.expectEmpty === true);
  const perCase = answerable.map((item) => {
    let pattern;
    try {
      pattern = new RegExp(item.key ?? "", "i");
    } catch {
      throw new LiveBenchmarkInvalid(`invalid key for ${item.id}`);
    }
    const memories = item.memories ?? [];
    const flags = memories.map((memory) => relevant(memory, pattern));
    const first = flags.indexOf(true);
    return {
      id: String(item.id),
      cat: String(item.cat ?? "unclassified"),
      hitAt1: flags[0] === true ? 1 : 0,
      hitAt5: first >= 0 && first < 5 ? 1 : 0,
      reciprocal: first < 0 ? 0 : 1 / (first + 1),
      relevant: flags.filter(Boolean).length,
      returned: memories.length,
    };
  });
  const returned = perCase.reduce((sum, item) => sum + item.returned, 0);
  const recallAt5 = mean(perCase.map((item) => item.hitAt5));
  const mrr = mean(perCase.map((item) => item.reciprocal));
  // With answerable queries but nothing returned, precision is 0: an empty answer must not outscore a wrong one.
  const precisionAt5 = perCase.length === 0 ? null : returned === 0 ? 0 : perCase.reduce((sum, item) => sum + item.relevant, 0) / returned;
  const negativeEmptyRate = empties.length === 0
    ? null
    : empties.filter((item) => (item.memories ?? []).length === 0).length / empties.length;
  const rates = [recallAt5, mrr, precisionAt5, negativeEmptyRate].filter((value) => value !== null);
  const perCategory = {};
  for (const item of perCase) {
    const bucket = perCategory[item.cat] ?? { hits: 0, count: 0 };
    bucket.hits += item.hitAt5;
    bucket.count += 1;
    perCategory[item.cat] = bucket;
  }
  return {
    recallAt1: mean(perCase.map((item) => item.hitAt1)),
    recallAt5,
    mrr,
    precisionAt5,
    negativeEmptyRate,
    score: rates.length === 0 ? 0 : 100 * mean(rates),
    perCategory: Object.fromEntries(
      Object.entries(perCategory).map(([cat, bucket]) => [cat, { hitAt5: bucket.hits / bucket.count, count: bucket.count }]),
    ),
    misses: perCase.filter((item) => item.hitAt5 === 0).map((item) => item.id),
    noisyEmpties: empties.filter((item) => (item.memories ?? []).length > 0).map((item) => String(item.id)),
  };
}

export function thresholdMisses(report, thresholds) {
  const misses = [];
  if (thresholds.minScore !== undefined && report.score < thresholds.minScore) misses.push("score");
  if (thresholds.maxP50 !== undefined && !(report.latency.server.p50 <= thresholds.maxP50)) misses.push("p50");
  if (thresholds.maxP95 !== undefined && !(report.latency.server.p95 <= thresholds.maxP95)) misses.push("p95");
  return misses;
}

export function readGroundTruth(file) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // JSON.parse messages can quote the input, and the input holds private queries.
    throw new LiveBenchmarkInvalid("ground truth is not readable JSON");
  }
  if (!parsed || !Array.isArray(parsed.queries) || parsed.queries.length === 0) {
    throw new LiveBenchmarkInvalid("ground truth requires at least one query");
  }
  for (const query of parsed.queries) {
    if (typeof query?.id !== "string" || !query.id) throw new LiveBenchmarkInvalid("ground truth query is missing id");
    if (typeof query.q !== "string" || !query.q.trim()) throw new LiveBenchmarkInvalid(`ground truth query ${query.id} is missing q`);
    if (query.expectEmpty === true) continue;
    if (typeof query.key !== "string" || !query.key) throw new LiveBenchmarkInvalid(`ground truth query ${query.id} is missing key`);
    try {
      new RegExp(query.key, "i");
    } catch {
      throw new LiveBenchmarkInvalid(`invalid key for ${query.id}`);
    }
  }
  return parsed.queries;
}

function parseArgs(argv) {
  const args = { passes: 3, thresholds: {} };
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new LiveBenchmarkInvalid(`missing value for ${arg}`);
      index += 1;
      return value;
    };
    if (arg === "--account") args.account = next();
    else if (arg === "--passes") args.passes = Number(next());
    else if (arg === "--min-score") args.thresholds.minScore = Number(next());
    else if (arg === "--max-p50") args.thresholds.maxP50 = Number(next());
    else if (arg === "--max-p95") args.thresholds.maxP95 = Number(next());
    else if (arg.startsWith("--")) throw new LiveBenchmarkInvalid(`unknown argument ${arg}`);
    else positionals.push(arg);
  }
  if (positionals.length !== 1) throw new LiveBenchmarkInvalid(`usage: node scripts/recall-audit-eval.mjs <ground-truth.json> --account ${Object.keys(ACCOUNT_ENV).join("|")}`);
  args.groundTruth = positionals[0];
  if (!Object.hasOwn(ACCOUNT_ENV, args.account)) throw new LiveBenchmarkInvalid("unknown account");
  if (!Number.isInteger(args.passes) || args.passes < 1) throw new LiveBenchmarkInvalid("--passes requires a positive integer");
  for (const [name, value] of Object.entries(args.thresholds)) {
    if (!Number.isFinite(value)) throw new LiveBenchmarkInvalid(`${name} is not a finite number`);
  }
  return args;
}

export async function runRecallAudit(options) {
  const root = options.repoRoot ?? repoRoot;
  if (options.groundTruth) assertQueryPathOutsideRepo(options.groundTruth, root);
  const queries = options.queries;
  if (!Array.isArray(queries) || queries.length === 0) throw new LiveBenchmarkInvalid("ground truth requires at least one query");
  const account = options.account;
  if (!Object.hasOwn(ACCOUNT_ENV, account)) throw new LiveBenchmarkInvalid("unknown account");
  const env = options.env ?? {};
  const key = env[ACCOUNT_ENV[account]];
  if (!key) throw new LiveBenchmarkInvalid(`missing ${ACCOUNT_ENV[account]}`);
  const passes = options.passes ?? 3;
  if (!Number.isInteger(passes) || passes < 1) throw new LiveBenchmarkInvalid("--passes requires a positive integer");
  const doFetch = options.fetch;
  const sleep = options.sleep;
  const now = options.now;
  const baseUrl = options.baseUrl || env.MC_BENCH_BASE_URL || "https://memorycrystal.ai";

  const server = [];
  const wall = [];
  let firstPass = null;
  for (let pass = 0; pass < passes; pass += 1) {
    if (pass > 0) await sleep(PASS_GAP_MS);
    const observed = [];
    for (const query of queries) {
      const started = now();
      const response = await doFetch(new URL("/api/mcp/recall", baseUrl), {
        method: "POST",
        signal: AbortSignal.timeout(RECALL_TIMEOUT_MS),
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          query: query.q,
          limit: 5,
          messageLimit: 0,
          recordAccess: false,
          ...(typeof query.mode === "string" && query.mode ? { mode: query.mode } : {}),
        }),
      });
      if (!response.ok) throw new LiveBenchmarkInvalid(`recall HTTP ${response.status} aborts the evaluation`);
      const payload = await response.json().catch(() => null);
      const elapsed = now() - started;
      if (embeddingDegraded(payload)) {
        throw new LiveBenchmarkInvalid("embedding_unavailable or embedding_cap_exceeded aborts the evaluation");
      }
      const total = payload?.diagnostics?.timings?.total;
      if (typeof total !== "number" || !Number.isFinite(total)) {
        throw new LiveBenchmarkInvalid("recall response is missing diagnostics.timings.total");
      }
      server.push(total);
      wall.push(elapsed);
      observed.push({
        id: query.id,
        cat: query.cat,
        key: query.key,
        expectEmpty: query.expectEmpty === true,
        memories: Array.isArray(payload?.memories) ? payload.memories : [],
      });
    }
    if (pass === 0) firstPass = observed;
  }

  const quality = scoreRecallAudit(firstPass);
  return {
    account,
    passes,
    queries: queries.length,
    recallAt1: quality.recallAt1,
    recallAt5: quality.recallAt5,
    mrr: quality.mrr,
    precisionAt5: quality.precisionAt5,
    negativeEmptyRate: quality.negativeEmptyRate,
    score: quality.score,
    perCategory: quality.perCategory,
    misses: quality.misses,
    noisyEmpties: quality.noisyEmpties,
    latency: { server: summarizeLatency(server), wall: summarizeLatency(wall) },
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const args = parseArgs(process.argv.slice(2));
    assertQueryPathOutsideRepo(args.groundTruth, repoRoot);
    const queries = readGroundTruth(args.groundTruth);
    const report = await runRecallAudit({
      queries,
      groundTruth: args.groundTruth,
      account: args.account,
      passes: args.passes,
      fetch: globalThis.fetch,
      sleep: (ms) => new Promise((resolveSleep) => { setTimeout(resolveSleep, ms); }),
      now: () => Date.now(),
      env: process.env,
      repoRoot,
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
    const misses = thresholdMisses(report, args.thresholds);
    if (misses.length > 0) {
      process.stderr.write(`threshold missed: ${misses.join(", ")}\n`);
      process.exit(1);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "recall audit failed"}\n`);
    process.exit(error instanceof LiveBenchmarkInvalid && /in-repo/.test(error.message) ? 2 : 1);
  }
}
