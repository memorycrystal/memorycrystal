// ILL-195 — the Cursor runtime must be the same code on every delivery surface.
//
// cursor-hooks.mjs reaches a Cursor user five ways:
//   1. authored source                  plugins/shared/
//   2. installer mirror install.sh curls apps/web/public/plugins/shared/
//      (install_shared_hooks, hooks.method=shared, host=cursor)
//   3. local plugin bundle served by     plugins/cursor/memory-crystal/hooks/
//      apps/web/app/install-assets/cursor-plugin/[...file]/route.ts
//   4. the hand-kept download list in    install.sh install_shared_hooks()
//   5. the hand-kept staging list in     install.sh install_cursor_local_plugin()
//
// A surface that lags the others ships Cursor users a runtime no test covers,
// so the entry point *and* everything it imports must stay byte-identical
// across all three, stay present in the bundle, and stay reachable — and both
// hand-kept installer lists must stay in step with what the runtime needs.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const ENTRY = "cursor-hooks.mjs";
const AUTHORED = "plugins/shared";
const CURSOR_PLUGIN = "plugins/cursor/memory-crystal";
const INSTALLER = "apps/web/public";
const ROUTE_DIR = "apps/web/app/install-assets/cursor-plugin/[...file]";
const MIRRORS = {
  "web installer mirror": "apps/web/public/plugins/shared",
  "bundled Cursor plugin": `${CURSOR_PLUGIN}/hooks`,
};

const read = (dir, file) => readFileSync(resolve(repoRoot, dir, file), "utf8");

// Static `import`/`export ... from "./x.mjs"`, either quote style. plugins/** is
// linted by nothing (eslint.config.mjs scopes convex/, mcp-server/src/, apps/web/
// only) and most test files here already use single quotes, so quote style is not
// a safe thing for the walk to assume.
const STATIC_IMPORT = /\bfrom\s+(["'])\.\/([\w.-]+\.mjs)\1/g;

// Deliberately broader than the walk: any relative .mjs specifier in any quote
// style, whatever syntax carries it — `await import()`, `new URL(..., import.meta.url)`,
// a bare string handed to a loader. Used only to make an unfollowed form fail loudly.
const RELATIVE_SPECIFIER = /(["'`])\.\/([\w.-]+\.mjs)\1/g;

export function staticImports(source) {
  return [...source.matchAll(STATIC_IMPORT)].map(([, , dep]) => dep);
}

export function relativeSpecifiers(source) {
  return [...source.matchAll(RELATIVE_SPECIFIER)].map(([, , dep]) => dep);
}

// Follow relative imports from the entry point so a shared dependency added
// later is guarded automatically instead of via a hand-kept list.
function runtimeClosure(entry) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...staticImports(read(AUTHORED, file)));
  }
  return [...seen].sort();
}

// route.ts ALLOWED_FILES, anchored on the declaration rather than substring-split
// so a second mention of the identifier cannot silently move the scanned region,
// and commented-out entries do not count as shipped.
function allowedFiles() {
  const route = read(ROUTE_DIR, "route.ts");
  const declarations = [...route.matchAll(/const\s+ALLOWED_FILES\s*=\s*new\s+Set\(\[([\s\S]*?)\]\)/g)];
  assert.equal(
    declarations.length,
    1,
    `expected exactly one ALLOWED_FILES declaration in ${ROUTE_DIR}/route.ts, found ${declarations.length}`,
  );
  const body = declarations[0][1]
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  const files = [...body.matchAll(/(["'])([^"'`]+)\1/g)].map(([, , file]) => file);
  assert.ok(files.length > 0, "ALLOWED_FILES parsed as empty — the declaration shape changed");
  return files;
}

// A bash function body, bounded by the next top-level `name() {` line rather than
// the next column-0 `}` — install_shared_hooks() embeds a heredoc of JavaScript
// whose own `}` sits in column 0 and would truncate the body mid-function.
function shellFunctionBody(source, name) {
  const lines = source.split("\n");
  const definitions = [];
  lines.forEach((line, index) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\(\)\s*\{\s*$/.exec(line);
    if (match) definitions.push({ name: match[1], index });
  });
  const mine = definitions.filter((definition) => definition.name === name);
  assert.equal(mine.length, 1, `expected exactly one ${name}() in install.sh, found ${mine.length}`);
  const start = mine[0].index;
  const next = definitions.find((definition) => definition.index > start);
  return lines.slice(start + 1, next ? next.index : lines.length).join("\n");
}

const closure = runtimeClosure(ENTRY);

test("the Cursor runtime closure resolves the shared modules it imports", () => {
  // Guards the walk above: a broken resolve would make every parity check below
  // pass vacuously on the entry point alone.
  assert.ok(closure.includes(ENTRY), `${ENTRY} missing from its own closure`);
  for (const dep of ["_lib.mjs", "crystal-hooks.mjs"]) {
    assert.ok(closure.includes(dep), `${dep} should be reachable from ${ENTRY}`);
  }
});

test("the import walk reads both quote styles", () => {
  // In-memory sources, not repository fixtures. Today's three runtime files are
  // all double-quoted, so without this the walk could regress to double-quote-only
  // and still look green.
  assert.deepEqual(staticImports(`import { x } from './newdep.mjs';`), ["newdep.mjs"]);
  assert.deepEqual(staticImports(`import { x } from "./newdep.mjs";`), ["newdep.mjs"]);
  assert.deepEqual(staticImports(`export { x } from './re-exported.mjs';`), ["re-exported.mjs"]);
  assert.deepEqual(staticImports(`import x from './a.mjs';\nimport y from "./b.mjs";`), ["a.mjs", "b.mjs"]);
  assert.deepEqual(staticImports(`import { readFileSync } from "fs";`), []);
});

test("dependency forms the walk does not follow are still detected", () => {
  // The audit below turns anything the walk misses into a loud failure, so it has
  // to see strictly more than the walk does.
  assert.deepEqual(staticImports(`const m = await import('./lazy.mjs');`), []);
  assert.deepEqual(relativeSpecifiers(`const m = await import('./lazy.mjs');`), ["lazy.mjs"]);
  assert.deepEqual(relativeSpecifiers(`new URL("./sidecar.mjs", import.meta.url)`), ["sidecar.mjs"]);
  assert.deepEqual(relativeSpecifiers("const p = `./templated.mjs`;"), ["templated.mjs"]);
  assert.deepEqual(relativeSpecifiers(`import { x } from './newdep.mjs';`), ["newdep.mjs"]);
});

test("every relative dependency in the Cursor runtime closure is inside the closure", () => {
  // Fails closed on an import form runtimeClosure() cannot parse: the file would
  // otherwise drop out of the closure and every parity check below would stop
  // covering it without a single test turning red.
  for (const file of closure) {
    for (const dep of relativeSpecifiers(read(AUTHORED, file))) {
      assert.ok(
        closure.includes(dep),
        `${AUTHORED}/${file} references ./${dep} in a form the import walk does not follow — ` +
          `teach runtimeClosure() about that form, or ${dep} ships to Cursor users unguarded`,
      );
    }
  }
});

for (const [label, dir] of Object.entries(MIRRORS)) {
  test(`${label} carries the Cursor runtime closure byte-identical to ${AUTHORED}`, () => {
    for (const file of closure) {
      assert.ok(
        existsSync(resolve(repoRoot, dir, file)),
        `${dir}/${file} is missing — ${ENTRY} imports it at runtime`,
      );
      assert.equal(
        read(dir, file),
        read(AUTHORED, file),
        `${dir}/${file} drifted from ${AUTHORED}/${file} — copy the authored source`,
      );
    }
  });
}

test("the bundled Cursor plugin wires and serves that closure", () => {
  const hooks = JSON.parse(read(CURSOR_PLUGIN, "hooks/hooks.json"));
  const commands = Object.values(hooks.hooks).flat().map((entry) => entry.command);
  assert.ok(commands.length > 0, "hooks.json declares no hook commands");
  for (const command of commands) {
    const referenced = [...command.matchAll(/\.\/hooks\/([\w.-]+\.mjs)/g)].map(([, file]) => file);
    assert.deepEqual(
      referenced,
      [ENTRY],
      `hooks.json should invoke ./hooks/${ENTRY} and nothing else, saw: ${command}`,
    );
  }

  const allowed = allowedFiles();
  for (const file of closure) {
    assert.ok(
      allowed.includes(`hooks/${file}`),
      `the cursor-plugin asset route will 404 hooks/${file}`,
    );
  }
});

test("install.sh install_shared_hooks() downloads every file in the Cursor runtime closure", () => {
  // The curl path is the surface that actually reaches users: a shared module the
  // runtime imports but the installer never fetches kills the Cursor
  // UserPromptSubmit hook at import with ERR_MODULE_NOT_FOUND.
  const body = shellFunctionBody(read(INSTALLER, "install.sh"), "install_shared_hooks");
  const fetched = [...body.matchAll(/install_shared_hook_asset\s+"([^"]+)"/g)].map(([, file]) => file);
  assert.ok(
    fetched.length > 0,
    "parsed no install_shared_hook_asset calls out of install_shared_hooks() — the parse is stale",
  );
  for (const file of closure) {
    assert.ok(
      fetched.includes(file),
      `install_shared_hooks() never curls ${file}, so a curl-installed Cursor hook dies at import`,
    );
  }
});

test("install.sh install_cursor_local_plugin() streams exactly the cursor-plugin route allowlist", () => {
  // Two hand-kept lists of the same 15 paths. If the shell list lags, the fetch
  // failure path only warns and skips, so plugin staging quietly no-ops.
  const body = shellFunctionBody(read(INSTALLER, "install.sh"), "install_cursor_local_plugin");
  const loop = /^[ \t]*for file in\b([\s\S]*?)^[ \t]*do[ \t]*$/m.exec(body);
  assert.ok(loop, "install_cursor_local_plugin() no longer has a `for file in ... do` asset list");
  const streamed = [...loop[1].matchAll(/"([^"]+)"/g)].map(([, file]) => file);
  assert.ok(streamed.length > 0, "parsed no files out of the install_cursor_local_plugin() loop");
  assert.deepEqual(
    [...streamed].sort(),
    [...allowedFiles()].sort(),
    "install.sh install_cursor_local_plugin() and route.ts ALLOWED_FILES have drifted — " +
      "both hand-kept lists must name the same Cursor plugin files",
  );
});
