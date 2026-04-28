import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TIER_LIMITS } from "../../../shared/tierLimits";
import { getMemoryEffectiveText, RAW_CONTENT_TOMBSTONE } from "../memoryText";
import { isPaidOrganicTier, rawContentExpiresAt, resolveSensoryRawTtlDays } from "../retention";

describe("reflection retention contract", () => {
  it("keeps sensory raw retention separate from STM retention", () => {
    expect(TIER_LIMITS.free.stmTtlDays).toBe(7);
    expect(TIER_LIMITS.free.sensoryRawTtlDays).toBe(7);
    expect(TIER_LIMITS.pro.stmTtlDays).toBe(30);
    expect(TIER_LIMITS.pro.sensoryRawTtlDays).toBe(14);
    expect(TIER_LIMITS.ultra.stmTtlDays).toBe(90);
    expect(TIER_LIMITS.ultra.sensoryRawTtlDays).toBe(30);
    expect(resolveSensoryRawTtlDays("unlimited", null)).toBe(30);
    expect(resolveSensoryRawTtlDays("unlimited", 45)).toBe(45);
  });

  it("uses explicit effective text and never treats tombstones as recall text", () => {
    expect(getMemoryEffectiveText({
      content: RAW_CONTENT_TOMBSTONE,
      rawContentWipedAt: Date.now(),
    })).toBe("");
    expect(getMemoryEffectiveText({
      content: RAW_CONTENT_TOMBSTONE,
      summary: "Retained summary",
      rawContentWipedAt: Date.now(),
    })).toBe("Retained summary");
    expect(getMemoryEffectiveText({
      content: "Raw content",
    })).toBe("Raw content");
  });

  it("computes raw content due dates from creation time and tier days", () => {
    const createdAt = Date.UTC(2026, 3, 27);
    expect(rawContentExpiresAt(createdAt, 14)).toBe(createdAt + 14 * 24 * 60 * 60 * 1000);
  });

  it("treats Organic/Pulse as paid-only", () => {
    expect(isPaidOrganicTier("free")).toBe(false);
    expect(isPaidOrganicTier("pro")).toBe(true);
    expect(isPaidOrganicTier("ultra")).toBe(true);
    expect(isPaidOrganicTier("unlimited")).toBe(true);
  });

  it("source guards cleanup from re-summarizing and preserves associations on TTL tombstone", () => {
    const cleanupSrc = readFileSync(join(__dirname, "..", "cleanup.ts"), "utf-8");
    expect(cleanupSrc).toContain("tombstoneSensoryRawContent");
    expect(cleanupSrc).toContain("getSensoryRawCandidatesForCleanup");
    expect(cleanupSrc).toContain("by_user_raw_retention_due");
    expect(cleanupSrc).toContain('.lte("rawContentExpiresAt", args.now)');
    expect(cleanupSrc).toContain('q.eq(q.field("rawContentWipedAt"), undefined)');
    expect(cleanupSrc).toContain("Cleanup never calls LLMs");
    expect(cleanupSrc).not.toMatch(/isExpiredSensory[\s\S]{0,400}deleteMemory/);
    expect(cleanupSrc).not.toMatch(/isExpiredSensory[\s\S]{0,400}deleteAssociationsForMemory/);
  });

  it("source guards reflection source summaries against index mismatches", () => {
    const reflectionSrc = readFileSync(join(__dirname, "..", "reflection.ts"), "utf-8");
    expect(reflectionSrc).toContain("use the zero-based list indexes exactly as shown");
    expect(reflectionSrc).not.toContain("${i + 1}. [${m.store}]");
  });

  it("source guards paid-only Organic/Pulse entry points", () => {
    const tickSrc = readFileSync(join(__dirname, "..", "organic", "tick.ts"), "utf-8");
    const adminSrc = readFileSync(join(__dirname, "..", "organic", "adminTick.ts"), "utf-8");
    expect(tickSrc).toMatch(/queueMemoryWritePulse[\s\S]*paid_only/);
    expect(tickSrc).toMatch(/processUserTick[\s\S]*paid plan required/);
    expect(tickSrc).toMatch(/triggerConversationPulse[\s\S]*paid-only/);
    expect(adminSrc).toMatch(/setMyOrganicPulseMode[\s\S]*assertPaidOrganicAccess/);
    expect(adminSrc).toMatch(/triggerMyOrganicPulseNow[\s\S]*paid plans only/);
  });
});
