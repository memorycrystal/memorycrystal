#!/usr/bin/env node
/**
 * Choose the recall v2 calibration/heldout salt.
 *
 * Salts are tried in order recall-v2-r1-salt-v1, v2, … and the search stops
 * at v10000. Assignment is sha256(salt|caseId); the last hex nibble even means
 * calibration, otherwise heldout. A salt is chosen only when splitBalanceOk
 * (representation plus hit@3 on positives, strongRate on negatives, limit max(0.15, 1 / min(kind counts))) passes for every
 * supplied outcome set. Recorded and hashed dumps are both required. A dump
 * shaped as { default, side } is checked on each vector read mode.
 *
 * Case outcomes do not depend on the salt. The split field in a dump is ignored.
 *
 *   node scripts/select-recall-split-salt.mjs \
 *     --recorded /tmp/recorded-observations.json \
 *     --hashed /tmp/hashed-observations.json
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const SALT_PREFIX = "recall-v2-r1-salt-v";
export const MAX_SALT_VERSION = 10000;
export const BALANCE_TOLERANCE = 0.15;

export function splitForCaseId(caseId, salt) {
  const digest = createHash("sha256").update(`${salt}|${caseId}`).digest("hex");
  const nibble = Number.parseInt(digest.slice(-1), 16);
  return nibble % 2 === 0 ? "calibration" : "heldout";
}

function round4(value) {
  return Math.round(value * 1e4) / 1e4;
}

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function perSplitRates(cases, salt) {
  const groups = new Map();
  for (const item of cases) {
    const split = splitForCaseId(item.id, salt);
    const key = `${item.className}:${split}`;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  const out = {};
  for (const key of [...groups.keys()].sort()) {
    const list = groups.get(key) ?? [];
    const positives = list.filter((item) => item.positive);
    const negatives = list.filter((item) => !item.positive);
    out[key] = {
      hitAt3: round4(mean(positives.map((item) => (item.hitAt3 ? 1 : 0)))),
      strongRate: round4(mean(negatives.map((item) => (item.quality === "strong" ? 1 : 0)))),
      positiveCount: positives.length,
      negativeCount: negatives.length,
    };
  }
  return out;
}

/**
 * Same rule as splitBalanceOk in convex/crystal/eval/recallGate.ts.
 * Each class/kind with n >= 2 needs max(1, floor(0.35 * n)) per split.
 * Representation is required before comparing rates; singleton kinds are exempt.
 */
export function balanceReport(perSplit, tolerance = BALANCE_TOLERANCE) {
  const failures = [];
  const deltas = [];
  const classes = new Set();
  for (const key of Object.keys(perSplit)) {
    const className = key.slice(0, key.lastIndexOf(":"));
    if (className) classes.add(className);
  }
  for (const className of [...classes].sort()) {
    const calibration = perSplit[`${className}:calibration`];
    const heldout = perSplit[`${className}:heldout`];
    // Every observed class (including legacy) must be represented by kind.
    // For n >= 2, each split needs max(1, floor(0.35 * n)) cases.
    for (const kind of ["positiveCount", "negativeCount"]) {
      const calibrationCount = calibration?.[kind] ?? 0;
      const heldoutCount = heldout?.[kind] ?? 0;
      const total = calibrationCount + heldoutCount;
      const minimum = total >= 2 ? Math.max(1, Math.floor(0.35 * total)) : 0;
      if (calibrationCount < minimum || heldoutCount < minimum) {
        failures.push(`${className} ${kind} split representation ${calibrationCount}/${heldoutCount}, minimum ${minimum} each`);
      }
    }
    if (!calibration || !heldout) continue;
    if (calibration.positiveCount > 0 && heldout.positiveCount > 0) {
      // Recover integer outcomes from four-decimal report rates for exact boundaries.
      const delta = Math.abs(
        Math.round(calibration.hitAt3 * calibration.positiveCount) / calibration.positiveCount
        - Math.round(heldout.hitAt3 * heldout.positiveCount) / heldout.positiveCount,
      );
      const allowedTolerance = Math.max(tolerance, 1 / Math.min(calibration.positiveCount, heldout.positiveCount));
      deltas.push({
        className,
        metric: "hit@3",
        delta,
        allowedTolerance,
        calibration: calibration.hitAt3,
        heldout: heldout.hitAt3,
      });
      if (delta > allowedTolerance + 1e-9) failures.push(`${className} hit@3 split delta ${delta}`);
    }
    if (calibration.negativeCount > 0 && heldout.negativeCount > 0) {
      // Recover integer outcomes from four-decimal report rates for exact boundaries.
      const delta = Math.abs(
        Math.round(calibration.strongRate * calibration.negativeCount) / calibration.negativeCount
        - Math.round(heldout.strongRate * heldout.negativeCount) / heldout.negativeCount,
      );
      const allowedTolerance = Math.max(tolerance, 1 / Math.min(calibration.negativeCount, heldout.negativeCount));
      deltas.push({
        className,
        metric: "strongRate",
        delta,
        allowedTolerance,
        calibration: calibration.strongRate,
        heldout: heldout.strongRate,
      });
      if (delta > allowedTolerance + 1e-9) failures.push(`${className} strongRate split delta ${delta}`);
    }
  }
  return { ok: failures.length === 0, failures, deltas };
}

export function selectFirstBalancedSalt(datasets, options = {}) {
  const tolerance = options.tolerance ?? BALANCE_TOLERANCE;
  const maxVersion = options.maxVersion ?? MAX_SALT_VERSION;
  const prefix = options.prefix ?? SALT_PREFIX;
  if (!Number.isInteger(maxVersion) || maxVersion < 1) {
    throw new Error(`max salt version must be a positive integer, got ${maxVersion}`);
  }
  if (!Array.isArray(datasets) || datasets.length === 0) {
    throw new Error("at least one outcome dataset is required");
  }
  for (const dataset of datasets) {
    if (!dataset?.name || !Array.isArray(dataset.cases) || dataset.cases.length === 0) {
      throw new Error(`dataset ${dataset?.name ?? "(unnamed)"} has no cases`);
    }
    for (const item of dataset.cases) {
      if (!item.id || !item.className || typeof item.positive !== "boolean") {
        throw new Error(`dataset ${dataset.name} case missing id, className, or positive`);
      }
    }
  }
  for (let version = 1; version <= maxVersion; version += 1) {
    const salt = `${prefix}${version}`;
    const reports = datasets.map((dataset) => {
      const balance = balanceReport(perSplitRates(dataset.cases, salt), tolerance);
      return { name: dataset.name, ...balance };
    });
    if (reports.every((report) => report.ok)) {
      return { salt, version, reports };
    }
  }
  throw new Error(
    `no salt ${prefix}1..v${maxVersion} satisfies representation and balance within max(${tolerance}, 1 / min(kind counts)) on every supplied outcome set`,
  );
}

export function outcomeSetsFromDump(label, dump) {
  if (Array.isArray(dump)) return [{ name: label, cases: dump }];
  if (dump && Array.isArray(dump.default) && Array.isArray(dump.side)) {
    return [
      { name: `${label}:default`, cases: dump.default },
      { name: `${label}:side`, cases: dump.side },
    ];
  }
  throw new Error(`${label} dump must be an observation array or { default, side }`);
}

export function formatSelection(selection) {
  const lines = [`salt: ${selection.salt}`, `version: ${selection.version}`];
  for (const report of selection.reports) {
    lines.push("");
    lines.push(report.name);
    if (report.deltas.length === 0) {
      lines.push("  (no class had both splits populated)");
      continue;
    }
    for (const row of report.deltas) {
      lines.push(
        `  ${row.className} ${row.metric} delta ${row.delta.toFixed(4)} tolerance ${row.allowedTolerance.toFixed(4)} (calibration ${row.calibration.toFixed(4)} heldout ${row.heldout.toFixed(4)})`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function parseArgs(argv) {
  let recorded = "";
  let hashed = "";
  let maxVersion = MAX_SALT_VERSION;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--recorded") recorded = argv[++index] ?? "";
    else if (arg === "--hashed") hashed = argv[++index] ?? "";
    else if (arg === "--max") maxVersion = Number(argv[++index]);
    else if (arg === "--help" || arg === "-h") return { help: true, recorded, hashed, maxVersion };
    else throw new Error(`unknown argument ${arg}`);
  }
  return { help: false, recorded, hashed, maxVersion };
}

function printHelp() {
  process.stdout.write(
    [
      "select-recall-split-salt — first recall-v2-r1 salt balanced on recorded and hashed outcomes",
      "",
      "USAGE",
      "  node scripts/select-recall-split-salt.mjs --recorded <dump.json> --hashed <dump.json>",
      "",
      "Each dump is a per-case observation array, or { default, side } from",
      "RECALL_V2_OBSERVATION_OUT. Both vector read modes are checked when present.",
      "Search order is recall-v2-r1-salt-v1, v2, … through v10000.",
      "",
    ].join("\n"),
  );
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return;
  }
  if (!args.recorded || !args.hashed) {
    throw new Error("--recorded and --hashed are required");
  }
  const recorded = outcomeSetsFromDump("recorded", JSON.parse(readFileSync(args.recorded, "utf8")));
  const hashed = outcomeSetsFromDump("hashed", JSON.parse(readFileSync(args.hashed, "utf8")));
  const selection = selectFirstBalancedSalt([...recorded, ...hashed], { maxVersion: args.maxVersion });
  process.stdout.write(formatSelection(selection));
}

const entry = process.argv[1] ? new URL(`file://${process.argv[1]}`).href : "";
if (import.meta.url === entry || process.argv[1]?.endsWith("select-recall-split-salt.mjs")) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
