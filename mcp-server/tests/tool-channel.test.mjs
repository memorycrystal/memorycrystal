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
