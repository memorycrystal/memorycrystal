import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../..");
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

describe("Convex read-budget guardrails", () => {
  it("uses a materialized trigger lookup instead of scanning active memories", () => {
    const schema = read("convex/schema.ts");
    const mcp = read("convex/crystal/mcp.ts");

    expect(schema).toContain("crystalMemoryTriggers: defineTable");
    expect(schema).toContain('.index("by_user_tool", ["userId", "toolName", "lastAccessedAt"])');
    expect(mcp).toContain("getTriggeredMemoryIdsForTools");

    const triggerLookupSection = mcp.match(
      /export const getMemoriesWithTriggers[\s\S]*?export const getTriggeredMemoryIdsForTools/,
    )?.[0] ?? "";

    expect(triggerLookupSection).not.toMatch(/query\("crystalMemories"\)[\s\S]*?take\(500\)/);
    expect(triggerLookupSection).toMatch(/query\("crystalMemoryTriggers"\)/);
  });

  it("keeps trigger rows synchronized on create, update, archive, and delete paths", () => {
    const memories = read("convex/crystal/memories.ts");
    const mcp = read("convex/crystal/mcp.ts");

    expect(memories).toContain("replaceMemoryTriggerRows");
    expect(memories).toContain("deleteMemoryTriggerRows");
    expect(memories).toMatch(/if \(nextArchived\) \{\s*await deleteMemoryTriggerRows/);
    expect(mcp).toMatch(/await replaceMemoryTriggerRows\(ctx, args\.userId, id, args\.actionTriggers, now\)/);
    expect(mcp).toMatch(/await deleteMemoryTriggerRows\(ctx, memoryId\)/);
  });

  it("uses cursor pagination for trigger backfill", () => {
    const mcp = read("convex/crystal/mcp.ts");
    const backfillSection = mcp.match(
      /export const backfillMemoryTriggersForUser[\s\S]*?export const mcpGetTriggers/,
    )?.[0] ?? "";

    expect(backfillSection).toContain("cursor: v.optional");
    expect(backfillSection).toContain(".paginate({ cursor: cursor ?? null");
    expect(backfillSection).toContain("continueCursor");
    expect(backfillSection).toContain("isDone");
    expect(backfillSection).not.toContain(".take(fetchLimit)");
  });

  it("provides a resumable all-user trigger backfill runner", () => {
    const mcp = read("convex/crystal/mcp.ts");
    const allUserBackfillSection = mcp.match(
      /export const backfillMemoryTriggersForAllUsers[\s\S]*?export const mcpGetTriggers/,
    )?.[0] ?? "";

    expect(allUserBackfillSection).toContain("pendingUserIds");
    expect(allUserBackfillSection).toContain("activeUserId");
    expect(allUserBackfillSection).toContain("memoryCursor");
    expect(allUserBackfillSection).toContain("scheduleContinuation");
    expect(allUserBackfillSection).toContain("backfillMemoryTriggersForUser");
  });

  it("does not expose actionTriggers on public createMemory input", () => {
    const memories = read("convex/crystal/memories.ts");
    const publicCreateInput = memories.match(
      /const createMemoryInput = v\.object\(\{[\s\S]*?\n\}\);/,
    )?.[0] ?? "";
    const internalCreateInput = memories.match(
      /const createMemoryInternalInput = v\.object\(\{[\s\S]*?\n\}\);/,
    )?.[0] ?? "";

    expect(publicCreateInput).not.toContain("actionTriggers");
    expect(internalCreateInput).toContain("actionTriggers");
  });

  it("keeps maintenance hot paths on indexed predicates", () => {
    const schema = read("convex/schema.ts");
    const memories = read("convex/crystal/memories.ts");
    const salience = read("convex/crystal/salience.ts");
    const consolidate = read("convex/crystal/consolidate.ts");
    const decay = read("convex/crystal/decay.ts");

    expect(schema).toContain("by_store_category_title");
    expect(schema).toContain("by_store_archived_salience");
    expect(schema).toContain("by_store_archived_created");
    expect(schema).toContain("by_user_archived_last_accessed");

    expect(memories).toMatch(/withIndex\("by_store_category_title"/);
    expect(salience).toMatch(/withIndex\("by_store_archived_salience"/);
    expect(consolidate).toMatch(/withIndex\("by_store_archived_created"/);
    expect(decay).toMatch(/withIndex\("by_user_archived_last_accessed"/);
    expect(decay).not.toContain("limit: limit + 1");
  });
});
