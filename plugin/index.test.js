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
    registerTool(tool) {
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
  test("1. Plugin loads and registers context engine without crashing", () => {
    const api = loadPlugin();
    const engine = api._getEngine();
    assert.ok(engine, "context engine should be registered");
    assert.equal(engine.info.name, "crystal-memory");
    assert.equal(engine.info.ownsCompaction, true);
    // Core hooks should be registered
    assert.ok(api._hooks.has("before_agent_start"), "before_agent_start hook");
    assert.ok(api._hooks.has("message_received"), "message_received hook");
    assert.ok(api._hooks.has("llm_output"), "llm_output hook");
    assert.ok(api._hooks.has("message_sent"), "message_sent hook");
    // Convex tools should be registered
    const toolNames = [...api._tools.keys()];
    assert.ok(toolNames.includes("memory_search"), "memory_search tool");
    assert.ok(toolNames.includes("crystal_recall"), "crystal_recall tool");
    assert.ok(toolNames.includes("crystal_remember"), "crystal_remember tool");
    assert.ok(toolNames.includes("crystal_set_scope"), "crystal_set_scope tool");
    assert.ok(toolNames.includes("crystal_checkpoint"), "crystal_checkpoint tool");
    assert.ok(toolNames.includes("memory_get"), "memory_get tool");
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

  test("4b. compact hook sends sourceSnapshotId as a top-level capture field", async () => {
    const api = loadPlugin();
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
    assert.match(text, /normal client-facing replies, refer to this system as "memory"/i);
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

  test("6c. before_agent_start fails closed for shared Morrow sessions without a concrete peer channel", async () => {
    fetchCalls.length = 0;
    const api = loadPlugin({ channelScope: "morrow-coach" });
    const hook = api._hooks.get("before_agent_start");
    assert.ok(typeof hook === "function", "before_agent_start is a function");

    const result = await hook(
      makeEvent({ prompt: "How should I respond to this client?", sessionKey: "agent:coach:main" }),
      makeCtx({ sessionKey: "agent:coach:main" })
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

  describe("channelScope for recall tools", () => {
    const recallToolCases = [
      { name: "memory_search", args: { query: "search memory" } },
      { name: "crystal_recall", args: { query: "decision notes", limit: 4 } },
      { name: "crystal_what_do_i_know", args: { topic: "project memory", limit: 4 } },
      { name: "crystal_why_did_we", args: { decision: "deploy plan", limit: 4 } },
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
  });
});
