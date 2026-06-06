#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const arg = process.argv[index];
  if (!arg.startsWith("--")) continue;
  const key = arg.slice(2);
  const next = process.argv[index + 1];
  if (next && !next.startsWith("--")) {
    args.set(key, next);
    index += 1;
  } else {
    args.set(key, "true");
  }
}

const outDir = args.get("out-dir") ?? "benchmarks/results/competitors";
const systems = (args.get("systems") ?? "mem0,zep,letta,pinecone")
  .split(",")
  .map((system) => system.trim().toLowerCase())
  .filter(Boolean);
const emitUnavailable = args.has("emit-unavailable");

const definitions = {
  mem0: {
    system: "Mem0",
    status: "not_reproduced",
    boundary: "direct_memory_api",
    reason_code: "not_run_v1_cost_control",
    reason: "V1 does not spend on competitor API runs. Public claims are shown separately until a reproduced run is authorized.",
    retryable: true,
    credential_env: "MEM0_API_KEY",
  },
  zep: {
    system: "Zep",
    status: "not_reproduced",
    boundary: "turn_extraction_e2e",
    reason_code: "not_run_v1_cost_control",
    reason: "V1 does not spend on competitor API runs. Zep public claims remain separated from reproduced Memory Crystal results.",
    retryable: true,
    credential_env: "ZEP_API_KEY",
  },
  letta: {
    system: "Letta",
    status: "not_reproduced",
    boundary: "agent_memory_runtime",
    reason_code: "not_run_v1_cost_control",
    reason: "V1 does not run paid or hosted competitor agent-memory benchmarks. Letta is an agent-runtime comparison and must be labeled separately.",
    retryable: true,
    credential_env: "LETTA_API_KEY",
  },
  pinecone: {
    system: "Pinecone Assistant",
    status: "not_available",
    boundary: "persistent_memory",
    reason_code: "adjacent_category_no_comparable_public_memory_score",
    reason: "Pinecone Assistant exposes assistant/RAG evaluation APIs, but no comparable public persistent-memory benchmark score is available for this V1 matrix.",
    retryable: false,
    credential_env: "PINECONE_API_KEY",
  },
};

if (!emitUnavailable) {
  console.error("This cheap V1 runner only supports --emit-unavailable. Reproduced adapter runs must be added explicitly before spending on external APIs.");
  process.exit(2);
}

for (const system of systems) {
  const definition = definitions[system];
  if (!definition) {
    console.error(`Unsupported system: ${system}`);
    process.exit(2);
  }
  const path = resolve(repoRoot, outDir, system, "latest.json");
  const artifact = {
    schema_version: 1,
    system: definition.system,
    status: definition.status,
    boundary: definition.boundary,
    run_id: `${system}-unavailable-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}Z`,
    run_at: new Date().toISOString(),
    stage: "competitor_reproduction",
    reason_code: definition.reason_code,
    reason: definition.reason,
    retryable: definition.retryable,
    score: null,
    source_artifact: "benchmarks/results/competitors/public-claims.json",
    redacted_environment: {
      external_network: false,
      credential_env: definition.credential_env,
      credential_present: Boolean(process.env[definition.credential_env]),
      spend_policy: "no_paid_competitor_runs_in_v1",
    },
    caveats: [
      "This is an explicit unavailable/not-reproduced artifact, not a benchmark score.",
      "Public claims for this system remain visible only as sourced public claims.",
    ],
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`Wrote ${path}`);
}
