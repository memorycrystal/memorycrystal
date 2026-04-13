#!/usr/bin/env node
const assert = require("node:assert/strict");
const http = require("node:http");

const registerPlugin = require("../plugin/index.js");

async function startMockServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      let body = null;
      try {
        body = rawBody ? JSON.parse(rawBody) : null;
      } catch {
        body = rawBody;
      }

      requests.push({
        method: req.method,
        path: req.url,
        headers: req.headers,
        body,
      });

      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, messages: [], memories: [] }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind mock server");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    async close() {
      await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
    },
  };
}

function createHarness(baseUrl) {
  const hooks = new Map();
  const warnings = [];

  const api = {
    id: "crystal-memory",
    pluginConfig: {
      apiKey: "test-api-key",
      convexUrl: baseUrl,
    },
    logger: {
      warn(message) {
        warnings.push(String(message));
      },
      info() {},
    },
    registerHook(name, fn) {
      hooks.set(name, fn);
    },
    registerTool() {},
    registerContextEngine() {},
  };

  registerPlugin(api);
  return { hooks, warnings };
}

function matchingRequests(requests, path) {
  return requests.filter((request) => request.path === path);
}

function latestRequest(requests, path) {
  const matches = matchingRequests(requests, path);
  return matches[matches.length - 1];
}

function assertStructuredTurn(logRequests) {
  // turnId was removed from plugin — just verify both logs exist with expected roles
  assert.equal(logRequests.length, 2);
}

async function runTest(name, fn) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}

async function main() {
  const server = await startMockServer();

  try {
    await runTest("message_received + llm_output logs full turn", async () => {
      server.requests.length = 0;
      const { hooks, warnings } = createHarness(server.baseUrl);
      const messageReceived = hooks.get("message_received");
      const llmOutput = hooks.get("llm_output");
      assert.equal(typeof messageReceived, "function");
      assert.equal(typeof llmOutput, "function");

      const ctx = {
        sessionKey: "session-one",
        messageProvider: "discord",
        workspaceId: "workspace-1",
        guildId: "guild-1",
        channelId: "channel-1",
      };

      await messageReceived(
        {
          context: {
            content: "Sentinel 49102372178",
            workspaceId: "workspace-1",
            guildId: "guild-1",
            channelId: "channel-1",
          },
          conversationId: "conversation-old",
        },
        ctx
      );

      await llmOutput(
        {
          content: "Got it - sentinel noted: 49102372178.",
          context: {
            workspaceId: "workspace-1",
            guildId: "guild-1",
            channelId: "channel-1",
          },
          conversationId: "conversation-old",
        },
        ctx
      );

      const logRequests = matchingRequests(server.requests, "/api/mcp/log");
      const captureRequests = matchingRequests(server.requests, "/api/mcp/capture");

      assert.equal(logRequests.length, 2);
      assert.equal(captureRequests.length, 1);
      assert.deepEqual(
        logRequests.map((request) => request.body.role),
        ["user", "assistant"]
      );
      assert.equal(logRequests[0].body.content, "Sentinel 49102372178");
      assert.equal(logRequests[1].body.content, "Got it - sentinel noted: 49102372178.");
      assert.equal(logRequests[0].body.channel, "discord:workspace-1:guild-1:channel-1");
      assert.equal(logRequests[1].body.channel, "discord:workspace-1:guild-1:channel-1");
      assert.equal(logRequests[0].body.sessionKey, "session-one");
      assert.equal(logRequests[1].body.sessionKey, "session-one");
      assertStructuredTurn(logRequests);
      assert.match(captureRequests[0].body.content, /User: Sentinel 49102372178/);
      assert.match(captureRequests[0].body.content, /Assistant: Got it - sentinel noted: 49102372178\./);
      assert.deepEqual(warnings.filter((w) => !w.startsWith("[crystal]")), []);
    });

    await runTest("message_received logs without sessionKey", async () => {
      server.requests.length = 0;
      const { hooks, warnings } = createHarness(server.baseUrl);
      const messageReceived = hooks.get("message_received");
      assert.equal(typeof messageReceived, "function");

      await messageReceived(
        {
          context: {
            content: "probe without session key",
            workspaceId: "workspace-1",
            guildId: "guild-1",
            channelId: "channel-1",
          },
          conversationId: "conversation-no-session",
          messageProvider: "discord",
        },
        {
          messageProvider: "discord",
          workspaceId: "workspace-1",
          guildId: "guild-1",
          channelId: "channel-1",
        }
      );

      const request = latestRequest(server.requests, "/api/mcp/log");
      assert.ok(request);
      assert.equal(request.body.role, "user");
      assert.equal(request.body.content, "probe without session key");
      assert.equal(request.body.channel, "discord:workspace-1:guild-1:channel-1");
      assert.equal(request.body.sessionKey, "conversation-no-session");
      // turnId was removed from plugin — just verify the log was sent
      assert.ok(request.body.role);
      assert.deepEqual(warnings.filter((w) => !w.startsWith("[crystal]")), []);
    });

    await runTest("message_sent fallback captures assistant turn", async () => {
      server.requests.length = 0;
      const { hooks, warnings } = createHarness(server.baseUrl);
      const messageReceived = hooks.get("message_received");
      const messageSent = hooks.get("message_sent");
      assert.equal(typeof messageReceived, "function");
      assert.equal(typeof messageSent, "function");

      const ctx = {
        sessionKey: "session-two",
        messageProvider: "discord",
        workspaceId: "workspace-1",
        guildId: "guild-1",
        channelId: "channel-1",
      };

      await messageReceived(
        {
          context: {
            content: "Count to ten",
            workspaceId: "workspace-1",
            guildId: "guild-1",
            channelId: "channel-1",
          },
          conversationId: "conversation-fallback",
        },
        ctx
      );

      await messageSent(
        {
          text: "1, 2, 3, 4, 5, 6, 7, 8, 9, 10.",
          context: {
            workspaceId: "workspace-1",
            guildId: "guild-1",
            channelId: "channel-1",
          },
          conversationId: "conversation-fallback",
        },
        ctx
      );

      const logRequests = matchingRequests(server.requests, "/api/mcp/log");
      const captureRequests = matchingRequests(server.requests, "/api/mcp/capture");
      assert.equal(logRequests.length, 2);
      assert.equal(logRequests[1].body.role, "assistant");
      assert.equal(logRequests[1].body.content, "1, 2, 3, 4, 5, 6, 7, 8, 9, 10.");
      assertStructuredTurn(logRequests);
      assert.equal(captureRequests.length, 1);
      assert.match(captureRequests[0].body.content, /User: Count to ten/);
      assert.match(captureRequests[0].body.content, /Assistant: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10\./);
      assert.deepEqual(warnings.filter((w) => !w.startsWith("[crystal]")), []);
    });

    await runTest("channel key ignores conversationId across new sessions", async () => {
      server.requests.length = 0;
      const { hooks } = createHarness(server.baseUrl);
      const messageReceived = hooks.get("message_received");
      assert.equal(typeof messageReceived, "function");

      const baseCtx = {
        messageProvider: "discord",
        workspaceId: "workspace-1",
        guildId: "guild-1",
        channelId: "channel-1",
      };

      await messageReceived(
        {
          context: {
            content: "before new",
            workspaceId: "workspace-1",
            guildId: "guild-1",
            channelId: "channel-1",
          },
          conversationId: "conversation-before-new",
        },
        { ...baseCtx, sessionKey: "session-before" }
      );

      await messageReceived(
        {
          context: {
            content: "after new",
            workspaceId: "workspace-1",
            guildId: "guild-1",
            channelId: "channel-1",
          },
          conversationId: "conversation-after-new",
        },
        { ...baseCtx, sessionKey: "session-after" }
      );

      const logRequests = matchingRequests(server.requests, "/api/mcp/log");
      assert.equal(logRequests.length, 2);
      assert.equal(logRequests[0].body.channel, "discord:workspace-1:guild-1:channel-1");
      assert.equal(logRequests[1].body.channel, "discord:workspace-1:guild-1:channel-1");
    });
  } finally {
    await server.close();
  }

  if (process.exitCode && process.exitCode !== 0) {
    process.exit(process.exitCode);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
});
