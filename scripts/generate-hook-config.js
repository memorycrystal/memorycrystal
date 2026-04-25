#!/usr/bin/env node

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const args = process.argv.slice(2);
const isHelp = args.includes("--help") || args.includes("-h");
const isDryRun = args.includes("--dry-run");

const unknownArgs = args.filter((arg) => !["--help", "-h", "--dry-run"].includes(arg));

const usage = () => {
  console.log(`Usage:
  node scripts/generate-hook-config.js [--dry-run] [--help]

Reads from:
  mcp-server/.env (preferred) or .env

Writes:
  plugin/openclaw-hook.json
  ~/.openclaw/extensions/internal-hooks/openclaw-hook.json

Options:
  --dry-run  Show generated JSON without writing files.
  --help     Show this usage message.`);
};

if (isHelp) {
  usage();
  process.exit(0);
}

if (unknownArgs.length > 0) {
  console.error(`Unknown argument(s): ${unknownArgs.join(", ")}`);
  usage();
  process.exit(1);
}

const fail = (message) => {
  console.error(`ERROR: ${message}`);
  process.exit(1);
};

const stripQuotes = (value) => {
  if (typeof value !== "string") {
    return "";
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
};

const readEnv = (envPath) => {
  const values = {};
  const raw = fs.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }
    const idx = trimmed.indexOf("=");
    const key = trimmed.slice(0, idx).trim();
    const value = stripQuotes(trimmed.slice(idx + 1).trim());
    if (key) {
      values[key] = value;
    }
  }
  return values;
};

const writeJson = (targetPath, payload, dryRun) => {
  const redactForDisplay = (value, keyPath = []) => {
    if (Array.isArray(value)) {
      return value.map((item, index) => redactForDisplay(item, keyPath.concat(String(index))));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, nested]) => {
          const nextPath = keyPath.concat(key);
          if (
            typeof nested === "string" &&
            /(?:api[_-]?key|token|secret|password|authorization)/i.test(key)
          ) {
            return [key, "[REDACTED]"];
          }
          return [key, redactForDisplay(nested, nextPath)];
        })
      );
    }
    return value;
  };

  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (dryRun) {
    console.log(`\n[DRY RUN] ${targetPath}`);
    console.log(`${JSON.stringify(redactForDisplay(payload), null, 2)}\n`);
    return;
  }
  fs.writeFileSync(targetPath, text, "utf8");
};

const SCRIPT_DIR = path.resolve(__dirname);
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const PLUGIN_DIR = path.resolve(REPO_ROOT, "plugin");
const MCP_DIST_DIR = path.resolve(REPO_ROOT, "mcp-server", "dist");
const MCP_DIST = path.join(MCP_DIST_DIR, "index.js");
const MCP_ENV_FILE = fs.existsSync(path.resolve(REPO_ROOT, "mcp-server", ".env"))
  ? path.resolve(REPO_ROOT, "mcp-server", ".env")
  : path.resolve(REPO_ROOT, ".env");
const INTERNAL_HOOK_PATH = path.join(os.homedir(), ".openclaw", "extensions", "internal-hooks", "openclaw-hook.json");
const PLUGIN_HOOK_PATH = path.join(PLUGIN_DIR, "openclaw-hook.json");

if (!fs.existsSync(PLUGIN_DIR)) {
  fail(`Plugin directory is missing: ${PLUGIN_DIR}`);
}
if (!fs.existsSync(MCP_DIST)) {
  fail(`MCP dist entrypoint not found: ${MCP_DIST}`);
}
if (!fs.existsSync(MCP_ENV_FILE)) {
  fail(`No env file found. Expected one of: ${path.resolve(REPO_ROOT, "mcp-server", ".env")} or ${path.resolve(REPO_ROOT, ".env")}`);
}

const NODE_PATH = process.execPath;
if (!fs.existsSync(NODE_PATH)) {
  fail(`Node executable not found at ${NODE_PATH}`);
}

const env = readEnv(MCP_ENV_FILE);
const requiredEnv = ["CONVEX_URL", "OPENAI_API_KEY", "OBSIDIAN_VAULT_PATH"];
const missingEnv = requiredEnv.filter((key) => !env[key]);
if (missingEnv.length > 0) {
  fail(`Missing required env keys in ${MCP_ENV_FILE}: ${missingEnv.join(", ")}`);
}

const captureHookPath = path.join(PLUGIN_DIR, "capture-hook.js");
const recallHookPath = path.join(PLUGIN_DIR, "recall-hook.js");

const commandEnv = {
  CONVEX_URL: stripQuotes(env.CONVEX_URL),
  OPENAI_API_KEY: stripQuotes(env.OPENAI_API_KEY),
  EMBEDDING_PROVIDER: stripQuotes(env.EMBEDDING_PROVIDER || ""),
  GEMINI_API_KEY: stripQuotes(env.GEMINI_API_KEY || ""),
  GEMINI_EMBEDDING_MODEL: stripQuotes(env.GEMINI_EMBEDDING_MODEL || ""),
  OBSIDIAN_VAULT_PATH: stripQuotes(env.OBSIDIAN_VAULT_PATH),
  CRYSTAL_MCP_HOST: stripQuotes(env.CRYSTAL_MCP_HOST || "127.0.0.1"),
  CRYSTAL_MCP_PORT: stripQuotes(env.CRYSTAL_MCP_PORT || "8788"),
  CRYSTAL_ENV_FILE: MCP_ENV_FILE,
  // Portability vars — injected so hooks/manifest can resolve paths without hardcoding
  CRYSTAL_NODE: NODE_PATH,
  CRYSTAL_PLUGIN_DIR: PLUGIN_DIR,
  CRYSTAL_ROOT: REPO_ROOT,
};

const pluginManifestTools = [
  "crystal_remember",
  "crystal_recall",
  "crystal_recent",
  "crystal_search_messages",
  "crystal_what_do_i_know",
  "crystal_why_did_we",
  "crystal_who_owns",
  "crystal_explain_connection",
  "crystal_dependency_chain",
  "crystal_preflight",
  "crystal_trace",
  "crystal_edit",
  "crystal_forget",
  "crystal_stats",
  "crystal_checkpoint",
  "crystal_wake",
  "crystal_ideas",
  "crystal_idea_action",
  "crystal_list_knowledge_bases",
  "crystal_query_knowledge_base",
  "crystal_import_knowledge",
];

const pluginConfig = {
  schemaVersion: 1,
  id: "crystal",
  name: "Memory Crystal",
  version: "0.1.0",
  description: "Drop-in OpenClaw memory plugin using Convex + MCP tools.",
  entry: "./handler.js",
  hooks: {
    postTurn: {
      enabled: false,
      description: "Reserved for future memory auto-write flows.",
    },
    startup: {
      enabled: true,
      description: "Load plugin metadata on OpenClaw startup.",
    },
  },
  capabilities: {
    tools: pluginManifestTools,
    mcpCommand: NODE_PATH,
    mcpArgs: [MCP_DIST],
  },
  commands: {
    "crystal-capture": {
      command: NODE_PATH,
      args: [captureHookPath],
      env: {
        ...commandEnv,
        CRYSTAL_MCP_MODE: "stdio",
      },
    },
    "crystal-recall": {
      command: NODE_PATH,
      args: [recallHookPath],
      env: {
        ...commandEnv,
        CRYSTAL_MCP_MODE: "stdio",
      },
    },
  },
  env: {
    CRYSTAL_MCP_MODE: "stdio",
    CRYSTAL_MCP_HOST: commandEnv.CRYSTAL_MCP_HOST,
    CRYSTAL_MCP_PORT: commandEnv.CRYSTAL_MCP_PORT,
    CRYSTAL_ENV_FILE: MCP_ENV_FILE,
  },
};

const internalHookConfig = {
  commands: {
    "crystal-memory": {
      command: NODE_PATH,
      args: [MCP_DIST],
      env: {
        ...commandEnv,
        CRYSTAL_MCP_MODE: "stdio",
      },
    },
    "crystal-capture": {
      command: NODE_PATH,
      args: [captureHookPath],
      env: {
        ...commandEnv,
        CRYSTAL_MCP_MODE: "stdio",
      },
    },
    "crystal-recall": {
      command: NODE_PATH,
      args: [recallHookPath],
      env: {
        ...commandEnv,
        CRYSTAL_MCP_MODE: "stdio",
      },
    },
  },
};

console.log("Detected configuration:");
console.log(`  node: ${NODE_PATH}`);
console.log(`  plugin: ${PLUGIN_DIR}`);
console.log(`  mcp dist: ${MCP_DIST}`);
console.log(`  env file: ${MCP_ENV_FILE}`);

fs.mkdirSync(path.dirname(INTERNAL_HOOK_PATH), { recursive: true });
writeJson(PLUGIN_HOOK_PATH, pluginConfig, isDryRun);
writeJson(INTERNAL_HOOK_PATH, internalHookConfig, isDryRun);

if (isDryRun) {
  console.log("\n[DRY RUN] No files were written.");
  process.exit(0);
}

console.log(`Wrote plugin manifest: ${PLUGIN_HOOK_PATH}`);
console.log(`Wrote OpenClaw internal hook map: ${INTERNAL_HOOK_PATH}`);
