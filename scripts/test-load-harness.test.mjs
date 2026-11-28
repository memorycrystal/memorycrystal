import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

test("load reporter distinguishes a long assertion from a stack-trace timeout", () => {
  const source = readFileSync(new URL("./test-load-harness.sh", import.meta.url), "utf8");
  const reporter = source.split("<<'NODE'\n")[1].split("\nNODE")[0];
  const dir = mkdtempSync(join(tmpdir(), "load-reporter-"));
  try {
    for (const [copy, message] of [[1, "AssertionError: expected 1 to equal 2\nstack"], [2, "Error: STACK_TRACE_ERROR\nstack"], [3, ""]]) {
      writeFileSync(join(dir, `round1-copy${copy}.json`), JSON.stringify({ numPassedTests: 0, testResults: [{ name: "/convex/synthetic.test.ts", assertionResults: [{ status: "failed", title: `case-${copy}`, duration: 34000, failureMessages: [message] }] }] }));
      writeFileSync(join(dir, `round1-copy${copy}.log`), "synthetic log\n");
    }
    const result = spawnSync(process.execPath, ["-", dir, "1", "3"], { input: reporter, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 1);
    const lines = result.stdout.split("\n");
    assert.doesNotMatch(lines.find((line) => line.includes("case-1")), /probable timeout/);
    assert.match(lines.find((line) => line.includes("case-2")), /probable timeout/);
    assert.match(lines.find((line) => line.includes("case-3")), /probable timeout/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
