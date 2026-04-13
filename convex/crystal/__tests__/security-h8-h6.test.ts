import { describe, expect, it } from "vitest";
import * as userProfiles from "../userProfiles";

/**
 * H-8: Public webhook mutations must not exist.
 * These functions exposed webhookToken in client-visible function signatures.
 * They should be removed — only the Internal versions should remain.
 */
describe("H-8: public webhook functions removed", () => {
  it("should not export getByPolarCustomer (public)", () => {
    expect((userProfiles as any).getByPolarCustomer).toBeUndefined();
  });

  it("should not export getByPolarSubscription (public)", () => {
    expect((userProfiles as any).getByPolarSubscription).toBeUndefined();
  });

  it("should not export updateSubscription (public)", () => {
    expect((userProfiles as any).updateSubscription).toBeUndefined();
  });

  it("should not export backfillMissingRoles (public)", () => {
    expect((userProfiles as any).backfillMissingRoles).toBeUndefined();
  });

  it("should not export upsertSubscriptionByUser (public)", () => {
    expect((userProfiles as any).upsertSubscriptionByUser).toBeUndefined();
  });

  it("should still export internal versions", () => {
    expect(userProfiles.getByPolarCustomerInternal).toBeDefined();
    expect(userProfiles.getByPolarSubscriptionInternal).toBeDefined();
    expect(userProfiles.updateSubscriptionInternal).toBeDefined();
    expect(userProfiles.upsertSubscriptionByUserInternal).toBeDefined();
  });
});

/**
 * H-6: The MC API key (config.apiKey) must never be sent to OpenAI.
 * The summarizer config must not fall back to config.apiKey for OpenAI calls.
 */
describe("H-6: no API key leak to OpenAI", () => {
  it("plugin/index.js should not contain apiKey fallback for OpenAI summarizer", () => {
    const fs = require("fs");
    const source = fs.readFileSync(
      require("path").resolve(__dirname, "../../../plugin/index.js"),
      "utf8",
    );

    // The old pattern: config?.openaiApiKey || process.env.OPENAI_API_KEY || config?.apiKey
    // After fix, config?.apiKey should NOT appear as a fallback for the summarizer apiKey
    // Match any line where apiKey is assigned with a fallback to config?.apiKey
    const leakPattern = /apiKey\s*:\s*.*\|\|\s*config\?\.apiKey/;
    expect(source).not.toMatch(leakPattern);
  });

  it("plugin/index.js comment should not document apiKey fallback for OpenAI", () => {
    const fs = require("fs");
    const source = fs.readFileSync(
      require("path").resolve(__dirname, "../../../plugin/index.js"),
      "utf8",
    );

    // The old comment: "falls back to OPENAI_API_KEY env var, then apiKey"
    expect(source).not.toMatch(/falls back to.*then apiKey/i);
  });
});
