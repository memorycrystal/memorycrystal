#!/usr/bin/env node

import { readFileSync } from "node:fs";

const DEFAULT_THRESHOLDS = {
  maxVectorQueryBytes: Number(
    process.env.MC_COST_SMOKE_MAX_VECTOR_QUERY_BYTES ?? 5 * 1024 * 1024 * 1024,
  ),
  maxTextQueryBytes: Number(
    process.env.MC_COST_SMOKE_MAX_TEXT_QUERY_BYTES ?? 1024 * 1024 * 1024,
  ),
  maxDbReadBytes: Number(
    process.env.MC_COST_SMOKE_MAX_DB_READ_BYTES ?? 50 * 1024 * 1024,
  ),
  maxOccRetries: Number(process.env.MC_COST_SMOKE_MAX_OCC_RETRIES ?? 100),
};

function readInput() {
  const path = process.argv[2];
  if (path) return readFileSync(path, "utf8");
  return readFileSync(0, "utf8");
}

function add(map, key, delta) {
  map.set(key, (map.get(key) ?? 0) + (Number(delta) || 0));
}

function topEntries(map, limit = 10) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

const counts = new Map();
const dbReadBytes = new Map();
const dbWriteBytes = new Map();
const vectorQueryBytes = new Map();
const textQueryBytes = new Map();
const occRetries = new Map();
const errors = [];

for (const rawLine of readInput().split(/\r?\n/)) {
  const line = rawLine.trim();
  if (!line.startsWith("{")) continue;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    continue;
  }
  if (entry.kind !== "Completion") continue;
  const identifier = entry.identifier ?? "<unknown>";
  const usage = entry.usageStats ?? {};
  add(counts, identifier, 1);
  add(
    dbReadBytes,
    identifier,
    usage.databaseReadBytes ?? usage.databaseIoReadBytes ?? 0,
  );
  add(
    dbWriteBytes,
    identifier,
    usage.databaseWriteBytes ?? usage.databaseIoWriteBytes ?? 0,
  );
  add(vectorQueryBytes, identifier, usage.vectorIndexReadQueryBytes ?? 0);
  add(textQueryBytes, identifier, usage.textIndexQueryBytes ?? 0);
  if (entry.occInfo && entry.willRetry) add(occRetries, identifier, 1);
  if (entry.error) errors.push({ identifier, error: entry.error });
}

const totals = {
  vectorQueryBytes: [...vectorQueryBytes.values()].reduce(
    (sum, value) => sum + value,
    0,
  ),
  textQueryBytes: [...textQueryBytes.values()].reduce(
    (sum, value) => sum + value,
    0,
  ),
  dbReadBytes: [...dbReadBytes.values()].reduce((sum, value) => sum + value, 0),
  occRetries: [...occRetries.values()].reduce((sum, value) => sum + value, 0),
  errors: errors.length,
};

const failures = [];
if (totals.vectorQueryBytes > DEFAULT_THRESHOLDS.maxVectorQueryBytes) {
  failures.push(
    `vector query bytes ${totals.vectorQueryBytes} > ${DEFAULT_THRESHOLDS.maxVectorQueryBytes}`,
  );
}
if (totals.textQueryBytes > DEFAULT_THRESHOLDS.maxTextQueryBytes) {
  failures.push(
    `text query bytes ${totals.textQueryBytes} > ${DEFAULT_THRESHOLDS.maxTextQueryBytes}`,
  );
}
if (totals.dbReadBytes > DEFAULT_THRESHOLDS.maxDbReadBytes) {
  failures.push(
    `DB read bytes ${totals.dbReadBytes} > ${DEFAULT_THRESHOLDS.maxDbReadBytes}`,
  );
}
if (totals.occRetries > DEFAULT_THRESHOLDS.maxOccRetries) {
  failures.push(
    `OCC retries ${totals.occRetries} > ${DEFAULT_THRESHOLDS.maxOccRetries}`,
  );
}

const report = {
  status: failures.length ? "fail" : "pass",
  thresholds: DEFAULT_THRESHOLDS,
  totals,
  topCounts: topEntries(counts),
  topDbReadBytes: topEntries(dbReadBytes),
  topDbWriteBytes: topEntries(dbWriteBytes),
  topVectorQueryBytes: topEntries(vectorQueryBytes),
  topTextQueryBytes: topEntries(textQueryBytes),
  topOccRetries: topEntries(occRetries),
  failures,
};

console.log(JSON.stringify(report, null, 2));
if (failures.length) process.exit(1);
