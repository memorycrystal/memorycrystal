// index.test.js — Integration tests for the crystal-memory plugin (Phase 2)
// Uses node:test. Run: node --test plugin/index.test.js
"use strict";

const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const { getPeerId, getChannelKey } = require("./utils/crystal-utils");

/** Extract the full text from a message's content (string or array of parts). */
function msgText(msg) {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) return msg.content.map((p) => p.text || "").join("");
  return "";
}

// ── Fetch mock ─────────────────────────────────────────────────────────────────
// Intercepts all HTTP calls made by the plugin (Convex endpoints).
// Returns { ok: true } for everything so no real network calls go out.
const fetchResponses = new Map();
const fetchCalls = [];
global.fetch = async (url, _opts = {}) => {
  fetchCalls.push({ url, opts: _opts });
  const override = fetchResponses.get(url) || { ok: true, json: async () => ({ ok: true, memories: [], messages: [], briefing: "" }) };
  return {
    ok: override.ok ?? true,
    status: override.status ?? 200,
    statusText: override.statusText ?? "OK",
    text: async () => JSON.stringify(override.body || {}),
    json: override.json ?? (async () => override.body ?? { ok: true, memories: [], messages: [] }),
  };
};

// ── Minimal api mock ───────────────────────────────────────────────────────────
function makeApi(config = {}) {
  const tools = new Map();
  const toolFactories = new Map();
  const hooks = new Map();
  const hookLists = new Map();
  let contextEngine = null;

  function rememberHook(event, handler) {
    const list = hookLists.get(event) || [];
    list.push(handler);
    hookLists.set(event, list);
    hooks.set(event, handler);
  }

  return {
    id: "crystal-memory",
    pluginConfig: { apiKey: "test-key-abc", convexUrl: "https://example.convex.site", ...config },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
    on(event, handler, _meta) {
      rememberHook(event, handler);
    },
    registerHook(event, handler, _meta) {
      rememberHook(event, handler);
    },
    registerTool(tool, opts = {}) {
      if (typeof tool === "function") {
        const names = []
          .concat(opts?.name || [])
          .concat(Array.isArray(opts?.names) ? opts.names : []);
        const factoryKey = names[0] || `__factory_${toolFactories.size}`;
        toolFactories.set(factoryKey, tool);
        const materialized = tool({ config: { plugins: { entries: { "crystal-memory": { config: { ...this.pluginConfig } } } } }, runtimeConfig: { plugins: { entries: { "crystal-memory": { config: { ...this.pluginConfig } } } } } });
        const list = Array.isArray(materialized) ? materialized : [materialized];
        for (const item of list.filter(Boolean)) {
          tools.set(item.name, item);
          toolFactories.set(item.name, tool);
        }
        return;
      }
      tools.set(tool.name, tool);
    },
    registerContextEngine(nameOrEngine, factory) {
      if (typeof factory === "function") {
        contextEngine = factory();
      } else {
        contextEngine = nameOrEngine;
      }
    },
    // Test helpers
    _tools: tools,
    _toolFactories: toolFactories,
    _materializeTool(name, ctx = {}) {
      const factory = toolFactories.get(name);
      if (!factory) return tools.get(name);
      const materialized = factory(ctx);
      if (Array.isArray(materialized)) return materialized.find((tool) => tool?.name === name);
      return materialized;
    },
    _hooks: hooks,
    _hookLists: hookLists,
    _getEngine: () => contextEngine,
  };
}

function makeCtx(overrides = {}) {
  return { sessionKey: "test-session-abc", channelId: "ch-1", ...overrides };
}

function makeEvent(overrides = {}) {
  return { content: "hello world", prompt: "hello world", sessionKey: "test-session-abc", ...overrides };
}

function makeTmpDbPath() {
  return path.join(os.tmpdir(), `crystal-plugin-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

// ── Load plugin ────────────────────────────────────────────────────────────────
// Re-require fresh for each test suite to avoid shared state contamination.
function loadPlugin(config) {
  // Bust require cache so each test gets a fresh module state
  const pluginPath = path.resolve(__dirname, "index.js");
  delete require.cache[pluginPath];
  const utilsPath = path.resolve(__dirname, "utils/crystal-utils.js");
  delete require.cache[utilsPath];
  const assemblerPath = path.resolve(__dirname, "compaction/crystal-assembler.js");
  delete require.cache[assemblerPath];
  const pluginFactory = require(pluginPath);
  const api = makeApi(config);
  pluginFactory(api);
  return api;
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("crystal-memory plugin — Phase 2 integration", () => {
  test("1. Plugin loads and registers context engine in reduced mode by default", () => {
    const api = loadPlugin();
    const engine = api._getEngine();
    assert.ok(engine, "context engine should be registered");
    assert.equal(engine.info.name, "crystal-memory");
    assert.equal(engine.info.ownsCompaction, false);
    // Core hooks should be registered
    assert.ok(api._hooks.has("before_agent_start"), "before_agent_start hook");
    assert.ok(api._hooks.has("message_received"), "message_received hook");
    assert.ok(api._hooks.has("llm_output"), "llm_output hook");
    assert.ok(api._hooks.has("message_sent"), "message_sent hook");
    // Convex tools should be registered
    const toolNames = [...api._tools.keys()];
    assert.ok(toolNames.includes("memory_search"), "memory_search tool");
    assert.ok(toolNames.includes("crystal_recall"), "crystal_recall tool");
    assert.ok(toolNames.includes("crystal_debug_recall"), "crystal_debug_recall tool");
    assert.ok(toolNames.includes("crystal_remember"), "crystal_remember tool");
    assert.ok(toolNames.includes("crystal_update"), "crystal_update tool");
    assert.ok(toolNames.includes("crystal_supersede"), "crystal_supersede tool");
    assert.ok(toolNames.includes("crystal_supercede"), "crystal_supercede alias tool");
    assert.ok(toolNames.includes("crystal_set_scope"), "crystal_set_scope tool");
    assert.ok(toolNames.includes("crystal_checkpoint"), "crystal_checkpoint tool");
    assert.ok(toolNames.includes("memory_get"), "memory_get tool");
    for (const name of ["crystal_remember", "crystal_update", "crystal_supersede"]) {
      assert.ok(api._tools.get(name).parameters.properties.category.enum.includes("skill"), `${name} supports skill category`);
    }
  });

  test("1d. assistant text hashing is stable and content-sensitive", () => {
    loadPlugin();
    const plugin = require(path.resolve(__dirname, "index.js"));
    const { computeAssistTextHash } = plugin.__test__;
    assert.equal(computeAssistTextHash(" hello "), computeAssistTextHash("hello"));
    assert.notEqual(computeAssistTextHash("hello"), computeAssistTextHash("hello!"));
  });

  test("1e. assistant LRU dedupe is session-scoped and evicts oldest over cap", () => {
    loadPlugin();
    const plugin = require(path.resolve(__dirname, "index.js"));
    const { recentlyWrittenAssist, noteAssistWrite, hasRecentlyWrittenAssist, constants } = plugin.__test__;
    recentlyWrittenAssist.clear();

    noteAssistWrite("session-a", "same answer", 1_000);
    assert.equal(hasRecentlyWrittenAssist("session-a", "same answer", 1_001), true);
    assert.equal(hasRecentlyWrittenAssist("session-b", "same answer", 1_002), false);

    recentlyWrittenAssist.clear();
    for (let i = 0; i < constants.ASSIST_DEDUPE_MAX + 1; i++) {
      noteAssistWrite(`session-${i}`, `answer-${i}`, 2_000 + i);
    }
    assert.equal(recentlyWrittenAssist.size, constants.ASSIST_DEDUPE_MAX);
    assert.equal(hasRecentlyWrittenAssist("session-0", "answer-0", 3_000), false);
    assert.equal(hasRecentlyWrittenAssist(`session-${constants.ASSIST_DEDUPE_MAX}`, `answer-${constants.ASSIST_DEDUPE_MAX}`, 3_000), true);
  });

  test("1f. stalled capture detector gates by threshold, age, and debounce", () => {
    loadPlugin();
    const plugin = require(path.resolve(__dirname, "index.js"));
    const { captureStalledState, noteUserMessage, shouldEmitCaptureStalled, constants } = plugin.__test__;
    captureStalledState.clear();

    const sessionKey = "stall-session";
    for (let i = 0; i < constants.STALLED_PENDING_THRESHOLD; i++) {
      noteUserMessage(sessionKey, 1_000 + i);
    }
    assert.equal(shouldEmitCaptureStalled(sessionKey, 1_000 + constants.STALLED_AGE_MS + 1), null);
    noteUserMessage(sessionKey, 2_000);
    assert.equal(shouldEmitCaptureStalled(sessionKey, 1_000 + constants.STALLED_AGE_MS - 1), null);
    const state = shouldEmitCaptureStalled(sessionKey, 2_000 + constants.STALLED_AGE_MS + 1);
    assert.ok(state);
    state.lastEmittedAt = 2_000 + constants.STALLED_AGE_MS + 1;
    assert.equal(shouldEmitCaptureStalled(sessionKey, state.lastEmittedAt + constants.STALLED_DEBOUNCE_MS - 1), null);
  });

  test("1g. stalled metric emitter swallows missing backend", async () => {
    const api = loadPlugin();
    const plugin = require(path.resolve(__dirname, "index.js"));
    const { captureStalledState, noteUserMessage, emitCaptureStalledMetric, constants } = plugin.__test__;
    captureStalledState.clear();
    fetchCalls.length = 0;
    fetchResponses.set("https://example.convex.site/api/mcp/metric", {
      ok: false,
      status: 404,
      body: { error: "missing" },
    });
    try {
      const sessionKey = "metric-missing-backend";
      for (let i = 0; i < constants.STALLED_PENDING_THRESHOLD + 1; i++) {
        noteUserMessage(sessionKey, 1_000 + i);
      }
      await assert.doesNotReject(() =>
        emitCaptureStalledMetric(api, makeCtx({ sessionKey }), sessionKey, "test-channel", 2_000 + constants.STALLED_AGE_MS + 1)
      );
      assert.equal(fetchCalls.at(-1).url, "https://example.convex.site/api/mcp/metric");
    } finally {
      fetchResponses.delete("https://example.convex.site/api/mcp/metric");
    }
  });

  test("1h. runtime metrics exposes expected callback keys", () => {
    loadPlugin();
    const plugin = require(path.resolve(__dirname, "index.js"));
    assert.deepEqual(Object.keys(plugin.__runtimeMetrics.callbacks).sort(), [
      "afterTurn",
      "assemble",
      "beforeAgentStart",
      "compact",
      "ingestBatch",
      "llmOutput",
      "messageReceived",
      "messageSent",
    ]);
  });

  test("1a. Update and supersede tools call their dedicated endpoints", async () => {
    const api = loadPlugin();
    const ctx = makeCtx({ sessionKey: "agent:agent-a:main" });

    fetchCalls.length = 0;
    await api._tools.get("crystal_update").execute("id", {
      memoryId: "mem-1",
      title: "Updated memory title",
      actionTriggers: ["crystal_recall"],
    }, null, null, ctx);
    assert.equal(fetchCalls.at(-1).url.endsWith("/api/mcp/update"), true);
    const updatePayload = JSON.parse(fetchCalls.at(-1).opts.body);
    assert.equal(updatePayload.memoryId, "mem-1");
    assert.deepEqual(updatePayload.actionTriggers, ["crystal_recall"]);

    fetchCalls.length = 0;
    await api._tools.get("crystal_supersede").execute("id", {
      oldMemoryId: "mem-1",
      title: "Replacement memory title",
      content: "Replacement memory content",
      reason: "corrected fact",
    }, null, null, ctx);
    assert.equal(fetchCalls.at(-1).url.endsWith("/api/mcp/supersede"), true);
    const supersedePayload = JSON.parse(fetchCalls.at(-1).opts.body);
    assert.equal(supersedePayload.oldMemoryId, "mem-1");
    assert.equal(supersedePayload.reason, "corrected fact");
  });

  test("1aa. Write tools preserve contradiction metadata from backend responses", async () => {
    const api = loadPlugin();
    const ctx = makeCtx({ sessionKey: "agent:agent-a:main" });
    const baseUrl = "https://example.convex.site";
    const contradiction = {
      detected: true,
      memoryId: "mem-existing",
      reason: "Conflicts with existing memory",
    };
    const contradictionCheck = {
      checked: true,
      candidateCount: 1,
    };

    fetchResponses.set(`${baseUrl}/api/mcp/capture`, {
      body: { ok: true, id: "mem-new", contradiction, contradictionCheck },
    });
    fetchResponses.set(`${baseUrl}/api/mcp/update`, {
      body: { success: true, memoryId: "mem-1", contradiction, contradictionCheck },
    });
    fetchResponses.set(`${baseUrl}/api/mcp/supersede`, {
      body: {
        success: true,
        action: "superseded",
        oldMemoryId: "mem-1",
        newMemoryId: "mem-2",
        contradiction,
        contradictionCheck,
      },
    });

    try {
      const rememberResult = await api._tools.get("crystal_remember").execute("id", {
        store: "semantic",
        category: "fact",
        title: "Contradictory memory title",
        content: "New content that may conflict.",
      }, null, null, ctx);
      const rememberPayload = JSON.parse(rememberResult.content[0].text);
      assert.deepEqual(rememberPayload.contradiction, contradiction);
      assert.deepEqual(rememberPayload.contradictionCheck, contradictionCheck);

      const updateResult = await api._tools.get("crystal_update").execute("id", {
        memoryId: "mem-1",
        title: "Updated memory title",
      }, null, null, ctx);
      const updatePayload = JSON.parse(updateResult.content[0].text);
      assert.deepEqual(updatePayload.contradiction, contradiction);
      assert.deepEqual(updatePayload.contradictionCheck, contradictionCheck);

      const supersedeResult = await api._tools.get("crystal_supersede").execute("id", {
        oldMemoryId: "mem-1",
        title: "Replacement memory title",
        content: "Replacement memory content",
      }, null, null, ctx);
      const supersedePayload = JSON.parse(supersedeResult.content[0].text);
      assert.deepEqual(supersedePayload.contradiction, contradiction);
      assert.deepEqual(supersedePayload.contradictionCheck, contradictionCheck);
    } finally {
      fetchResponses.delete(`${baseUrl}/api/mcp/capture`);
      fetchResponses.delete(`${baseUrl}/api/mcp/update`);
      fetchResponses.delete(`${baseUrl}/api/mcp/supersede`);
    }
  });

  test("1ab. Tool preamble tells the agent to offer contradiction resolution choices", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "index.js"), "utf8");

    assert.match(source, /contradiction\.detected:\s*true/);
    assert.match(source, /offer explicit resolution choices/i);
    assert.match(source, /update the old memory, supersede it, keep both with clarified scope, or cancel for now/i);
  });

  test("1b. Plugin registers full context engine ownership when explicitly configured", () => {
    const api = loadPlugin({ contextEngineMode: "full", localStoreEnabled: true });
    const engine = api._getEngine();
    assert.ok(engine, "context engine should be registered");
    assert.equal(engine.info.ownsCompaction, true);
  });

  test("1c. hook-only mode skips context engine registration entirely", () => {
    const api = loadPlugin({ contextEngineMode: "hook-only" });
    const engine = api._getEngine();
    assert.equal(engine, null);
    assert.ok(api._hooks.has("before_agent_start"), "hook-only mode still registers lifecycle hooks");
    assert.ok(api._tools.has("memory_search"), "hook-only mode still registers tools");
  });

  test("2. ingestBatch hook: messages are queued and flushed to Convex", async () => {
    const api = loadPlugin();
    const engine = api._getEngine();
    const ctx = makeCtx();
    const payload = {
      sessionKey: "test-session-abc",
      messages: [
        { role: "user", content: "What is the capital of France?" },
        { role: "assistant", content: "Paris is the capital of France." },
      ],
    };
    // Should not throw; returns flushed count
    const result = await engine.ingestBatch(payload, ctx);
    assert.ok(result === undefined || typeof result === "object", "ingestBatch returns undefined or object");
  });

  test("3. assemble hook: returns messages array (with or without system prepend)", async () => {
    const api = loadPlugin();
    const engine = api._getEngine();
    const ctx = makeCtx();
    const payload = {
      sessionKey: "test-session-abc",
      budget: 100000,
      messages: [
        { role: "user", content: "What is the capital of France?" },
      ],
    };
    const result = await engine.assemble(payload, ctx);
    assert.ok(result && typeof result === "object", "assemble returns object");
    assert.ok(Array.isArray(result.messages), "result.messages is array");
    assert.ok(result.messages.length >= 1, "at least original message preserved");
    assert.ok(typeof result.used === "number", "result.used is number");
    // If a system message is prepended, it must come first
    if (result.messages.length > 1 && result.messages[0].role === "system") {
      assert.ok(Array.isArray(result.messages[0].content), "system message has array content parts");
      assert.ok(result.messages[0].content.length > 0, "system message content is non-empty");
      assert.ok(typeof result.messages[0].content[0].text === "string", "system message content part has text");
    }
  });

  test("3a. reduced mode assemble fetches recall without prepending startup-style system context", async () => {
    const api = loadPlugin({ contextEngineMode: "reduced" });
    const engine = api._getEngine();
    const ctx = makeCtx();
    fetchCalls.length = 0;
    const result = await engine.assemble({
      sessionKey: "test-session-abc",
      tokenBudget: 100000,
      messages: [{ role: "user", content: "What is the capital of France?" }],
    }, ctx);
    assert.ok(Array.isArray(result.messages), "result.messages is array");
    assert.equal(result.messages.some((msg) => msg.role === "system"), false, "reduced mode should not prepend startup recall during assemble");
    assert.equal(fetchCalls.some((call) => call.url.endsWith("/api/mcp/recall")), true, "reduced mode assemble should still fetch remote recall");
  });

  test("4. compact hook: returns status string, does not throw", async () => {
    const api = loadPlugin();
    const engine = api._getEngine();
    const ctx = makeCtx();
    const payload = {
      sessionKey: "test-session-abc",
      reason: "context_window_full",
      messages: [{ role: "user", content: "Lots of old messages" }],
    };
    const result = await engine.compact(payload, ctx);
    // Should return a string or null — never throw
    assert.ok(result === null || typeof result === "string", `compact returned: ${typeof result}`);
    if (typeof result === "string") {
      assert.ok(result.includes("Memory Crystal") || result.includes("compaction"), "result mentions compaction");
    }
  });

  test("4a. reduced mode compact skips compaction ownership work", async () => {
    const api = loadPlugin({ contextEngineMode: "reduced" });
    const engine = api._getEngine();
    const result = await engine.compact({
      sessionKey: "test-session-abc",
      reason: "context_window_full",
      messages: [{ role: "user", content: "Lots of old messages" }],
    }, makeCtx());
    assert.equal(result, "Memory Crystal compaction skipped in reduced mode");
  });

  test("4b. compact hook sends sourceSnapshotId as a top-level capture field", async () => {
    const api = loadPlugin({ contextEngineMode: "full", localStoreEnabled: true });
    const engine = api._getEngine();
    const ctx = makeCtx();
    fetchCalls.length = 0;

    const snapshotUrl = "https://example.convex.site/api/mcp/snapshot";
    const captureUrl = "https://example.convex.site/api/mcp/capture";

    fetchResponses.set(snapshotUrl, {
      ok: true,
      json: async () => ({ id: "snapshot-123" }),
    });
    fetchResponses.set(captureUrl, {
      ok: true,
      json: async () => ({ id: "capture-456" }),
    });

    await engine.compact({
      sessionKey: "test-session-abc",
      reason: "context_window_full",
      messages: [{ role: "user", content: "Lots of old messages" }],
    }, ctx);

    const captureCall = fetchCalls.find((call) => call.url === captureUrl);
    assert.ok(captureCall, "capture request should be sent");
    const payload = JSON.parse(captureCall.opts.body);
    assert.equal(payload.sourceSnapshotId, "snapshot-123");
    assert.equal("metadata" in payload, false);

    fetchResponses.delete(snapshotUrl);
    fetchResponses.delete(captureUrl);
  });

  test("5. afterTurn hook: completes without error", async () => {
    const api = loadPlugin();
    const engine = api._getEngine();
    const ctx = makeCtx();
    const payload = { sessionKey: "test-session-abc" };
    // afterTurn returns undefined — just must not throw
    await assert.doesNotReject(async () => {
      await engine.afterTurn(payload, ctx);
    });
  });

  test("5a. crystal_doctor reports context engine mode and callback counters", async () => {
    const api = loadPlugin({ contextEngineMode: "reduced" });
    const engine = api._getEngine();
    await engine.assemble({
      sessionKey: "doctor-session",
      tokenBudget: 1000,
      messages: [{ role: "user", content: "hi" }],
    }, makeCtx({ sessionKey: "doctor-session" }));
    const result = await api._tools.get("crystal_doctor").execute("id", {}, null, null, makeCtx());
    const text = result.content[0].text;
    assert.match(text, /Context engine mode: reduced/);
    assert.match(text, /Context engine registered: yes/);
    assert.match(text, /Owns compaction: no/);
    assert.match(text, /Callback counts:/);
  });

  test("5b. crystal_doctor detects OpenClaw dispatch gap when only message_received fires", async () => {
    const api = loadPlugin({ contextEngineMode: "full", localStoreEnabled: true });
    const hook = api._hooks.get("message_received");
    assert.ok(typeof hook === "function", "message_received hook is a function");

    for (let i = 0; i < 6; i += 1) {
      await hook(
        makeEvent({ content: `runtime dispatch probe ${i}`, prompt: `runtime dispatch probe ${i}`, sessionKey: "dispatch-gap-session" }),
        makeCtx({ sessionKey: "dispatch-gap-session" })
      );
    }

    const result = await api._tools.get("crystal_doctor").execute("id", {}, null, null, makeCtx({ sessionKey: "dispatch-gap-session" }));
    const text = result.content[0].text;

    assert.match(text, /Callback counts: before_agent_start=0, message_received=6, llm_output=0/);
    assert.match(text, /assemble=0/);
    assert.match(text, /afterTurn=0/);
    assert.match(text, /Dispatch diagnostic: WARNING/);
    assert.match(text, /OpenClaw runtime dispatch gap likely/);
    assert.match(text, /message_received fired 6×, but before_agent_start, llm_output, assemble, and afterTurn are all 0/);
    assert.match(text, /Memory Crystal config/);
  });

  test("6. before_agent_start hook: returns prependContext or undefined", async () => {
    const api = loadPlugin();
    const hook = api._hooks.get("before_agent_start");
    assert.ok(typeof hook === "function", "before_agent_start is a function");
    const event = makeEvent({ prompt: "test query" });
    const ctx = makeCtx();
    // Returns object with prependContext or undefined
    await assert.doesNotReject(async () => {
      const result = await hook(event, ctx);
      if (result !== undefined) {
        assert.ok(typeof result.prependContext === "string", "prependContext is string");
        assert.ok(result.prependContext.length > 0, "prependContext is non-empty");
      }
    });
  });

  test("6b. injected guidance prefers generic memory wording and silent obvious saves", async () => {
    const api = loadPlugin();
    const hook = api._hooks.get("before_agent_start");
    assert.ok(typeof hook === "function", "before_agent_start is a function");

    const result = await hook(makeEvent({ prompt: "Remember the deployment rule for production" }), makeCtx());
    assert.ok(result && typeof result.prependContext === "string", "prependContext is returned");

    const text = result.prependContext;
    assert.match(text, /In normal replies, say "memory" rather than "Memory Crystal"/i);
    assert.match(text, /Save clear durable memories without asking first/i);
    assert.match(text, /Ask before saving only when the memory is ambiguous, sensitive, private, or consent-dependent/i);
    assert.equal(text.includes("Want me to save this to Crystal?"), false);

    for (const name of ["memory_search", "memory_get", "crystal_recall", "crystal_remember"]) {
      const tool = api._tools.get(name);
      assert.ok(tool, `${name} tool should be registered`);
      assert.equal(tool.description.includes("Memory Crystal"), false, `${name} description should stay generic`);
    }

    assert.match(api._tools.get("crystal_doctor").description, /Memory Crystal plugin/);
  });

  test("6c. before_agent_start still fails closed for non-agent shared sessions without a concrete peer channel", async () => {
    fetchCalls.length = 0;
    const api = loadPlugin({ channelScope: "morrow-coach" });
    const hook = api._hooks.get("before_agent_start");
    assert.ok(typeof hook === "function", "before_agent_start is a function");

    const result = await hook(
      makeEvent({ prompt: "How should I respond to this client?", sessionKey: "shared:coach:main" }),
      makeCtx({ sessionKey: "shared:coach:main" })
    );

    assert.ok(result && typeof result.prependContext === "string", "prependContext is returned");
    assert.match(result.prependContext, /Active Memory Backend/);

    const urls = fetchCalls.map((call) => call.url);
    assert.equal(urls.some((url) => url.endsWith("/api/mcp/wake")), false);
    assert.equal(urls.some((url) => url.endsWith("/api/mcp/recall")), false);
    assert.equal(urls.some((url) => url.endsWith("/api/mcp/search-messages")), false);
    assert.equal(urls.some((url) => url.endsWith("/api/mcp/recent-messages")), false);
  });

  test("6d. before_agent_start uses the concrete peer-scoped Morrow channel when peerId is present", async () => {
    fetchCalls.length = 0;
    const api = loadPlugin({ channelScope: "morrow-coach" });
    const hook = api._hooks.get("before_agent_start");
    assert.ok(typeof hook === "function", "before_agent_start is a function");

    await hook(
      makeEvent({ prompt: "How should I respond to this client?", sessionKey: "agent:coach:main" }),
      makeCtx({ sessionKey: "agent:coach:main", peerId: "12345" })
    );

    const wakeCall = fetchCalls.find((call) => call.url.endsWith("/api/mcp/wake"));
    assert.ok(wakeCall, "wake request should be sent for concrete peer scope");
    assert.equal(JSON.parse(wakeCall.opts.body).channel, "morrow-coach:12345");

    const recallCall = fetchCalls.find((call) => call.url.endsWith("/api/mcp/recall"));
    assert.ok(recallCall, "recall request should be sent for concrete peer scope");
    assert.equal(JSON.parse(recallCall.opts.body).channel, "morrow-coach:12345");
  });

  test("6e. before_agent_start searches same-peer messages when peer scope is concrete", async () => {
    fetchCalls.length = 0;
    const api = loadPlugin({ channelScope: "morrow-coach" });
    const hook = api._hooks.get("before_agent_start");
    assert.ok(typeof hook === "function", "before_agent_start is a function");

    await hook(
      makeEvent({ prompt: "What are my daughters names and birthdays?", sessionKey: "agent:coach:main" }),
      makeCtx({ sessionKey: "agent:coach:main", peerId: "511172388" })
    );

    const searchCall = fetchCalls.find((call) => call.url.endsWith("/api/mcp/search-messages"));
    assert.ok(searchCall, "search-messages request should be sent for concrete peer scope");
    assert.equal(JSON.parse(searchCall.opts.body).channel, "morrow-coach:511172388");

    const recentCall = fetchCalls.find((call) => call.url.endsWith("/api/mcp/recent-messages"));
    assert.ok(recentCall, "recent-messages request should be sent for concrete peer scope");
    assert.equal(JSON.parse(recentCall.opts.body).channel, "morrow-coach:511172388");
  });

  test("6ea. before_agent_start uses shared main scope for trusted agent sessions on the read path", async () => {
    fetchCalls.length = 0;
    const api = loadPlugin({ channelScope: "morrow-coach" });
    const hook = api._hooks.get("before_agent_start");
    assert.ok(typeof hook === "function", "before_agent_start is a function");

    await hook(
      makeEvent({ prompt: "What do I already know for the main agent?", sessionKey: "agent:main:main" }),
      makeCtx({ sessionKey: "agent:main:main" })
    );

    const wakeCall = fetchCalls.find((call) => call.url.endsWith("/api/mcp/wake"));
    assert.ok(wakeCall, "wake request should be sent for trusted shared agent sessions");
    assert.equal(JSON.parse(wakeCall.opts.body).channel, "morrow-coach:main");

    const recallCall = fetchCalls.find((call) => call.url.endsWith("/api/mcp/recall"));
    assert.ok(recallCall, "recall request should be sent for trusted shared agent sessions");
    assert.equal(JSON.parse(recallCall.opts.body).channel, "morrow-coach:main");
  });

  test("6f. before_agent_start can inject the full recall debug payload when enabled", async () => {
    fetchCalls.length = 0;
    const api = loadPlugin({ debugRecallOutput: true });
    const hook = api._hooks.get("before_agent_start");
    assert.ok(typeof hook === "function", "before_agent_start is a function");

    const recallUrl = "https://example.convex.site/api/mcp/recall";
    const searchUrl = "https://example.convex.site/api/mcp/search-messages";
    const recentUrl = "https://example.convex.site/api/mcp/recent-messages";
    const wakeUrl = "https://example.convex.site/api/mcp/wake";
    const fullMemoryContent = "April 2 planning notes: ".concat("debug payload should keep this content untrimmed. ".repeat(20)).trim();

    fetchResponses.set(wakeUrl, {
      ok: true,
      json: async () => ({ briefing: "Wake summary for debug." }),
    });
    fetchResponses.set(recallUrl, {
      ok: true,
      json: async () => ({
        memories: [
          {
            memoryId: "mem_apr2",
            store: "episodic",
            category: "event",
            title: "April 2 work log",
            content: fullMemoryContent,
            score: 0.91,
            confidence: 0.88,
            tags: ["april", "history"],
          },
        ],
      }),
    });
    fetchResponses.set(searchUrl, {
      ok: true,
      json: async () => ({
        messages: [
          { role: "user", content: "What did we work on on April 2nd?", timestamp: Date.parse("2026-04-02T10:00:00Z") },
        ],
      }),
    });
    fetchResponses.set(recentUrl, {
      ok: true,
      json: async () => ({
        messages: [
          { role: "user", content: "We worked on recall debugging.", createdAt: Date.parse("2026-04-02T10:00:00Z") },
          { role: "assistant", content: "We patched the plugin output path.", createdAt: Date.parse("2026-04-02T10:05:00Z") },
        ],
      }),
    });

    try {
      const result = await hook(
        makeEvent({ prompt: "What did we work on on April 2nd?" }),
        makeCtx()
      );

      assert.ok(result && typeof result.prependContext === "string", "prependContext is returned");
      assert.match(result.prependContext, /## Memory Crystal Debug Output/);
      assert.match(result.prependContext, /print the entire JSON payload below inside a ```json fenced block/i);
      assert.match(result.prependContext, /"prompt": "What did we work on on April 2nd\?"/);
      assert.match(result.prependContext, /"memoryId": "mem_apr2"/);
      assert.match(result.prependContext, /debug payload should keep this content untrimmed/);
      assert.match(result.prependContext, /Wake summary for debug\./);
      assert.match(result.prependContext, /Relevant Memory Evidence/);
    } finally {
      fetchResponses.delete(wakeUrl);
      fetchResponses.delete(recallUrl);
      fetchResponses.delete(searchUrl);
      fetchResponses.delete(recentUrl);
    }
  });

  test("6g. tool discipline preamble is injected once per session while backend preamble remains", async () => {
    fetchCalls.length = 0;
    const api = loadPlugin();
    const hook = api._hooks.get("before_agent_start");
    assert.ok(typeof hook === "function", "before_agent_start is a function");

    const first = await hook(
      makeEvent({ prompt: "Help me think through this architecture tradeoff.", sessionKey: "session-preamble-1" }),
      makeCtx({ sessionKey: "session-preamble-1" })
    );
    const second = await hook(
      makeEvent({ prompt: "And what about the migration plan?", sessionKey: "session-preamble-1" }),
      makeCtx({ sessionKey: "session-preamble-1" })
    );

    assert.ok(first && typeof first.prependContext === "string");
    assert.ok(second && typeof second.prependContext === "string");
    assert.match(first.prependContext, /## Active Memory Backend/);
    assert.match(first.prependContext, /## Memory Tool Discipline/);
    assert.match(second.prependContext, /## Active Memory Backend/);
    assert.equal(second.prependContext.includes("## Memory Tool Discipline"), false);
  });

  test("7. message_received hook: logs user message without throwing", async () => {
    const api = loadPlugin();
    const hook = api._hooks.get("message_received");
    const event = makeEvent({ content: "What is 2+2?", prompt: "What is 2+2?" });
    const ctx = makeCtx();
    await assert.doesNotReject(async () => { await hook(event, ctx); });
  });

  test("7b. proactive before_dispatch recall fails closed for shared Morrow sessions without a concrete peer channel", async () => {
    fetchCalls.length = 0;
    const api = loadPlugin({ channelScope: "morrow-coach" });
    const messageReceived = api._hooks.get("message_received");
    const beforeDispatchHooks = api._hookLists.get("before_dispatch") || [];
    const proactiveRecallHook = beforeDispatchHooks[1];

    assert.ok(typeof messageReceived === "function", "message_received hook should exist");
    assert.ok(typeof proactiveRecallHook === "function", "proactive recall before_dispatch hook should exist");

    const event = makeEvent({
      content: "What did we decide for this client before?",
      prompt: "What did we decide for this client before?",
      sessionKey: "agent:coach:main",
    });
    const ctx = makeCtx({ sessionKey: "agent:coach:main" });

    await messageReceived(event, ctx);
    fetchCalls.length = 0;
    const result = await proactiveRecallHook(event, ctx);

    assert.equal(result, undefined);
    assert.equal(fetchCalls.some((call) => call.url.endsWith("/api/mcp/recall")), false);
  });

  test("8. dispose: cleans up without throwing", () => {
    const api = loadPlugin();
    const engine = api._getEngine();
    assert.doesNotThrow(() => engine.dispose());
  });

  test("8a. session_end clears robust capture state for that session", async () => {
    const api = loadPlugin();
    const plugin = require(path.resolve(__dirname, "index.js"));
    const {
      recentlyWrittenAssist,
      captureStalledState,
      noteAssistWrite,
      noteUserMessage,
    } = plugin.__test__;
    const sessionEndHook = api._hooks.get("session_end");
    assert.ok(typeof sessionEndHook === "function", "session_end hook should be registered");

    noteAssistWrite("session-a", "assistant reply");
    noteUserMessage("session-a", 1_000);
    noteAssistWrite("session-b", "assistant reply");
    noteUserMessage("session-b", 1_000);

    await sessionEndHook(makeEvent({ sessionKey: "session-a" }), makeCtx({ sessionKey: "session-a" }));

    assert.equal(captureStalledState.has("session-a"), false);
    assert.equal([...recentlyWrittenAssist.keys()].some((key) => key.startsWith("session-a:")), false);
    assert.equal(captureStalledState.has("session-b"), true);
    assert.equal([...recentlyWrittenAssist.keys()].some((key) => key.startsWith("session-b:")), true);
  });

  test("8b. dispose clears robust capture state", () => {
    const api = loadPlugin();
    const plugin = require(path.resolve(__dirname, "index.js"));
    const {
      recentlyWrittenAssist,
      captureStalledState,
      noteAssistWrite,
      noteUserMessage,
    } = plugin.__test__;
    const engine = api._getEngine();

    noteAssistWrite("session-a", "assistant reply");
    noteUserMessage("session-a", 1_000);
    engine.dispose();

    assert.equal(recentlyWrittenAssist.size, 0);
    assert.equal(captureStalledState.size, 0);
  });

  test("9. Plugin works with no apiKey (graceful degradation)", async () => {
    const api = loadPlugin({ apiKey: undefined });
    const engine = api._getEngine();
    // assemble with no apiKey should return original messages unchanged
    const payload = { sessionKey: "s1", budget: 1000, messages: [{ role: "user", content: "hi" }] };
    const result = await engine.assemble(payload, makeCtx());
    assert.ok(Array.isArray(result.messages));
  });

  test("11. assemble hook: messages do not contain [object Object] when localStore has messages", async () => {
    // This tests the bug where assembleContext returns an array of message objects
    // and they were being joined as strings, producing "[object Object]" in content.
    const api = loadPlugin();
    const engine = api._getEngine();
    const ctx = makeCtx();
    const payload = {
      sessionKey: "test-session-abc",
      budget: 100000,
      messages: [
        { role: "user", content: "Hello from test" },
      ],
    };
    const result = await engine.assemble(payload, ctx);
    assert.ok(Array.isArray(result.messages), "result.messages is array");
    // None of the messages should have content containing "[object Object]"
    for (const msg of result.messages) {
      assert.ok(typeof msg === "object" && msg !== null, "each message is an object");
      assert.ok("role" in msg, "each message has role");
      assert.ok("content" in msg, "each message has content");
      assert.ok(Array.isArray(msg.content), "message content is an array of content parts");
      for (const part of msg.content) {
        assert.ok(typeof part.text === "string", "content part has text string");
        assert.ok(!part.text.includes("[object Object]"), `content part must not contain "[object Object]": got "${part.text.slice(0, 80)}"`);
      }
    }
  });

  test("11a. local store stays disabled by default even when a dbPath is available", async () => {
    const dbPath = makeTmpDbPath();
    try {
      const api = loadPlugin({ apiKey: "local", dbPath, localStoreEnabled: false });
      const engine = api._getEngine();
      await engine.ingestBatch({
        sessionKey: "disabled-local-store",
        messages: [
          { role: "user", content: "hello" },
          { role: "assistant", content: "world" },
        ],
      }, makeCtx({ sessionKey: "disabled-local-store" }));

      assert.equal(fs.existsSync(dbPath), false, "local sqlite db should not be created when localStoreEnabled=false");
    } finally {
      fs.rmSync(dbPath, { force: true });
    }
  });

  test("11aa. local store stays disabled by default when runtime config omits both localStoreEnabled and dbPath", async () => {
    const { checkSqliteAvailability } = await import(path.resolve(__dirname, "store/crystal-local-store.js"));
    const avail = checkSqliteAvailability();
    if (!avail.available) return;

    const api = loadPlugin({ apiKey: "local" });
    const engine = api._getEngine();
    await engine.ingestBatch({
      sessionKey: "default-local-store-disabled",
      messages: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "world" },
      ],
    }, makeCtx({ sessionKey: "default-local-store-disabled" }));

    assert.equal(api._tools.has("crystal_grep"), false, "local grep tool should not register when local store stays disabled by default");
    assert.equal(api._tools.has("crystal_describe"), false, "local describe tool should not register when local store stays disabled by default");
    assert.equal(api._tools.has("crystal_expand"), false, "local expand tool should not register when local store stays disabled by default");
  });

  test("11b. assemble hook respects localSummaryInjection and localSummaryMaxTokens config", async () => {
    const { checkSqliteAvailability, CrystalLocalStore } = await import(path.resolve(__dirname, "store/crystal-local-store.js"));
    const avail = checkSqliteAvailability();
    if (!avail.available) return;

    const dbPath = makeTmpDbPath();
    try {
      const seedStore = new CrystalLocalStore();
      seedStore.init(dbPath);
      seedStore.insertSummary({
        summaryId: "sum_cfg_1",
        sessionKey: "cfg-session",
        kind: "leaf",
        depth: 0,
        content: "Important deployment migration history dashboard",
        tokenCount: 120,
      });
      seedStore.insertSummary({
        summaryId: "sum_cfg_2",
        sessionKey: "cfg-session",
        kind: "leaf",
        depth: 0,
        content: "Backup detail about rollback procedures and infra cleanup",
        tokenCount: 120,
      });
      seedStore.addMessage("cfg-session", "user", "deployment migration history dashboard");
      seedStore.addMessage("cfg-session", "assistant", "Previous deployment migration context was summarized.");
      seedStore.close();

      let api = loadPlugin({ apiKey: "local", dbPath, localSummaryInjection: false });
      let engine = api._getEngine();
      let result = await engine.assemble({
        sessionKey: "cfg-session",
        messages: [{ role: "user", content: "deployment migration history dashboard" }],
      }, makeCtx({ sessionKey: "cfg-session" }));
      assert.equal(result.messages.some((m) => m.role === "system" && msgText(m).includes("Relevant context from earlier")), false);

      api = loadPlugin({ apiKey: "local", dbPath, localSummaryInjection: true, localSummaryMaxTokens: 150 });
      engine = api._getEngine();
      result = await engine.assemble({
        sessionKey: "cfg-session",
        messages: [{ role: "user", content: "deployment migration history dashboard" }],
      }, makeCtx({ sessionKey: "cfg-session" }));
      const injected = result.messages.find((m) => m.role === "system" && msgText(m).includes("Relevant context from earlier"));
      assert.ok(injected, "config-enabled injection should add a system message");
      assert.ok(msgText(injected).includes("Important deployment migration history"), "first relevant summary should be injected");
      assert.ok(!msgText(injected).includes("Backup detail about rollback"), "token cap should exclude the second summary");
    } finally {
      fs.rmSync(dbPath, { force: true });
    }
  });

  test("11c. assemble skips shared agent local summary injection when no concrete client channel is available", async () => {
    const { checkSqliteAvailability, CrystalLocalStore } = await import(path.resolve(__dirname, "store/crystal-local-store.js"));
    const avail = checkSqliteAvailability();
    if (!avail.available) return;

    const dbPath = makeTmpDbPath();
    try {
      const seedStore = new CrystalLocalStore();
      seedStore.init(dbPath);
      seedStore.insertSummary({
        summaryId: "sum_shared_agent_1",
        sessionKey: "agent:coach:main",
        kind: "leaf",
        depth: 0,
        content: "BJ Moffatt private coaching history that must never bleed into another client.",
        tokenCount: 60,
      });
      seedStore.addMessage("agent:coach:main", "user", "BJ Moffatt private coaching history");
      seedStore.close();

      const api = loadPlugin({ apiKey: "local", dbPath, channelScope: "morrow-coach", localSummaryInjection: true });
      const engine = api._getEngine();
      const result = await engine.assemble({
        sessionKey: "agent:coach:main",
        messages: [{ role: "user", content: "How should I respond to this client?" }],
      }, makeCtx({ sessionKey: "agent:coach:main" }));

      assert.equal(
        result.messages.some((m) => m.role === "system" && msgText(m).includes("Relevant context from earlier in this conversation")),
        false
      );
      assert.equal(
        result.messages.some((m) => msgText(m).includes("BJ Moffatt private coaching history")),
        false
      );
    } finally {
      fs.rmSync(dbPath, { force: true });
    }
  });

  test("11d. ingestBatch stores shared coach local context under the concrete scoped channel instead of agent:coach:main", async () => {
    const { checkSqliteAvailability } = await import(path.resolve(__dirname, "store/crystal-local-store.js"));
    const avail = checkSqliteAvailability();
    if (!avail.available) return;

    const dbPath = makeTmpDbPath();
    try {
      const api = loadPlugin({ apiKey: "local", dbPath, channelScope: "morrow-coach" });
      const engine = api._getEngine();
      await engine.ingestBatch({
        sessionKey: "agent:coach:main",
        channel: "morrow-coach:12345",
        messages: [
          { role: "user", content: "Andy-specific note" },
          { role: "assistant", content: "Coach response for Andy" },
        ],
      }, makeCtx({ sessionKey: "agent:coach:main" }));

      const db = require("better-sqlite3")(dbPath, { readonly: true });
      try {
        const keys = db.prepare("SELECT session_key FROM conversations ORDER BY session_key ASC").all().map((row) => row.session_key);
        assert.deepEqual(keys, ["morrow-coach:12345"]);
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(dbPath, { force: true });
    }
  });

  test("11e. assemble skips admin-session local summary injection when no concrete peer channel is available", async () => {
    const { checkSqliteAvailability, CrystalLocalStore } = await import(path.resolve(__dirname, "store/crystal-local-store.js"));
    const avail = checkSqliteAvailability();
    if (!avail.available) return;

    const dbPath = makeTmpDbPath();
    try {
      const seedStore = new CrystalLocalStore();
      seedStore.init(dbPath);
      seedStore.insertSummary({
        summaryId: "sum_admin_scope_1",
        sessionKey: "morrow-admin-console",
        kind: "leaf",
        depth: 0,
        content: "Shared coach admin context that must not leak into a client session without peer scope.",
        tokenCount: 60,
      });
      seedStore.addMessage("morrow-admin-console", "user", "Shared coach admin context");
      seedStore.close();

      const api = loadPlugin({ apiKey: "local", dbPath, channelScope: "morrow-coach", localSummaryInjection: true });
      const engine = api._getEngine();
      const result = await engine.assemble({
        sessionKey: "morrow-admin-console",
        messages: [{ role: "user", content: "How should I respond to this client?" }],
      }, makeCtx({ sessionKey: "morrow-admin-console" }));

      assert.equal(
        result.messages.some((m) => m.role === "system" && msgText(m).includes("Relevant context from earlier in this conversation")),
        false
      );
      assert.equal(
        result.messages.some((m) => msgText(m).includes("Shared coach admin context that must not leak")),
        false
      );
    } finally {
      fs.rmSync(dbPath, { force: true });
    }
  });

  test("11f. Telegram DM capture paths normalize to a single telegram:<id> conversation key", async () => {
    const { checkSqliteAvailability } = await import(path.resolve(__dirname, "store/crystal-local-store.js"));
    const avail = checkSqliteAvailability();
    if (!avail.available) return;

    const dbPath = makeTmpDbPath();
    try {
      const api = loadPlugin({ apiKey: "local", dbPath });
      const engine = api._getEngine();
      const messageReceived = api._hooks.get("message_received");
      const telegramId = "511172388";

      await messageReceived({
        content: "Telegram DM from the raw OpenClaw session descriptor",
        prompt: "Telegram DM from the raw OpenClaw session descriptor",
        sessionKey: `agent:main:telegram:direct:${telegramId}`,
        messageProvider: "telegram",
        context: { chat_id: telegramId },
      }, makeCtx({
        sessionKey: `agent:main:telegram:direct:${telegramId}`,
        conversationId: `telegram:${telegramId}`,
        messageProvider: "telegram",
      }));

      await engine.ingestBatch({
        sessionKey: `telegram:${telegramId}`,
        messages: [
          { role: "user", content: "Telegram DM from the canonical conversation key" },
          { role: "assistant", content: "Assistant reply stays in the same Telegram DM context" },
        ],
      }, makeCtx({
        sessionKey: `telegram:${telegramId}`,
        conversationId: `telegram:${telegramId}`,
        messageProvider: "telegram",
      }));

      const db = require("better-sqlite3")(dbPath, { readonly: true });
      try {
        const keys = db.prepare("SELECT session_key FROM conversations ORDER BY session_key ASC").all().map((row) => row.session_key);
        const messageCount = db.prepare(`
          SELECT COUNT(*) AS count
          FROM messages
          WHERE conv_id = (SELECT id FROM conversations WHERE session_key = ?)
        `).get(`telegram:${telegramId}`).count;
        assert.deepEqual(keys, [`telegram:${telegramId}`]);
        assert.equal(messageCount, 3);
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(dbPath, { force: true });
    }
  });

  test("9d. crystal_preflight does not classify a lesson as both a rule and a lesson", async () => {
    const api = loadPlugin();
    const tool = api._tools.get("crystal_preflight");
    const url = "https://example.convex.site/api/mcp/recall";
    fetchResponses.set(url, {
      ok: true,
      json: async () => ({
        memories: [
          { title: "Lesson from procedural memory", store: "procedural", category: "lesson" },
          { title: "Rule memory", store: "semantic", category: "rule" },
        ],
      }),
    });
    const result = await tool.execute("id", { action: "deploy config" }, null, null, makeCtx());
    const text = result.content[0].text;
    assert.match(text, /"rules": \[\n\s+"Rule memory"\n\s+\]/);
    assert.match(text, /"lessons": \[\n\s+"Lesson from procedural memory"\n\s+\]/);
    fetchResponses.delete(url);
  });

  test("10. Tools: crystal_grep/describe/expand registered when store initializes (lazy)", async () => {
    // These tools are registered lazily after the local store initializes.
    // Since better-sqlite3 may not be installed in the test env, local store init
    // may fail gracefully — so we check that no crash occurred and that Convex tools
    // are still registered.
    const api = loadPlugin();
    // Simulate afterTurn which tries to register local tools
    const engine = api._getEngine();
    await engine.afterTurn({ sessionKey: "s1" }, makeCtx()).catch(() => {});
    // Convex tools must always be present regardless of local store
    assert.ok(api._tools.has("crystal_recall"), "crystal_recall always present");
    assert.ok(api._tools.has("memory_search"), "memory_search always present");
    // Note: crystal_grep etc. may or may not be present depending on whether
    // better-sqlite3 loaded. Either way no crash should occur.
  });

  describe("crystal-utils channel scoping", () => {
    test("getPeerId returns Telegram sender ID from event context", () => {
      const ctx = {};
      const event = { metadata: { from: { id: 12345 }, senderId: "ignored" }, context: { from: { id: 999 }, sender_id: "ctx" } };
      assert.equal(getPeerId(ctx, event), "12345");
    });

    test("getPeerId falls back to Discord authorId", () => {
      const ctx = {};
      const event = { metadata: { guild: { id: 1 } }, context: { authorId: "discord-9" } };
      assert.equal(getPeerId(ctx, event), "discord-9");
    });

    test("getPeerId falls back to session key last segment", () => {
      const ctx = { sessionKey: "agent:openclaw:session:12345" };
      assert.equal(getPeerId(ctx, {}), "12345");
    });

    test("getChannelKey with channelScope uses peer namespace", () => {
      const event = { metadata: { from: { id: 12345 } } };
      assert.equal(getChannelKey({}, event, "coach"), "coach:12345");
    });

    test("getChannelKey without channelScope preserves existing channel logic", () => {
      const event = { context: { chat_id: "channel:coach" } };
      assert.equal(getChannelKey({}, event), "openclaw:coach");
    });
  });

  describe("normalizeConvexHttpBase — custom domain regression (§5)", () => {
    test("custom domain passes through unchanged (no .convex.cloud suffix to rewrite)", () => {
      const { normalizeConvexHttpBase } = require("./index.js").__test__;
      assert.equal(normalizeConvexHttpBase("https://convex.memorycrystal.ai"), "https://convex.memorycrystal.ai");
    });

    test(".convex.cloud suffix is rewritten to .convex.site but custom domain is not affected", () => {
      const { normalizeConvexHttpBase } = require("./index.js").__test__;
      // Verify the regex does not match a custom domain that merely contains 'convex' in its hostname
      assert.equal(normalizeConvexHttpBase("convex.memorycrystal.ai"), "convex.memorycrystal.ai");
      // Verify the rewrite still works for the legacy pattern it is designed for
      assert.equal(normalizeConvexHttpBase("https://rightful-mockingbird-389.convex.cloud"), "https://rightful-mockingbird-389.convex.site");
    });
  });

  describe("channelScope for recall tools", () => {
    const recallToolCases = [
      { name: "memory_search", args: { query: "search memory" } },
      { name: "crystal_recall", args: { query: "decision notes", limit: 4 } },
      { name: "crystal_what_do_i_know", args: { topic: "project memory", limit: 4 } },
      { name: "crystal_why_did_we", args: { decision: "deploy plan", limit: 4 } },
      { name: "crystal_preflight", args: { action: "deploy plan" } },
    ];

    test("4 recall tools include channel when channelScope is configured", async () => {
      const api = loadPlugin({ channelScope: "coach" });
      const ctx = makeCtx({ peerId: "12345" });
      for (const { name, args } of recallToolCases) {
        fetchCalls.length = 0;
        const tool = api._tools.get(name);
        await tool.execute("id", args, null, null, ctx);
        const payload = JSON.parse(fetchCalls.at(-1).opts.body);
        assert.equal(payload.channel, "coach:12345");
      }
    });

    test("4 recall tools use shared main scope for trusted agent sessions without a concrete peer id", async () => {
      const api = loadPlugin({ channelScope: "coach" });
      const ctx = makeCtx({ sessionKey: "agent:main:main" });
      for (const { name, args } of recallToolCases) {
        fetchCalls.length = 0;
        const tool = api._tools.get(name);
        await tool.execute("id", args, null, null, ctx);
        const payload = JSON.parse(fetchCalls.at(-1).opts.body);
        assert.equal(payload.channel, "coach:main");
      }
    });

    test("per-agent shared scope policy overrides global peer scope for shared agents", async () => {
      const api = loadPlugin({
        channelScope: "morrow-coach",
        agentScopePolicies: [
          { agentId: "coach", scope: "morrow-coach", mode: "peer" },
          { agentId: "dm-replies", scope: "morrow-team", mode: "shared" },
        ],
      });
      const ctx = makeCtx({ sessionKey: "agent:dm-replies:discord:channel:1467149719997513860" });
      for (const { name, args } of recallToolCases) {
        fetchCalls.length = 0;
        const tool = api._tools.get(name);
        await tool.execute("id", args, null, null, ctx);
        const payload = JSON.parse(fetchCalls.at(-1).opts.body);
        assert.equal(payload.channel, "morrow-team:main-dm-replies");
        assert.equal(payload.agentId, "dm-replies");
      }
    });

    test("two shared agents under same scope get distinct channels (no bleed)", async () => {
      const rememberArgs = {
        store: "semantic",
        category: "fact",
        title: "Shared agent memory title",
        content: "Some content to remember.",
      };

      // Two shared agents under the same scope
      const api = loadPlugin({
        agentScopePolicies: [
          { agentId: "agent-a", scope: "coach", mode: "shared" },
          { agentId: "agent-b", scope: "coach", mode: "shared" },
        ],
      });
      const rememberTool = api._tools.get("crystal_remember");

      // agent-a write
      fetchCalls.length = 0;
      await rememberTool.execute("id", rememberArgs, null, null, makeCtx({ sessionKey: "agent:agent-a:main" }));
      const payloadA = JSON.parse(fetchCalls.at(-1).opts.body);
      assert.equal(payloadA.channel, "coach:main-agent-a");

      // agent-b write
      fetchCalls.length = 0;
      await rememberTool.execute("id", rememberArgs, null, null, makeCtx({ sessionKey: "agent:agent-b:main" }));
      const payloadB = JSON.parse(fetchCalls.at(-1).opts.body);
      assert.equal(payloadB.channel, "coach:main-agent-b");

      // Channels must be distinct — no bleed
      assert.notEqual(payloadA.channel, payloadB.channel);

      // Backward compat: shared agent whose agentId cannot be derived yields legacy scope:main
      // getAgentId returns "" for a non-agent: sessionKey with no explicit ctx.agentId
      // and no matching policy → no channel appended → getScopedChannelPolicy returns no policy match.
      // Use a policy whose agentId matches via ctx.agentId="" so the policy is not found;
      // the global channelScope falls back to peer mode (no shared channel in that path).
      // Instead, verify via recall tools which use the same shared resolution path.
      for (const { name, args } of recallToolCases) {
        fetchCalls.length = 0;
        const tool = api._tools.get(name);
        await tool.execute("id", args, null, null, makeCtx({ sessionKey: "agent:agent-a:main" }));
        const payload = JSON.parse(fetchCalls.at(-1).opts.body);
        assert.equal(payload.channel, "coach:main-agent-a", `${name} read channel must match agent-a write channel`);
      }
    });

    test("per-agent peer scope policy works without a global channelScope", async () => {
      const api = loadPlugin({
        agentScopePolicies: [
          { agentId: "coach", scope: "morrow-coach", mode: "peer" },
          { agentId: "dm-replies", scope: "morrow-team", mode: "shared" },
        ],
      });
      const ctx = makeCtx({ sessionKey: "agent:coach:main", peerId: "12345" });
      for (const { name, args } of recallToolCases) {
        fetchCalls.length = 0;
        const tool = api._tools.get(name);
        await tool.execute("id", args, null, null, ctx);
        const payload = JSON.parse(fetchCalls.at(-1).opts.body);
        assert.equal(payload.channel, "morrow-coach:12345");
        assert.equal(payload.agentId, "coach");
      }
    });

    test("factory tool context preserves session identity even when execute ctx is empty", async () => {
      const api = loadPlugin({ channelScope: "coach" });
      const tool = api._materializeTool("crystal_recall", { sessionKey: "agent:main:main" });
      fetchCalls.length = 0;
      await tool.execute("id", { query: "shared recall", limit: 1 }, null, null, {});
      const payload = JSON.parse(fetchCalls.at(-1).opts.body);
      assert.equal(payload.channel, "coach:main");
    });

    test("4 recall tools omit channel when channelScope is not configured", async () => {
      const api = loadPlugin();
      const ctx = makeCtx({ peerId: "12345" });
      for (const { name, args } of recallToolCases) {
        fetchCalls.length = 0;
        const tool = api._tools.get(name);
        await tool.execute("id", args, null, null, ctx);
        const payload = JSON.parse(fetchCalls.at(-1).opts.body);
        assert.equal("channel" in payload, false);
      }
    });

    test("crystal_debug_recall returns the raw recall bundle and rendered sections", async () => {
      const api = loadPlugin({ channelScope: "coach" });
      const ctx = makeCtx({ peerId: "12345", sessionKey: "debug-session-1" });
      const tool = api._tools.get("crystal_debug_recall");
      const wakeUrl = "https://example.convex.site/api/mcp/wake";
      const recallUrl = "https://example.convex.site/api/mcp/recall";
      const searchUrl = "https://example.convex.site/api/mcp/search-messages";
      const recentUrl = "https://example.convex.site/api/mcp/recent-messages";

      fetchResponses.set(wakeUrl, {
        ok: true,
        json: async () => ({ briefing: "Wake briefing for coach 12345" }),
      });
      fetchResponses.set(recallUrl, {
        ok: true,
        json: async () => ({
          memories: [
            { memoryId: "m-1", title: "April 2 sprint", content: "We worked on recall diagnostics.", store: "semantic", category: "event", score: 0.91, continuityScore: 1 },
            { memoryId: "m-2", title: "Wrong peer memory", content: "Should be filtered in peer scope.", store: "semantic", category: "event", score: 0.77, continuityScore: 0 },
          ],
        }),
      });
      fetchResponses.set(searchUrl, {
        ok: true,
        json: async () => ({
          messages: [
            { role: "user", content: "What did we work on on April 2nd?", timestamp: Date.UTC(2026, 3, 2, 16, 0, 0) },
          ],
        }),
      });
      fetchResponses.set(recentUrl, {
        ok: true,
        json: async () => ({
          messages: [
            { role: "assistant", content: "We were debugging recall output shape.", createdAt: Date.UTC(2026, 3, 2, 16, 5, 0) },
          ],
        }),
      });

      try {
        fetchCalls.length = 0;
        const result = await tool.execute("id", { query: "What did we work on on April 2nd?" }, null, null, ctx);
        const payload = JSON.parse(result.content[0].text);

        assert.equal(payload.channel, "coach:12345");
        assert.equal(payload.recallRequest.channel, "coach:12345");
        assert.equal(payload.searchMessagesRequest.channel, "coach:12345");
        assert.equal(payload.recentMessagesRequest.channel, "coach:12345");
        assert.equal(payload.recallResponse.memories.length, 2);
        assert.equal(payload.renderedSections.relevantMemoryEvidence.includes("April 2 sprint"), true);
        assert.equal(payload.efficiency.rawRecallCount, 2);
        assert.equal(payload.efficiency.hookFilteredRecallCount, 1);
        assert.equal(payload.efficiency.messageMatchCount, 1);
        assert.equal(payload.efficiency.recentMessageCount, 1);
      } finally {
        fetchResponses.delete(wakeUrl);
        fetchResponses.delete(recallUrl);
        fetchResponses.delete(searchUrl);
        fetchResponses.delete(recentUrl);
      }
    });

    test("before_agent_start uses shared main scope for configured shared agents", async () => {
      fetchCalls.length = 0;
      const api = loadPlugin({
        channelScope: "morrow-coach",
        agentScopePolicies: [
          { agentId: "coach", scope: "morrow-coach", mode: "peer" },
          { agentId: "dm-replies", scope: "morrow-team", mode: "shared" },
        ],
      });
      const hook = api._hooks.get("before_agent_start");

      await hook(
        makeEvent({ prompt: "Draft a reply using the social posts knowledge base." }),
        makeCtx({ sessionKey: "agent:dm-replies:discord:channel:1467149719997513860" })
      );

      const wakeCall = fetchCalls.find((call) => call.url.endsWith("/api/mcp/wake"));
      const recallCall = fetchCalls.find((call) => call.url.endsWith("/api/mcp/recall"));
      assert.ok(wakeCall, "wake request should be sent for shared agents");
      assert.ok(recallCall, "recall request should be sent for shared agents");
      assert.equal(JSON.parse(wakeCall.opts.body).channel, "morrow-team:main-dm-replies");
      assert.equal(JSON.parse(recallCall.opts.body).channel, "morrow-team:main-dm-replies");
    });

    test("general prompts skip message-search scaffolding in before_agent_start", async () => {
      fetchCalls.length = 0;
      const api = loadPlugin();
      const hook = api._hooks.get("before_agent_start");

      await hook(
        makeEvent({ prompt: "Help me think through this architecture tradeoff." }),
        makeCtx()
      );

      const urls = fetchCalls.map((call) => call.url);
      assert.equal(urls.some((url) => url.endsWith("/api/mcp/recall")), true);
      assert.equal(urls.some((url) => url.endsWith("/api/mcp/search-messages")), false);
      assert.equal(urls.some((url) => url.endsWith("/api/mcp/recent-messages")), false);
    });

    test("non-history questions do not trigger message search just because they are questions", async () => {
      fetchCalls.length = 0;
      const api = loadPlugin();
      const hook = api._hooks.get("before_agent_start");

      await hook(
        makeEvent({ prompt: "What about the migration plan?", sessionKey: "plain-question-1" }),
        makeCtx({ sessionKey: "plain-question-1" })
      );

      const urls = fetchCalls.map((call) => call.url);
      assert.equal(urls.some((url) => url.endsWith("/api/mcp/recall")), true);
      assert.equal(urls.some((url) => url.endsWith("/api/mcp/search-messages")), false);
      assert.equal(urls.some((url) => url.endsWith("/api/mcp/recent-messages")), false);
    });

    test("crystal_set_scope overrides channel scope for the active session and session_end clears it", async () => {
      const api = loadPlugin({ channelScope: "default-scope" });
      const ctx = makeCtx({ peerId: "12345", sessionKey: "session-override-1" });
      const setScopeTool = api._tools.get("crystal_set_scope");
      const recallTool = api._tools.get("crystal_recall");
      const wakeTool = api._tools.get("crystal_wake");
      const sessionEndHook = api._hooks.get("session_end");

      assert.ok(setScopeTool, "crystal_set_scope should be registered");
      assert.ok(typeof sessionEndHook === "function", "session_end hook should be registered");

      await setScopeTool.execute("id", { scope: "morrow-coach" }, null, null, ctx);

      fetchCalls.length = 0;
      await recallTool.execute("id", { query: "project memory" }, null, null, ctx);
      let payload = JSON.parse(fetchCalls.at(-1).opts.body);
      assert.equal(payload.channel, "morrow-coach:12345");

      fetchCalls.length = 0;
      await wakeTool.execute("id", {}, null, null, ctx);
      payload = JSON.parse(fetchCalls.at(-1).opts.body);
      assert.equal(payload.channel, "morrow-coach:12345");

      await sessionEndHook({ sessionKey: "session-override-1" }, ctx);

      fetchCalls.length = 0;
      await recallTool.execute("id", { query: "project memory" }, null, null, ctx);
      payload = JSON.parse(fetchCalls.at(-1).opts.body);
      assert.equal(payload.channel, "default-scope:12345");
    });

    test("crystal_set_scope also drives shared-session local context keying", async () => {
      const { checkSqliteAvailability } = await import(path.resolve(__dirname, "store/crystal-local-store.js"));
      const avail = checkSqliteAvailability();
      if (!avail.available) return;

      const dbPath = makeTmpDbPath();
      try {
        const api = loadPlugin({ apiKey: "local", dbPath, channelScope: "default-scope" });
        const ctx = makeCtx({ peerId: "12345", sessionKey: "agent:coach:main" });
        const setScopeTool = api._tools.get("crystal_set_scope");
        const engine = api._getEngine();

        await setScopeTool.execute("id", { scope: "morrow-coach" }, null, null, ctx);
        await engine.ingestBatch({
          sessionKey: "agent:coach:main",
          messages: [
            { role: "user", content: "Andy-specific note" },
            { role: "assistant", content: "Coach response for Andy" },
          ],
        }, ctx);

        const db = require("better-sqlite3")(dbPath, { readonly: true });
        try {
          const keys = db.prepare("SELECT session_key FROM conversations ORDER BY session_key ASC").all().map((row) => row.session_key);
          assert.deepEqual(keys, ["morrow-coach:12345"]);
        } finally {
          db.close();
        }
      } finally {
        fs.rmSync(dbPath, { force: true });
      }
    });

    test("crystal_remember ignores invalid explicit channels when channelScope is configured", async () => {
      const api = loadPlugin({ channelScope: "morrow-coach" });
      const ctx = makeCtx({ peerId: "511172388", sessionKey: "agent:coach:main" });
      const rememberTool = api._tools.get("crystal_remember");

      fetchCalls.length = 0;
      await rememberTool.execute("id", {
        store: "semantic",
        category: "person",
        title: "Andy Doucet daughters and birthdays",
        content: "Autumn: April 2, 2018. Scarlett: October 25, 2016.",
        channel: "telegram",
      }, null, null, ctx);
      let payload = JSON.parse(fetchCalls.at(-1).opts.body);
      assert.equal(payload.channel, "morrow-coach:511172388");

      fetchCalls.length = 0;
      await rememberTool.execute("id", {
        store: "semantic",
        category: "person",
        title: "Scarlett birthday",
        content: "Scarlett's birthday is October 25, 2016.",
        channel: "morrow-coach:default",
      }, null, null, ctx);
      payload = JSON.parse(fetchCalls.at(-1).opts.body);
      assert.equal(payload.channel, "morrow-coach:511172388");

      fetchCalls.length = 0;
      await rememberTool.execute("id", {
        store: "semantic",
        category: "person",
        title: "Peer-scoped keep",
        content: "Concrete peer channel should be preserved.",
        channel: "morrow-coach:511172388",
      }, null, null, ctx);
      payload = JSON.parse(fetchCalls.at(-1).opts.body);
      assert.equal(payload.channel, "morrow-coach:511172388");
    });
  });
});
