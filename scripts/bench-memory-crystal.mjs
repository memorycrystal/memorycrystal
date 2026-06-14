#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultFixture = resolve(repoRoot, "benchmarks/memory/fixtures.json");
const defaultOut = resolve(repoRoot, `.crystal/benchmarks/${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}Z/memory-crystal.json`);

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

const boundary = args.get("boundary") ?? "retrieval_seeded";
const fixturePath = resolve(repoRoot, args.get("fixture") ?? defaultFixture);
const outPath = resolve(repoRoot, args.get("out") ?? defaultOut);
const apiUrl = args.get("api-url")?.replace(/\/$/, "");
const apiKeyEnv = args.get("api-key-env") ?? "MEMORY_CRYSTAL_API_KEY";
const apiKey = process.env[apiKeyEnv];
const runId = `mc-${boundary}-${new Date().toISOString().replace(/[-:.]/g, "").slice(0, 15)}Z`;

const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

const gitCommit = () => {
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout.trim() : "unknown";
};

const checksumFile = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const normalize = (value) => String(value ?? "").toLowerCase().replace(/\s+/g, " ").trim();
const percentile = (values, percentileValue) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((percentileValue / 100) * sorted.length) - 1);
  return sorted[index];
};

const redactKey = (key) => {
  if (!key) return null;
  if (key.length <= 8) return "***";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
};

const trackWeights = {
  locomo_style: 25,
  fact_recall: 15,
  preference_recall: 15,
  contradiction: 15,
  scope_privacy: 15,
  latency_cost: 15,
};

const scoreCase = ({ benchmarkCase, returnedMemoryIds, returnedText, latencyMs }) => {
  const normalizedText = normalize(returnedText);
  const missingExpected = benchmarkCase.expected.filter((expected) => !normalizedText.includes(normalize(expected)));
  const leakedForbiddenText = (benchmarkCase.forbidden ?? []).filter((forbidden) => normalizedText.includes(normalize(forbidden)));
  const leakedForbiddenIds = (benchmarkCase.forbiddenMemoryIds ?? []).filter((id) => returnedMemoryIds.includes(id));
  const leakedForbidden = [...leakedForbiddenText, ...leakedForbiddenIds];
  const expectedIdsFound = benchmarkCase.expectedMemoryIds.every((id) => returnedMemoryIds.includes(id));
  const correct = missingExpected.length === 0 && expectedIdsFound && leakedForbidden.length === 0;

  return {
    id: benchmarkCase.id,
    track: benchmarkCase.track,
    correct,
    leak: leakedForbidden.length > 0,
    recallAt1: benchmarkCase.expectedMemoryIds.includes(returnedMemoryIds[0] ?? ""),
    recallAt3: returnedMemoryIds.slice(0, 3).some((id) => benchmarkCase.expectedMemoryIds.includes(id)),
    recallAt5: returnedMemoryIds.slice(0, 5).some((id) => benchmarkCase.expectedMemoryIds.includes(id)),
    latencyMs: Number(latencyMs.toFixed(2)),
    expectedMemoryIds: benchmarkCase.expectedMemoryIds,
    returnedMemoryIds,
    missingExpected,
    leakedForbidden,
  };
};

const summarize = (caseResults) => {
  const total = caseResults.length;
  const correct = caseResults.filter((result) => result.correct).length;
  const forbiddenLeaks = caseResults.filter((result) => result.leak).length;
  const tracks = Object.keys(trackWeights).map((track) => {
    const trackResults = caseResults.filter((result) => result.track === track);
    const trackCorrect = trackResults.filter((result) => result.correct).length;
    const trackLeaks = trackResults.filter((result) => result.leak).length;
    const accuracy = trackResults.length === 0 ? 0 : trackCorrect / trackResults.length;
    return {
      track,
      weight: trackWeights[track],
      correct: trackCorrect,
      total: trackResults.length,
      accuracy: Number(accuracy.toFixed(4)),
      forbidden_leaks: trackLeaks,
      score: track === "scope_privacy" && trackLeaks > 0
        ? 0
        : Number((trackWeights[track] * accuracy).toFixed(2)),
    };
  });
  return {
    score: Number(tracks.reduce((sum, track) => sum + track.score, 0).toFixed(2)),
    correct,
    total,
    accuracy: total === 0 ? 0 : Number((correct / total).toFixed(4)),
    recall_at_1: total === 0 ? 0 : Number((caseResults.filter((result) => result.recallAt1).length / total).toFixed(4)),
    recall_at_3: total === 0 ? 0 : Number((caseResults.filter((result) => result.recallAt3).length / total).toFixed(4)),
    recall_at_5: total === 0 ? 0 : Number((caseResults.filter((result) => result.recallAt5).length / total).toFixed(4)),
    forbidden_leaks: forbiddenLeaks,
    p50_ms: Number(percentile(caseResults.map((result) => result.latencyMs), 50).toFixed(2)),
    p95_ms: Number(percentile(caseResults.map((result) => result.latencyMs), 95).toFixed(2)),
    tracks,
  };
};

const writeArtifact = (artifact) => {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(artifact, null, 2)}\n`);
  console.log(`Wrote ${outPath}`);
};

const writeFailureArtifact = ({ status, reasonCode, reason, stage, retryable = true }) => {
  writeArtifact({
    schema_version: 1,
    system: "Memory Crystal",
    status,
    boundary,
    run_id: runId,
    run_at: new Date().toISOString(),
    stage,
    reason_code: reasonCode,
    reason,
    retryable,
    source_artifact: "benchmarks/memory/fixtures.json",
    redacted_environment: {
      api_url: apiUrl ?? null,
      api_key_env: apiKeyEnv,
      api_key_present: Boolean(apiKey),
      external_network: Boolean(apiUrl),
      spend_policy: "cheap_v1_no_paid_large_runs",
    },
    caveats: [
      "This artifact records why the hosted benchmark was not run.",
      "It is not a benchmark score.",
    ],
  });
};

if (boundary === "retrieval_seeded") {
  const result = spawnSync("npm", ["exec", "vitest", "run", "convex/crystal/__tests__/memory-benchmark.test.ts"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      MC_BENCHMARK_OUT: outPath,
      MC_BENCHMARK_GIT_COMMIT: gitCommit(),
    },
  });
  process.exit(result.status ?? 1);
}

if (!apiUrl || !apiKey) {
  writeFailureArtifact({
    status: "blocked_credentials",
    reasonCode: !apiUrl ? "missing_api_url" : "missing_api_key",
    reason: `Boundary ${boundary} requires --api-url and ${apiKeyEnv} in the environment.`,
    stage: "hosted_setup",
  });
  process.exit(2);
}

const authHeaders = {
  Authorization: `Bearer ${apiKey}`,
  "content-type": "application/json",
};

const postJson = async (path, body) => {
  const response = await fetch(`${apiUrl}${path}`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  if (!response.ok) {
    throw new Error(`${path} failed with HTTP ${response.status}: ${JSON.stringify(json).slice(0, 500)}`);
  }
  return json;
};

const scopeId = args.get("scope-id") ?? runId;
const scopedChannel = (channel) => `${scopeId}:${channel}`;

const runHttpBoundary = async () => {
  const caseResults = [];
  for (const benchmarkCase of fixture.cases) {
    if (boundary === "direct_memory_api") {
      for (const memory of benchmarkCase.memories) {
        await postJson("/api/mcp/capture", {
          title: memory.title,
          content: memory.content,
          store: memory.store ?? "semantic",
          category: memory.category ?? "fact",
          tags: memory.tags ?? [],
          channel: scopedChannel(memory.channel ?? benchmarkCase.channel),
          metadata: JSON.stringify({ benchmark_case_id: benchmarkCase.id, fixture_memory_id: memory.id, scope_id: scopeId }),
        });
      }
    } else if (boundary === "turn_extraction_e2e") {
      for (const memory of benchmarkCase.memories.filter((entry) => !entry.archived)) {
        await postJson("/api/mcp/turn", {
          sessionKey: `${scopeId}:${benchmarkCase.id}`,
          channel: scopedChannel(memory.channel ?? benchmarkCase.channel),
          turnId: `${scopeId}:${benchmarkCase.id}:${memory.id}`,
          userMessage: `Remember this benchmark fact: ${memory.content}`,
          assistantMessage: "Acknowledged.",
          captureMode: "sync-test-only",
          metadata: { benchmark_case_id: benchmarkCase.id, fixture_memory_id: memory.id, scope_id: scopeId },
        });
      }
    } else if (boundary !== "http_recall") {
      throw new Error(`Unsupported boundary: ${boundary}`);
    }

    const start = performance.now();
    const recall = await postJson("/api/mcp/recall", {
      query: benchmarkCase.query,
      channel: scopedChannel(benchmarkCase.channel),
      limit: 5,
      includeAssociations: false,
    });
    const latencyMs = performance.now() - start;
    const memories = Array.isArray(recall.memories) ? recall.memories : [];
    const returnedText = memories.map((memory) => `${memory.title ?? ""} ${memory.content ?? ""}`).join("\n");
    const returnedMemoryIds = memories.map((memory) => {
      const metadata = typeof memory.metadata === "string" ? memory.metadata : "";
      const match = /"fixture_memory_id":"([^"]+)"/.exec(metadata);
      return match?.[1] ?? String(memory.memoryId ?? memory._id ?? "");
    });
    caseResults.push(scoreCase({ benchmarkCase, returnedMemoryIds, returnedText, latencyMs }));
  }

  const summary = summarize(caseResults);
  writeArtifact({
    schema_version: 1,
    system: "Memory Crystal",
    run_id: runId,
    run_at: new Date().toISOString(),
    status: summary.forbidden_leaks === 0 ? "verified_reproduced" : "unsafe",
    boundary,
    seed_source: boundary === "http_recall" ? "pre-seeded-hosted-scope" : null,
    write_source: boundary === "direct_memory_api" ? "/api/mcp/capture" : boundary === "turn_extraction_e2e" ? "/api/mcp/turn" : null,
    scope_id: scopeId,
    git_commit: gitCommit(),
    fixture_checksum: checksumFile(fixturePath),
    source_artifact: "benchmarks/memory/fixtures.json",
    api_mode: apiUrl,
    model: "server-configured",
    embedding_model: "server-configured",
    judge_model: "rule-based-exact-match",
    redacted_environment: {
      api_url: apiUrl,
      api_key_env: apiKeyEnv,
      api_key: redactKey(apiKey),
      external_network: true,
      spend_policy: "caller_authorized_hosted_run",
    },
    score: summary.score,
    summary,
    case_results: caseResults,
    caveats: [
      boundary === "turn_extraction_e2e"
        ? "Measures synchronous test extraction path and recall over synthetic turns."
        : "Does not measure automatic turn extraction quality.",
    ],
  });
};

runHttpBoundary().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
