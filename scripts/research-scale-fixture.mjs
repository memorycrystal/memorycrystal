#!/usr/bin/env node
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

const argv = process.argv.slice(2);
const value = (name, fallback) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : fallback;
};
const has = (name) => argv.includes(name);
const sourceCount = Number(value("--sources", "100000"));
const runCount = Number(value("--runs", "1000000"));
const artifactCount = Number(value("--artifacts", "10000"));
const batchSize = Math.min(Math.max(Number(value("--batch", "100")), 1), 100);
const concurrency = Math.min(Math.max(Number(value("--concurrency", "4")), 1), 16);
const replay = has("--replay");
const confirmScale = has("--confirm-scale");
const apiUrl = (process.env.MEMORY_CRYSTAL_API_URL ?? "http://127.0.0.1:3211").replace(/\/$/, "");
const apiKey = process.env.MEMORY_CRYSTAL_API_KEY ?? "";

if (!apiKey) throw new Error("MEMORY_CRYSTAL_API_KEY is required");
if (!/^https?:\/\/(?:127\.0\.0\.1|localhost)(?::|\/)/.test(apiUrl) && !has("--allow-remote")) {
  throw new Error("Scale fixture is local-only unless --allow-remote is explicitly supplied");
}
if ((sourceCount >= 100_000 || runCount >= 1_000_000 || artifactCount >= 10_000) && !confirmScale) {
  console.log(JSON.stringify({
    ready: true,
    destructive: false,
    target: apiUrl,
    sourceCount,
    runCount,
    artifactCount,
    message: "Re-run with --confirm-scale to load the documented full fixture.",
  }, null, 2));
  process.exit(0);
}

async function request(path, init = {}, attempt = 0) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : null;
  const transient = response.status === 429 || response.status === 503
    || /too many writes per second|changed while this mutation was being run/i.test(parsed?.error ?? text);
  if (!response.ok && transient && attempt < 8) {
    const retryAfter = Number(response.headers.get("retry-after"));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(100 * (2 ** attempt), 2_000) + Math.floor(Math.random() * 100);
    await new Promise((resolve) => setTimeout(resolve, delay));
    return request(path, init, attempt + 1);
  }
  if (!response.ok) throw new Error(`${path} failed (${response.status}): ${parsed?.error ?? text}`);
  return parsed;
}

const post = (path, payload) => request(path, { method: "POST", body: JSON.stringify(payload) });
const hash = (value) => createHash("sha256").update(value).digest("hex");
const p95 = (values) => values.slice().sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * 0.95) - 1)] ?? 0;

const collection = await post("/api/research/collections", {
  name: `Scale fixture ${new Date().toISOString()}`,
  domain: "trading_strategy",
  description: "Synthetic MoonDev-style reference workload. Not research evidence.",
  retentionPolicy: "scale_fixture",
});
const collectionId = collection.collectionId;

function sourceRecord(index) {
  const key = `scale-source:${index}`;
  return {
    stableKey: key,
    idempotencyKey: key,
    sourceType: "repository_file",
    host: "fixture.invalid",
    canonicalUrl: `https://fixture.invalid/strategy/${index}`,
    repositoryOwner: "fixture",
    repositoryName: "moondev-reference",
    immutableVersion: "fixture-v1",
    filePath: `strategies/${index}.md`,
    retrievedAt: 1_750_000_000_000 + index,
    contentHash: hash(key),
    licenseId: "MIT",
    licenseDisposition: "acceptable",
    securityDisposition: "clean",
    quarantineState: "released",
    parserVersion: "scale-fixture-v1",
  };
}

const firstSource = await post("/api/research/sources", { collectionId, source: sourceRecord(0) });
const item = await post("/api/research/items", {
  collectionId,
  item: {
    stableKey: "scale-item:0",
    idempotencyKey: "scale-item:0",
    itemType: "trading_strategy",
    contentHash: hash("scale-item:0"),
    ruleHash: hash("scale-rule:0"),
    normalizedRuleJson: JSON.stringify({ version: 1, entry: { indicator: "sma", operator: "crosses_above" }, exit: { operator: "crosses_below" } }),
    strategyCard: "Synthetic SMA crossover scale-fixture strategy. Informational test data only.",
    sourceIds: [firstSource.sourceId],
    indicators: ["sma"], entries: ["crosses_above"], exits: ["crosses_below"], riskControls: ["fixed_fraction"],
    directions: ["long"], markets: ["crypto"], assets: ["BTC-USD"], timeframes: ["1h"],
    causalTimestampPolicy: "bar_close_only", parserVersion: "scale-fixture-v1", reviewStatus: "qualified", securityStatus: "clean",
  },
});
const semanticVector = Array.from({ length: 3072 }, (_, index) => ((index % 97) + 1) / 100);
await post("/api/research/items/embedding", {
  collectionId,
  itemId: item.itemId,
  contentHash: hash("scale-item:0"),
  model: "scale-fixture-embedding-v1",
  embedding: semanticVector,
});
const variant = await post("/api/research/variants", {
  collectionId,
  variant: {
    stableKey: "scale-variant:0", idempotencyKey: "scale-variant:0", itemId: item.itemId,
    parameterJson: JSON.stringify({ fast: 20, slow: 50 }), parameterHash: hash("20:50"),
    market: "crypto", venue: "fixture", symbol: "BTC-USD", timeframe: "1h", direction: "long",
    executionAssumptionsJson: JSON.stringify({ feeBps: 10, slippageBps: 5 }), variantHash: hash("scale-variant:0"),
  },
});
const dataset = await post("/api/research/datasets", {
  collectionId,
  dataset: {
    stableKey: "scale-dataset:0", idempotencyKey: "scale-dataset:0", provider: "fixture", venue: "fixture",
    symbols: ["BTC-USD"], resolution: "1h", startTimestamp: 1_600_000_000_000, endTimestamp: 1_750_000_000_000,
    retrievedAt: 1_750_000_000_001, checksum: hash("scale-dataset:0"), adjustmentPolicy: "none",
    missingDataPolicy: "reject_gap", timezonePolicy: "UTC", causalityStatus: "valid",
  },
});

const sourceStart = performance.now();
for (let offset = 1; offset < sourceCount; offset += batchSize) {
  const sources = Array.from({ length: Math.min(batchSize, sourceCount - offset) }, (_, index) => sourceRecord(offset + index));
  await post("/api/research/sources/bulk", { collectionId, sources });
}
const sourceSeconds = (performance.now() - sourceStart) / 1000;

const artifactPayload = new TextEncoder().encode("representative compressed artifact fixture\n");
for (let index = 0; index < artifactCount; index += 1) {
  const stableKey = `scale-artifact:${index}`;
  const upload = await post("/api/research/artifacts/upload-url", { collectionId, expectedBytes: artifactPayload.byteLength });
  const uploaded = await fetch(upload.uploadUrl, { method: "POST", headers: { "content-type": "application/gzip" }, body: artifactPayload });
  if (!uploaded.ok) throw new Error(`Artifact upload ${index} failed (${uploaded.status})`);
  const { storageId } = await uploaded.json();
  await post("/api/research/artifacts/register", {
    collectionId, stableKey, idempotencyKey: stableKey, artifactType: "compressed_report", storageId,
    checksum: hash(Buffer.from(artifactPayload)), mimeType: "application/gzip", compressedBytes: artifactPayload.byteLength,
    uncompressedBytes: artifactPayload.byteLength, status: "accepted",
  });
}

function runRecord(index) {
  const runSpecHash = hash(`scale-run:${index}`);
  const score = (index % 1000) / 1000;
  return {
    itemId: item.itemId, variantId: variant.variantId, datasetId: dataset.datasetId,
    runSpecHash, idempotencyKey: runSpecHash, engineVersion: "scale-fixture-engine-v1", codeVersion: "fixture-v1",
    fold: String(index % 10), seed: index, splitJson: JSON.stringify({ method: "walk_forward", fold: index % 10 }),
    costAssumptionsJson: JSON.stringify({ feeBps: 10, spreadBps: 2, slippageBps: 5, latencyMs: 100 }),
    startedAt: 1_750_000_000_000 + index, completedAt: 1_750_000_000_100 + index, status: "completed",
    netReturn: score / 10, sharpe: score * 3, maxDrawdown: -score / 2, winRate: 0.4 + score / 5,
    tradeCount: 100 + (index % 500), rankingScore: score, robustnessScore: 1 - Math.abs(0.5 - score),
    metricsJson: JSON.stringify({ profitFactor: 1 + score, turnover: index % 100 }), artifactIds: [],
  };
}

async function loadRuns(expectDuplicates) {
  let inserted = 0;
  let duplicates = 0;
  const recallLatencies = [];
  const started = performance.now();
  const offsets = Array.from({ length: Math.ceil(runCount / batchSize) }, (_, index) => index * batchSize);
  let nextBatch = 0;
  const worker = async () => {
    while (true) {
      const batchIndex = nextBatch;
      nextBatch += 1;
      if (batchIndex >= offsets.length) return;
      const offset = offsets[batchIndex];
      const runs = Array.from({ length: Math.min(batchSize, runCount - offset) }, (_, index) => runRecord(offset + index));
      const response = await post("/api/research/runs/bulk", { collectionId, runs });
      inserted += response.inserted;
      duplicates += response.duplicate;
      if (batchIndex % 100 === 0) {
        const recallStarted = performance.now();
        await post("/api/mcp/recall", { query: "scale fixture recall canary", limit: 3 });
        recallLatencies.push(performance.now() - recallStarted);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, offsets.length) }, () => worker()));
  const seconds = (performance.now() - started) / 1000;
  if (expectDuplicates && inserted !== 0) throw new Error(`Replay inserted ${inserted} duplicate runs`);
  return { inserted, duplicates, seconds, rowsPerSecond: runCount / seconds, recallP95Ms: p95(recallLatencies) };
}

const primary = await loadRuns(false);
if (primary.rowsPerSecond < 500) throw new Error(`Experiment throughput gate failed: ${primary.rowsPerSecond.toFixed(1)} rows/s < 500 rows/s`);
const replayResult = replay ? await loadRuns(true) : null;

const queryLatencies = [];
for (let index = 0; index < 30; index += 1) {
  const started = performance.now();
  await post("/api/research/query", { collectionId, kind: "runs", status: "completed", limit: 25 });
  queryLatencies.push(performance.now() - started);
}
const queryP95Ms = p95(queryLatencies);
if (queryP95Ms >= 750) throw new Error(`Indexed query p95 gate failed: ${queryP95Ms.toFixed(1)}ms >= 750ms`);

const semanticLatencies = [];
for (let index = 0; index < 30; index += 1) {
  const started = performance.now();
  await post("/api/research/query", {
    collectionId, kind: "semantic", embedding: semanticVector, model: "scale-fixture-embedding-v1", limit: 10,
  });
  semanticLatencies.push(performance.now() - started);
}
const semanticP95Ms = p95(semanticLatencies);
if (semanticP95Ms >= 1500) throw new Error(`Semantic query p95 gate failed: ${semanticP95Ms.toFixed(1)}ms >= 1500ms`);

const stats = await request(`/api/research/collections/${collectionId}/stats`);
if (stats.totals.sources !== sourceCount || stats.totals.runs !== runCount || stats.totals.artifacts !== artifactCount) {
  throw new Error(`Exact count gate failed: ${JSON.stringify(stats.totals)}`);
}

console.log(JSON.stringify({
  collectionId,
  expected: { sources: sourceCount, runs: runCount, artifacts: artifactCount },
  exact: stats.totals,
  sourceRowsPerSecond: sourceCount / sourceSeconds,
  experiment: primary,
  concurrency,
  replay: replayResult,
  indexedQueryP95Ms: queryP95Ms,
  semanticQueryP95Ms: semanticP95Ms,
  passed: true,
}, null, 2));
