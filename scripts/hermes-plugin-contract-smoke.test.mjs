#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const pluginPath = join(root, "integrations", "hermes", "crystal-memory", "__init__.py");
const source = readFileSync(pluginPath, "utf8");

assert.match(source, /class MemoryCrystalProvider/);
assert.match(source, /def register\(ctx/);
assert.match(source, /register_memory_provider/);
assert.match(source, /MEMORY_CRYSTAL_HERMES_MODE/);

const python = `
import importlib.util
import json
import os
import pathlib
import sys

path = pathlib.Path(${JSON.stringify(pluginPath)})
spec = importlib.util.spec_from_file_location("mc_hermes_contract_smoke", path)
mod = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)

class FakeClient:
    configured = True
    api_url = "https://convex.example"
    api_key = "mc_test"
    def auth(self): return {"ok": True}
    def stats(self): return {"ok": True, "total": 1}
    def wake(self, session_id, channel): return {"briefing": "ready"}
    def recall(self, query, session_id, channel, limit=6): return {"memories": [{"title": "contract", "content": "provider fixture"}]}
    def turn(self, *args, **kwargs): return {"ok": True, "messages": [{"id": "a1"}]}
    def triggers(self, tool_name): return {"memories": []}
    def tool(self, tool_name, args): return {"ok": True, "tool": tool_name}

mod._CLIENT_FACTORY = lambda: FakeClient()
mod.SESSIONS.clear()
mod.ACTIVE_MODE = "unregistered"

class ProviderCtx:
    def __init__(self):
        self.providers = []
        self.commands = []
    def register_memory_provider(self, provider):
        self.providers.append(provider)
    def register_command(self, name, fn, description=None):
        self.commands.append(name)

ctx = ProviderCtx()
mod.register(ctx)
assert mod.ACTIVE_MODE == "provider"
assert len(ctx.providers) == 1
provider = ctx.providers[0]
provider.initialize("s1", platform="cli", user_id="u1")
assert "provider fixture" in provider.prefetch("what changed?")
provider.sync_turn("hello", "world")
status = json.loads(mod.crystal_status())
assert status["activeMode"] == "provider"

mod.SESSIONS.clear()
mod.ACTIVE_MODE = "unregistered"

class HookCtx:
    def __init__(self):
        self.hooks = []
        self.commands = []
    def register_hook(self, name, fn):
        self.hooks.append(name)
    def register_command(self, name, fn, description=None):
        self.commands.append(name)

ctx = HookCtx()
mod.register(ctx)
assert mod.ACTIVE_MODE == "hooks"
assert "pre_llm_call" in ctx.hooks
assert "post_llm_call" in ctx.hooks
print("hermes plugin contract smoke passed")
`;

const result = spawnSync("python3", ["-c", python], {
  cwd: root,
  encoding: "utf8",
  env: { ...process.env, MEMORY_CRYSTAL_HERMES_MODE: "auto" },
});

if (result.status !== 0) {
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
}
assert.equal(result.status, 0);
process.stdout.write(result.stdout);
