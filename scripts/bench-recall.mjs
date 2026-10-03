#!/usr/bin/env node
/**
 * Recall v2 production-path gate (ILL-304).
 *
 * Default mode is `recorded`: real-model vectors keyed by
 * sha256(model | builderVersion | exact provider input). A missing or
 * mismatched fixture fails before the harness starts.
 *
 * `npm run bench:recall -- --mode hashed` runs the deterministic hashed
 * embedding. `--write-baseline` rewrites benchmarks/results/recall-v2/baseline.json
 * in recorded mode. `--write-hashed-baseline` writes baseline.hashed.json.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const spec = "convex/crystal/__tests__/recall-v2.bench.test.ts";
const fixture = resolve(repoRoot, "convex/crystal/eval/recorded-embeddings.json");
const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    [
      "bench-recall — production-path mcpRecall gate (ILL-304)",
      "",
      "USAGE",
      "  npm run bench:recall                         recorded mode, both vector read modes",
      "  npm run bench:recall -- --mode hashed         deterministic hashed embeddings",
      "  npm run bench:recall -- --write-baseline      rewrite baseline.json (recorded)",
      "  npm run bench:recall -- --write-hashed-baseline",
      "  npm run bench:recall -- --out <file>          also write the metric JSON",
      "",
      "WHAT IT MEASURES",
      "  Gold set v2 plus the unchanged 69 legacy cases, invoked through /api/mcp/recall",
      "  (mcpRecall). This is the crystal_recall path. recallMemories uses the same",
      "  engine; npm run test:recall-eval measures the legacy 69 through that action.",
      "",
      "FAILURES",
      "  Heldout class thresholds, legacy-69 R@3/MRR, coverage precision/recall,",
      "  injection negatives, private-scope leaks, expectedAbsent and KB parity.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

let mode = "recorded";
let writeBaseline = false;
let out = "";
let modeExplicit = false;
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--mode") {
    mode = args[++index];
    modeExplicit = true;
  } else if (arg === "--write-baseline") writeBaseline = true;
  else if (arg === "--write-hashed-baseline") {
    mode = "hashed";
    writeBaseline = true;
  } else if (arg === "--out") out = args[++index];
  else {
    process.stderr.write(`unknown argument ${arg}\n`);
    process.exit(2);
  }
}
if (mode !== "recorded" && mode !== "hashed") {
  process.stderr.write("mode must be recorded or hashed\n");
  process.exit(2);
}
if (writeBaseline && args.includes("--write-baseline")) {
  if (modeExplicit && mode !== "recorded") {
    process.stderr.write("--write-baseline requires recorded mode\n");
    process.exit(2);
  }
  mode = "recorded";
}
if (mode === "recorded" && !existsSync(fixture)) {
  process.stderr.write(
    [
      "recorded embedding fixture missing: convex/crystal/eval/recorded-embeddings.json",
      "Record it with OPENROUTER_API_KEY set in one process:",
      "  npm run bench:recall:record-embeddings",
      "Then regenerate the recorded baseline:",
      "  npm run bench:recall -- --write-baseline",
      "",
    ].join("\n"),
  );
  process.exit(1);
}

const env = {
  ...process.env,
  RECALL_V2_MODE: mode,
  RECALL_V2_WRITE_BASELINE: writeBaseline ? "1" : "",
};
if (out) env.RECALL_V2_OUT = resolve(repoRoot, out);

process.stdout.write(`Running recall v2 mcpRecall gate (${mode}, both vector read modes)...\n\n`);
const result = spawnSync(
  "npx",
  ["vitest", "run", spec, "--disableConsoleIntercept"],
  { cwd: repoRoot, stdio: "inherit", env },
);
if (result.error) {
  process.stderr.write(`bench-recall failed to launch vitest: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
