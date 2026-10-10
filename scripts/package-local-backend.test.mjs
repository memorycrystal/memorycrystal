#!/usr/bin/env node
// Packager hardening tests (ILL-336): billing/private-token rewrites,
// SOURCE_DATE_EPOCH reproducibility, archive structure and modes, and the
// fail-closed privacy gate. No client names appear here: stem behaviour is
// exercised with synthetic terms files.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";

import {
  applySubstitutions,
  findCaseInsensitiveStemLeaks,
  findHostedOnlyPaths,
  findSecretLikeLeaks,
  loadPrivateScrubTerms,
  replaceRequired,
  stripHostedBillingFunctions,
  stripHostedBillingProductIds,
  stripPolarLookupIndexes,
  stripPrivateFinancialTables,
} from "./lib/public-scrub.mjs";
import { collectArchiveEntries, createTar, createTarGz, createZip } from "./lib/deterministic-archive.mjs";
import { omitPackagerMarkerEntries } from "./package-local-backend.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EPOCH = "1700000000"; // 2023-11-14T22:13:20.000Z
const VERSION = "packager-test";
const TOP = `memorycrystal-local-backend-${VERSION}`;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function tmp(t, prefix = "mc-packager-test-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function scratchHome(dir) {
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  return home;
}

function snapshotFiles(dir) {
  const files = [];
  const walk = (current) => {
    for (const ent of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) files.push([full, readFileSync(full)]);
    }
  };
  walk(dir);
  files.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return files;
}

function build(t, { epoch = EPOCH, env = {}, extraArgs = [] } = {}) {
  const dir = tmp(t);
  const home = scratchHome(dir);
  const out = join(dir, TOP);
  const archiveDir = join(dir, "archives");
  const result = spawnSync(
    process.execPath,
    ["scripts/package-local-backend.mjs", "--version", VERSION, "--out", out, "--archive-dir", archiveDir, ...extraArgs],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: { ...process.env, ...(epoch === null ? {} : { SOURCE_DATE_EPOCH: epoch }), ...env, HOME: home },
    },
  );
  return { dir, home, out, archiveDir, tar: join(archiveDir, `${TOP}.tar.gz`), zip: join(archiveDir, `${TOP}.zip`), ...result };
}

function tarListing(path) {
  const listing = spawnSync("tar", ["-tvzf", path], { encoding: "utf8", env: { ...process.env, TZ: "UTC" } });
  assert.equal(listing.status, 0, listing.stderr);
  return listing.stdout.trimEnd().split("\n").map((line) => {
    const [mode, owner, size, date, time, ...rest] = line.trim().split(/\s+/);
    return { mode, owner, size: Number(size), date, time, path: rest.join(" ") };
  });
}

function zipListing(path) {
  const listing = spawnSync("zipinfo", [path], { encoding: "utf8" });
  if (listing.status !== 0) return null;
  return listing.stdout.trimEnd().split("\n").filter((line) => /^[-d][rwx-]{9}\s/.test(line)).map((line) => {
    const parts = line.trim().split(/\s+/);
    return { mode: parts[0], version: parts[1], os: parts[2], path: parts.slice(8).join(" ") };
  });
}

const MARKER = ".memorycrystal-packager-output";
const PACKAGER = join(REPO_ROOT, "scripts/package-local-backend.mjs");

test("importing the packager creates and removes nothing", (t) => {
  const scratch = tmp(t, "mc-packager-import-");
  const before = readdirSync(scratch).sort();
  const child = [
    'import { readdirSync } from "node:fs";',
    'import { pathToFileURL } from "node:url";',
    `const scratch = ${JSON.stringify(scratch)};`,
    "const before = readdirSync(scratch).sort();",
    `await import(pathToFileURL(${JSON.stringify(PACKAGER)}).href);`,
    "const after = readdirSync(scratch).sort();",
    'if (before.join("\\0") !== after.join("\\0")) process.exit(4);',
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", child], {
    cwd: scratch,
    encoding: "utf8",
    env: { ...process.env, HOME: scratch },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.deepEqual(readdirSync(scratch).sort(), before);
  assert.equal(existsSync(join(scratch, ".memorycrystal")), false);
});

test("running without --out exits 2 and leaves the scratch home empty", (t) => {
  const scratch = tmp(t, "mc-packager-no-out-");
  const before = readdirSync(scratch).sort();
  const result = spawnSync(process.execPath, [PACKAGER, "--version", VERSION], {
    cwd: scratch,
    encoding: "utf8",
    env: { ...process.env, HOME: scratch },
  });
  assert.equal(result.status, 2);
  assert.equal(result.stderr.trim().split("\n").length, 1);
  assert.match(result.stderr, /--out/);
  assert.equal(result.stdout, "");
  assert.deepEqual(readdirSync(scratch).sort(), before);
  assert.equal(existsSync(join(scratch, ".memorycrystal")), false);
});

test("a non-empty --out without the marker exits 3 and its files survive byte-for-byte", (t) => {
  const scratch = tmp(t, "mc-packager-foreign-");
  const home = scratchHome(scratch);
  const out = join(scratch, "foreign");
  mkdirSync(join(out, "nested"), { recursive: true });
  writeFileSync(join(out, "nested", "keep.txt"), Buffer.from("keep-these-bytes"));
  const before = snapshotFiles(out);
  const result = spawnSync(process.execPath, [PACKAGER, "--version", VERSION, "--out", out], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, HOME: home },
  });
  assert.equal(result.status, 3);
  assert.equal(result.stderr.trim().split("\n").length, 1);
  assert.equal(result.stderr.includes(out), true);
  const after = snapshotFiles(out);
  assert.equal(after.length, before.length);
  for (let index = 0; index < before.length; index += 1) {
    assert.equal(after[index][0], before[index][0]);
    assert.deepEqual(after[index][1], before[index][1]);
  }
  assert.equal(existsSync(join(out, MARKER)), false);
  assert.equal(existsSync(join(home, ".memorycrystal")), false);
});

test("a re-run into a marked --out succeeds", (t) => {
  const first = build(t);
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert.equal(existsSync(join(first.out, MARKER)), true);
  const againDir = join(first.dir, "archives-again");
  const again = spawnSync(process.execPath, [PACKAGER, "--version", VERSION, "--out", first.out, "--archive-dir", againDir], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, HOME: first.home, SOURCE_DATE_EPOCH: EPOCH },
  });
  assert.equal(again.status, 0, `${again.stdout}\n${again.stderr}`);
  assert.equal(existsSync(join(first.out, MARKER)), true);
  assert.equal(existsSync(join(againDir, `${TOP}.tar.gz`)), true);
  assert.equal(existsSync(join(first.home, ".memorycrystal")), false);
});

test("an empty pre-created --out succeeds", (t) => {
  const scratch = tmp(t, "mc-packager-empty-");
  const home = scratchHome(scratch);
  const out = join(scratch, "empty-out");
  mkdirSync(out);
  const result = spawnSync(process.execPath, [PACKAGER, "--version", VERSION, "--out", out], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, HOME: home, SOURCE_DATE_EPOCH: EPOCH },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(existsSync(join(out, MARKER)), true);
  assert.equal(existsSync(join(out, "manifest.json")), true);
  assert.equal(existsSync(join(home, ".memorycrystal")), false);
});

test("neither archive, the manifest, nor the checksum list contains the marker", (t) => {
  const built = build(t);
  assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
  assert.equal(existsSync(join(built.out, MARKER)), true);
  const tar = spawnSync("tar", ["-tzf", built.tar], { encoding: "utf8" });
  assert.equal(tar.status, 0, tar.stderr);
  assert.equal(tar.stdout.includes(MARKER), false);
  const zip = spawnSync("python3", ["-c", "import sys, zipfile\nprint('\\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))", built.zip], { encoding: "utf8" });
  assert.equal(zip.status, 0, zip.stderr);
  assert.equal(zip.stdout.includes(MARKER), false);
  const manifest = JSON.parse(readFileSync(join(built.out, "manifest.json"), "utf8"));
  assert.equal(manifest.files.some((file) => String(file.path).includes(MARKER)), false);
  assert.equal(existsSync(join(built.home, ".memorycrystal")), false);
});

test("a nested marker-named file is absent from both archives", async (t) => {
  const dir = tmp(t, "mc-packager-nested-marker-");
  const root = join(dir, "tree");
  mkdirSync(join(root, "nested", "deep"), { recursive: true });
  mkdirSync(join(root, "nested", MARKER), { recursive: true });
  writeFileSync(join(root, "keep.txt"), "keep\n");
  writeFileSync(join(root, "nested", "deep", MARKER), "synthetic-marker\n");
  writeFileSync(join(root, "nested", MARKER, "inside.txt"), "synthetic-inside\n");
  const entries = omitPackagerMarkerEntries(collectArchiveEntries(root, "top"));
  assert.equal(entries.some((entry) => entry.archivePath.split("/").includes(MARKER)), false, "entry count");
  assert.equal(entries.some((entry) => entry.archivePath === "top/keep.txt"), true, "keep count");
  const mtime = new Date(Number(EPOCH) * 1000);
  const tarPath = join(dir, "nested.tar.gz");
  const zipPath = join(dir, "nested.zip");
  writeFileSync(tarPath, createTarGz(entries, { mtime }));
  writeFileSync(zipPath, await createZip(entries, { mtime }));
  const tar = spawnSync("tar", ["-tzf", tarPath], { encoding: "utf8" });
  assert.equal(tar.status, 0, "tar status");
  assert.equal(tar.stdout.includes(MARKER), false, "tar marker count");
  assert.equal(tar.stdout.includes("keep.txt"), true, "tar keep count");
  const zip = spawnSync("python3", ["-c", "import sys, zipfile\nprint('\\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))", zipPath], { encoding: "utf8" });
  assert.equal(zip.status, 0, "zip status");
  assert.equal(zip.stdout.includes(MARKER), false, "zip marker count");
  assert.equal(zip.stdout.includes("keep.txt"), true, "zip keep count");
});

test("the packager archive step omits a nested marker file", async (t) => {
  const dir = tmp(t, "mc-packager-nested-archive-");
  const home = scratchHome(dir);
  const out = join(dir, TOP);
  const archiveDir = join(dir, "archives");
  const planterPath = join(dir, "plant-nested-marker.mjs");
  writeFileSync(planterPath, `import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const out = process.argv[2];
const marker = process.argv[3];
const deadline = Date.now() + 120000;
while (Date.now() < deadline) {
  if (existsSync(out + "/" + marker)) {
    mkdirSync(out + "/nested/deep", { recursive: true });
    mkdirSync(out + "/nested/" + marker, { recursive: true });
    writeFileSync(out + "/nested/deep/" + marker, "");
    writeFileSync(out + "/nested/deep/keep.txt", "keep\\n");
    writeFileSync(out + "/nested/" + marker + "/inside.txt", "keep\\n");
    process.exit(0);
  }
  spawnSync("sleep", ["0.05"]);
}
process.exit(2);
`);
  const planter = spawn(process.execPath, [planterPath, out, MARKER], { stdio: ["ignore", "ignore", "pipe"] });
  let planterStderr = "";
  planter.stderr.on("data", (chunk) => { planterStderr += String(chunk); });
  const result = spawnSync(process.execPath, [PACKAGER, "--version", VERSION, "--out", out, "--archive-dir", archiveDir], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: { ...process.env, HOME: home, SOURCE_DATE_EPOCH: EPOCH },
  });
  if (planter.exitCode === null && planter.signalCode === null) planter.kill("SIGTERM");
  const planterExit = await new Promise((resolve) => {
    if (planter.exitCode !== null || planter.signalCode !== null) resolve(planter.exitCode);
    else planter.once("exit", (code) => resolve(code));
  });
  assert.equal(planterExit, 0, `planter status ${planterExit} stderr_lines ${planterStderr.split("\n").length}`);
  assert.equal(result.status, 0, `packager status ${result.status} stderr_lines ${(result.stderr || "").split("\n").length}`);
  assert.equal(existsSync(join(out, "nested", "deep", "keep.txt")), true, "planted keep count");
  const tar = spawnSync("tar", ["-tzf", join(archiveDir, `${TOP}.tar.gz`)], { encoding: "utf8" });
  assert.equal(tar.status, 0, tar.stderr);
  assert.equal(tar.stdout.includes("nested/deep/keep.txt"), true, "tar keep count");
  assert.equal(tar.stdout.includes(MARKER), false, "tar marker count");
  const zip = spawnSync("python3", ["-c", "import sys, zipfile\nprint('\\n'.join(zipfile.ZipFile(sys.argv[1]).namelist()))", join(archiveDir, `${TOP}.zip`)], { encoding: "utf8" });
  assert.equal(zip.status, 0, zip.stderr);
  assert.equal(zip.stdout.includes("nested/deep/keep.txt"), true, "zip keep count");
  assert.equal(zip.stdout.includes(MARKER), false, "zip marker count");
  assert.equal(existsSync(join(home, ".memorycrystal")), false);
});

// ── Shared scrub rules ────────────────────────────────────────────────────────

test("stripHostedBillingProductIds is shape-based, keeps constants distinct and is drift-safe", () => {
  const source = [
    'const PRO_PRODUCT_ID = "0123abcd-4567-89ef-0123-456789abcdef";',
    'const ULTRA_PRODUCT_ID = "fedcba98-7654-3210-fedc-ba9876543210";',
    "const other = 1;",
    "",
  ].join("\n");
  const rewritten = stripHostedBillingProductIds(source);
  assert.doesNotMatch(rewritten, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  assert.match(rewritten, /^const PRO_PRODUCT_ID = "hosted-billing-product:pro_product_id";/m);
  assert.match(rewritten, /^const ULTRA_PRODUCT_ID = "hosted-billing-product:ultra_product_id";/m);
  assert.match(rewritten, /^const other = 1;$/m);
  assert.throws(() => stripHostedBillingProductIds('const PRO_PRODUCT_ID = "0123abcd-4567-89ef-0123-456789abcdef";\n'), /expected 2 .* found 1/);
  assert.doesNotThrow(() => stripHostedBillingProductIds('const PRO_PRODUCT_ID = "0123abcd-4567-89ef-0123-456789abcdef";\n', { expectedCount: 1 }));
});

test("stripHostedBillingFunctions removes exactly the hosted Polar functions and keeps their neighbours", () => {
  const source = [
    "export const getUserTier = query({",
    "  args: {},",
    "  handler: async (ctx) => {",
    "    return 1;",
    "  },",
    "});",
    "",
    "// Billing info for the current authenticated user (used by /api/polar/portal)",
    "export const getCurrentUserBillingInfo = query({",
    "  args: {},",
    "  handler: async (ctx) => {",
    "    return profile ? { a: 1 } : null;",
    "  },",
    "});",
    "",
    "// Checkout context for the current authenticated user (used by /api/polar/checkout).",
    "// The identity comes from the session only.",
    "export const getCurrentUserCheckoutContext = query({",
    "  args: {},",
    "  handler: async (ctx) => {",
    "    return { userId, polarCustomerId: profile?.polarCustomerId ?? null };",
    "  },",
    "});",
    "",
    "// Internal helpers for webhook/server jobs",
    "export const getByUserInternal = internalQuery({",
    "  args: { userId: v.string() },",
    "  handler: async (ctx, { userId }) => ctx.db.query(\"crystalUserProfiles\").first(),",
    "});",
    "",
    "export const getByPolarCustomerInternal = internalQuery({",
    "  args: { polarCustomerId: v.string() },",
    "  handler: async (ctx, { polarCustomerId }) =>",
    "    ctx.db.query(\"crystalUserProfiles\").first(),",
    "});",
    "",
    "export const getByPolarSubscriptionInternal = internalQuery({",
    "  args: { polarSubscriptionId: v.string() },",
    "  handler: async (ctx, { polarSubscriptionId }) =>",
    "    ctx.db.query(\"crystalUserProfiles\").first()",
    "});",
    "",
    "export const updateSubscriptionInternal = internalMutation({",
    "  args: {",
    "    userProfileId: v.id(\"crystalUserProfiles\"),",
    "    subscriptionStatus: v.union(",
    "      v.literal(\"active\"), v.literal(\"inactive\")",
    "    ),",
    "  },",
    "  handler: async (ctx, { userProfileId, ...fields }) => {",
    "    await ctx.db.patch(userProfileId, { ...fields, updatedAt: Date.now() });",
    "  },",
    "});",
    "",
    "// Used by background jobs to iterate all users",
    "export const listAllUserIds = internalQuery({",
    "  args: {},",
    "  handler: async (ctx) => [],",
    "});",
    "",
  ].join("\n");
  const rewritten = stripHostedBillingFunctions(source);
  for (const name of ["getCurrentUserBillingInfo", "getCurrentUserCheckoutContext", "getByPolarCustomerInternal", "getByPolarSubscriptionInternal", "updateSubscriptionInternal", "/api/polar/portal", "/api/polar/checkout"]) {
    assert.doesNotMatch(rewritten, new RegExp(name.replace(/[/.]/g, "\\$&")), `${name} must be removed`);
  }
  for (const name of ["getUserTier", "getByUserInternal", "listAllUserIds", "Internal helpers for webhook/server jobs", "Used by background jobs"]) {
    assert.match(rewritten, new RegExp(name), `${name} must survive`);
  }
  assert.throws(() => stripHostedBillingFunctions(rewritten), /hosted billing function getCurrentUserBillingInfo/);
});

test("schema helpers drop finance tables and Polar indexes while restoring the table delimiter", () => {
  const schema = [
    "  crystalUserProfiles: defineTable({",
    "    userId: v.string(),",
    "  })",
    '    .index("by_user", ["userId"])',
    '    .index("by_subscription_status", ["subscriptionStatus"])',
    '    .index("by_polar_subscription", ["polarSubscriptionId"])',
    '    .index("by_polar_customer", ["polarCustomerId"]),',
    "",
    "  crystalReflectionRuns: defineTable({",
    "    userId: v.string(),",
    "  }),",
    "",
    "  crystalCostRateCards: defineTable({",
    "    provider: v.string(),",
    "  })",
    '    .index("by_effective_from", ["effectiveFrom"]),',
    "",
    "  crystalDailyCostLedger: defineTable({",
    "    dateKey: v.string(),",
    "  })",
    '    .index("by_payer_date", ["payer", "dateKey"]),',
    "",
    "  crystalDailyBusinessLedger: defineTable({",
    "    dateKey: v.string(),",
    "  })",
    '    .index("by_date", ["dateKey"]),',
    "",
    "  crystalProviderReconciliation: defineTable({",
    "    provider: v.string(),",
    "  })",
    '    .index("by_period_start", ["periodStart"]),',
    "",
    "  // Handled Polar subscription events that ended without an entitlement write",
    "  // (ILL-321, audit A09). Provider IDs only.",
    "  polarUnmatchedEvents: defineTable({",
    "    eventType: v.string(),",
    "    receivedAt: v.number(),",
    "  })",
    '    .index("by_subscription_event", ["polarSubscriptionId", "eventType"])',
    '    .index("by_received", ["receivedAt"]),',
    "",
    "  keepMe: defineTable({ a: v.string() }),",
    "",
  ].join("\n");
  const rewritten = stripPrivateFinancialTables(stripPolarLookupIndexes(schema));
  assert.doesNotMatch(rewritten, /by_polar_subscription|by_polar_customer|crystalCostRateCards|crystalDailyCostLedger|crystalDailyBusinessLedger|crystalProviderReconciliation|polarUnmatchedEvents|Handled Polar subscription events|by_received/);
  assert.match(rewritten, /\.index\("by_subscription_status", \["subscriptionStatus"\]\),\n\n  crystalReflectionRuns/);
  assert.match(rewritten, /keepMe: defineTable/);
  assert.match(rewritten, /crystalReflectionRuns: defineTable\(\{\n    userId: v\.string\(\),\n  \}\),\n\n  keepMe/, "the strips leave one blank line between the surviving neighbours");
  assert.throws(() => stripPolarLookupIndexes("nothing here"), /public user-profile table delimiter/);
  // Drift-safe: the unmatched-events table must exist exactly once.
  assert.throws(() => stripPrivateFinancialTables("nothing here"), /expected 1 polarUnmatchedEvents table match, found 0/);
  assert.throws(() => stripPrivateFinancialTables(schema + schema), /expected 1 polarUnmatchedEvents table match, found 2/);
});

test("stripPrivateFinancialTables removes the real polarUnmatchedEvents table from convex/schema.ts", () => {
  const schema = readFileSync(join(REPO_ROOT, "convex/schema.ts"), "utf8");
  assert.match(schema, /polarUnmatchedEvents: defineTable/);
  const rewritten = stripPrivateFinancialTables(schema);
  assert.doesNotMatch(rewritten, /polarUnmatchedEvents|by_subscription_event|by_received|reconciledUserId/);
  assert.match(rewritten, /\/\/ ============ Cloud Control Plane/);
});

test("replaceRequired refuses silent drift", () => {
  assert.throws(() => replaceRequired("a", /b/g, "c", "thing", 1), /expected 1 thing match, found 0/);
  assert.throws(() => replaceRequired("bb", /b/g, "c", "thing", 1), /expected 1 thing match, found 2/);
  assert.equal(replaceRequired("ab", /b/g, "c", "thing", 1), "ac");
});

test("private terms: substitutions apply in order and stems are case-insensitive regexes", (t) => {
  const dir = tmp(t);
  const termsFile = join(dir, "terms.json");
  writeFileSync(termsFile, JSON.stringify({ substitutions: [["Zebrafoo", "peer"], ["zebrafoo-coach", "peer-coach"]], stems: ["\\bzebrafoo"] }));
  const terms = loadPrivateScrubTerms(termsFile);
  assert.equal(terms.substitutions.length, 2);
  assert.equal(applySubstitutions("Zebrafoo and zebrafoo-coach", terms.substitutions), "peer and peer-coach");
  mkdirSync(join(dir, "tree/sub"), { recursive: true });
  writeFileSync(join(dir, "tree/sub/a.ts"), "const x = 'ZEBRAFOO team';\nconst y = 'tomorrow';\n");
  writeFileSync(join(dir, "tree/clean.ts"), "const z = 'nothing to see';\n");
  writeFileSync(join(dir, "tree/blob.bin"), Buffer.from([0, 1, 2, 90, 69, 66]));
  assert.deepEqual(findCaseInsensitiveStemLeaks(join(dir, "tree"), terms.stems), ["sub/a.ts:1 matches client stem /\\bzebrafoo/i"]);
  // A stem in a file or directory name ships in the archive listing, even for binary files.
  mkdirSync(join(dir, "tree/ZebraFoo-assets"), { recursive: true });
  writeFileSync(join(dir, "tree/ZebraFoo-assets/logo.bin"), Buffer.from([0, 1, 2]));
  writeFileSync(join(dir, "tree/zebrafooPurge.ts"), "export const purge = 1;\n");
  assert.deepEqual(findCaseInsensitiveStemLeaks(join(dir, "tree"), terms.stems), [
    "ZebraFoo-assets/logo.bin path matches client stem /\\bzebrafoo/i",
    "sub/a.ts:1 matches client stem /\\bzebrafoo/i",
    "zebrafooPurge.ts path matches client stem /\\bzebrafoo/i",
  ]);
  assert.equal(loadPrivateScrubTerms(join(dir, "missing.json")), null);
  writeFileSync(join(dir, "bad.json"), JSON.stringify({ substitutions: [["only-one"]] }));
  assert.throws(() => loadPrivateScrubTerms(join(dir, "bad.json")), /\[from, to\] pair/);
});

test("secret-like and hosted-only scans flag leaks and accept the documented allowlist", (t) => {
  const dir = tmp(t);
  const write = (rel, content) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), content); };
  write("convex/crystal/redactSecrets.ts", "const RULES = [[/\\bsk-(?:proj-)?[A-Za-z0-9_-]{10,}\\b/g, 'sk-[REDACTED]']];\n");
  write("convex/crystal/providerSettings.ts", "if (!trimmed.startsWith('sk-or-')) throw new Error('Keys must start with sk-or-');\n");
  write("infra/convex/.env.local.template", "CRYSTAL_BACKEND=local\n");
  assert.deepEqual(findSecretLikeLeaks(dir), []);
  write("convex/crystal/leak.ts", `const key = "sk-${"a".repeat(40)}";\n`);
  write(".env", "SECRET=1\n");
  write("convex/key.pem", "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n");
  const secrets = findSecretLikeLeaks(dir);
  assert.ok(secrets.some((hit) => hit.startsWith("convex/crystal/leak.ts contains a OpenAI")), secrets.join("\n"));
  assert.ok(secrets.includes(".env is an environment file"), secrets.join("\n"));
  assert.ok(secrets.some((hit) => hit.startsWith("convex/key.pem contains a PEM")), secrets.join("\n"));

  write("convex/crystal/adminEmails.ts", "export const x = 1;\n");
  write("convex/crystal/adminSupport.ts", "export const x = 1;\n");
  write("convex/crystal/adminSettings/resolvers.ts", "export const x = 1;\n");
  write("convex/crystal/memories.ts", "export const x = 1;\n");
  assert.deepEqual(findHostedOnlyPaths(dir), []);
  write("convex/cloud/tenants.ts", "export const x = 1;\n");
  write("convex/crystal/adminDelete.ts", "export const x = 1;\n");
  write("convex/crystal/adminSettings/mutations.ts", "export const x = 1;\n");
  write("apps/web/page.tsx", "export default 1;\n");
  assert.deepEqual(findHostedOnlyPaths(dir).sort(), [
    "apps/web/page.tsx is a hosted-only path",
    "convex/cloud/tenants.ts is a hosted-only path",
    "convex/crystal/adminDelete.ts is an admin backend module outside the self-hosted override allowlist",
    "convex/crystal/adminSettings/mutations.ts is an admin backend module outside the self-hosted override allowlist",
  ]);
});

// ── Deterministic archive writer ─────────────────────────────────────────────

test("archive writer: sorted members, normalized modes, owner 0/0, stable bytes across calls and timezones", async (t) => {
  const dir = tmp(t);
  const root = join(dir, "src");
  const longDir = join(root, "a".repeat(60), "b".repeat(60));
  mkdirSync(join(root, "bin"), { recursive: true });
  mkdirSync(longDir, { recursive: true });
  writeFileSync(join(root, "zeta.txt"), "z\n");
  writeFileSync(join(root, "alpha.txt"), "a\n");
  writeFileSync(join(root, "bin/install"), "#!/usr/bin/env bash\n");
  chmodSync(join(root, "bin/install"), 0o775); // umask noise must normalize to 0755
  chmodSync(join(root, "alpha.txt"), 0o664); // and to 0644
  writeFileSync(join(longDir, "c".repeat(40) + ".ts"), "export const long = true;\n");

  const entries = collectArchiveEntries(root, "top");
  assert.deepEqual(entries.map((e) => e.archivePath).slice(0, 5), ["top", `top/${"a".repeat(60)}`, `top/${"a".repeat(60)}/${"b".repeat(60)}`, `top/${"a".repeat(60)}/${"b".repeat(60)}/${"c".repeat(40)}.ts`, "top/alpha.txt"]);
  assert.equal(entries.find((e) => e.archivePath === "top/bin/install").mode, 0o755);
  assert.equal(entries.find((e) => e.archivePath === "top/alpha.txt").mode, 0o644);

  const mtime = new Date(Number(EPOCH) * 1000);
  const tar1 = createTarGz(entries, { mtime });
  const tar2 = createTarGz(entries, { mtime });
  assert.equal(sha256(tar1), sha256(tar2));
  const tarPath = join(dir, "t.tar.gz");
  writeFileSync(tarPath, tar1);
  const listed = tarListing(tarPath);
  assert.ok(listed.every((e) => e.owner === "0/0"), "tar owners must be 0/0");
  assert.equal(listed.find((e) => e.path === "top/bin/install").mode, "-rwxr-xr-x");
  assert.equal(listed.find((e) => e.path === "top/alpha.txt").mode, "-rw-r--r--");
  assert.equal(listed.find((e) => e.path === "top/").mode, "drwxr-xr-x");
  assert.ok(listed.some((e) => e.path.endsWith(`${"c".repeat(40)}.ts`)), "long path must round-trip through the ustar prefix field");
  assert.ok(listed.every((e) => e.date === "2023-11-14" && e.time === "22:13"), "tar mtimes must equal the epoch");
  // ustar checksum sanity: system tar extracts without complaint.
  const extract = spawnSync("tar", ["-xzf", tarPath, "-C", dir], { encoding: "utf8" });
  assert.equal(extract.status, 0, extract.stderr);
  assert.equal(readFileSync(join(dir, "top/zeta.txt"), "utf8"), "z\n");
  assert.equal(createTar(entries, { mtime }).length % 512, 0);

  const previousTz = process.env.TZ;
  try {
    process.env.TZ = "UTC";
    const zipUtc = await createZip(entries, { mtime });
    process.env.TZ = "America/Vancouver";
    const zipPacific = await createZip(entries, { mtime });
    assert.equal(sha256(zipUtc), sha256(zipPacific), "zip bytes must not depend on the builder's timezone");
    const zipPath = join(dir, "t.zip");
    writeFileSync(zipPath, zipUtc);
    const zipped = zipListing(zipPath);
    if (zipped) {
      assert.equal(zipped.find((e) => e.path === "top/bin/install").mode, "-rwxr-xr-x");
      assert.equal(zipped.find((e) => e.path === "top/alpha.txt").mode, "-rw-r--r--");
      assert.equal(zipped.find((e) => e.path === "top/").mode, "drwxr-xr-x");
      assert.ok(zipped.every((e) => e.os === "unx"), "zip entries must carry Unix attributes");
    } else {
      console.warn("SKIP (loud): zipinfo not on PATH — zip mode assertions were NOT run");
    }
    const unzipTest = spawnSync("unzip", ["-tq", zipPath], { encoding: "utf8" });
    if (unzipTest.status !== null && unzipTest.error === undefined) assert.equal(unzipTest.status, 0, unzipTest.stdout + unzipTest.stderr);
  } finally {
    if (previousTz === undefined) delete process.env.TZ; else process.env.TZ = previousTz;
  }
});

// ── The packager end to end ───────────────────────────────────────────────────

test("SOURCE_DATE_EPOCH stamps manifest.json and every archive member; identical epochs give identical archives", (t) => {
  const first = build(t);
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert.match(first.stdout, /SOURCE_DATE_EPOCH: 1700000000 \(SOURCE_DATE_EPOCH; 2023-11-14T22:13:20\.000Z\)/);
  const manifest = JSON.parse(readFileSync(join(first.out, "manifest.json"), "utf8"));
  assert.equal(manifest.createdAt, "2023-11-14T22:13:20.000Z");
  assert.equal(manifest.sourceDateEpoch, 1700000000);
  assert.equal(manifest.version, VERSION);
  const paths = manifest.files.map((f) => f.path);
  assert.deepEqual(paths, [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), "manifest files are in code-unit order");

  const second = build(t);
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert.equal(sha256(readFileSync(first.tar)), sha256(readFileSync(second.tar)), "tar.gz must be reproducible");
  assert.equal(sha256(readFileSync(first.zip)), sha256(readFileSync(second.zip)), "zip must be reproducible");
  assert.equal(readFileSync(join(first.out, "manifest.json"), "utf8"), readFileSync(join(second.out, "manifest.json"), "utf8"));

  const other = build(t, { epoch: "1600000000" });
  assert.equal(other.status, 0, `${other.stdout}\n${other.stderr}`);
  assert.equal(JSON.parse(readFileSync(join(other.out, "manifest.json"), "utf8")).createdAt, "2020-09-13T12:26:40.000Z");
  assert.notEqual(sha256(readFileSync(first.tar)), sha256(readFileSync(other.tar)), "a different epoch must change the archive");

  const invalid = build(t, { epoch: "yesterday" });
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /SOURCE_DATE_EPOCH must be an integer/);
});

test("archives: one top-level directory, 0755 launchers and scripts, 0/0 owners, tar and zip agree", (t) => {
  const built = build(t);
  assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
  const tar = tarListing(built.tar);
  assert.deepEqual([...new Set(tar.map((e) => e.path.split("/")[0]))], [TOP]);
  assert.ok(tar.every((e) => e.owner === "0/0"));
  for (const rel of ["bin/install", "bin/doctor", "bin/install.sh", "bin/doctor.sh", "bin/down", "bin/rollback", "bin/upgrade"]) {
    assert.equal(tar.find((e) => e.path === `${TOP}/${rel}`)?.mode, "-rwxr-xr-x", `${rel} must be 0755 in the tar`);
  }
  const shellScripts = tar.filter((e) => /\/scripts\/[^/]+\.sh$/.test(e.path));
  assert.ok(shellScripts.length >= 5, "scripts/*.sh must ship");
  assert.ok(shellScripts.every((e) => e.mode === "-rwxr-xr-x"), "scripts/*.sh must keep their exec bit in the tar");
  assert.equal(tar.find((e) => e.path === `${TOP}/manifest.json`)?.mode, "-rw-r--r--");
  assert.equal(tar.find((e) => e.path === `${TOP}/bin/install.ps1`)?.mode, "-rw-r--r--");

  const zip = zipListing(built.zip);
  if (!zip) {
    console.warn("SKIP (loud): zipinfo not on PATH — zip structure assertions were NOT run");
    return;
  }
  assert.deepEqual([...new Set(zip.map((e) => e.path.split("/")[0]))], [TOP]);
  for (const rel of ["bin/install", "bin/doctor"]) {
    assert.equal(zip.find((e) => e.path === `${TOP}/${rel}`)?.mode, "-rwxr-xr-x", `${rel} must be 0755 in the zip`);
  }
  assert.ok(zip.filter((e) => /\/scripts\/[^/]+\.sh$/.test(e.path)).every((e) => e.mode === "-rwxr-xr-x"));
  assert.deepEqual(zip.map((e) => e.path).sort(), tar.map((e) => e.path).sort(), "tar and zip must carry the same members");
});

test("the artifact exclusions name scripts/ops explicitly and the mirror agrees (ILL-347)", () => {
  const source = readFileSync(join(REPO_ROOT, "scripts/package-local-backend.mjs"), "utf8");
  const listStart = source.indexOf("const privatePackagePaths = [");
  const listEnd = source.indexOf("];", listStart);
  assert.ok(listStart > 0 && listEnd > listStart, "privatePackagePaths list is present");
  const list = source.slice(listStart, listEnd);
  assert.match(list, /^\s*"scripts\/ops",$/m, "scripts/ops is an explicit artifact exclusion");
  const mirror = readFileSync(join(REPO_ROOT, "scripts/sync-public.mjs"), "utf8");
  assert.match(mirror, /^\s*"scripts\/ops",$/m, "scripts/ops is an explicit mirror exclusion");
  // The copy list never picks up scripts/ops either: only individual scripts are copied.
  assert.doesNotMatch(source, /\["scripts\/ops/);
  assert.doesNotMatch(source, /\["scripts", "scripts"\]/);
});

test("the shipped copy carries no hosted billing internals, hosted paths or contributor notes", (t) => {
  const built = build(t);
  assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
  const read = (rel) => readFileSync(join(built.out, rel), "utf8");
  const uuidConstant = /PRODUCT_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"/;
  assert.doesNotMatch(read("convex/crystal/userProfiles.ts"), uuidConstant);
  assert.doesNotMatch(read("convex/crystal/stats.ts"), uuidConstant);
  assert.match(read("convex/crystal/userProfiles.ts"), /hosted-billing-product:pro_product_id/);
  assert.doesNotMatch(read("convex/crystal/userProfiles.ts"), /getCurrentUserBillingInfo|getCurrentUserCheckoutContext|getByPolarCustomerInternal|getByPolarSubscriptionInternal|updateSubscriptionInternal/);
  assert.match(read("convex/crystal/userProfiles.ts"), /export const getByUserInternal|export const listAllUserIds/);
  const schema = read("convex/schema.ts");
  assert.doesNotMatch(schema, /crystalCostRateCards|crystalDailyCostLedger|crystalDailyBusinessLedger|crystalProviderReconciliation|polarUnmatchedEvents|by_subscription_event|by_polar_subscription|by_polar_customer|crystalAdminSettings|============ Cloud Control Plane/);
  assert.match(schema, /by_subscription_status/, "emailCrons still needs by_subscription_status");
  assert.match(schema, /roles: v\.optional/, "localAuth.ts still writes roles");
  for (const rel of ["convex/cloud", "convex/AGENTS.md", "convex/crystal/adminSettings/mutations.ts", "convex/crystal/polarWebhook.ts", "convex/crystal/polarUnmatchedEvents.ts", "convex/crystal/planPricing.ts", "convex/crystal/privateMemoryImport.ts", "convex/crystal/__tests__", "convex/crystal/eval", "scripts/ops"]) {
    assert.equal(existsSync(join(built.out, rel)), false, `${rel} must not ship`);
  }
  for (const rel of ["convex/crystal/adminEmails.ts", "convex/crystal/adminSupport.ts", "convex/crystal/adminSettings/resolvers.ts"]) {
    assert.equal(read(rel), read(`convex/selfHosted/${rel === "convex/crystal/adminSettings/resolvers.ts" ? "adminSettingsResolvers.ts" : rel.split("/").pop()}`), `${rel} must be the self-hosted override`);
  }
  assert.match(built.stdout, /Privacy gate passed/);
  const clean = spawnSync(process.execPath, ["scripts/local-backend-artifact-smoke.mjs"], { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, HOME: built.home, CRYSTAL_TEST_ARTIFACT_ROOT: built.out } });
  assert.equal(clean.status, 0, `smoke must pass on the freshly built tree\n${clean.stdout}\n${clean.stderr}`);
});

test("the privacy gate fails closed when a client stem survives in the shipped tree", (t) => {
  const dir = tmp(t);
  const termsFile = join(dir, "terms.json");
  // A stem every Convex schema contains, with no substitution to remove it:
  // the build must refuse rather than ship it.
  writeFileSync(termsFile, JSON.stringify({ substitutions: [], stems: ["\\bdefineTable\\b"] }));
  const expectedFile = join(dir, "expected.json");
  writeFileSync(expectedFile, JSON.stringify({ publicTree: [], localBackendArchive: [] }));
  const built = build(t, { env: { CRYSTAL_CLIENT_TERMS_FILE: termsFile, CRYSTAL_PUBLIC_SCRUB_EXPECTED_FILE: expectedFile } });
  assert.notEqual(built.status, 0, "packager must exit non-zero on a privacy gate hit");
  assert.match(built.stderr, /privacy gate failed/);
  assert.match(built.stderr, /gate_failures [1-9]/);
  assert.match(built.stderr, /stem convex\/schema\.ts [1-9]/);
  assert.equal(built.stderr.includes("\\bdefineTable\\b"), false, "stem source printed");
  assert.equal(existsSync(built.tar), false, "no archive may be written after a gate failure");
});

test("printed gate failures for a synthetic tree omit the needle and the stem source", (t) => {
  const needle = "ZorblaxNeedle";
  const stemWord = "ZorblaxStem";
  const stemSource = "\\bZorblaxStem\\b";
  const root = tmp(t, "mc-packager-print-");
  for (const rel of ["convex", "shared", "infra/convex", "scripts/lib", "package.json", "apps/web/package.json", "plugin/openclaw.plugin.json"]) {
    cpSync(join(REPO_ROOT, rel), join(root, rel), { recursive: true });
  }
  for (const name of readdirSync(join(REPO_ROOT, "scripts"))) {
    if (/^convex-local-.*\.(sh|ts)$/.test(name) || name === "package-local-backend.mjs") {
      cpSync(join(REPO_ROOT, "scripts", name), join(root, "scripts", name));
    }
  }
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"), "dir");
  writeFileSync(join(root, "scripts/sync-public.mjs"), [
    'import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";',
    'import { join } from "node:path";',
    `export const PUBLIC_LEAK_CHECKS = [{ label: "synthetic marker", needle: ${JSON.stringify(needle)} }];`,
    "export function findPublicMirrorLeaks(root) {",
    "  const failures = [];",
    "  const walk = (current) => {",
    "    if (!existsSync(current)) return;",
    "    for (const entry of readdirSync(current)) {",
    '      if (entry === ".git" || entry === "node_modules") continue;',
    "      const full = join(current, entry);",
    "      const rel = full.slice(root.length + 1);",
    "      const stat = statSync(full);",
    "      if (stat.isDirectory()) { walk(full); continue; }",
    "      if (!stat.isFile()) continue;",
    '      let text = "";',
    '      try { text = readFileSync(full, "utf8"); } catch { continue; }',
    "      for (const { label, needle: value } of PUBLIC_LEAK_CHECKS) {",
    "        if (text.includes(value)) failures.push(`${rel} references ${label} (${value})`);",
    "      }",
    "    }",
    "  };",
    "  walk(root);",
    "  return failures;",
    "}",
    "",
  ].join("\n"));
  const termsFile = join(root, "terms.json");
  writeFileSync(termsFile, JSON.stringify({ substitutions: [], stems: [stemSource] }));
  writeFileSync(join(root, "scripts/public-scrub-expected.private.json"), JSON.stringify({ publicTree: [], localBackendArchive: [] }));
  const doctor = join(root, "scripts/convex-local-doctor.sh");
  writeFileSync(doctor, `${readFileSync(doctor, "utf8")}\n# ${needle} ${stemWord}\n`);
  writeFileSync(join(root, "shared", `${needle}-note.txt`), `${needle}\n${stemWord}\n`);
  const out = join(root, "out", TOP);
  const archiveDir = join(root, "archives");
  const home = scratchHome(root);
  const result = spawnSync(process.execPath, [join(root, "scripts/package-local-backend.mjs"), "--version", VERSION, "--out", out, "--archive-dir", archiveDir], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HOME: home, SOURCE_DATE_EPOCH: EPOCH, CRYSTAL_CLIENT_TERMS_FILE: termsFile },
  });
  const output = `${result.stdout || ""}\n${result.stderr || ""}`;
  assert.notEqual(result.status, 0, `status ${result.status}`);
  assert.equal(output.includes(needle), false, `needle text count ${output.includes(needle) ? 1 : 0}`);
  assert.equal(output.includes(stemWord), false, `stem letters count ${output.includes(stemWord) ? 1 : 0}`);
  assert.equal(output.includes(stemSource), false, `stem source count ${output.includes(stemSource) ? 1 : 0}`);
  assert.match(output, /privacy gate failed/);
  assert.match(output, /gate_failures [1-9]/);
  assert.match(output, /needle <redacted path \d+> [1-9]/);
  assert.match(output, /stem scripts\/convex-local-doctor\.sh [1-9]/);
  assert.equal(existsSync(join(archiveDir, `${TOP}.tar.gz`)), false, "no archive may be written");
});

// ── Terms-file gate (round 2, P3): fail closed on a private checkout ─────────
//
// A private checkout is one that carries scripts/sync-public.mjs. There, a
// missing terms file or an empty stems list would make the scrub a silent
// no-op and leave the gate blind, so the build must refuse. A public checkout
// has neither file and keeps the warning-only behaviour.

test("a private checkout without the client terms file refuses to build", (t) => {
  const dir = tmp(t);
  assert.ok(existsSync(join(REPO_ROOT, "scripts/sync-public.mjs")), "this checkout must be private (carries sync-public.mjs)");
  const built = build(t, { env: { CRYSTAL_CLIENT_TERMS_FILE: join(dir, "missing-terms.json") } });
  assert.notEqual(built.status, 0, "packager must exit non-zero without the terms file on a private checkout");
  assert.match(built.stderr, /private checkout without a client terms file/);
  assert.match(built.stderr, /missing-terms\.json is missing/);
  assert.match(built.stderr, /Refusing to build/);
  assert.equal(existsSync(built.tar), false, "no archive may be written");
  assert.equal(existsSync(built.zip), false);
});

test("a private checkout whose terms file has an empty stems list refuses to build", (t) => {
  const dir = tmp(t);
  const termsFile = join(dir, "terms.json");
  writeFileSync(termsFile, JSON.stringify({ substitutions: [["Zebrafish Widgets", "a partner"]], stems: [] }));
  const built = build(t, { env: { CRYSTAL_CLIENT_TERMS_FILE: termsFile } });
  assert.notEqual(built.status, 0, "packager must exit non-zero with no stems on a private checkout");
  assert.match(built.stderr, /private checkout with no client stems/);
  assert.match(built.stderr, /Refusing to build/);
  assert.equal(existsSync(built.tar), false, "no archive may be written");
});

test("a public checkout (no sync-public.mjs) keeps the warning-only behaviour and builds", (t) => {
  // Simulate the public mirror: the packaging inputs and scripts/lib, but no
  // sync-public.mjs and no terms file.
  const root = tmp(t, "mc-public-checkout-");
  for (const rel of ["convex", "shared", "infra/convex", "scripts/lib", "package.json", "apps/web/package.json", "plugin/openclaw.plugin.json"]) {
    cpSync(join(REPO_ROOT, rel), join(root, rel), { recursive: true });
  }
  for (const name of readdirSync(join(REPO_ROOT, "scripts"))) {
    if (/^convex-local-.*\.(sh|ts)$/.test(name) || name === "package-local-backend.mjs") cpSync(join(REPO_ROOT, "scripts", name), join(root, "scripts", name));
  }
  // The archive writer needs fflate; a real public checkout has run npm ci.
  symlinkSync(join(REPO_ROOT, "node_modules"), join(root, "node_modules"), "dir");
  assert.equal(existsSync(join(root, "scripts/sync-public.mjs")), false);
  assert.equal(existsSync(join(root, "scripts/client-terms.private.json")), false);
  const out = join(root, "out", TOP);
  const archiveDir = join(root, "archives");
  const home = scratchHome(root);
  const env = { ...process.env, HOME: home, SOURCE_DATE_EPOCH: EPOCH };
  delete env.CRYSTAL_CLIENT_TERMS_FILE;
  const result = spawnSync(process.execPath, [join(root, "scripts/package-local-backend.mjs"), "--version", VERSION, "--out", out, "--archive-dir", archiveDir], { cwd: root, encoding: "utf8", env });
  assert.equal(result.status, 0, `public checkout build must succeed\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stderr, /no client-term substitutions loaded \(expected on a public checkout\)/);
  assert.doesNotMatch(result.stderr, /Refusing to build/);
  assert.match(result.stdout, /Privacy gate passed \(mirror needles: unavailable on this checkout, client stems: 0\)/);
  assert.equal(existsSync(join(archiveDir, `${TOP}.tar.gz`)), true);
  assert.equal(existsSync(join(archiveDir, `${TOP}.zip`)), true);
});

test("hosted operations tooling under scripts/ops never ships: no include-list entry or parent, nothing packaged (ILL-351)", (t) => {
  assert.equal(existsSync(join(REPO_ROOT, "scripts/ops/deploy-gates")), true, "the private tooling exists in this checkout");
  const dryDir = tmp(t, "mc-packager-dry-");
  const dryHome = scratchHome(dryDir);
  const dry = spawnSync(process.execPath, ["scripts/package-local-backend.mjs", "--version", VERSION, "--out", join(dryDir, TOP), "--dry-run"], { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, HOME: dryHome } });
  assert.equal(dry.status, 0, dry.stderr);
  const includeList = dry.stdout.split("\n").map((line) => line.match(/^copy (\S+) -> /)?.[1]).filter(Boolean);
  assert.ok(includeList.length > 0, "the dry run prints the include list");
  for (const source of includeList) {
    const normalized = source.replace(/\/+$/, "");
    assert.notEqual(normalized, "scripts/ops", source);
    assert.equal(normalized.startsWith("scripts/ops/"), false, source);
    assert.equal(["", ".", "scripts"].includes(normalized), false, `${source} is a parent of scripts/ops`);
  }
  const built = build(t);
  assert.equal(built.status, 0, `${built.stdout}\n${built.stderr}`);
  const manifest = JSON.parse(readFileSync(join(built.out, "manifest.json"), "utf8"));
  assert.ok(manifest.files.length > 0);
  for (const file of manifest.files) assert.equal(file.path.startsWith("scripts/ops/"), false, file.path);
  assert.equal(existsSync(join(built.out, "scripts/ops")), false);
  const packaged = [];
  (function walk(dir, rel) {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const next = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(join(dir, ent.name), next); else packaged.push(next);
    }
  })(built.out, "");
  assert.ok(packaged.length > 0);
  for (const path of packaged) assert.equal(path.startsWith("scripts/ops/"), false, path);
  for (const entry of tarListing(built.tar)) assert.equal(entry.path.includes("/scripts/ops/"), false, entry.path);
});
