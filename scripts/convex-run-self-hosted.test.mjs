import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CREDENTIAL_RETURNING_FUNCTIONS,
  SAFE_OBSERVABLE_OUTPUT_SCHEMAS,
  SENSITIVE_TABLES,
  SENSITIVE_TABLE_SAFE_PROJECTIONS,
  classifyConvexFunctionOutput,
  projectSafeObservableOutput,
} from "./lib/convex-function-output-policy.mjs";
import { parseSafeObservableArgs } from "./lib/convex-run-safe-observable-args.mjs";

const SCRIPT_PATH = fileURLToPath(
  new URL("./convex-run-self-hosted.mjs", import.meta.url),
);

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "memorycrystal-convex-run-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const markerPath = join(directory, "npx-call.json");
  writeFileSync(
    join(directory, "npx"),
    `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(process.env.SHIM_MARKER, JSON.stringify({
  admin: process.env.CONVEX_SELF_HOSTED_ADMIN_KEY,
  args: process.argv.slice(2),
  deployment: process.env.CONVEX_DEPLOYMENT,
  deployKey: process.env.CONVEX_DEPLOY_KEY,
  url: process.env.CONVEX_SELF_HOSTED_URL,
}));
if (process.env.SHIM_RAW_OUTPUT) {
  process.stdout.write(process.env.SHIM_RAW_OUTPUT);
  process.stderr.write(process.env.SHIM_RAW_OUTPUT);
}
`,
    { mode: 0o755 },
  );
  return { directory, markerPath };
}

function baseEnv(directory, markerPath) {
  return {
    ...process.env,
    CONVEX_DEPLOYMENT: "prod:managed-cloud",
    CONVEX_DEPLOY_KEY: "managed-cloud-key",
    CONVEX_SELF_HOSTED_ADMIN_KEY: "self-hosted-admin-fixture",
    CONVEX_SELF_HOSTED_URL: "https://self-hosted.example.test",
    PATH: `${directory}:${process.env.PATH}`,
    SHIM_MARKER: markerPath,
  };
}

test("convex run wrapper passes only the resolved self-hosted environment to npx", (t) => {
  const { directory, markerPath } = fixture(t);
  const result = spawnSync(
    process.execPath,
    [SCRIPT_PATH, "crystal/example:query", '{"value":1}'],
    { encoding: "utf8", env: baseEnv(directory, markerPath) },
  );

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const call = JSON.parse(readFileSync(markerPath, "utf8"));
  assert.deepEqual(call.args, [
    "convex",
    "run",
    "crystal/example:query",
    '{"value":1}',
  ]);
  assert.equal(call.url, "https://self-hosted.example.test");
  assert.equal(call.admin, "self-hosted-admin-fixture");
  assert.equal(call.deployment, "");
  assert.equal(call.deployKey, "");
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("--allow-local is consumed by the wrapper and never forwarded", (t) => {
  const { directory, markerPath } = fixture(t);
  const env = baseEnv(directory, markerPath);
  env.CONVEX_SELF_HOSTED_URL = "http://127.0.0.1:3210";
  const result = spawnSync(
    process.execPath,
    [SCRIPT_PATH, "crystal/example:query", "{}", "--allow-local"],
    { encoding: "utf8", env },
  );

  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  const call = JSON.parse(readFileSync(markerPath, "utf8"));
  assert.deepEqual(call.args, ["convex", "run", "crystal/example:query", "{}"]);
});

test("wrapper rejects partial self-hosted credentials before invoking npx", (t) => {
  const { directory, markerPath } = fixture(t);
  const env = baseEnv(directory, markerPath);
  delete env.CONVEX_SELF_HOSTED_ADMIN_KEY;
  const result = spawnSync(
    process.execPath,
    [SCRIPT_PATH, "crystal/example:query", "{}"],
    { encoding: "utf8", env },
  );

  assert.equal(result.status, 2);
  assert.match(result.stderr, /partial self-hosted credentials/);
  assert.equal(existsSync(markerPath), false);
});

test("wrapper refuses credential-returning mutations before inherited stdout can leak", (t) => {
  for (const functionName of CREDENTIAL_RETURNING_FUNCTIONS) {
    const { directory, markerPath } = fixture(t);
    const result = spawnSync(
      process.execPath,
      [
        SCRIPT_PATH,
        functionName,
        "{}",
        ...(functionName.includes("provisionScoped") ? ["--allow-local"] : []),
      ],
      { encoding: "utf8", env: baseEnv(directory, markerPath) },
    );

    assert.equal(result.status, 2);
    assert.match(result.stderr, /Refusing a credential-returning function/);
    assert.equal(existsSync(markerPath), false);
  }
});

test("option-prefixed credential functions never reach npx (exact cycle-4 bypass)", (t) => {
  const layouts = [
    ["--typecheck", "disable", "crystal/apiKeys:mintApiKeyForUserInternal", "{}"],
    ["--typecheck=disable", "crystal/apiKeys:mintApiKeyForUserInternal", "{}"],
    ["--prod", "crystal/apiKeys:mintApiKeyForUserInternal", "{}"],
    ["--deployment", "prod", "cloud/cfTunnel:claimTunnel", "{}"],
    ["--", "crystal/apiKeys:mintApiKeyForUserInternal", "{}"],
    ["--identity", '{"name":"x"}', "cloud/provisionTenant:provisionTenant", "{}"],
    ["--push", "cloud/tunnelReclaim:_resumeTenant", "{}"],
    [
      "--typecheck",
      "disable",
      "--codegen",
      "disable",
      "crystal/apiKeys:prepareApiKeyRotationForUserInternal",
      "{}",
    ],
  ];

  for (const argv of layouts) {
    const { directory, markerPath } = fixture(t);
    const result = spawnSync(process.execPath, [SCRIPT_PATH, ...argv], {
      encoding: "utf8",
      env: baseEnv(directory, markerPath),
    });
    assert.equal(result.status, 2, argv.join(" "));
    assert.match(
      result.stderr,
      /Refusing convex run options before the function name|Refusing a credential-returning function/,
    );
    assert.equal(existsSync(markerPath), false, argv.join(" "));
  }
});

test("credential function after valid position is still refused regardless of trailing options", (t) => {
  const { directory, markerPath } = fixture(t);
  const result = spawnSync(
    process.execPath,
    [
      SCRIPT_PATH,
      "crystal/apiKeys:mintApiKeyForUserInternal",
      "{}",
      "--typecheck",
      "disable",
    ],
    { encoding: "utf8", env: baseEnv(directory, markerPath) },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Refusing a credential-returning function/);
  assert.equal(existsSync(markerPath), false);
});

test("unclassified child output is captured and never replayed", (t) => {
  const { directory, markerPath } = fixture(t);
  const syntheticRawKey = `DUMMY_${"PRODUCTION_RAW_KEY".repeat(4)}`;
  const env = baseEnv(directory, markerPath);
  env.SHIM_RAW_OUTPUT = syntheticRawKey;
  const result = spawnSync(
    process.execPath,
    [SCRIPT_PATH, "crystal/example:query", "{}"],
    { encoding: "utf8", env },
  );

  assert.equal(result.status, 0);
  assert.equal(existsSync(markerPath), true);
  assert.equal(`${result.stdout}${result.stderr}`.includes(syntheticRawKey), false);
});

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (
        entry.name === "__tests__" ||
        entry.name === "_generated" ||
        entry.name === "node_modules"
      ) {
        return [];
      }
      return sourceFiles(path);
    }
    return entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  });
}

// Credential / capability keys returned by Convex exports. Includes one-time
// device/session codes and staging tokens as well as raw API keys.
const CREDENTIAL_RETURN_KEYS =
  "rawKey|apiKey|bootstrapToken|tunnelToken|sessionToken|providerKey|openrouterApiKey|geminiApiKey|valueSecret|cleartext|deviceCode|userCode|stagingToken";

// Terminal read methods that materialize full document rows (or arrays of them).
const ROW_TERMINALS = "first|collect|unique|take";

function returnExprCarriesCredential(expr) {
  const trimmed = expr.trim();
  if (/^rawKey\b/.test(trimmed)) return true;
  // Explicit property: apiKey: value / deviceCode: value
  if (new RegExp(`\\b(?:${CREDENTIAL_RETURN_KEYS})\\s*:`).test(expr)) {
    return true;
  }
  // Object shorthand: { keyId, rawKey, deactivated } or { deviceCode, userCode }
  if (
    new RegExp(`[{\\,]\\s*(?:${CREDENTIAL_RETURN_KEYS})\\s*[\\,}\\n]`).test(
      expr,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Detect full-document passthrough of secret-bearing tables.
 * Conservative heuristic (not full dataflow analysis): flag chain returns,
 * bare/spread/filter/map/alias returns of variables assigned from
 * sensitive-table reads, arrays of rows, and typed Doc returns. Mere side-effect
 * queries and field projections do not match. Safe projections must be
 * allowlisted in SENSITIVE_TABLE_SAFE_PROJECTIONS.
 */
function bodyReturnsSensitiveTablePassthrough(body) {
  for (const table of SENSITIVE_TABLES) {
    const tableLit = String.raw`["']${table}["']`;

    // return ctx.db.query("sensitive")....first()/collect()/unique()/take()
    // Require ctx.db so export const name = internalQuery({...}) cannot match.
    // Allow whitespace/newlines between db and .query (common Convex style).
    // Stay within a single statement: no ';' between return and the table read.
    if (
      new RegExp(
        String.raw`\breturn\s+(?:await\s+)?[^;]{0,240}?ctx\.db\s*\.\s*query\s*\(\s*${tableLit}[^;]{0,500}?\.(?:${ROW_TERMINALS})\s*\(`,
      ).test(body)
    ) {
      return true;
    }

    // const row = await ctx.db.query("sensitive")....first()/take(); return row
    // also return { ...row }, return row.filter(...), return row.map(...)
    // Bind directly to ctx.db.query so `export const getFoo = internalQuery({`
    // cannot capture the export name (its body also contains ctx.db.query).
    const assignRe = new RegExp(
      String.raw`(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?ctx\.db\s*\.\s*query\s*\(\s*${tableLit}[^;]{0,500}?\.(?:${ROW_TERMINALS})\s*\(`,
      "g",
    );
    for (const match of body.matchAll(assignRe)) {
      const id = match[1];
      // Bare identifier return only (not return id.field / return { queued }).
      if (
        new RegExp(
          String.raw`\breturn\s+(?:await\s+)?${id}\s*(?:;|//|/\*|\n|$)`,
        ).test(body)
      ) {
        return true;
      }
      if (
        new RegExp(
          String.raw`\breturn\s+\{[^;]{0,240}?\.\.\.\s*${id}\b`,
        ).test(body)
      ) {
        return true;
      }
      // Filtered / mapped / sliced arrays of sensitive rows.
      if (
        new RegExp(
          String.raw`\breturn\s+(?:await\s+)?${id}\s*\.\s*(?:filter|map|slice|flatMap|concat)\s*\(`,
        ).test(body)
      ) {
        return true;
      }
      // Alias then return: const eligible = rows.filter(...); return eligible;
      const aliasRe = new RegExp(
        String.raw`(?:const|let)\s+(\w+)\s*=\s*${id}\s*\.\s*(?:filter|map|slice|flatMap)\s*\(`,
        "g",
      );
      for (const aliasMatch of body.matchAll(aliasRe)) {
        const alias = aliasMatch[1];
        if (
          new RegExp(
            String.raw`\breturn\s+(?:await\s+)?${alias}\s*(?:;|//|/\*|\n|$)`,
          ).test(body)
        ) {
          return true;
        }
      }
    }

    // ctx.db.get(id) where id is typed as Id<"sensitive"> (knowable table type).
    if (
      new RegExp(
        String.raw`\breturn\s+(?:await\s+)?ctx\.db\.get\s*\([^)]*Id\s*<\s*${tableLit}`,
      ).test(body)
    ) {
      return true;
    }
    // Typed full-document return: Promise<Doc<"sensitive"> | null> or arrays.
    // Bound the scan to the handler head so later body text cannot match.
    if (
      new RegExp(
        String.raw`:\s*Promise\s*<\s*(?:Doc\s*<\s*${tableLit}\s*>|Array\s*<\s*Doc\s*<\s*${tableLit}\s*>)`,
      ).test(body.slice(0, 500))
    ) {
      return true;
    }
  }
  return false;
}

function bodyLooksCredentialReturning(body, functionKey = "") {
  if (SENSITIVE_TABLE_SAFE_PROJECTIONS.has(functionKey)) {
    // Still catch explicit raw credential property returns even on allowlisted
    // exports (defense in depth).
    // Fall through only for property-name checks, not table passthrough.
  } else if (bodyReturnsSensitiveTablePassthrough(body)) {
    return true;
  }

  // Direct raw-key return (createApiKey / regenerate / mint / issue).
  if (/\breturn\s+rawKey\b/.test(body)) return true;

  // Only inspect actual return statements so helper locals (auth extractors,
  // rate-limit wrappers) in the same file cannot poison classification.
  const returnStatements = body.matchAll(
    /\breturn\s+([\s\S]*?)(?:;|\n\s*(?:}|const |let |if |for |while |throw |await |return ))/g,
  );
  for (const match of returnStatements) {
    if (returnExprCarriesCredential(match[1])) return true;
  }

  // Handler return-type annotations: only keys inside the Promise<{...}> object
  // type. Do not scan past the first closing brace into the function body
  // (args like { deviceCode } must not poison classification).
  const head = body.slice(0, 800);
  if (
    new RegExp(
      String.raw`:\s*Promise<\s*\{[^}]{0,400}\b(?:${CREDENTIAL_RETURN_KEYS})\b`,
    ).test(head)
  ) {
    return true;
  }
  // Re-export / passthrough of a known credential result type.
  if (
    /:\s*Promise<\s*ProvisionResult\s*>/.test(head) &&
    /\breturn\s+result\b/.test(body)
  ) {
    return true;
  }
  return false;
}

function nextExportBoundary(source, fromIndex) {
  const tail = source.slice(fromIndex + 1);
  // Stop at the next top-level declaration so non-exported helpers that follow
  // an export (httpAction wrappers, requireAuth, etc.) are not absorbed.
  const match = tail.match(
    /\n(?=(?:export\s+(?:const|function|async\s+function|type|interface|class|default)\b|(?:async\s+)?function\s+[A-Za-z_]|(?:type|interface|class)\s+[A-Za-z_]))/,
  );
  if (!match || match.index === undefined) return source.length;
  return fromIndex + 1 + match.index;
}

const EXPORT_DECLARATION =
  /export const\s+(\w+)(?:\s*:\s*[^=]+)?\s*=\s*(?:internalMutation|mutation|internalQuery|query|internalAction|action)\s*\(/g;

function iterateCrystalCloudExports(callback) {
  const convexRoot = fileURLToPath(new URL("../convex/", import.meta.url));
  for (const path of sourceFiles(convexRoot)) {
    const relative = path
      .slice(convexRoot.length)
      .replace(/^[/\\]+/, "")
      .replaceAll("\\", "/");
    if (!relative.startsWith("crystal/") && !relative.startsWith("cloud/")) {
      continue;
    }
    if (relative.includes("/__tests__/") || relative.includes("/fixtures/")) {
      continue;
    }
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(EXPORT_DECLARATION)) {
      const start = match.index;
      const end = nextExportBoundary(source, start);
      const body = source.slice(start, end);
      const modulePath = relative.replace(/\.ts$/, "");
      const functionKey = `${modulePath}:${match[1]}`;
      callback({ functionKey, body, modulePath, relative, path });
    }
  }
}

function credentialReturningFunctionsFromSource() {
  const found = new Set();
  iterateCrystalCloudExports(({ functionKey, body }) => {
    if (bodyLooksCredentialReturning(body, functionKey)) {
      found.add(functionKey);
    }
  });
  return found;
}

function sensitiveTableTouchingExportsFromSource() {
  const found = new Map();
  iterateCrystalCloudExports(({ functionKey, body }) => {
    const tables = [...SENSITIVE_TABLES].filter(
      (table) => body.includes(`"${table}"`) || body.includes(`'${table}'`),
    );
    if (tables.length > 0) found.set(functionKey, tables);
  });
  return found;
}

const REQUIRED_CLOUD_CREDENTIAL_FUNCTIONS = [
  "cloud/cfTunnel:claimTunnel",
  "cloud/provisionTenant:provisionTenant",
  "cloud/tunnelReclaim:_resumeTenant",
];

const REQUIRED_SENSITIVE_TABLE_PASSTHROUGH = [
  "crystal/adminSettings/mutations:getStagingRow",
  "crystal/organic/tick:getEnabledTickStates",
  "crystal/organic/tick:getTickStateByUser",
  "crystal/organic/ideaDigest:getDigestEligibleUsers",
];

const REQUIRED_CYCLE6_CREDENTIAL_FUNCTIONS = [
  "crystal/organic/tick:getEnabledTickStates",
  "crystal/organic/ideaDigest:getDigestEligibleUsers",
  "crystal/deviceAuth:startSession",
];

test("source-derived credential-returning functions are centrally classified", () => {
  const discovered = credentialReturningFunctionsFromSource();
  const missing = [...discovered].filter(
    (name) => !CREDENTIAL_RETURNING_FUNCTIONS.has(name),
  );
  assert.deepEqual(
    missing,
    [],
    `Policy omitted credential-returning functions: ${missing.join(", ")}`,
  );
  for (const required of REQUIRED_CLOUD_CREDENTIAL_FUNCTIONS) {
    assert.equal(
      CREDENTIAL_RETURNING_FUNCTIONS.has(required),
      true,
      `Policy must deny ${required}`,
    );
    assert.equal(
      discovered.has(required),
      true,
      `Source discovery must find ${required}`,
    );
  }
  for (const required of REQUIRED_SENSITIVE_TABLE_PASSTHROUGH) {
    assert.equal(
      discovered.has(required),
      true,
      `Source discovery must find sensitive-table passthrough ${required}`,
    );
    assert.equal(
      CREDENTIAL_RETURNING_FUNCTIONS.has(required),
      true,
      `Policy must deny sensitive-table passthrough ${required}`,
    );
  }
  // Policy may include intentional extras that the heuristic also finds; every
  // policy entry must still resolve to a real export in the scanned tree.
  const allDeclared = new Set();
  iterateCrystalCloudExports(({ functionKey }) => {
    allDeclared.add(functionKey);
  });
  const stale = [...CREDENTIAL_RETURNING_FUNCTIONS].filter(
    (name) => !allDeclared.has(name),
  );
  assert.deepEqual(stale, [], `Policy has stale entries: ${stale.join(", ")}`);
});

test("every sensitive-table export is credential-classified or an explicit safe projection", () => {
  const touching = sensitiveTableTouchingExportsFromSource();
  const unreviewed = [];
  for (const [functionKey] of touching) {
    if (CREDENTIAL_RETURNING_FUNCTIONS.has(functionKey)) continue;
    if (SENSITIVE_TABLE_SAFE_PROJECTIONS.has(functionKey)) continue;
    unreviewed.push(functionKey);
  }
  assert.deepEqual(
    unreviewed,
    [],
    `Sensitive-table exports lack classification: ${unreviewed.join(", ")}`,
  );

  // Safe projections must not trip credential discovery (shape excludes raw fields).
  for (const safe of SENSITIVE_TABLE_SAFE_PROJECTIONS) {
    assert.equal(
      CREDENTIAL_RETURNING_FUNCTIONS.has(safe),
      false,
      `Safe projection ${safe} must not also be credential-classified`,
    );
  }
  const discovered = credentialReturningFunctionsFromSource();
  for (const safe of SENSITIVE_TABLE_SAFE_PROJECTIONS) {
    assert.equal(
      discovered.has(safe),
      false,
      `Safe projection ${safe} must not be discovered as credential-returning (returned shape must exclude raw fields)`,
    );
    assert.equal(
      touching.has(safe),
      true,
      `Safe projection ${safe} must still reference a sensitive table`,
    );
  }

  // Stale safe-projection entries are not allowed.
  const allDeclared = new Set();
  iterateCrystalCloudExports(({ functionKey }) => allDeclared.add(functionKey));
  const staleSafe = [...SENSITIVE_TABLE_SAFE_PROJECTIONS].filter(
    (name) => !allDeclared.has(name),
  );
  assert.deepEqual(
    staleSafe,
    [],
    `Safe-projection policy has stale entries: ${staleSafe.join(", ")}`,
  );
});

test("cycle-6 credential omissions are discovered, classified, and blocked (incl. option-prefixed)", (t) => {
  const discovered = credentialReturningFunctionsFromSource();
  for (const target of REQUIRED_CYCLE6_CREDENTIAL_FUNCTIONS) {
    assert.equal(discovered.has(target), true, `discovery must find ${target}`);
    assert.equal(
      CREDENTIAL_RETURNING_FUNCTIONS.has(target),
      true,
      `policy must deny ${target}`,
    );
    assert.equal(classifyConvexFunctionOutput(target), "credential");

    const layouts = [
      [target, "{}"],
      ["--typecheck", "disable", target, "{}"],
      ["--typecheck=disable", target, "{}"],
      ["--prod", target, "{}"],
      ["--", target, "{}"],
    ];
    for (const argv of layouts) {
      const { directory, markerPath } = fixture(t);
      const result = spawnSync(process.execPath, [SCRIPT_PATH, ...argv], {
        encoding: "utf8",
        env: baseEnv(directory, markerPath),
      });
      assert.equal(result.status, 2, `${target} ${argv.join(" ")}`);
      assert.match(
        result.stderr,
        /Refusing a credential-returning function|Refusing convex run options before the function name/,
      );
      assert.equal(existsSync(markerPath), false, argv.join(" "));
    }
  }
});

test("fixture: .take() / filtered-array / session-capability variants classify as credential", () => {
  // Synthetic bodies mirroring the three cycle-6 reproductions plus variants.
  const takeBody = `
export const getEnabledTickStates = internalQuery({
  args: {},
  handler: async (ctx) => {
    return ctx.db
      .query("organicTickState")
      .withIndex("by_enabled", (q) => q.eq("enabled", true))
      .take(500);
  },
});
`;
  const filterBody = `
export const getDigestEligibleUsers = internalQuery({
  args: {},
  handler: async (ctx) => {
    const states = await ctx.db
      .query("organicTickState")
      .withIndex("by_enabled", (q) => q.eq("enabled", true))
      .take(500);
    return states.filter((s) => s.notificationEmail === true);
  },
});
`;
  const sessionBody = `
export const startSession = internalMutation({
  args: {},
  handler: async (ctx) => {
    return { deviceCode, userCode, expiresAt: now + SESSION_TTL_MS };
  },
});
`;
  const aliasBody = `
export const listSensitive = internalQuery({
  handler: async (ctx) => {
    const rows = await ctx.db.query("userProviderSettings").collect();
    const eligible = rows.filter((r) => r.active);
    return eligible;
  },
});
`;
  assert.equal(bodyReturnsSensitiveTablePassthrough(takeBody), true);
  assert.equal(bodyReturnsSensitiveTablePassthrough(filterBody), true);
  assert.equal(bodyLooksCredentialReturning(sessionBody, "x:startSession"), true);
  assert.equal(bodyReturnsSensitiveTablePassthrough(aliasBody), true);
  assert.equal(
    bodyLooksCredentialReturning(takeBody, "crystal/organic/tick:getEnabledTickStates"),
    true,
  );
});

test("getStagingRow is discovered, classified, and blocked before npx (incl. option-prefixed)", (t) => {
  const target = "crystal/adminSettings/mutations:getStagingRow";
  const discovered = credentialReturningFunctionsFromSource();
  assert.equal(discovered.has(target), true);
  assert.equal(CREDENTIAL_RETURNING_FUNCTIONS.has(target), true);

  const layouts = [
    [target, "{}"],
    ["--typecheck", "disable", target, "{}"],
    ["--typecheck=disable", target, "{}"],
    ["--prod", target, "{}"],
    ["--", target, "{}"],
  ];
  for (const argv of layouts) {
    const { directory, markerPath } = fixture(t);
    const result = spawnSync(process.execPath, [SCRIPT_PATH, ...argv], {
      encoding: "utf8",
      env: baseEnv(directory, markerPath),
    });
    assert.equal(result.status, 2, argv.join(" "));
    assert.match(
      result.stderr,
      /Refusing a credential-returning function|Refusing convex run options before the function name/,
    );
    assert.equal(existsSync(markerPath), false, argv.join(" "));
  }
});

// ── Safe-observable output policy (AC-7 / AC-8 count evidence) ─────────────

function adminHelperFixture(t, { payload, exitCode = 0, stderr = "" } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "memorycrystal-safe-obs-"));
  t.after(() => rmSync(directory, { force: true, recursive: true }));
  const helperPath = join(directory, "admin-helper.mjs");
  const markerPath = join(directory, "helper-call.json");
  writeFileSync(
    helperPath,
    `#!/usr/bin/env node
import { writeFileSync, writeSync } from "node:fs";
writeFileSync(process.env.HELPER_MARKER, JSON.stringify({
  argv: process.argv.slice(2),
  admin: process.env.CONVEX_SELF_HOSTED_ADMIN_KEY,
  url: process.env.CONVEX_SELF_HOSTED_URL,
}));
if (${exitCode} !== 0) {
  process.stderr.write(${JSON.stringify(stderr || "helper failed")});
  process.exit(${exitCode});
}
const payload = ${JSON.stringify(payload ?? null)};
try {
  writeSync(3, JSON.stringify(payload) + "\\n");
} catch {
  process.stderr.write("fd3 write failed");
  process.exit(1);
}
`,
    { mode: 0o755 },
  );
  return { directory, helperPath, markerPath };
}

test("projectSafeObservableOutput accepts exact valid count shapes", () => {
  assert.deepEqual(
    projectSafeObservableOutput(
      "crystal/dailyDriver:emitOvernightBriefForAllUsers",
      { usersScanned: 3, briefsEmitted: 1 },
    ),
    { usersScanned: 3, briefsEmitted: 1 },
  );
  assert.deepEqual(
    projectSafeObservableOutput(
      "crystal/hygieneWorklist:runGraphLintForAllUsers",
      { usersLinted: 2, usersWithFindings: 1, ideasEmitted: 0 },
    ),
    { usersLinted: 2, usersWithFindings: 1, ideasEmitted: 0 },
  );
  assert.deepEqual(
    projectSafeObservableOutput(
      "crystal/hygieneWorklist:runConceptGapScanForAllUsers",
      { usersScanned: 5, totalEmitted: 2 },
    ),
    { usersScanned: 5, totalEmitted: 2 },
  );
});

test("projectSafeObservableOutput rejects extra fields, secrets, negatives, non-integers", () => {
  const fn = "crystal/dailyDriver:emitOvernightBriefForAllUsers";
  assert.throws(() =>
    projectSafeObservableOutput(fn, {
      usersScanned: 1,
      briefsEmitted: 0,
      openrouterApiKey: "sk-secret",
    }),
  );
  assert.throws(() =>
    projectSafeObservableOutput(fn, { usersScanned: -1, briefsEmitted: 0 }),
  );
  assert.throws(() =>
    projectSafeObservableOutput(fn, { usersScanned: 1.5, briefsEmitted: 0 }),
  );
  assert.throws(() =>
    projectSafeObservableOutput(fn, { usersScanned: "1", briefsEmitted: 0 }),
  );
  assert.throws(() => projectSafeObservableOutput(fn, null));
  assert.throws(() => projectSafeObservableOutput(fn, "not-json-object"));
  assert.throws(() =>
    projectSafeObservableOutput(fn, { usersScanned: 1 }),
  );
});

test("safe-observable wrapper prints projected counts via fd-3 only", (t) => {
  for (const [functionName, fields] of Object.entries(
    SAFE_OBSERVABLE_OUTPUT_SCHEMAS,
  )) {
    const payload = Object.fromEntries(fields.map((f, i) => [f, i + 1]));
    const { directory, helperPath, markerPath } = adminHelperFixture(t, {
      payload,
    });
    const env = {
      ...baseEnv(directory, join(directory, "unused-npx-marker")),
      HELPER_MARKER: markerPath,
      MEMORY_CRYSTAL_CONVEX_ADMIN_RUN_HELPER: helperPath,
      // PATH without a usable npx so accidental spawn would fail loudly.
      PATH: directory,
    };
    const result = spawnSync(
      process.execPath,
      [SCRIPT_PATH, functionName, "{}"],
      { encoding: "utf8", env },
    );
    assert.equal(result.status, 0, `${functionName}: ${result.stderr}`);
    assert.equal(result.stdout.trim(), JSON.stringify(payload));
    assert.equal(result.stderr, "");
    const call = JSON.parse(readFileSync(markerPath, "utf8"));
    assert.deepEqual(call.argv, [functionName]);
    assert.equal(call.admin, "self-hosted-admin-fixture");
  }
});

test("safe-observable accepts no-args and exact empty object only", (t) => {
  const functionName = "crystal/dailyDriver:emitOvernightBriefForAllUsers";
  const payload = { usersScanned: 2, briefsEmitted: 1 };

  for (const argv of [[functionName], [functionName, "{}"], [functionName, " {} "]]) {
    // Unit grammar for empty object (including whitespace-only object text).
    if (argv.length === 1) {
      assert.deepEqual(parseSafeObservableArgs(argv), {});
    } else if (argv[1] === "{}") {
      assert.deepEqual(parseSafeObservableArgs(argv), {});
    }

    const { directory, helperPath, markerPath } = adminHelperFixture(t, {
      payload,
    });
    const env = {
      ...baseEnv(directory, join(directory, "unused")),
      HELPER_MARKER: markerPath,
      MEMORY_CRYSTAL_CONVEX_ADMIN_RUN_HELPER: helperPath,
      PATH: directory,
    };
    // Wrapper path: only exact no-args or "{}" (JSON.parse of " {} " is fine too).
    if (argv[1] === " {} ") continue;
    const result = spawnSync(process.execPath, [SCRIPT_PATH, ...argv], {
      encoding: "utf8",
      env,
    });
    assert.equal(result.status, 0, `${argv.join(" ")}: ${result.stderr}`);
    assert.equal(result.stdout.trim(), JSON.stringify(payload));
    assert.equal(existsSync(markerPath), true);
  }
});

test("safe-observable rejects nonempty, second JSON, --component, options, malformed; helper never runs", (t) => {
  const functionName = "crystal/hygieneWorklist:runGraphLintForAllUsers";
  const cases = [
    [functionName, '{"usersScanned":1}'],
    [functionName, "{}", "{}"],
    [functionName, "--component", "crystal"],
    [functionName, "--component=crystal"],
    [functionName, "--typecheck", "disable"],
    [functionName, "--prod"],
    [functionName, "{not-json"],
    [functionName, "null"],
    [functionName, "[]"],
    [functionName, "extra-positional"],
  ];

  for (const argv of cases) {
    assert.throws(
      () => parseSafeObservableArgs(argv),
      /Refusing safe-observable run/,
      argv.join(" "),
    );

    const { directory, helperPath, markerPath } = adminHelperFixture(t, {
      payload: { usersLinted: 1, usersWithFindings: 0, ideasEmitted: 0 },
    });
    // Broken deployment credentials + helper marker: rejection must happen
    // before env resolution and before the helper runs.
    const env = {
      ...baseEnv(directory, join(directory, "unused")),
      HELPER_MARKER: markerPath,
      MEMORY_CRYSTAL_CONVEX_ADMIN_RUN_HELPER: helperPath,
      PATH: directory,
    };
    delete env.CONVEX_SELF_HOSTED_ADMIN_KEY;
    delete env.CONVEX_SELF_HOSTED_URL;

    const result = spawnSync(process.execPath, [SCRIPT_PATH, ...argv], {
      encoding: "utf8",
      env,
    });
    assert.equal(result.status, 2, argv.join(" "));
    assert.match(
      result.stderr,
      /Refusing safe-observable run/,
      argv.join(" "),
    );
    // Must not fall through to partial-credential errors or helper execution.
    assert.equal(
      result.stderr.includes("partial self-hosted credentials"),
      false,
      argv.join(" "),
    );
    assert.equal(existsSync(markerPath), false, argv.join(" "));
    assert.equal(result.stdout, "");
  }
});

test("safe-observable wrapper suppresses extra/secret fields and malformed fd-3", (t) => {
  const functionName = "crystal/dailyDriver:emitOvernightBriefForAllUsers";
  const cases = [
    { usersScanned: 1, briefsEmitted: 0, secret: "leak" },
    { usersScanned: -3, briefsEmitted: 0 },
    "not-an-object",
    null,
  ];
  for (const payload of cases) {
    const { directory, helperPath, markerPath } = adminHelperFixture(t, {
      payload,
    });
    const env = {
      ...baseEnv(directory, join(directory, "unused")),
      HELPER_MARKER: markerPath,
      MEMORY_CRYSTAL_CONVEX_ADMIN_RUN_HELPER: helperPath,
      PATH: directory,
    };
    const result = spawnSync(
      process.execPath,
      [SCRIPT_PATH, functionName, "{}"],
      { encoding: "utf8", env },
    );
    assert.equal(result.status, 1, JSON.stringify(payload));
    assert.match(result.stderr, /schema validation|privileged child output was suppressed/);
    assert.equal(result.stdout, "");
    assert.equal(`${result.stdout}${result.stderr}`.includes("leak"), false);
  }
});

test("safe-observable failure path never replays child stdout/stderr", (t) => {
  const functionName = "crystal/hygieneWorklist:runGraphLintForAllUsers";
  const secret = `DUMMY_FAIL_${"SECRET".repeat(4)}`;
  const { directory, helperPath, markerPath } = adminHelperFixture(t, {
    exitCode: 1,
    stderr: secret,
  });
  const env = {
    ...baseEnv(directory, join(directory, "unused")),
    HELPER_MARKER: markerPath,
    MEMORY_CRYSTAL_CONVEX_ADMIN_RUN_HELPER: helperPath,
    PATH: directory,
  };
  const result = spawnSync(
    process.execPath,
    [SCRIPT_PATH, functionName, "{}"],
    { encoding: "utf8", env },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Convex function failed/);
  assert.equal(`${result.stdout}${result.stderr}`.includes(secret), false);
});

test("credential-denied and unclassified success remain non-leaking for AC evidence path", (t) => {
  // Credential still refused before helper.
  {
    const { directory, helperPath, markerPath } = adminHelperFixture(t, {
      payload: { usersScanned: 1, briefsEmitted: 0 },
    });
    const env = {
      ...baseEnv(directory, join(directory, "unused")),
      HELPER_MARKER: markerPath,
      MEMORY_CRYSTAL_CONVEX_ADMIN_RUN_HELPER: helperPath,
    };
    const result = spawnSync(
      process.execPath,
      [SCRIPT_PATH, "crystal/apiKeys:createApiKey", "{}"],
      { encoding: "utf8", env },
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Refusing a credential-returning function/);
    assert.equal(existsSync(markerPath), false);
  }

  // Unclassified success still suppresses output (no AC channel).
  {
    const { directory, markerPath } = fixture(t);
    const env = baseEnv(directory, markerPath);
    env.SHIM_RAW_OUTPUT = JSON.stringify({ usersScanned: 9, briefsEmitted: 9 });
    const result = spawnSync(
      process.execPath,
      [SCRIPT_PATH, "crystal/example:query", "{}"],
      { encoding: "utf8", env },
    );
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  }
});

test("only the three AC cron actions are safe-observable", () => {
  const names = Object.keys(SAFE_OBSERVABLE_OUTPUT_SCHEMAS).sort();
  assert.deepEqual(names, [
    "crystal/dailyDriver:emitOvernightBriefForAllUsers",
    "crystal/hygieneWorklist:runConceptGapScanForAllUsers",
    "crystal/hygieneWorklist:runGraphLintForAllUsers",
  ].sort());
  for (const name of names) {
    assert.equal(classifyConvexFunctionOutput(name), "safe-observable");
  }
  assert.equal(
    classifyConvexFunctionOutput("crystal/example:query"),
    "unclassified",
  );
});
