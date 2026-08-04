#!/usr/bin/env node
/**
 * bench-recall.mjs — the ILL-102 recall-quality gate CLI.
 *
 * Runs the versioned gold set (`convex/crystal/eval/goldset.json`) through the
 * REAL recall action under convex-test and prints recall@{1,3,5,10} + MRR
 * (overall and per-store) plus the `buried` (gold returned at rank>3) and
 * `misses` (gold never returned) diagnostics. It is a thin, sibling-of-
 * `bench-*.mjs` wrapper around the eval spec, which owns the convex-test setup.
 *
 * Offline + deterministic: no network, no OpenAI, no Docker. A fixed gold set on
 * unchanged ranking code prints identical numbers on every run.
 *
 * ---------------------------------------------------------------------------
 * RELEASE GATE RULE (see docs/recall-eval-gate.md):
 *   Any PR that changes `convex/crystal/recallRanking.ts` weights or the recall
 *   candidate set MUST paste the before/after `bench-recall` numbers on the
 *   committed gold set. A recall@3 regression requires explicit justification.
 * ---------------------------------------------------------------------------
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const spec = "convex/crystal/__tests__/recall-eval.test.ts";

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(
    [
      "bench-recall — recall@k / MRR eval gate for Memory Crystal recall",
      "",
      "USAGE",
      "  node scripts/bench-recall.mjs            Run the gold set through the real",
      "                                           recall action; print recall@{1,3,5,10}",
      "                                           + MRR (overall + per-store), buried, misses.",
      "  node scripts/bench-recall.mjs --help     Show this help and the gate rule.",
      "",
      "  npm run bench:recall                     Same, via the package script.",
      "",
      "WHAT IT MEASURES",
      "  A fixed, versioned gold set (convex/crystal/eval/goldset.json) is seeded into an",
      "  in-memory Convex backend and each case is run through the real recall action",
      "  (api.crystal.recall.recallMemories) — the same code path crystal_recall uses.",
      "  Ranking is NOT reimplemented. Embeddings are deterministic (offline hashed",
      "  bag-of-words), so numbers are reproducible.",
      "",
      "RELEASE GATE RULE",
      "  Any PR that changes recallRanking.ts weights or the recall candidate set MUST",
      "  paste before/after bench-recall numbers on the committed gold set in the PR.",
      "  A recall@3 regression requires explicit justification. See docs/recall-eval-gate.md.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

process.stdout.write("Running recall eval gate (real recall action, offline, deterministic)...\n\n");

// `--disableConsoleIntercept` lets the harness's formatted metric table reach
// stdout. The eval spec also asserts determinism + ranking sensitivity, so a
// non-zero exit here is a genuine gate failure.
const result = spawnSync(
  "npx",
  ["vitest", "run", spec, "--disableConsoleIntercept"],
  { cwd: repoRoot, stdio: "inherit", env: process.env },
);

if (result.error) {
  process.stderr.write(`bench-recall failed to launch vitest: ${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
