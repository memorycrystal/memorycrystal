#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import yaml from "js-yaml";

const routePath = join("apps", "web", "app", "install-assets", "hermes-plugin", "[...file]", "route.ts");
const pluginRoot = join("integrations", "hermes", "crystal-memory");
const source = readFileSync(routePath, "utf8");

assert.match(source, /const ALLOWED_FILES = new Set\(\[/);
assert.match(source, /"plugin\.yaml"/);
assert.match(source, /"__init__\.py"/);
assert.doesNotMatch(source, /test_crystal_memory\.py/);
assert.match(source, /relativePath\.includes\("\.\."\)/);
assert.match(source, /pluginFile\.startsWith\(`\$\{PLUGIN_ROOT\}\$\{sep\}`\)/);
assert.equal(existsSync(join(pluginRoot, "plugin.yaml")), true);
assert.equal(existsSync(join(pluginRoot, "__init__.py")), true);

const manifest = yaml.load(readFileSync(join(pluginRoot, "plugin.yaml"), "utf8"));
assert.equal(manifest.name, "crystal-memory");
assert.deepEqual(manifest.provides_hooks, [
  "pre_llm_call",
  "post_llm_call",
  "pre_tool_call",
  "on_session_start",
  "on_session_end",
  "on_session_finalize",
  "on_session_reset",
]);
assert.equal(
  manifest.requires_env.find((entry) => entry.name === "MEMORY_CRYSTAL_HERMES_MODE")?.default,
  "auto",
);

console.log("hermes plugin asset route smoke passed");
