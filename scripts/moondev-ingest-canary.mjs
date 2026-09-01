#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

const home = process.env.MEMORY_CRYSTAL_HOME || join(process.env.HOME || "", ".memorycrystal");
const ingestHandoff = JSON.parse(readFileSync(process.env.MOONDEV_RESEARCH_HANDOFF_FILE || join(home, "handoffs", "moondev-research-ingest.json"), "utf8"));
const readHandoff = JSON.parse(readFileSync(process.env.GERALD_RESEARCH_HANDOFF_FILE || join(home, "handoffs", "gerald-research-read.json"), "utf8"));
const base = String(ingestHandoff.apiUrl).replace(/\/$/, "");
const collectionId = ingestHandoff.immutableScope.collectionIds[0];
if (collectionId !== readHandoff.immutableScope.collectionIds[0]) throw new Error("MoonDev and Gerald credentials target different collections");
const nonce = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const workerId = `moondev-canary-${nonce}`;
const checks = [];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const headersFor = (credential, body) => ({ authorization: `Bearer ${credential}`, ...(body === undefined ? {} : { "content-type": "application/json" }) });

async function request(name, credential, path, { method = "GET", body, expected = [200], redirect = "follow" } = {}) {
  const started = performance.now();
  const response = await fetch(`${base}${path}`, { method, headers: headersFor(credential, body), body: body === undefined ? undefined : JSON.stringify(body), redirect });
  const text = await response.text();
  let parsed = text;
  try { parsed = text ? JSON.parse(text) : null; } catch {}
  if (!expected.includes(response.status)) throw new Error(`${name}: expected ${expected.join("/")}, got ${response.status}: ${text.slice(0, 400)}`);
  checks.push({ name, status: response.status, ms: Math.round(performance.now() - started) });
  return { body: parsed, headers: response.headers };
}
const ingest = (name, path, body, expected = [200, 201]) => request(name, ingestHandoff.credential, path, { method: "POST", body, expected });
const read = (name, path, options) => request(name, readHandoff.credential, path, options);

const job = await ingest("create deterministic job", "/api/research/jobs", {
  collectionId, jobType: "moondev-credential-canary", idempotencyKey: `moondev-canary-job:${nonce}`,
  manifest: { schemaVersion: 1, nonce, recordTypes: ["source", "item", "variant", "dataset", "run"] }, totalCount: 5,
}, [201]);
const shard = await ingest("create deterministic shard", `/api/research/jobs/${job.body.jobId}/shards`, {
  shardKey: "000000", ordinal: 0, totalCount: 5, maxAttempts: 3,
}, [201]);
const claimed = await ingest("claim shard lease", `/api/research/jobs/${job.body.jobId}/claim`, { workerId, leaseMs: 120_000 });
if (claimed.body._id !== shard.body.shardId || claimed.body.leaseOwner !== workerId) throw new Error("Claim did not return the deterministic shard lease");
await ingest("heartbeat shard lease", `/api/research/shards/${shard.body.shardId}/heartbeat`, { workerId, progressCount: 0, cursor: "begin", leaseMs: 120_000 });

async function ingestRecord(recordType, payload) {
  const idempotencyKey = payload.idempotencyKey;
  const first = await ingest(`ingest ${recordType}`, `/api/research/shards/${shard.body.shardId}/ingest`, { workerId, recordType, idempotencyKey, payload }, [201]);
  const replay = await ingest(`replay ${recordType}`, `/api/research/shards/${shard.body.shardId}/ingest`, { workerId, recordType, idempotencyKey, payload }, [200]);
  if (first.body.status !== "imported" || replay.body.replay !== true || replay.body.resultingEntityId !== first.body.resultingEntityId) {
    throw new Error(`${recordType} replay was not a zero-insert replay`);
  }
  return first.body.resultingEntityId;
}

const sourcePayload = {
  stableKey: `moondev:source:${nonce}`, idempotencyKey: `moondev:source:${nonce}`, sourceType: "repository_file",
  host: "moondev.local", canonicalUrl: `https://moondev.local/canary/${nonce}/strategy.py`, repositoryOwner: "moondev",
  repositoryName: "credential-canary", immutableVersion: hash(`commit:${nonce}`), filePath: "strategies/canary.py",
  retrievedAt: Date.now(), contentHash: hash(`source:${nonce}`), contentSample: "SMA crossover research fixture; never execute downloaded source code.",
  licenseId: "MIT", licenseDisposition: "acceptable", securityDisposition: "clean", quarantineState: "released", parserVersion: "moondev-canary-v1",
};
const sourceId = await ingestRecord("source", sourcePayload);
const itemPayload = {
  stableKey: `moondev:item:${nonce}`, idempotencyKey: `moondev:item:${nonce}`, itemType: "trading_strategy",
  contentHash: hash(`item:${nonce}`), ruleHash: hash(`rule:${nonce}`), normalizedRuleJson: JSON.stringify({ entry: "fast_sma crosses above slow_sma", exit: "inverse crossover" }),
  strategyCard: `MoonDev credential canary ${nonce}: deterministic SMA crossover.`, sourceIds: [sourceId], indicators: ["SMA"], entries: ["cross above"], exits: ["cross below"],
  riskControls: ["fixed fractional"], directions: ["long"], markets: ["crypto"], assets: ["BTC-USD"], timeframes: ["1h"],
  causalTimestampPolicy: "bar_close_only", parserVersion: "moondev-canary-v1", reviewStatus: "qualified", securityStatus: "clean",
};
const itemId = await ingestRecord("item", itemPayload);
const variantPayload = {
  stableKey: `moondev:variant:${nonce}`, idempotencyKey: `moondev:variant:${nonce}`, itemId,
  parameterJson: JSON.stringify({ fast: 20, slow: 50 }), parameterHash: hash(`params:${nonce}`), market: "crypto", venue: "canary",
  symbol: "BTC-USD", timeframe: "1h", direction: "long", executionAssumptionsJson: JSON.stringify({ feeBps: 10, slippageBps: 5 }), variantHash: hash(`variant:${nonce}`),
};
const variantId = await ingestRecord("variant", variantPayload);
const datasetPayload = {
  stableKey: `moondev:dataset:${nonce}`, idempotencyKey: `moondev:dataset:${nonce}`, provider: "canary", venue: "canary", symbols: ["BTC-USD"], resolution: "1h",
  startTimestamp: 1_700_000_000_000, endTimestamp: 1_710_000_000_000, retrievedAt: Date.now(), checksum: hash(`dataset:${nonce}`),
  adjustmentPolicy: "none", missingDataPolicy: "reject_gap", timezonePolicy: "UTC", causalityStatus: "valid",
};
const datasetId = await ingestRecord("dataset", datasetPayload);
const runPayload = {
  itemId, variantId, datasetId, runSpecHash: hash(`run:${nonce}`), idempotencyKey: `moondev:run:${nonce}`,
  engineVersion: "moondev-canary-v1", codeVersion: "credential-canary", fold: "0", seed: 42,
  splitJson: JSON.stringify({ method: "walk_forward", fold: 0 }), costAssumptionsJson: JSON.stringify({ feeBps: 10, slippageBps: 5 }),
  startedAt: Date.now() - 1000, completedAt: Date.now(), status: "completed", netReturn: 0.12, sharpe: 1.7,
  maxDrawdown: -0.08, winRate: 0.55, tradeCount: 120, rankingScore: 0.82, robustnessScore: 0.78,
  metricsJson: JSON.stringify({ profitFactor: 1.4 }), artifactIds: [],
};
const runId = await ingestRecord("run", runPayload);

const expanded = Buffer.from(`MoonDev accepted artifact ${nonce}\n`.repeat(20));
const compressed = gzipSync(expanded);
const reservation = await ingest("reserve artifact upload", "/api/research/artifacts/upload-url", {
  collectionId, sourceId, stableKey: `moondev:artifact:${nonce}`, idempotencyKey: `moondev:artifact:${nonce}`,
  artifactType: "backtest_report", expectedBytes: compressed.byteLength, checksum: hash(compressed), mimeType: "application/gzip",
  uncompressedBytes: expanded.byteLength, compressionType: "gzip",
});
const uploaded = await fetch(reservation.body.uploadUrl, { method: "POST", headers: { "content-type": "application/gzip" }, body: compressed });
if (!uploaded.ok) throw new Error(`artifact upload failed: ${uploaded.status}`);
const registered = await ingest("server-verify accepted artifact", "/api/research/artifacts/register", {
  artifactId: reservation.body.artifactId, storageId: (await uploaded.json()).storageId,
}, [201]);
if (registered.body.status !== "accepted") throw new Error(`valid gzip artifact was not accepted: ${JSON.stringify(registered.body)}`);

await ingest("complete shard from server counts", `/api/research/shards/${shard.body.shardId}/complete`, { workerId });

const items = await read("Gerald reads ingested item", "/api/research/query", { method: "POST", body: { kind: "items", collectionId, asset: "BTC-USD", timeframe: "1h", limit: 10 } });
const runs = await read("Gerald reads ingested run", "/api/research/query", { method: "POST", body: { kind: "runs", collectionId, itemId, minSharpe: 1.5, minTradeCount: 100, limit: 10 } });
const jobs = await read("Gerald reads completed job", `/api/research/collections/${collectionId}/jobs?status=completed&limit=10`);
const trace = await read("Gerald reads finalist trace", `/api/research/trace?runId=${runId}`);
const artifactRead = await read("Gerald reads accepted artifact", `/api/research/artifacts/${reservation.body.artifactId}/read`, { redirect: "manual", expected: [307] });
if (!items.body.items.some((row) => row._id === itemId)) throw new Error("Gerald item readback missing canary item");
if (!runs.body.runs.some((row) => row._id === runId)) throw new Error("Gerald run readback missing canary run");
if (!jobs.body.jobs.some((row) => row._id === job.body.jobId && row.importedCount === 5 && row.duplicateCount === 0)) throw new Error("Gerald job readback lacks server-derived counts");
if (trace.body.run._id !== runId || trace.body.item._id !== itemId || !trace.body.sources.some((row) => row._id === sourceId)) throw new Error("Gerald trace lineage is incomplete");
if (!artifactRead.headers.get("location")) throw new Error("Accepted artifact read did not return a download location");

for (const [name, path, body] of [
  ["archive denied", `/api/research/collections/${collectionId}/archive`, { archived: true }],
  ["restore denied", `/api/research/collections/${collectionId}/restore`, { entity: "sources", records: [] }],
  ["promotion denied", "/api/research/promote", { collectionId, itemId, runId, datasetId }],
  ["demotion denied", "/api/research/demote", { collectionId, promotionId: runId }],
]) await ingest(name, path, body, [403]);

const reportPath = process.env.MOONDEV_CANARY_REPORT || join(home, "reports", `moondev-ingest-canary-${Date.now()}.json`);
mkdirSync(dirname(reportPath), { recursive: true, mode: 0o700 });
const report = {
  schemaVersion: 1, status: "passed", createdAt: new Date().toISOString(), collectionId,
  jobId: job.body.jobId, shardId: shard.body.shardId, entities: { sourceId, itemId, variantId, datasetId, runId, artifactId: reservation.body.artifactId },
  serverDerivedCounts: { imported: 5, duplicatesInsertedOnReplay: 0 }, checks,
};
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`MoonDev ingest credential canary passed ${checks.length} checks: ${reportPath}\n`);
