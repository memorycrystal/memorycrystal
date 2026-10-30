// openclaw-2026-8.test.js — crystal-memory against an OpenClaw 2026.8 typed-hook
// host (api.on) and a legacy registerHook host.
// Run: node --test plugin/__tests__/openclaw-2026-8.test.js
"use strict";

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const PLUGIN_DIR = path.resolve(__dirname, "..");
const BASE_URL = "https://example.convex.site";

// PluginHookName as shipped by OpenClaw 2026.8. The fake host warns on anything else.
const HOST_HOOK_NAMES = new Set([
  "before_model_resolve", "agent_turn_prepare", "before_prompt_build", "before_agent_reply",
  "model_call_started", "model_call_ended", "llm_input", "llm_output", "before_agent_finalize",
  "agent_end", "before_compaction", "after_compaction", "before_reset", "inbound_claim",
  "channel_pairing_requested", "message_received", "message_sending", "reply_payload_sending",
  "message_sent", "before_tool_call", "after_tool_call", "tool_result_persist",
  "before_message_write", "session_start", "session_end", "subagent_delivery_target",
  "subagent_spawned", "subagent_progress", "subagent_ended", "gateway_start", "gateway_stop",
  "heartbeat_prompt_contribution", "cron_reconciled", "cron_changed", "skill_proposal_evaluate",
  "skill_proposal_changed", "skill_changed", "before_dispatch", "reply_dispatch",
  "before_install", "before_agent_run", "resolve_exec_env",
]);

// The exact 0.10.0 registerHook sequence: names and meta, in order.
const LEGACY_0_10_0_REGISTRATIONS = [
  ["before_agent_start", { name: "crystal-memory.before-agent-start", description: "Inject wake briefing + recall" }],
  ["before_tool_call", { name: "crystal-memory.before-tool-call", description: "Surface actionTriggers warnings before tool calls" }],
  ["before_dispatch", { name: "crystal-memory.before-dispatch-rate-limit", description: "Check Memory Crystal rate limit before dispatch" }],
  ["before_dispatch", { name: "crystal-memory.before-dispatch-reinforcement", description: "Re-inject cached recall for lost-in-the-middle mitigation" }],
  ["message_received", { name: "crystal-memory.message-received", description: "Buffer + persist user turn" }],
  ["llm_output", { name: "crystal-memory.llm-output", description: "Capture AI response" }],
  ["message_sending", { name: "crystal-memory.message-sending-fallback", description: "Pre-send assistant capture fallback" }],
  ["message_sent", { name: "crystal-memory.message-sent-fallback", description: "Fallback assistant capture" }],
  ["agent_end", { name: "crystal-memory.agent-end-fallback", description: "Final agent-turn capture fallback" }],
  ["session_end", { name: "crystal-memory.session-end", description: "Clear per-session caches on session end" }],
];

const strongRecallCoverage = {
  quality: "strong",
  relevanceFloor: 0.2,
  strongThreshold: 0.62,
  injectScoreThreshold: 0.35,
  memoryRelevanceMax: 0.8,
  messageRelevanceMax: 0,
};

// ── Fetch stub ─────────────────────────────────────────────────────────────────
const fetchResponses = new Map();
const fetchCalls = [];
global.fetch = async (url, opts = {}) => {
  fetchCalls.push({ url: String(url), opts });
  const override = fetchResponses.get(String(url));
  const body = override?.body ?? { ok: true, memories: [], messages: [], briefing: "" };
  return {
    ok: override?.ok ?? true,
    status: override?.status ?? 200,
    statusText: "OK",
    text: async () => JSON.stringify(body),
    json: async () => body,
  };
};
const callsTo = (endpoint) => fetchCalls.filter((call) => call.url === `${BASE_URL}${endpoint}`);
const turnBodies = () => callsTo("/api/mcp/turn").map((call) => JSON.parse(call.opts.body));

function setRecallMemories(memories) {
  fetchResponses.set(`${BASE_URL}/api/mcp/recall`, {
    body: { diagnostics: { coverage: strongRecallCoverage }, memories },
  });
}

// ── Fake hosts ─────────────────────────────────────────────────────────────────
function makeToolRegistry(getConfig) {
  const tools = new Map();
  return {
    tools,
    registerTool(tool, opts = {}) {
      if (typeof tool === "function") {
        const runtime = { plugins: { entries: { "crystal-memory": { config: { ...getConfig() } } } } };
        const materialized = tool({ config: runtime, runtimeConfig: runtime });
        for (const item of (Array.isArray(materialized) ? materialized : [materialized]).filter(Boolean)) {
          tools.set(item.name, item);
        }
        return;
      }
      tools.set(tool.name, tool);
    },
  };
}

function baseApi(config) {
  // A channel scope gives automatic writes a resolvable channel.
  const pluginConfig = { apiKey: "test-key-abc", convexUrl: BASE_URL, injectRecall: true, channelScope: "test-scope", ...config };
  const registry = makeToolRegistry(() => pluginConfig);
  return {
    id: "crystal-memory",
    pluginConfig,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    registerTool: registry.registerTool,
    registerContextEngine() {},
    _tools: registry.tools,
  };
}

// OpenClaw 2026.8: both api.on and api.registerHook exist, but typed hooks are
// dispatched only to api.on handlers. registerHook just records the call.
function makeHost2026(config = {}) {
  const api = baseApi(config);
  const onHandlers = new Map();
  api._onCalls = [];
  api._registerHookCalls = [];
  api._hostWarnings = [];
  api.on = function on(name, handler, opts) {
    api._onCalls.push({ name, opts, argc: arguments.length });
    if (!HOST_HOOK_NAMES.has(name)) {
      api._hostWarnings.push(`unknown typed hook "${name}" ignored`);
      return;
    }
    const list = onHandlers.get(name) || [];
    list.push(handler);
    onHandlers.set(name, list);
  };
  api.registerHook = function registerHook(name, _handler, meta) {
    api._registerHookCalls.push({ name, meta });
  };
  api._dispatch = async (name, event, ctx) => {
    const results = [];
    for (const handler of onHandlers.get(name) || []) results.push(await handler(event, ctx));
    return results;
  };
  api._dispatchSync = (name, event, ctx) => (onHandlers.get(name) || []).map((handler) => {
    const result = handler(event, ctx);
    assert.ok(!(result && typeof result.then === "function"), `${name} handler must be synchronous`);
    return result;
  });
  return api;
}

// Pre-2026.8 host: registerHook only.
function makeLegacyHost(config = {}) {
  const api = baseApi(config);
  const handlers = new Map();
  api._registerHookCalls = [];
  api.registerHook = function registerHook(name, handler, meta) {
    api._registerHookCalls.push({ name, meta });
    const list = handlers.get(name) || [];
    list.push(handler);
    handlers.set(name, list);
  };
  api._dispatch = async (name, event, ctx) => {
    const results = [];
    for (const handler of handlers.get(name) || []) results.push(await handler(event, ctx));
    return results;
  };
  return api;
}

function freshPlugin() {
  for (const rel of ["index.js", "utils/crystal-utils.js", "compaction/crystal-assembler.js"]) {
    delete require.cache[path.join(PLUGIN_DIR, rel)];
  }
  return require(path.join(PLUGIN_DIR, "index.js"));
}
function load(host) {
  const plugin = freshPlugin();
  plugin(host);
  return { api: host, internals: plugin.__test__ };
}

const ctxFor = (sessionKey, extra = {}) => ({ sessionKey, channelId: "ch-1", ...extra });
const resultText = (result) => (result?.content || []).map((part) => part?.text || "").join("\n");
async function statusText(api, ctx) {
  return resultText(await api._tools.get("crystal_status").execute("id", {}, null, null, ctx));
}

const savedEnv = {};
beforeEach(() => {
  fetchCalls.length = 0;
  fetchResponses.clear();
  for (const name of ["MEMORY_CRYSTAL_CAPTURE_TURNS", "MEMORY_CRYSTAL_TURN_CAPTURE"]) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
});
afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

// ── api.on path ────────────────────────────────────────────────────────────────
describe("OpenClaw 2026.8 host (api.on)", () => {
  test("registers only allowlisted 2026.8 hook names through api.on with typed opts", () => {
    const { api, internals } = load(makeHost2026());
    const { ON_HOOK_NAMES, PROMPT_BUILD_HOOK_TIMEOUT_MS, PROMPT_BUILD_RECALL_TIMEOUT_MS } = internals;

    assert.ok(Object.isFrozen(ON_HOOK_NAMES), "the api.on allowlist is frozen");
    for (const name of ON_HOOK_NAMES) assert.ok(HOST_HOOK_NAMES.has(name), `${name} is a 2026.8 hook name`);
    assert.ok(!ON_HOOK_NAMES.includes("before_agent_start"), "before_agent_start is never on the api.on path");

    assert.equal(api._registerHookCalls.length, 0, "registerHook is not used when api.on exists");
    assert.deepEqual(api._hostWarnings, [], "the host saw no unknown hook names");
    const names = api._onCalls.map((call) => call.name);
    assert.deepEqual([...names].sort(), [...ON_HOOK_NAMES].sort(), "exactly the allowlist registers, once each");

    for (const call of api._onCalls) {
      if (call.opts === undefined) continue;
      assert.equal(typeof call.opts, "object");
      for (const key of Object.keys(call.opts)) {
        assert.ok(key === "priority" || key === "timeoutMs", `${call.name} opts key ${key} is not a typed-hook option`);
      }
      assert.ok(!("name" in call.opts) && !("description" in call.opts), `${call.name} passes no registerHook meta`);
    }
    const promptBuild = api._onCalls.find((call) => call.name === "before_prompt_build");
    assert.equal(promptBuild.opts.timeoutMs, PROMPT_BUILD_HOOK_TIMEOUT_MS);
    assert.ok(PROMPT_BUILD_HOOK_TIMEOUT_MS > PROMPT_BUILD_RECALL_TIMEOUT_MS, "host timeout leaves a margin over the recall bound");
  });

  test("before_prompt_build returns a single prependContext with recall and reinforcement", async () => {
    const { api } = load(makeHost2026());
    setRecallMemories([{
      memoryId: "m-db", store: "semantic", category: "fact",
      title: "Storage engine", content: "The project stores memories in Convex.", score: 0.91, relevance: 0.8,
    }]);
    const sessionKey = "prompt-build-session";
    const prompt = "Which storage engine does the project use for memories?";

    // Prompt taken from messages when event.prompt is absent.
    const first = await api._dispatch("before_prompt_build", { messages: [{ role: "user", content: prompt }] }, ctxFor(sessionKey));
    assert.equal(first.length, 1, "one prompt-build handler");
    assert.equal(typeof first[0]?.prependContext, "string");
    assert.match(first[0].prependContext, /Relevant Memory Evidence/);
    assert.match(first[0].prependContext, /Convex/);
    const recallBody = JSON.parse(callsTo("/api/mcp/recall")[0].opts.body);
    assert.equal(recallBody.query, prompt, "recall query comes from the last user message");
    assert.ok(!/Memory Reinforcement/.test(first[0].prependContext), "no reinforcement before the threshold");

    let last;
    for (let turn = 2; turn <= 5; turn += 1) {
      last = await api._dispatch("before_prompt_build", { prompt, messages: [] }, ctxFor(sessionKey));
    }
    assert.equal(last.length, 1);
    assert.match(last[0].prependContext, /## Memory Reinforcement/, "reinforcement joins the same prependContext");
    assert.match(last[0].prependContext, /\[Recall: Storage engine\]/);

    fetchResponses.set(`${BASE_URL}/api/mcp/rate-limit-check`, { body: { allowed: true } });
    const dispatch = await api._dispatch("before_dispatch", { content: prompt }, ctxFor(sessionKey));
    assert.deepEqual(dispatch, [undefined], "before_dispatch injects nothing on the api.on path");
  });

  test("before_dispatch rate limit returns { handled, text } and nothing otherwise", async () => {
    const { api } = load(makeHost2026());
    fetchResponses.set(`${BASE_URL}/api/mcp/rate-limit-check`, { body: { allowed: false } });
    const blocked = await api._dispatch("before_dispatch", { content: "hi" }, ctxFor("rate-session"));
    assert.equal(blocked.length, 1);
    assert.equal(blocked[0].handled, true);
    assert.equal(typeof blocked[0].text, "string");
    assert.match(blocked[0].text, /rate limit/i);
    assert.deepEqual(Object.keys(blocked[0]).sort(), ["handled", "text"], "no block/reason on the api.on path");

    fetchResponses.set(`${BASE_URL}/api/mcp/rate-limit-check`, { body: { allowed: true } });
    assert.deepEqual(await api._dispatch("before_dispatch", { content: "hi" }, ctxFor("rate-session")), [undefined]);
  });

  test("guardrails are stashed per toolCallId and appended to the matching tool result", async () => {
    const { api, internals } = load(makeHost2026({ enableTriggers: true }));
    internals.guardrailStash.clear();
    const ctx = ctxFor("guardrail-session");
    const triggersUrl = `${BASE_URL}/api/mcp/triggers`;

    fetchResponses.set(triggersUrl, { body: { memories: [{ title: "Exec rule", content: "Confirm the target directory first." }] } });
    const r1 = await api._dispatch("before_tool_call", { toolName: "exec", toolCallId: "call-1", params: {} }, ctx);
    fetchResponses.set(triggersUrl, { body: { memories: [{ title: "Write rule", content: "Back up the file before overwriting." }] } });
    const r2 = await api._dispatch("before_tool_call", { toolName: "write", toolCallId: "call-2", params: {} }, ctx);
    assert.deepEqual(r1, [undefined], "before_tool_call never blocks or asks for approval");
    assert.deepEqual(r2, [undefined]);

    // Results arrive out of order; each gets only its own guardrail.
    const [p2] = api._dispatchSync("tool_result_persist", {
      toolName: "write", toolCallId: "call-2",
      message: { role: "toolResult", toolCallId: "call-2", content: [{ type: "text", text: "written" }] },
    }, ctx);
    assert.deepEqual(p2.message.content[0], { type: "text", text: "written" }, "existing content is kept");
    assert.equal(p2.message.content.length, 2);
    assert.match(p2.message.content[1].text, /\[crystal-guardrail\] Write rule/);
    assert.ok(!/Exec rule/.test(JSON.stringify(p2.message)));

    const [p1] = api._dispatchSync("tool_result_persist", {
      toolName: "exec", toolCallId: "call-1",
      message: { role: "toolResult", toolCallId: "call-1", content: "exit 0" },
    }, ctx);
    assert.match(p1.message.content, /^exit 0\n\n\[crystal-guardrail\] Exec rule/);
    assert.ok(!/Write rule/.test(p1.message.content));

    // Entries are consumed; unknown or missing ids return nothing.
    const again = api._dispatchSync("tool_result_persist", { toolCallId: "call-1", message: { role: "toolResult", content: "x" } }, ctx);
    assert.deepEqual(again, [undefined]);
    assert.deepEqual(api._dispatchSync("tool_result_persist", { message: { role: "toolResult", content: "x" } }, ctx), [undefined]);
    assert.equal(internals.guardrailStash.size, 0);
  });

  test("guardrail stash expires by TTL and stays bounded", () => {
    const { internals } = load(makeHost2026());
    const { stashGuardrail, takeGuardrail, guardrailStash, GUARDRAIL_STASH_MAX, GUARDRAIL_STASH_TTL_MS } = internals;
    guardrailStash.clear();

    const t0 = 1_000_000;
    stashGuardrail("old-call", "old text", "s", t0);
    assert.equal(takeGuardrail("old-call", t0 + GUARDRAIL_STASH_TTL_MS + 1), "", "expired entries are dropped");
    assert.equal(guardrailStash.size, 0);

    for (let i = 0; i < GUARDRAIL_STASH_MAX + 50; i += 1) stashGuardrail(`call-${i}`, `text ${i}`, "s", t0);
    assert.equal(guardrailStash.size, GUARDRAIL_STASH_MAX, "the stash never exceeds its bound");
    assert.equal(takeGuardrail("call-0", t0), "", "oldest entries are evicted first");
    assert.equal(takeGuardrail(`call-${GUARDRAIL_STASH_MAX + 49}`, t0), `text ${GUARDRAIL_STASH_MAX + 49}`);
    guardrailStash.clear();
  });
});

// ── Exactly-once capture ───────────────────────────────────────────────────────
describe("exactly-once turn capture on the api.on path", () => {
  test("message_received → llm_output → message_sending → message_sent → agent_end captures once", async () => {
    const { api } = load(makeHost2026());
    const sessionKey = "once-session";
    const ctx = ctxFor(sessionKey, { runId: "run-1" });
    const user = "Summarise the release checklist for me.";

    await api._dispatch("message_received", { content: user }, ctx);
    // llm_output carries every assistant text of the run; agent_end only the last.
    await api._dispatch("llm_output", { runId: "run-1", sessionId: sessionKey, assistantTexts: ["Looking at the checklist.", "Run tests, bump versions, tag."] }, ctx);
    const sending = await api._dispatch("message_sending", { content: "Run tests, bump versions, tag." }, ctx);
    assert.deepEqual(sending, [undefined], "message_sending returns nothing");
    await api._dispatch("message_sent", { content: "Run tests, bump versions, tag.", success: true }, ctx);
    await api._dispatch("agent_end", {
      runId: "run-1",
      success: true,
      messages: [
        { role: "user", content: user },
        { role: "assistant", content: "Looking at the checklist." },
        { role: "assistant", content: "Run tests, bump versions, tag." },
      ],
    }, ctx);

    const bodies = turnBodies();
    assert.equal(bodies.length, 1, `expected exactly one /api/mcp/turn, got ${bodies.length}`);
    assert.equal(bodies[0].sessionKey, sessionKey);
    assert.equal(bodies[0].userMessage, user);
  });

  test("the same lifecycle without run ids still captures once", async () => {
    const { api } = load(makeHost2026());
    const sessionKey = "once-no-run-session";
    const ctx = ctxFor(sessionKey);
    const user = "What changed in the last deploy?";

    await api._dispatch("message_received", { content: user }, ctx);
    await api._dispatch("llm_output", { assistantTexts: ["Checking.", "Only the docs changed."] }, ctx);
    await api._dispatch("message_sending", { content: "Only the docs changed." }, ctx);
    await api._dispatch("message_sent", { content: "Only the docs changed." }, ctx);
    await api._dispatch("agent_end", {
      success: true,
      messages: [
        { role: "user", content: user },
        { role: "assistant", content: "Checking." },
        { role: "assistant", content: "Only the docs changed." },
      ],
    }, ctx);

    assert.equal(turnBodies().length, 1);
  });

  test("two interleaved sessions each capture their own turn once", async () => {
    const { api } = load(makeHost2026());
    const a = ctxFor("interleave-a");
    const b = ctxFor("interleave-b");
    const endEvent = (user, texts) => ({
      success: true,
      messages: [{ role: "user", content: user }, ...texts.map((content) => ({ role: "assistant", content }))],
    });

    await api._dispatch("message_received", { content: "Question for session A?" }, a);
    await api._dispatch("message_received", { content: "Question for session B?" }, b);
    await api._dispatch("llm_output", { assistantTexts: ["A thinking.", "Answer for A."] }, a);
    await api._dispatch("llm_output", { assistantTexts: ["B thinking.", "Answer for B."] }, b);
    await api._dispatch("agent_end", endEvent("Question for session B?", ["B thinking.", "Answer for B."]), b);
    await api._dispatch("agent_end", endEvent("Question for session A?", ["A thinking.", "Answer for A."]), a);

    const bodies = turnBodies();
    assert.equal(bodies.length, 2, `expected one capture per session, got ${bodies.length}`);
    const bySession = Object.fromEntries(bodies.map((body) => [body.sessionKey, body]));
    assert.equal(bySession["interleave-a"].userMessage, "Question for session A?");
    assert.equal(bySession["interleave-b"].userMessage, "Question for session B?");
  });

  test("a turn without llm_output is captured by agent_end", async () => {
    const { api } = load(makeHost2026());
    const ctx = ctxFor("no-llm-output-session");
    await api._dispatch("message_received", { content: "Ping the status page please." }, ctx);
    await api._dispatch("agent_end", {
      success: true,
      messages: [{ role: "user", content: "Ping the status page please." }, { role: "assistant", content: "The status page is green." }],
    }, ctx);
    await api._dispatch("message_sent", { content: "The status page is green." }, ctx);

    const bodies = turnBodies();
    assert.equal(bodies.length, 1);
    assert.equal(bodies[0].assistantMessage, "The status page is green.");
  });

  test("two consecutive turns produce two captures", async () => {
    const { api } = load(makeHost2026());
    const ctx = ctxFor("consecutive-session");
    for (const [user, reply] of [["First question here?", "First answer here."], ["Second question here?", "Second answer here."]]) {
      await api._dispatch("message_received", { content: user }, ctx);
      await api._dispatch("llm_output", { assistantTexts: ["Thinking.", reply] }, ctx);
      await api._dispatch("agent_end", {
        success: true,
        messages: [{ role: "user", content: user }, { role: "assistant", content: "Thinking." }, { role: "assistant", content: reply }],
      }, ctx);
    }
    const bodies = turnBodies();
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies.map((body) => body.userMessage), ["First question here?", "Second question here?"]);
  });
});

// ── captureTurns switch ────────────────────────────────────────────────────────
async function runFullTurn(api, ctx) {
  await api._dispatch("before_prompt_build", { prompt: "Which storage engine does the project use for memories?" }, ctx);
  await api._dispatch("message_received", { content: "Which storage engine does the project use for memories?" }, ctx);
  await api._dispatch("llm_output", { assistantTexts: ["It uses Convex."] }, ctx);
  await api._dispatch("message_sent", { content: "It uses Convex." }, ctx);
  await api._dispatch("agent_end", {
    success: true,
    messages: [{ role: "user", content: "Which storage engine does the project use for memories?" }, { role: "assistant", content: "It uses Convex." }],
  }, ctx);
}

describe("captureTurns", () => {
  const recallMemory = {
    memoryId: "m-ct", store: "semantic", category: "fact",
    title: "Storage engine", content: "The project stores memories in Convex.", score: 0.91, relevance: 0.8,
  };

  test("defaults to on and reports source=default", async () => {
    const { api } = load(makeHost2026());
    const ctx = ctxFor("capture-default-session");
    await runFullTurn(api, ctx);
    assert.equal(turnBodies().length, 1);
    assert.match(await statusText(api, ctx), /Capture turns: captureTurns=on \(source=default\)/);
  });

  test("captureTurns=false in config sends zero turn captures while recall still works", async () => {
    const { api } = load(makeHost2026({ captureTurns: false }));
    setRecallMemories([recallMemory]);
    const ctx = ctxFor("capture-config-off-session");
    const [built] = await api._dispatch("before_prompt_build", { prompt: "Which storage engine does the project use for memories?" }, ctx);
    assert.match(built.prependContext, /Relevant Memory Evidence/, "recall is unaffected");
    await runFullTurn(api, ctx);
    assert.equal(callsTo("/api/mcp/turn").length, 0, "no turn-capture requests");
    assert.match(await statusText(api, ctx), /Capture turns: captureTurns=off \(source=config\)/);
  });

  test("MEMORY_CRYSTAL_CAPTURE_TURNS overrides config", async () => {
    process.env.MEMORY_CRYSTAL_CAPTURE_TURNS = "false";
    const { api } = load(makeHost2026({ captureTurns: true }));
    setRecallMemories([recallMemory]);
    const ctx = ctxFor("capture-env-off-session");
    const [built] = await api._dispatch("before_prompt_build", { prompt: "Which storage engine does the project use for memories?" }, ctx);
    assert.match(built.prependContext, /Relevant Memory Evidence/, "recall is unaffected");
    await runFullTurn(api, ctx);
    assert.equal(callsTo("/api/mcp/turn").length, 0, "env off wins over config on");
    assert.match(await statusText(api, ctx), /Capture turns: captureTurns=off \(source=env\)/);

    process.env.MEMORY_CRYSTAL_CAPTURE_TURNS = "true";
    const { api: api2 } = load(makeHost2026({ captureTurns: false }));
    assert.match(await statusText(api2, ctx), /Capture turns: captureTurns=on \(source=env\)/);
  });
});

// ── Status ─────────────────────────────────────────────────────────────────────
describe("status", () => {
  test("api.on host: status shows the host API and exactly the registered hook names", async () => {
    const { api } = load(makeHost2026());
    const text = await statusText(api, ctxFor("status-on-session"));
    assert.match(text, /^Host API: on$/m);
    assert.match(text, /^Hooks: api=on, registered=10,/m);
    const doctor = resultText(await api._tools.get("crystal_doctor").execute("id", {}, null, null, ctxFor("status-on-session")));
    assert.match(doctor, /^Hook API: on$/m);
    const line = doctor.split("\n").find((l) => l.startsWith("Hook registrations: "));
    const reported = line.slice("Hook registrations: ".length).split(", ");
    assert.deepEqual([...reported].sort(), [...new Set(api._onCalls.map((call) => call.name))].sort());
    assert.match(text, /Capture turns: captureTurns=on/);
  });

  test("legacy host: status shows registerHook", async () => {
    const { api } = load(makeLegacyHost());
    const text = await statusText(api, ctxFor("status-legacy-session"));
    assert.match(text, /^Host API: registerHook$/m);
    assert.match(text, /^Hooks: api=registerHook, registered=9,/m);
  });
});

// ── Legacy registerHook parity with 0.10.0 ─────────────────────────────────────
describe("legacy registerHook host (0.10.0 parity)", () => {
  test("registers the exact 0.10.0 names and meta, in order", () => {
    const { api } = load(makeLegacyHost());
    assert.deepEqual(
      api._registerHookCalls.map((call) => [call.name, call.meta]),
      LEGACY_0_10_0_REGISTRATIONS,
    );
  });

  test("keeps 0.10.0 behaviour: before_agent_start recall, {warning}, {block, reason}, before_dispatch reinforcement", async () => {
    const { api, internals } = load(makeLegacyHost({ enableTriggers: true }));
    setRecallMemories([{
      memoryId: "m-legacy", store: "semantic", category: "fact",
      title: "Storage engine", content: "The project stores memories in Convex.", score: 0.91, relevance: 0.8,
    }]);
    const sessionKey = "legacy-session";
    const ctx = ctxFor(sessionKey);

    const [start] = await api._dispatch("before_agent_start", { prompt: "Which storage engine does the project use for memories?" }, ctx);
    assert.match(start.prependContext, /Relevant Memory Evidence/);

    fetchResponses.set(`${BASE_URL}/api/mcp/triggers`, { body: { memories: [{ title: "Exec rule", content: "Confirm first." }] } });
    const [tool] = await api._dispatch("before_tool_call", { toolName: "exec" }, ctx);
    assert.match(tool.warning, /\[crystal-guardrail\] Exec rule/);

    fetchResponses.set(`${BASE_URL}/api/mcp/rate-limit-check`, { body: { allowed: false } });
    const [rateLimit, reinforcementIdle] = await api._dispatch("before_dispatch", { content: "hi" }, ctx);
    assert.equal(rateLimit.block, true);
    assert.match(rateLimit.reason, /rate limit/i);
    assert.equal(reinforcementIdle, undefined, "0.10.0 never counts turns on the legacy path");

    internals.reinforcementTurnCounters.set(sessionKey, 5);
    fetchResponses.set(`${BASE_URL}/api/mcp/rate-limit-check`, { body: { allowed: true } });
    const [allowed, reinforcement] = await api._dispatch("before_dispatch", { content: "hi" }, ctx);
    assert.equal(allowed, undefined);
    assert.match(reinforcement.prependContext, /## Memory Reinforcement/);
  });

  test("legacy capture still persists a turn once", async () => {
    const { api } = load(makeLegacyHost());
    const ctx = ctxFor("legacy-capture-session");
    await api._dispatch("message_received", { content: "Legacy question here?" }, ctx);
    await api._dispatch("llm_output", { assistantTexts: ["Legacy answer here."] }, ctx);
    await api._dispatch("message_sent", { content: "Legacy answer here." }, ctx);
    await api._dispatch("agent_end", {
      success: true,
      messages: [{ role: "user", content: "Legacy question here?" }, { role: "assistant", content: "Legacy answer here." }],
    }, ctx);
    assert.equal(turnBodies().length, 1);
  });
});
