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
assert.deepEqual(manifest.provides_commands, ["crystal_status", "crystal_doctor"]);
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
  manifest.requires_env.find((entry) => entry.name === "MEMORY_CRYSTAL_API_KEY")?.secret,
  true,
);
assert.equal(
  manifest.optional_env.find((entry) => entry.name === "MEMORY_CRYSTAL_HERMES_MODE")?.default,
  "auto",
);
assert.equal(
  manifest.optional_env.find((entry) => entry.name === "MEMORY_CRYSTAL_AUTO_RECALL_TIMEOUT")?.default,
  "16",
);

assert.equal(
  manifest.optional_env.find((entry) => entry.name === "MEMORY_CRYSTAL_CAPTURE_TURNS")?.default,
  "true",
);
assert.equal(
  manifest.optional_env.find((entry) => entry.name === "MEMORY_CRYSTAL_INJECT_RECALL")?.default,
  "false",
);
for (const name of [
  "MEMORY_CRYSTAL_API_URL",
  "CRYSTAL_CONVEX_URL",
  "MEMORY_CRYSTAL_CAPTURE_TURNS",
  "MEMORY_CRYSTAL_INJECT_RECALL",
  "MEMORY_CRYSTAL_ALLOW_GROUP_WRITES",
  "MEMORY_CRYSTAL_AGENT_SCOPE",
  "MEMORY_CRYSTAL_TIMEOUT",
  "MEMORY_CRYSTAL_RECALL_TIMEOUT",
  "MEMORY_CRYSTAL_AUTO_RECALL_TIMEOUT",
  "MEMORY_CRYSTAL_CONTEXT_CHARS",
  "MEMORY_CRYSTAL_FAILURE_THRESHOLD",
  "MEMORY_CRYSTAL_CIRCUIT_COOLDOWN",
  "MEMORY_CRYSTAL_PROVIDER_TOOLS",
  "MEMORY_CRYSTAL_MCP_CONFIGURED",
  "MEMORY_CRYSTAL_CAPTURE_QUEUE_SIZE",
  "MEMORY_CRYSTAL_CAPTURE_SHUTDOWN_FLUSH_TIMEOUT",
]) {
  assert.ok(manifest.optional_env.find((entry) => entry.name === name), `missing optional env ${name}`);
}

console.log("hermes plugin asset route smoke passed");
