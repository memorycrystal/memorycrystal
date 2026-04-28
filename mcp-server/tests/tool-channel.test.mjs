import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const readTool = (name) =>
  fs.readFileSync(path.join(process.cwd(), "src", "tools", `${name}.ts`), "utf8");

test("recall tool schema and Convex call include optional channel", () => {
  const source = readTool("recall");

  assert.match(source, /channel\?: string;/);
  assert.match(source, /channel:\s*\{\s*type:\s*"string"/);
  assert.match(source, /channel:\s*parsed\.channel/);
});

test("stats tool schema and Convex query include optional channel", () => {
  const source = readTool("stats");

  assert.match(source, /channel\?: string;/);
  assert.match(source, /channel:\s*\{\s*type:\s*"string"/);
  assert.match(source, /channel:\s*parsed\.channel/);
});

test("checkpoint and forget tools include optional channel passthrough", () => {
  const checkpoint = readTool("checkpoint");
  const forget = readTool("forget");

  assert.match(checkpoint, /channel\?: string;/);
  assert.match(checkpoint, /channel:\s*\{\s*type:\s*"string"/);
  assert.match(checkpoint, /channel:\s*parsed\.channel/);

  assert.match(forget, /channel\?: string;/);
  assert.match(forget, /channel:\s*\{\s*type:\s*"string"/);
  assert.match(forget, /channel:\s*parsed\.channel/);
});

test("update and supersede tools expose dedicated Convex endpoints", () => {
  const update = readTool("update");
  const supersede = readTool("supersede");
  const index = fs.readFileSync(path.join(process.cwd(), "src", "index.ts"), "utf8");

  assert.match(update, /name:\s*"crystal_update"/);
  assert.match(update, /"\/api\/mcp\/update"/);
  assert.match(update, /actionTriggers/);

  assert.match(supersede, /name:\s*"crystal_supersede"/);
  assert.match(supersede, /name:\s*"crystal_supercede"/);
  assert.match(supersede, /"\/api\/mcp\/supersede"/);
  assert.match(supersede, /oldMemoryId/);

  assert.match(index, /updateTool/);
  assert.match(index, /supersedeTool/);
  assert.match(index, /case "crystal_update"/);
  assert.match(index, /case "crystal_supersede"/);
  assert.match(index, /case "crystal_supercede"/);
});

test("public memory category schemas include skill", () => {
  for (const name of ["remember", "edit", "update", "supersede", "recall"]) {
    const source = readTool(name);
    assert.match(source, /"skill"/, `${name} tool should expose skill category`);
  }

  const obsidian = fs.readFileSync(path.join(process.cwd(), "src", "lib", "obsidian.ts"), "utf8");
  assert.match(obsidian, /"skill"/, "Obsidian category guard should allow skill memories");
});
