"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { createServer } = require("node:http");

const REPO_ROOT = path.resolve(__dirname, "..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "crystal-enable.sh");
const GOOD_BACKEND = "https://convex.memorycrystal.ai";
const BAD_BACKEND = "https://hardy-pony-523.convex.site";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "crystal-enable-test-"));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function runEnable(args, envOverrides, cwd = REPO_ROOT) {
  return spawnSync("bash", [SCRIPT_PATH, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      CONVEX_URL: "",
      CRYSTAL_CONVEX_URL: "",
      MEMORY_CRYSTAL_API_URL: "",
      MEMORY_CRYSTAL_API_KEY: "",
      CRYSTAL_API_KEY: "",
      ...envOverrides,
    },
  });
}

test("crystal-enable preserves persisted plugin backend over generic CONVEX_URL drift", () => {
  const openclawDir = makeTmpDir();
  const configPath = path.join(openclawDir, "openclaw.json");
  fs.writeFileSync(configPath, JSON.stringify({
    plugins: {
      entries: {
        "crystal-memory": {
          enabled: true,
          config: {
            apiKey: "persisted-key",
            convexUrl: `${GOOD_BACKEND}/`,
          },
        },
      },
    },
  }, null, 2));

  const result = runEnable([], {
    OPENCLAW_DIR: openclawDir,
    CONVEX_URL: `${BAD_BACKEND}/`,
    MEMORY_CRYSTAL_API_KEY: "test-key",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const config = readJson(configPath);
  assert.equal(config.plugins.entries["crystal-memory"].config.convexUrl, GOOD_BACKEND);
  assert.equal(config.hooks.internal.entries["crystal-memory"].env.CONVEX_URL, GOOD_BACKEND);
  assert.equal(config.hooks.internal.entries["crystal-memory"].env.CRYSTAL_CONVEX_URL, GOOD_BACKEND);
});

test("crystal-enable prefers explicit CRYSTAL_CONVEX_URL over generic CONVEX_URL", () => {
  const openclawDir = makeTmpDir();
  const configPath = path.join(openclawDir, "openclaw.json");
  const result = runEnable([], {
    OPENCLAW_DIR: openclawDir,
    CONVEX_URL: BAD_BACKEND,
    CRYSTAL_CONVEX_URL: `${GOOD_BACKEND}/`,
    MEMORY_CRYSTAL_API_KEY: "test-key",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const config = readJson(configPath);
  assert.equal(config.plugins.entries["crystal-memory"].config.convexUrl, GOOD_BACKEND);
});

test("crystal-enable lets an explicit memory backend override replace persisted config", () => {
  const openclawDir = makeTmpDir();
  const configPath = path.join(openclawDir, "openclaw.json");
  fs.writeFileSync(configPath, JSON.stringify({
    plugins: {
      entries: {
        "crystal-memory": {
          enabled: true,
          config: {
            apiKey: "persisted-key",
            convexUrl: `${BAD_BACKEND}/`,
          },
        },
      },
    },
  }, null, 2));

  const result = runEnable([], {
    OPENCLAW_DIR: openclawDir,
    CRYSTAL_CONVEX_URL: `${GOOD_BACKEND}/`,
    MEMORY_CRYSTAL_API_KEY: "test-key",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const config = readJson(configPath);
  assert.equal(config.plugins.entries["crystal-memory"].config.convexUrl, GOOD_BACKEND);
  assert.match(result.stdout, /BACKEND_SOURCE=explicit memory backend env override/);
});

test("crystal-enable rejects generic bootstrap backends whose MCP routes 404", () => {
  const openclawDir = makeTmpDir();
  const configPath = path.join(openclawDir, "openclaw.json");
  const result = runEnable([], {
    OPENCLAW_DIR: openclawDir,
    CONVEX_URL: BAD_BACKEND,
    MEMORY_CRYSTAL_API_KEY: "test-key",
  });

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stdout + result.stderr, /refusing to persist Memory Crystal backend/);
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, "utf8");
    assert.equal(raw.trim(), "", "config should not be written on validation failure");
  }
});

test("crystal-enable can bypass backend validation when explicitly requested", () => {
  const openclawDir = makeTmpDir();
  const configPath = path.join(openclawDir, "openclaw.json");
  const result = runEnable(["--allow-unvalidated-backend"], {
    OPENCLAW_DIR: openclawDir,
    CONVEX_URL: `${BAD_BACKEND}/`,
    MEMORY_CRYSTAL_API_KEY: "test-key",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const config = readJson(configPath);
  assert.equal(config.plugins.entries["crystal-memory"].config.convexUrl, BAD_BACKEND);
  assert.match(result.stdout, /BACKEND_VALIDATION=MCP routes missing \(HTTP 404\)/);
});

test("crystal-enable auto-enables full context-engine mode when local sqlite is available and config is unset", () => {
  const openclawDir = makeTmpDir();
  const configPath = path.join(openclawDir, "openclaw.json");

  const result = runEnable([], {
    OPENCLAW_DIR: openclawDir,
    CRYSTAL_CONVEX_URL: `${GOOD_BACKEND}/`,
    MEMORY_CRYSTAL_API_KEY: "test-key",
    CRYSTAL_LOCAL_SQLITE_READY: "1",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const config = readJson(configPath);
  assert.equal(config.plugins.entries["crystal-memory"].config.localStoreEnabled, true);
  assert.equal(config.plugins.entries["crystal-memory"].config.contextEngineMode, "full");
});

test("crystal-enable does not mangle a custom-domain backend (§156 regression)", () => {
  const openclawDir = makeTmpDir();
  const configPath = path.join(openclawDir, "openclaw.json");
  const CUSTOM_BACKEND = "https://convex.memorycrystal.ai";

  // Persist the custom domain as the existing backend — mirrors the GOOD_BACKEND pattern above.
  fs.writeFileSync(configPath, JSON.stringify({
    plugins: {
      entries: {
        "crystal-memory": {
          enabled: true,
          config: {
            apiKey: "persisted-key",
            convexUrl: `${CUSTOM_BACKEND}/`,
          },
        },
      },
    },
  }, null, 2));

  // Use --allow-unvalidated-backend so no live HTTP call is made to the custom domain.
  const result = runEnable(["--allow-unvalidated-backend"], {
    OPENCLAW_DIR: openclawDir,
    CRYSTAL_CONVEX_URL: `${CUSTOM_BACKEND}/`,
    MEMORY_CRYSTAL_API_KEY: "test-key",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const config = readJson(configPath);
  // The custom domain must not be rewritten — the .convex.cloud→.convex.site regex
  // is anchored with $ and must not affect hostnames that merely contain "convex".
  assert.equal(config.plugins.entries["crystal-memory"].config.convexUrl, CUSTOM_BACKEND);
});

test("crystal-enable preserves explicit reduced-mode settings even when local sqlite is available", () => {
  const openclawDir = makeTmpDir();
  const configPath = path.join(openclawDir, "openclaw.json");
  fs.writeFileSync(configPath, JSON.stringify({
    plugins: {
      entries: {
        "crystal-memory": {
          enabled: true,
          config: {
            apiKey: "persisted-key",
            convexUrl: `${GOOD_BACKEND}/`,
            localStoreEnabled: false,
            contextEngineMode: "reduced",
          },
        },
      },
    },
  }, null, 2));

  const result = runEnable([], {
    OPENCLAW_DIR: openclawDir,
    CRYSTAL_CONVEX_URL: `${GOOD_BACKEND}/`,
    MEMORY_CRYSTAL_API_KEY: "test-key",
    CRYSTAL_LOCAL_SQLITE_READY: "1",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const config = readJson(configPath);
  assert.equal(config.plugins.entries["crystal-memory"].config.localStoreEnabled, false);
  assert.equal(config.plugins.entries["crystal-memory"].config.contextEngineMode, "reduced");
});

test("crystal-enable uses reachable local backend overlay and propagates bearer env", async () => {
  const server = createServer((_req, res) => {
    res.statusCode = 401;
    res.end("auth required");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const openclawDir = makeTmpDir();
    const configPath = path.join(openclawDir, "openclaw.json");
    const localBackend = `http://127.0.0.1:${server.address().port}`;
    const result = runEnable([], {
      OPENCLAW_DIR: openclawDir,
      CRYSTAL_BACKEND: "local",
      CRYSTAL_CONVEX_SITE_URL: `${localBackend}/`,
      MEMORY_CRYSTAL_API_KEY: "local-dev-bearer-token",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /BACKEND_SOURCE=local backend overlay/);
    const config = readJson(configPath);
    const entry = config.plugins.entries["crystal-memory"];
    assert.equal(entry.config.convexUrl, localBackend);
    assert.equal(entry.config.apiKey, "local-dev-bearer-token");
    assert.equal(config.hooks.internal.entries["crystal-memory"].env.CRYSTAL_API_KEY, "local-dev-bearer-token");
    assert.equal(config.hooks.internal.entries["crystal-memory"].env.CRYSTAL_CONVEX_URL, localBackend);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
