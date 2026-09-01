#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const home = process.env.MEMORY_CRYSTAL_HOME || join(process.env.HOME || "", ".memorycrystal");
const handoffPath = process.env.GERALD_RESEARCH_HANDOFF_FILE || join(home, "handoffs", "gerald-research-read.json");
const handoff = JSON.parse(readFileSync(handoffPath, "utf8"));
const base = String(handoff.apiUrl).replace(/\/$/, "");
const collectionId = handoff.immutableScope.collectionIds[0];
const headers = { authorization: `Bearer ${handoff.credential}` };
const checks = [];

async function check(name, method, path, body, expected) {
  const started = performance.now();
  const response = await fetch(`${base}${path}`, {
    method, headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: "manual",
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  if (!expected.includes(response.status)) throw new Error(`${name}: expected ${expected.join("/")}, got ${response.status}: ${text.slice(0, 300)}`);
  checks.push({ name, status: response.status, ms: Math.round(performance.now() - started) });
  return parsed;
}

const listed = await check("bound collection list", "GET", "/api/research/collections?limit=100", undefined, [200]);
if (listed.collections.length !== 1 || listed.collections[0]._id !== collectionId || listed.nextCursor !== null) {
  throw new Error("Gerald list escaped its single collection or omitted terminal nextCursor");
}
for (const [name, path] of [
  ["stats", `/api/research/collections/${collectionId}/stats`],
  ["jobs", `/api/research/collections/${collectionId}/jobs?limit=10`],
  ["rollups", `/api/research/collections/${collectionId}/rollups?limit=10`],
  ["promotions", `/api/research/collections/${collectionId}/promotions?limit=10`],
]) await check(`read ${name}`, "GET", path, undefined, [200]);
await check("item filters", "POST", "/api/research/query", { kind: "items", collectionId, market: "crypto", asset: "BTC", timeframe: "1h", limit: 10 }, [200]);
await check("run filters", "POST", "/api/research/query", { kind: "runs", collectionId, minSharpe: 1, maxDrawdown: 25, minTradeCount: 10, sortBy: "rankingScore", limit: 10 }, [200]);
await check("explicit agent scope expansion denied", "GET", "/api/research/collections?agentId=not-gerald", undefined, [403]);
const unsupported = await check("unsupported filter rejected", "GET", "/api/research/collections?madeUpFilter=yes", undefined, [400]);
if (unsupported.code !== "research_unsupported_filter" || unsupported.schemaVersion !== "research.v1" || !unsupported.requestId) {
  throw new Error("Stable unsupported-filter error contract missing");
}

const localAuth = JSON.parse(readFileSync(join(home, "local-auth.json"), "utf8"));
const adminResponse = await fetch(`${base}/api/research/collections?limit=100`, { headers: { authorization: `Bearer ${localAuth.localToken}` } });
const adminCollections = (await adminResponse.json()).collections || [];
const other = adminCollections.find((row) => row._id !== collectionId);
if (other) await check("other collection denied", "GET", `/api/research/collections/${other._id}/stats`, undefined, [403]);

for (const [name, path, body] of [
  ["source ingest", "/api/research/sources", { collectionId, source: {} }],
  ["artifact upload", "/api/research/artifacts/upload-url", { collectionId }],
  ["job create", "/api/research/jobs", { collectionId }],
  ["collection archive", `/api/research/collections/${collectionId}/archive`, { archived: true }],
  ["collection restore", `/api/research/collections/${collectionId}/restore`, { entity: "sources", records: [] }],
  ["promotion", "/api/research/promote", { collectionId }],
  ["demotion", "/api/research/demote", { collectionId }],
  ["memory write", "/api/research/memory", { collectionId }],
]) await check(`${name} denied`, "POST", path, body, [403]);

const reportPath = process.env.GERALD_CONTRACT_REPORT || join(home, "reports", `gerald-read-contract-${Date.now()}.json`);
mkdirSync(dirname(reportPath), { recursive: true, mode: 0o700 });
writeFileSync(reportPath, `${JSON.stringify({ schemaVersion: 1, status: "passed", createdAt: new Date().toISOString(), collectionId, checks }, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`Gerald read-only contract passed ${checks.length} checks: ${reportPath}\n`);
