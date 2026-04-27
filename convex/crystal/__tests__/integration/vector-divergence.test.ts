import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

const seedStatusRef = makeFunctionReference<"query">("crystal/seed:seedStatus");
const vectorDivergenceCanaryRef = makeFunctionReference<"action">("crystal/seed:vectorDivergenceCanary");

const shouldRun = process.env.CRYSTAL_BACKEND === "local" && Boolean(process.env.CONVEX_URL || process.env.CONVEX_SELF_HOSTED_URL);
const describeLocal = shouldRun ? describe : describe.skip;

function loadFixture() {
  const fixturePath = resolve(process.cwd(), "fixtures", "crystal-memories.json");
  if (!existsSync(fixturePath)) throw new Error(`Fixture file not found: ${fixturePath}`);
  return JSON.parse(readFileSync(fixturePath, "utf8"));
}

describeLocal("local Convex vector divergence canary", () => {
  it("finds a high-scoring seeded onboarding memory through the local vector index", async () => {
    const fixture = loadFixture();
    const client = new ConvexHttpClient(process.env.CONVEX_URL || process.env.CONVEX_SELF_HOSTED_URL || "http://127.0.0.1:3210");
    if (process.env.CONVEX_SELF_HOSTED_ADMIN_KEY) {
      (client as any).setAdminAuth(process.env.CONVEX_SELF_HOSTED_ADMIN_KEY);
    }

    const status = await client.query(seedStatusRef, {
      userId: fixture.userId,
      channel: fixture.channel,
    }) as { memories: number; embeddedMemories: number };
    expect(status.memories).toBeGreaterThanOrEqual(5);
    expect(status.embeddedMemories).toBe(status.memories);

    const onboarding = fixture.memories.find((memory: { title: string; content: string }) =>
      /memory crystal onboarding/i.test(`${memory.title}\n${memory.content}`)
    ) ?? fixture.memories[0];
    const canary = await client.action(vectorDivergenceCanaryRef, {
      embedding: onboarding.embedding,
      query: "memory crystal onboarding",
      userId: fixture.userId,
      channel: fixture.channel,
      minScore: 0.6,
    }) as { ok: boolean; results: Array<{ title: string; score: number }> };

    expect(canary.ok).toBe(true);
    expect(canary.results.length).toBeGreaterThanOrEqual(1);
    expect(canary.results[0].title.toLowerCase()).toContain("memory crystal");
  });
});
