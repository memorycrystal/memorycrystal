#!/usr/bin/env node
/**
 * Safe live recall benchmark (ILL-304). Dedicated benchmark keys only.
 * Reports IDs and aggregates. Query text and memory bodies are not printed.
 *
 * Cold probes are scheduled by this script: five calls per account, each
 * preceded by 15 minutes with no benchmark call on that account. Latency labels
 * come from measured gaps, not the schedule: a cold sample needs a measured gap
 * of at least 15 minutes, a warm sample at most 10 seconds. Samples that break
 * the rule are flagged and left out of the latency distributions. A run with
 * fewer than five measured cold samples per account is incomplete.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MIN_SPACING_MS = 1100;
export const COLD_GAP_MS = 15 * 60 * 1000;
export const COLD_PROBES = 5;
export const WARMUP_CALLS = 5;
export const WARM_MAX_GAP_MS = 10_000;
export const MAX_CALLS_PER_ACCOUNT = 150;
export const ACCOUNT_ENV = {
  illumin8: "MC_BENCH_KEY_ILLUMIN8",
  morrow: "MC_BENCH_KEY_MORROW",
  coach: "MC_BENCH_KEY_COACH",
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export class LiveBenchmarkInvalid extends Error {
  constructor(message) {
    super(message);
    this.name = "LiveBenchmarkInvalid";
  }
}

export function assertQueryPathOutsideRepo(queryPath, root = repoRoot) {
  const resolved = path.resolve(queryPath);
  const base = path.resolve(root);
  const relative = path.relative(base, resolved);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
    throw new LiveBenchmarkInvalid("live benchmark refuses an in-repo query path");
  }
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function summarizeLatency(values) {
  return {
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    max: values.length === 0 ? null : Math.max(...values),
  };
}

function mean(values) {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Quality metrics over measured observations, matching the offline definitions:
 * hit@k and MRR over positives, strongRate/anyMemoryRate over negatives, strong
 * precision over every strong-labelled response (gold in top 3), strong recall
 * over positives. Empty denominators report null, never 0.
 */
export function computeRecallMetrics(items) {
  const positives = items.filter((item) => item.positive);
  const negatives = items.filter((item) => !item.positive);
  const inTop = (item, k) => item.goldIds.some((id) => item.rankedIds.slice(0, k).includes(id));
  const strong = items.filter((item) => item.quality === "strong");
  return {
    caseCount: items.length,
    positiveCount: positives.length,
    negativeCount: negatives.length,
    hitAt1: mean(positives.map((item) => (inTop(item, 1) ? 1 : 0))),
    hitAt3: mean(positives.map((item) => (inTop(item, 3) ? 1 : 0))),
    hitAt5: mean(positives.map((item) => (inTop(item, 5) ? 1 : 0))),
    mrr: mean(positives.map((item) => {
      const index = item.rankedIds.findIndex((id) => item.goldIds.includes(id));
      return index < 0 ? 0 : 1 / (index + 1);
    })),
    strongRate: mean(negatives.map((item) => (item.quality === "strong" ? 1 : 0))),
    anyMemoryRate: mean(negatives.map((item) => (item.rankedIds.length > 0 ? 1 : 0))),
    strongPrecision: mean(strong.map((item) => (item.positive && inTop(item, 3) ? 1 : 0))),
    strongRecall: mean(positives.map((item) => (item.quality === "strong" ? 1 : 0))),
    expectedAbsentViolations: items.reduce((sum, item) => sum + item.absent, 0),
  };
}

function groupBy(items, key) {
  const groups = {};
  for (const item of items) (groups[item[key]] ??= []).push(item);
  return groups;
}

export async function runLiveBenchmark(options) {
  const rows = options.rows ?? [];
  const doFetch = options.fetch;
  const sleep = options.sleep;
  const now = options.now;
  const env = options.env ?? {};
  const root = options.repoRoot ?? repoRoot;
  if (options.queryPath) assertQueryPathOutsideRepo(options.queryPath, root);
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new LiveBenchmarkInvalid("live benchmark requires at least one row");
  }

  const byAccount = new Map();
  for (const row of rows) {
    if (!Object.hasOwn(ACCOUNT_ENV, row.account)) {
      throw new LiveBenchmarkInvalid("live benchmark row names an unknown account");
    }
    const list = byAccount.get(row.account) ?? [];
    list.push(row);
    byAccount.set(row.account, list);
  }
  for (const [account, list] of byAccount) {
    const planned = COLD_PROBES + WARMUP_CALLS + list.length;
    if (list.length > MAX_CALLS_PER_ACCOUNT || planned > MAX_CALLS_PER_ACCOUNT) {
      throw new LiveBenchmarkInvalid(`account ${account} exceeds ${MAX_CALLS_PER_ACCOUNT} calls`);
    }
    if (!env[ACCOUNT_ENV[account]]) {
      throw new LiveBenchmarkInvalid(`missing ${ACCOUNT_ENV[account]}`);
    }
  }

  const baseUrl = options.baseUrl || env.MC_BENCH_BASE_URL || "https://memorycrystal.ai";
  const started = now();
  const healthByAccount = {};
  // Validate every key before the first recall: user ledger is benchmark-only.
  for (const account of byAccount.keys()) {
    const response = await doFetch(new URL("/api/mcp/health", baseUrl), {
      headers: { authorization: `Bearer ${env[ACCOUNT_ENV[account]]}` },
    });
    if (!response.ok) throw new LiveBenchmarkInvalid(`health HTTP ${response.status} aborts the live benchmark`);
    const health = await response.json().catch(() => null);
    if (!health?.build || typeof health.build.commit !== "string" || !health.build.commit
      || typeof health.build.dirty !== "boolean" || !Object.hasOwn(health.build, "builtAt")
      || !["generated", "env", "unknown"].includes(health.build.source)) {
      throw new LiveBenchmarkInvalid("health missing build identity");
    }
    for (const scope of ["global", "user"]) {
      const ledger = health?.costLedger?.[scope];
      if (!ledger || typeof ledger !== "object" || Array.isArray(ledger) || Object.keys(ledger).length === 0) {
        throw new LiveBenchmarkInvalid(`health missing costLedger.${scope}`);
      }
      for (const status of Object.values(ledger)) {
        if (status === "warn" || status === "emergency") {
          throw new LiveBenchmarkInvalid(`${scope} cost ledger is at warn or emergency`);
        }
        if (status !== "ok") throw new LiveBenchmarkInvalid(`${scope} cost ledger has unknown status`);
      }
    }
    healthByAccount[account] = health;
  }

  const lastAt = new Map();
  const idleSince = new Map();
  const callCount = {};
  const coldCount = {};
  const warmCount = {};
  const labelViolations = {};
  const stageSamples = {};
  const observations = [];

  async function space(account, minGap) {
    const previous = lastAt.get(account);
    if (previous == null) {
      if (!idleSince.has(account)) idleSince.set(account, now());
      if (minGap >= COLD_GAP_MS) await sleep(minGap);
      return;
    }
    const wait = minGap - (now() - previous);
    if (wait > 0) await sleep(wait);
  }

  async function callAccount(account, row, kind) {
    await space(account, kind === "cold" ? COLD_GAP_MS : MIN_SPACING_MS);
    const startedCall = now();
    const reference = lastAt.get(account) ?? idleSince.get(account);
    const gapMs = reference == null ? null : startedCall - reference;
    const response = await doFetch(new URL("/api/mcp/recall", baseUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${env[ACCOUNT_ENV[account]]}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ query: row.query, ...(row.params ?? {}) }),
    });
    const wall = now() - startedCall;
    lastAt.set(account, now());
    callCount[account] = (callCount[account] ?? 0) + 1;
    if (!response.ok) throw new LiveBenchmarkInvalid(`recall HTTP ${response.status} aborts the live benchmark`);
    const payload = await response.json().catch(() => ({}));
    const degradations = [payload?.degradation, ...(payload?.degradation?.relatedDegradations ?? [])];
    if (degradations.some((entry) => entry?.code === "embedding_unavailable"
      || entry?.code === "embedding_cap_exceeded" || entry?.reason?.split(",").includes("embedding_cap_exceeded"))) {
      throw new LiveBenchmarkInvalid("embedding_unavailable or embedding_cap_exceeded aborts the live benchmark");
    }
    if (kind === "warmup") return;
    // Latency label from the measured gap before this call, not the schedule.
    const latencyLabel = kind === "cold"
      ? (gapMs != null && gapMs >= COLD_GAP_MS ? "cold" : null)
      : (gapMs != null && gapMs <= WARM_MAX_GAP_MS ? "warm" : null);
    const memoryIds = (payload.memories ?? []).map((memory) => String(memory._id ?? memory.memoryId ?? "")).filter(Boolean);
    const messageIds = (payload.messageMatches ?? []).map((match) => String(match.messageId ?? "")).filter(Boolean);
    if (latencyLabel === null) {
      labelViolations[account] = (labelViolations[account] ?? 0) + 1;
    } else {
      if (latencyLabel === "cold") coldCount[account] = (coldCount[account] ?? 0) + 1;
      else warmCount[account] = (warmCount[account] ?? 0) + 1;
      const samples = ((stageSamples[account] ??= { cold: {}, warm: {} })[latencyLabel]);
      const timings = payload.diagnostics?.timings ?? {};
      for (const [stage, value] of Object.entries(timings)) {
        if (typeof value === "number") (samples[stage] ??= []).push(value);
      }
      (samples.wall ??= []).push(wall);
    }
    const expectedIds = Array.isArray(row.expected?.memoryIds) ? row.expected.memoryIds.map(String) : [];
    const none = row.expected?.none === true;
    observations.push({
      id: String(row.id),
      positive: !none && expectedIds.length > 0,
      rankedIds: memoryIds,
      goldIds: none ? [] : expectedIds,
      quality: payload?.diagnostics?.coverage?.quality === "strong" || payload?.diagnostics?.coverage?.quality === "weak"
        ? payload.diagnostics.coverage.quality
        : "none",
      absent: (row.expectedAbsent ?? []).filter((id) => memoryIds.includes(String(id)) || messageIds.includes(String(id))).length,
      kind,
      account,
      className: typeof row.class === "string" && row.class ? row.class : "unclassified",
    });
  }

  for (const [account, list] of byAccount) {
    for (let index = 0; index < COLD_PROBES; index += 1) {
      await callAccount(account, list[index % list.length], "cold");
    }
    for (let index = 0; index < WARMUP_CALLS; index += 1) {
      await callAccount(account, list[index % list.length], "warmup");
    }
    for (const row of list) await callAccount(account, row, "warm");
  }

  // Quality is measured on the scheduled warm rows (quality does not depend on
  // the gap); latency uses only samples whose measured gap matched their label.
  const measured = observations.filter((item) => item.kind === "warm");
  const summarizeStages = (stages) => Object.fromEntries(Object.entries(stages ?? {}).map(([stage, values]) => [stage, summarizeLatency(values)]));
  const perAccount = {};
  let complete = true;
  for (const account of byAccount.keys()) {
    const cold = coldCount[account] ?? 0;
    if (cold < COLD_PROBES) complete = false;
    const accountItems = measured.filter((item) => item.account === account);
    perAccount[account] = {
      calls: callCount[account] ?? 0,
      cold,
      warm: warmCount[account] ?? 0,
      labelViolations: labelViolations[account] ?? 0,
      incomplete: cold < COLD_PROBES,
      latency: {
        cold: summarizeStages(stageSamples[account]?.cold),
        warm: summarizeStages(stageSamples[account]?.warm),
      },
      metrics: {
        overall: computeRecallMetrics(accountItems),
        perClass: Object.fromEntries(Object.entries(groupBy(accountItems, "className")).map(([name, items]) => [name, computeRecallMetrics(items)])),
      },
    };
  }
  return {
    complete,
    build: healthByAccount[rows[0].account].build,
    builds: Object.fromEntries(Object.entries(healthByAccount).map(([account, health]) => [account, health.build])),
    calls: Object.values(callCount).reduce((sum, value) => sum + value, 0),
    wallClockMs: now() - started,
    perAccount,
    metrics: {
      overall: computeRecallMetrics(measured),
      perClass: Object.fromEntries(Object.entries(groupBy(measured, "className")).map(([name, items]) => [name, computeRecallMetrics(items)])),
    },
    notes: ["Other traffic on the account cannot be controlled and is not part of these samples."],
  };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const queryPath = process.argv[2];
  if (!queryPath) {
    process.stderr.write("usage: node scripts/bench-recall-live.mjs <queries.jsonl>\n");
    process.exit(2);
  }
  try {
    assertQueryPathOutsideRepo(queryPath, repoRoot);
    const rows = readFileSync(queryPath, "utf8").split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
    const report = await runLiveBenchmark({
      rows,
      queryPath,
      fetch: globalThis.fetch,
      sleep: (ms) => new Promise((resolveSleep) => { setTimeout(resolveSleep, ms); }),
      now: () => Date.now(),
      env: process.env,
      repoRoot,
    });
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "live benchmark failed"}\n`);
    process.exit(error instanceof LiveBenchmarkInvalid && /in-repo/.test(error.message) ? 2 : 1);
  }
}
