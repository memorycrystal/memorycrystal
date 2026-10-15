import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BALANCE_TOLERANCE,
  balanceReport,
  outcomeSetsFromDump,
  perSplitRates,
  selectFirstBalancedSalt,
  splitForCaseId,
} from "./select-recall-split-salt.mjs";

const SCRIPT = fileURLToPath(new URL("./select-recall-split-salt.mjs", import.meta.url));

test("assignment follows sha256 last-nibble parity", () => {
  const salt = "recall-v2-r1-salt-v1";
  const caseId = "v2-neg-01";
  const digest = createHash("sha256").update(`${salt}|${caseId}`).digest("hex");
  const nibble = Number.parseInt(digest.slice(-1), 16);
  assert.equal(splitForCaseId(caseId, salt), nibble % 2 === 0 ? "calibration" : "heldout");
  assert.notEqual(nibble % 2 === 0, nibble % 2 !== 0);
});

test("balance uses rounded hit@3 on positives and strongRate on negatives", () => {
  const boundary = balanceReport({
    "scope:calibration": { hitAt3: 1, strongRate: 0, positiveCount: 20, negativeCount: 0 },
    "scope:heldout": { hitAt3: 0.85, strongRate: 0, positiveCount: 20, negativeCount: 0 },
  });
  assert.equal(boundary.ok, true);
  assert.equal(Math.abs(1 - 0.85) > BALANCE_TOLERANCE + 1e-9, false);

  const over = balanceReport({
    "recency:calibration": { hitAt3: 1, strongRate: 0, positiveCount: 6, negativeCount: 0 },
    "recency:heldout": { hitAt3: 0.6667, strongRate: 0, positiveCount: 6, negativeCount: 0 },
  });
  assert.equal(over.ok, false);
  assert.match(over.failures[0], /recency hit@3 split delta /);

  const strong = balanceReport({
    "identifier:calibration": { hitAt3: 1, strongRate: 1, positiveCount: 2, negativeCount: 4 },
    "identifier:heldout": { hitAt3: 1, strongRate: 0.5, positiveCount: 2, negativeCount: 4 },
  });
  assert.equal(strong.ok, false);
  assert.match(strong.failures.join("\n"), /identifier strongRate split delta /);

  const oneSided = balanceReport({
    "preflight:calibration": { hitAt3: 0, strongRate: 0, positiveCount: 6, negativeCount: 0 },
  });
  assert.equal(oneSided.ok, false);
  assert.match(oneSided.failures[0], /preflight positiveCount split representation/);

  const negativesOnly = balanceReport({
    "message:calibration": { hitAt3: 0, strongRate: 0, positiveCount: 0, negativeCount: 4 },
    "message:heldout": { hitAt3: 0, strongRate: 0.1, positiveCount: 0, negativeCount: 4 },
  });
  assert.equal(negativesOnly.ok, true);
  assert.equal(negativesOnly.deltas.length, 1);
  assert.equal(negativesOnly.deltas[0].metric, "strongRate");
});

test("rates ignore a dump split field and round the positive hit mean", () => {
  const salt = "recall-v2-r1-salt-v1";
  const ids = [];
  while (ids.filter((id) => splitForCaseId(id, salt) === "calibration").length < 3
    || ids.filter((id) => splitForCaseId(id, salt) === "heldout").length < 3) {
    ids.push(`rate-${ids.length}`);
  }
  const calibration = ids.filter((id) => splitForCaseId(id, salt) === "calibration").slice(0, 3);
  const heldout = ids.filter((id) => splitForCaseId(id, salt) === "heldout").slice(0, 3);
  const cases = [
    ...calibration.map((id, index) => ({
      id,
      className: "low-content",
      positive: true,
      hitAt3: index < 2,
      quality: "weak",
      split: "heldout",
    })),
    ...heldout.map((id) => ({
      id,
      className: "low-content",
      positive: true,
      hitAt3: false,
      quality: "strong",
      split: "calibration",
    })),
  ];
  const rates = perSplitRates(cases, salt);
  assert.equal(rates["low-content:calibration"].hitAt3, 0.6667);
  assert.equal(rates["low-content:calibration"].positiveCount, 3);
  assert.equal(rates["low-content:heldout"].hitAt3, 0);
  assert.equal(rates["low-content:calibration"].strongRate, 0);
  assert.equal(rates["low-content:heldout"].negativeCount, 0);
});

function unbalancedPair() {
  const salt = "recall-v2-r1-salt-v1";
  const ids = [];
  while (ids.filter((id) => splitForCaseId(id, salt) === "calibration").length < 2
    || ids.filter((id) => splitForCaseId(id, salt) === "heldout").length < 2) {
    ids.push(`pick-${ids.length}`);
  }
  const recorded = ids.map((id) => ({
    id,
    className: "low-content",
    positive: true,
    hitAt3: splitForCaseId(id, salt) === "calibration",
    quality: "strong",
    split: "calibration",
  }));
  const hashed = recorded.map((item) => ({ ...item, hitAt3: !item.hitAt3 }));
  return [
    { name: "recorded", cases: recorded },
    { name: "hashed", cases: hashed },
  ];
}

test("selects the first salt that passes every dataset and rejects a short search", () => {
  const datasets = unbalancedPair();
  assert.equal(balanceReport(perSplitRates(datasets[0].cases, "recall-v2-r1-salt-v1")).ok, false);
  assert.equal(balanceReport(perSplitRates(datasets[1].cases, "recall-v2-r1-salt-v1")).ok, false);

  const selected = selectFirstBalancedSalt(datasets);
  assert.match(selected.salt, /^recall-v2-r1-salt-v\d+$/);
  assert.ok(selected.version >= 2);
  assert.ok(selected.reports.every((report) => report.ok));
  for (let version = 1; version < selected.version; version += 1) {
    const salt = `recall-v2-r1-salt-v${version}`;
    const passed = datasets.every((dataset) => balanceReport(perSplitRates(dataset.cases, salt)).ok);
    assert.equal(passed, false, salt);
  }
  assert.throws(
    () => selectFirstBalancedSalt(datasets, { maxVersion: 1 }),
    /no salt recall-v2-r1-salt-v1\.\.v1 /,
  );
});

test("a { default, side } dump is two outcome sets and the CLI prints that salt", () => {
  const datasets = unbalancedPair();
  const dump = { default: datasets[0].cases, side: datasets[1].cases };
  assert.deepEqual(
    outcomeSetsFromDump("recorded", dump).map((dataset) => dataset.name),
    ["recorded:default", "recorded:side"],
  );
  const directory = mkdtempSync(join(tmpdir(), "recall-salt-"));
  try {
    const recorded = join(directory, "recorded.json");
    const hashed = join(directory, "hashed.json");
    writeFileSync(recorded, JSON.stringify(dump));
    writeFileSync(hashed, JSON.stringify(datasets[0].cases));
    const expected = selectFirstBalancedSalt([
      ...outcomeSetsFromDump("recorded", JSON.parse(readFileSync(recorded, "utf8"))),
      ...outcomeSetsFromDump("hashed", JSON.parse(readFileSync(hashed, "utf8"))),
    ]);
    const result = spawnSync(process.execPath, [SCRIPT, "--recorded", recorded, "--hashed", hashed], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`^salt: ${expected.salt}\\n`));
    assert.match(result.stdout, /recorded:default/);
    assert.match(result.stdout, /recorded:side/);
    assert.match(result.stdout, /^hashed\n/m);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("selector rejects a salt that empties either kind of a class", () => {
  const salt = "recall-v2-r1-salt-v1";
  const ids = [];
  for (let i = 0; ids.length < 6; i++) {
    if (splitForCaseId(`empty-${i}`, salt) === "calibration") ids.push(`empty-${i}`);
  }
  for (const positive of [true, false]) {
    const cases = ids.map(id => ({ id, className: "preflight", positive, hitAt3: true, quality: "strong" }));
    assert.throws(() => selectFirstBalancedSalt([{ name: "recorded", cases }], { maxVersion: 1 }), /no salt/);
    assert.ok(selectFirstBalancedSalt([{ name: "recorded", cases }]).version > 1);
  }
});

test("representation enforces the 35 percent floor independently for both kinds", () => {
  for (const kind of ["positiveCount", "negativeCount"]) {
    for (const [left, right, expected] of [[9, 1, false], [7, 3, true], [1, 1, true], [1, 0, true]]) {
      const row = count => ({ hitAt3: 1, strongRate: 1, positiveCount: 0, negativeCount: 0, [kind]: count });
      assert.equal(balanceReport({ "legacy:calibration": row(left), "legacy:heldout": row(right) }).ok, expected);
    }
  }
});

test("one-case small-class gaps pass for both metrics, including rounded thirds", () => {
  for (const [count, rate] of [[3, 0.6667], [6, 0.8333], [4, 0.75]]) {
    const result = balanceReport({
      "preflight:calibration": { hitAt3: 1, strongRate: 1, positiveCount: count, negativeCount: count },
      "preflight:heldout": { hitAt3: rate, strongRate: rate, positiveCount: count, negativeCount: count },
    });
    assert.equal(result.ok, true);
  }
});
