#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
assert.match(readFileSync(join(pluginRoot, "plugin.yaml"), "utf8"), /name: crystal-memory/);

console.log("hermes plugin asset route smoke passed");
