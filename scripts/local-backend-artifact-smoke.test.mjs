#!/usr/bin/env node
// Regression tests for the artifact smoke's relative-import resolver (ILL-336).
//
// The smoke reported false positives for `./distillationPause.helper` and
// `./buildInfo.generated`: path.extname() treats the dotted basename segment as
// an extension, so the resolver never probed `.ts`. The fix must keep failing
// on imports that are genuinely missing from the archive.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { findUnresolvedRelativeImports, resolveRelativeImport } from "./lib/relative-import-check.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "mc-import-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (rel, content = "export const value = 1;\n") => {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
    return path;
  };
  return { root, write };
}

test("dotted basenames that are not source extensions resolve to their .ts module", (t) => {
  const { root, write } = fixture(t);
  write("convex/distillationPause.helper.ts");
  write("convex/buildInfo.generated.ts");
  write("convex/sub/index.ts");
  write("convex/d.ts");
  write("convex/data.json", "{}\n");
  write("convex/a.ts", [
    'import { value as x } from "./distillationPause.helper";',
    'import y from "./buildInfo.generated";',
    'import z from "./d.js";',
    'import w from "./sub";',
    'import q from "./data.json";',
    'const lazy = () => import("./buildInfo.generated");',
    '// import k from "./commented-out";',
    '/* import k2 from "./block-comment"; */',
    "export const all = [x, y, z, w, q, lazy];",
    "",
  ].join("\n"));

  assert.deepEqual(findUnresolvedRelativeImports(join(root, "convex")), []);
  assert.equal(
    resolveRelativeImport(join(root, "convex/a.ts"), "./distillationPause.helper"),
    join(root, "convex/distillationPause.helper.ts"),
  );
  assert.equal(resolveRelativeImport(join(root, "convex/a.ts"), "./d.js"), join(root, "convex/d.ts"));
  assert.equal(resolveRelativeImport(join(root, "convex/a.ts"), "./sub"), join(root, "convex/sub/index.ts"));
});

test("a genuinely missing import still fails the check", (t) => {
  const { root, write } = fixture(t);
  write("convex/present.ts");
  write("convex/emptyDir/.keep", "");
  write("convex/bad.ts", [
    'import m from "./doesNotExist";',
    'import n from "./missing.helper";',
    'import o from "./emptyDir";',
    'import p from "./nope.js";',
    'import ok from "./present";',
    "export const all = [m, n, o, p, ok];",
    "",
  ].join("\n"));

  const missing = findUnresolvedRelativeImports(join(root, "convex"), { displayRoot: root });
  assert.deepEqual(missing, [
    { file: "convex/bad.ts", specifier: "./doesNotExist" },
    { file: "convex/bad.ts", specifier: "./missing.helper" },
    { file: "convex/bad.ts", specifier: "./emptyDir" },
    { file: "convex/bad.ts", specifier: "./nope.js" },
  ]);
  assert.equal(resolveRelativeImport(join(root, "convex/bad.ts"), "./doesNotExist"), null);
  assert.equal(resolveRelativeImport(join(root, "convex/bad.ts"), "./missing.helper"), null);
});

test("generated Convex declarations are skipped, other files are not", (t) => {
  const { root, write } = fixture(t);
  write("convex/_generated/api.d.ts", 'import type * as x from "./missing.js";\n');
  write("convex/real.ts", 'import x from "./missing";\nexport default x;\n');
  assert.deepEqual(
    findUnresolvedRelativeImports(join(root, "convex"), { displayRoot: root }),
    [{ file: "convex/real.ts", specifier: "./missing" }],
  );
});

test("the smoke fails end-to-end on a provided artifact root with a broken import", (t) => {
  const { root } = fixture(t);
  const out = join(root, "artifact");
  const packaged = spawnSync("node", ["scripts/package-local-backend.mjs", "--version", "smoke-test", "--out", out], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(packaged.status, 0, `packager failed\n${packaged.stdout}\n${packaged.stderr}`);

  const env = { ...process.env, CRYSTAL_TEST_ARTIFACT_ROOT: out };
  const clean = spawnSync("node", ["scripts/local-backend-artifact-smoke.mjs"], { cwd: REPO_ROOT, encoding: "utf8", env });
  assert.equal(clean.status, 0, `smoke should pass on a clean provided root\n${clean.stdout}\n${clean.stderr}`);
  assert.match(clean.stdout, /Testing provided artifact root/);

  writeFileSync(
    join(out, "convex/crystal/brokenImport.ts"),
    'import { nothing } from "./doesNotExist";\nexport const broken = nothing;\n',
  );
  const broken = spawnSync("node", ["scripts/local-backend-artifact-smoke.mjs"], { cwd: REPO_ROOT, encoding: "utf8", env });
  assert.notEqual(broken.status, 0, "smoke must fail when an import cannot be resolved");
  assert.match(broken.stderr, /convex\/crystal\/brokenImport\.ts -> \.\/doesNotExist/);
});
