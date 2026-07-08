#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const errors = [];

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(resolve(repoRoot, path), "utf8"));
  } catch (error) {
    errors.push(`${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
    return null;
  }
};

const requireField = (artifact, path, field) => {
  if (artifact?.[field] === undefined || artifact?.[field] === null || artifact?.[field] === "") {
    errors.push(`${path}: missing ${field}`);
  }
};

const secretPatterns = [
  /sk-[A-Za-z0-9_-]{20,}/,
  /mc_[A-Za-z0-9_-]{20,}/,
  /Bearer\s+[A-Za-z0-9._-]{20,}/i,
  /api[_-]?key["']?\s*[:=]\s*["'][A-Za-z0-9._-]{16,}/i,
];

const assertNoSecrets = (path) => {
  const text = readFileSync(resolve(repoRoot, path), "utf8");
  for (const pattern of secretPatterns) {
    if (pattern.test(text)) errors.push(`${path}: contains secret-looking text`);
  }
};

const scoreStatuses = new Set(["verified_reproduced", "unsafe"]);
const unavailableStatuses = new Set(["not_available", "not_reproduced", "blocked_terms", "blocked_credentials"]);
const allowedStatuses = new Set([...scoreStatuses, ...unavailableStatuses, "public_claim", "cheap_v1_verified_partial"]);

const validateResultArtifact = (path) => {
  const artifact = readJson(path);
  if (!artifact) return;
  assertNoSecrets(path);
  for (const field of ["schema_version", "system", "status", "boundary", "run_id", "run_at"]) {
    requireField(artifact, path, field);
  }
  if (!allowedStatuses.has(artifact.status)) {
    errors.push(`${path}: unsupported status ${artifact.status}`);
  }
  if (scoreStatuses.has(artifact.status)) {
    requireField(artifact, path, "score");
    requireField(artifact, path, "source_artifact");
  }
  if (unavailableStatuses.has(artifact.status)) {
    for (const field of ["reason_code", "reason", "retryable", "source_artifact"]) {
      requireField(artifact, path, field);
    }
  }
};

const validatePublicClaims = () => {
  const path = "benchmarks/results/competitors/public-claims.json";
  const artifact = readJson(path);
  if (!artifact) return;
  assertNoSecrets(path);
  requireField(artifact, path, "schema_version");
  requireField(artifact, path, "researched_at");
  if (!Array.isArray(artifact.claims)) {
    errors.push(`${path}: claims must be an array`);
    return;
  }
  for (const [index, claim] of artifact.claims.entries()) {
    for (const field of ["system", "status", "claim", "benchmark", "value", "source_url", "source_accessed_at", "notes"]) {
      requireField(claim, `${path}#claims[${index}]`, field);
    }
    if (claim.status !== "public_claim") {
      errors.push(`${path}#claims[${index}]: status must be public_claim`);
    }
  }
};

const resultFiles = [
  "benchmarks/results/memory-crystal/latest.json",
  "benchmarks/results/memory-crystal/latency-cost-latest.json",
  "benchmarks/results/memory-crystal/hosted-direct-latest.json",
  "benchmarks/results/memory-crystal/hosted-turn-e2e-latest.json",
  "benchmarks/results/memory-crystal/hosted-recall-latest.json",
];

for (const file of resultFiles) {
  if (existsSync(resolve(repoRoot, file))) validateResultArtifact(file);
}

const competitorRoot = resolve(repoRoot, "benchmarks/results/competitors");
if (existsSync(competitorRoot)) {
  for (const entry of readdirSync(competitorRoot, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const latest = join("benchmarks/results/competitors", entry.name, "latest.json");
      if (existsSync(resolve(repoRoot, latest))) validateResultArtifact(latest);
    }
  }
}

validatePublicClaims();

if (args.has("--matrix")) {
  for (const system of ["mem0", "zep", "letta", "pinecone"]) {
    const latest = `benchmarks/results/competitors/${system}/latest.json`;
    if (!existsSync(resolve(repoRoot, latest))) errors.push(`${latest}: missing competitor matrix artifact`);
  }
}

if (errors.length > 0) {
  console.error(errors.map((error) => `- ${error}`).join("\n"));
  process.exit(1);
}

console.log("Benchmark artifacts validated");
