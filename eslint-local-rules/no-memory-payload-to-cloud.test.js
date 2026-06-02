"use strict";

/**
 * Tests for the no-memory-payload-to-cloud ESLint rule.
 *
 * Uses ESLint's built-in RuleTester. No external test runner required —
 * RuleTester throws on failure, so this file can be run with:
 *
 *   node eslint-local-rules/no-memory-payload-to-cloud.test.js
 *
 * It is also picked up by vitest when the test glob includes this path.
 */

const { RuleTester } = require("eslint");
const rule = require("./no-memory-payload-to-cloud");

const CLOUD_FILE = "/project/convex/cloud/telemetry.ts";
const TELEMETRY_HTTP_FILE = "/project/convex/cloud/telemetryHttp.ts";
const NON_CLOUD_FILE = "/project/convex/crystal/mcp.ts";

const MESSAGE =
  "convex/cloud/** must never import crystalMemories — tenant memories live in local Convex only (Principle 1).";

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
  },
});

ruleTester.run("no-memory-payload-to-cloud", rule, {
  valid: [
    // Non-cloud files may reference crystalMemories freely
    {
      filename: NON_CLOUD_FILE,
      code: `import { crystalMemories } from "../schema";`,
    },
    {
      filename: NON_CLOUD_FILE,
      code: `const x = db.query("crystalMemories").collect();`,
    },
    // Cloud files that do NOT reference forbidden identifiers are fine
    {
      filename: CLOUD_FILE,
      code: `import { tenants, tunnels } from "../schema";`,
    },
    {
      filename: CLOUD_FILE,
      code: `const count = await ctx.db.query("tenants").collect();`,
    },
    {
      filename: CLOUD_FILE,
      code: `export const telemetryHandler = httpAction(async (ctx, req) => { return new Response("ok"); });`,
    },
    // M6 — telemetryHttp.ts must NOT trigger the rule (it references no memory tables)
    {
      filename: TELEMETRY_HTTP_FILE,
      code: `import { httpAction, internalMutation, internalQuery } from "../_generated/server";`,
    },
    {
      filename: TELEMETRY_HTTP_FILE,
      code: `import { v } from "convex/values"; import { internal } from "../_generated/api";`,
    },
    {
      filename: TELEMETRY_HTTP_FILE,
      code: `const count = await ctx.db.query("telemetry").withIndex("by_payloadId", q => q.eq("payloadId", id)).first();`,
    },
    {
      filename: TELEMETRY_HTTP_FILE,
      code: `const tenant = await ctx.db.get(tenantId); const tunnel = await ctx.db.query("tunnels").first();`,
    },
    {
      filename: TELEMETRY_HTTP_FILE,
      code: `await ctx.db.insert("telemetry", { tenantId, payloadId, payload, receivedAt: Date.now(), mcVersion });`,
    },
    {
      filename: TELEMETRY_HTTP_FILE,
      code: `const keys = await ctx.db.query("apiKeys").withIndex("by_tenantId", q => q.eq("tenantId", id)).collect();`,
    },
  ],

  invalid: [
    // Named import of crystalMemories inside a cloud file
    {
      filename: CLOUD_FILE,
      code: `import { crystalMemories } from "../schema";`,
      errors: [{ message: MESSAGE }],
    },
    // Import path containing the forbidden name
    {
      filename: CLOUD_FILE,
      code: `import crystalMemoriesSchema from "../crystal/crystalMemories";`,
      errors: [{ message: MESSAGE }],
    },
    // Property access on db object
    {
      filename: CLOUD_FILE,
      code: `const rows = await ctx.db.query(schema.crystalMemories).collect();`,
      errors: [{ message: MESSAGE }],
    },
    // Standalone identifier reference
    {
      filename: CLOUD_FILE,
      code: `const tbl = crystalMemories;`,
      errors: [{ message: MESSAGE }],
    },
    // crystalSessions is also forbidden
    {
      filename: CLOUD_FILE,
      code: `import { crystalSessions } from "../schema";`,
      errors: [{ message: MESSAGE }],
    },
    // crystalMessages is also forbidden
    {
      filename: CLOUD_FILE,
      code: `import { crystalMessages } from "../schema";`,
      errors: [{ message: MESSAGE }],
    },
    // embedding is also forbidden
    {
      filename: CLOUD_FILE,
      code: `import { embedding } from "../crystal/schema";`,
      errors: [{ message: MESSAGE }],
    },
  ],
});

console.log("no-memory-payload-to-cloud: all RuleTester assertions passed.");
