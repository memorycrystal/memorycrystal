/**
 * Tests for correctness fixes: H-2, H-3, H-9, H-10, H-11
 */
import { describe, expect, it } from "vitest";

// ── H-2 & H-10: Unbounded .collect() ────────────────────────────────────────
// We verify that the query functions apply .take() limits by checking the
// source code (static analysis), since convex-test doesn't expose query plans.

import { readFileSync } from "fs";
import { join } from "path";

function readOrganic(file: string): string {
  return readFileSync(join(__dirname, "..", "organic", file), "utf-8");
}

describe("H-2: bounded queries in organic tick", () => {
  const tickSrc = readOrganic("tick.ts");

  it("getEnabledTickStates uses .take() (no unbounded .collect())", () => {
    const fnMatch = tickSrc.match(
      /getEnabledTickStates[\s\S]*?handler[\s\S]*?by_enabled[\s\S]*?\.take\(\d+\)/
    );
    expect(fnMatch).not.toBeNull();
  });

  it("runTick (cron recovery) uses .take() (no unbounded .collect())", () => {
    const fnMatch = tickSrc.match(
      /export const runTick[\s\S]*?by_enabled[\s\S]*?\.take\(\d+\)/
    );
    expect(fnMatch).not.toBeNull();
  });

  it("initTickState uses .take() (no unbounded .collect())", () => {
    const fnMatch = tickSrc.match(
      /initTickState[\s\S]*?by_user[\s\S]*?\.take\(\d+\)/
    );
    expect(fnMatch).not.toBeNull();
  });
});

describe("H-2: bounded queries in ideaDigest", () => {
  const digestSrc = readOrganic("ideaDigest.ts");

  it("getDigestEligibleUsers uses .take() (no unbounded .collect())", () => {
    const fnMatch = digestSrc.match(
      /getDigestEligibleUsers[\s\S]*?\.take\(\d+\)/
    );
    expect(fnMatch).not.toBeNull();
  });
});

describe("H-10: bounded queries in getMyOrganicSkills", () => {
  const adminSrc = readOrganic("adminTick.ts");

  it("getMyOrganicSkills uses .take() (no unbounded .collect())", () => {
    const fnMatch = adminSrc.match(
      /getMyOrganicSkills[\s\S]*?by_store_category[\s\S]*?\.take\(\d+\)/
    );
    expect(fnMatch).not.toBeNull();
  });

  it("getMyOrganicDashboardData ensembles query uses .take() (no unbounded .collect())", () => {
    const fnMatch = adminSrc.match(
      /organicEnsembles[\s\S]*?by_user[\s\S]*?\.take\(\d+\)/
    );
    expect(fnMatch).not.toBeNull();
  });
});

// ── H-3: Duplicate tick chain dedup ──────────────────────────────────────────

describe("H-3: tick dedup guard", () => {
  const tickSrc = readOrganic("tick.ts");

  it("processUserTick checks for recent tick runs before doing work", () => {
    // The processUserTick handler should query recent tick runs and skip if one ran recently
    const fnMatch = tickSrc.match(
      /processUserTick[\s\S]*?handler[\s\S]*?recentRun/i
    );
    expect(fnMatch).not.toBeNull();
  });
});

// ── H-9: Embedding dimension consistency ─────────────────────────────────────

describe("H-9: embedding dimensions match schema", () => {
  const schemaSrc = readFileSync(join(__dirname, "..", "..", "schema.ts"), "utf-8");
  const mcpSrc = readFileSync(join(__dirname, "..", "mcp.ts"), "utf-8");
  const utilsSrc = readOrganic("utils.ts");

  it("schema declares 3072-dimensional vector indices", () => {
    const dims = schemaSrc.match(/dimensions:\s*(\d+)/g);
    expect(dims).not.toBeNull();
    // All dimension declarations should be 3072
    for (const d of dims!) {
      expect(d).toContain("3072");
    }
  });

  it("organic/utils.ts embedText is Gemini-only with dimension validation", () => {
    expect(utilsSrc).toContain("gemini-embedding-2-preview");
    expect(utilsSrc).toContain("REQUIRED_EMBEDDING_DIMENSIONS");
    expect(utilsSrc).not.toContain("OpenAI fallback");
  });

  it("mcp.ts embedText is Gemini-only with dimension validation", () => {
    expect(mcpSrc).toContain("gemini-embedding-2-preview");
    expect(mcpSrc).toContain("REQUIRED_EMBEDDING_DIMENSIONS");
    expect(mcpSrc).toContain("assertGeminiProvider");
    expect(mcpSrc).not.toContain("OPENAI_EMBEDDING_ENDPOINT");
  });
});

// ── H-11: Nav operator precedence ────────────────────────────────────────────

describe("H-11: hasOrganic operator precedence", () => {
  const layoutSrc = readFileSync(
    join(__dirname, "..", "..", "..", "apps", "web", "app", "(dashboard)", "layout.tsx"),
    "utf-8"
  );

  it("does not allow pathname alone to set hasOrganic when query returned null", () => {
    // The hasOrganic expression should NOT have bare `|| pathname?.startsWith`
    // without proper guarding (e.g., only when query is still loading)
    const hasBarePathnameOr = /hasOrganic\s*=\s*[^;]*!==\s*null\s*\n?\s*\|\|\s*pathname/.test(layoutSrc);
    expect(hasBarePathnameOr).toBe(false);
  });

  it("uses explicit parentheses in hasOrganic expression", () => {
    // Should have parenthesized groups
    const hasParens = /hasOrganic\s*=\s*\(/.test(layoutSrc);
    expect(hasParens).toBe(true);
  });
});

// ── H-9b: stmEmbedder uses correct model + dimensions ──────────────────────

describe("H-9b: stmEmbedder is Gemini-only", () => {
  const stmSrc = readFileSync(join(__dirname, "..", "stmEmbedder.ts"), "utf-8");

  it("uses Gemini as sole provider (no OpenAI references)", () => {
    expect(stmSrc).toContain("gemini-embedding-2-preview");
    expect(stmSrc).not.toContain("OPENAI_EMBEDDING_ENDPOINT");
    expect(stmSrc).not.toContain("text-embedding-3-small");
    expect(stmSrc).not.toContain("text-embedding-3-large");
  });

  it("has dimension validation invariant", () => {
    expect(stmSrc).toContain("REQUIRED_EMBEDDING_DIMENSIONS");
    expect(stmSrc).toMatch(/REQUIRED_EMBEDDING_DIMENSIONS\s*=\s*3072/);
  });

  it("rejects non-gemini provider via assertGeminiProvider", () => {
    expect(stmSrc).toContain("assertGeminiProvider");
  });
});

describe("H-9c: MCP server embed adapter is Gemini-only", () => {
  const embedSrc = readFileSync(
    join(__dirname, "..", "..", "..", "mcp-server", "src", "lib", "embed.ts"),
    "utf-8"
  );

  it("OpenAI adapter throws on construction", () => {
    expect(embedSrc).toMatch(/class OpenAIEmbedAdapter[\s\S]*?throw new Error/);
    expect(embedSrc).toContain("OpenAI embeddings are disabled");
  });

  it("getEmbedAdapter rejects openai provider", () => {
    expect(embedSrc).toMatch(/case "openai":\s*\n\s*throw new Error/);
  });

  it("exports REQUIRED_EMBEDDING_DIMENSIONS = 3072", () => {
    expect(embedSrc).toMatch(/REQUIRED_EMBEDDING_DIMENSIONS\s*=\s*3072/);
  });

  it("GeminiEmbedAdapter validates vector dimensions", () => {
    expect(embedSrc).toMatch(/values\.length !== REQUIRED_EMBEDDING_DIMENSIONS/);
  });
});

describe("H-9d: assets.ts is Gemini-only (no text-embedding-3-small)", () => {
  const assetsSrc = readFileSync(join(__dirname, "..", "assets.ts"), "utf-8");

  it("does not reference OpenAI embedding models", () => {
    expect(assetsSrc).not.toContain("text-embedding-3-small");
    expect(assetsSrc).not.toContain("text-embedding-3-large");
    expect(assetsSrc).not.toContain("OPENAI_EMBEDDING");
  });

  it("uses Gemini as sole provider", () => {
    expect(assetsSrc).toContain("gemini-embedding-2-preview");
    expect(assetsSrc).toContain("assertGeminiProvider");
  });

  it("validates embedding dimensions", () => {
    expect(assetsSrc).toContain("REQUIRED_EMBEDDING_DIMENSIONS");
  });
});

describe("H-9e: plugin recall-hook.js is Gemini-only", () => {
  const recallHookSrc = readFileSync(
    join(__dirname, "..", "..", "..", "plugin", "recall-hook.js"),
    "utf-8"
  );

  it("does not reference OpenAI embedding models or endpoints", () => {
    expect(recallHookSrc).not.toContain("text-embedding-3-small");
    expect(recallHookSrc).not.toContain("text-embedding-3-large");
    expect(recallHookSrc).not.toContain("OPENAI_URL");
    expect(recallHookSrc).not.toContain("OPENAI_MODEL");
  });

  it("uses Gemini as sole provider with dimension validation", () => {
    expect(recallHookSrc).toContain("gemini-embedding-2-preview");
    expect(recallHookSrc).toContain("REQUIRED_EMBEDDING_DIMENSIONS");
  });
});

describe("H-9f: knowledgeBases.ts is Gemini-only", () => {
  const kbSrc = readFileSync(join(__dirname, "..", "knowledgeBases.ts"), "utf-8");

  it("does not reference OpenAI embedding endpoints", () => {
    expect(kbSrc).not.toContain("OPENAI_EMBEDDING_ENDPOINT");
    expect(kbSrc).not.toContain("openai.com/v1/embeddings");
  });

  it("has assertGeminiProvider guard", () => {
    expect(kbSrc).toContain("assertGeminiProvider");
  });

  it("validates batch embedding dimensions", () => {
    expect(kbSrc).toContain("REQUIRED_EMBEDDING_DIMENSIONS");
  });
});

// ── Retrieval fix: what_do_i_know passes query for hybrid search ────────────

describe("crystal_what_do_i_know passes query to recallMemories", () => {
  const whatSrc = readFileSync(
    join(__dirname, "..", "..", "..", "mcp-server", "src", "tools", "what-do-i-know.ts"),
    "utf-8"
  );

  it("includes query parameter in the recallMemories action call", () => {
    // The call to recallMemories should include `query: parsed.topic`
    expect(whatSrc).toMatch(/recallMemories[\s\S]*?query:\s*parsed\.topic/);
  });
});

// ── Retrieval fix: searchMessages uses channel in vector filter ─────────────

describe("searchMessages uses channel in vector filter", () => {
  const msgSrc = readFileSync(join(__dirname, "..", "messages.ts"), "utf-8");

  it("passes channel into vectorSearch filter when available", () => {
    // The vectorSearch call should include channel in the filter
    expect(msgSrc).toMatch(/vectorSearch\("crystalMessages"[\s\S]*?eq\("channel"/);
  });

  it("has text-search fallback via searchMessagesByTextForUser", () => {
    // searchMessages should call searchMessagesByTextForUser as fallback
    expect(msgSrc).toMatch(/searchMessages[\s\S]*searchMessagesByTextForUser/);
  });

  it("filters final search results by channel after vector and text fallback paths", () => {
    expect(msgSrc).toMatch(/filterSearchResultsByChannel/);
    expect(msgSrc).toMatch(/return filterSearchResultsByChannel\(vectorHits, channel\)/);
  });

  it("MCP search messages filters final surfaced messages and turns by channel", () => {
    const mcpSrc = readFileSync(join(__dirname, "..", "mcp.ts"), "utf-8");
    expect(mcpSrc).toMatch(/filterMessageMatchesByChannel/);
    expect(mcpSrc).toMatch(/filterMessageTurnsByChannel/);
    expect(mcpSrc).toMatch(/mcpSearchMessages[\s\S]*filterMessageMatchesByChannel/);
  });
});

describe("memory recall fast path batches hydration work", () => {
  const recallSrc = readFileSync(join(__dirname, "..", "recall.ts"), "utf-8");
  const mcpSrc = readFileSync(join(__dirname, "..", "mcp.ts"), "utf-8");

  it("semanticSearch batches memory hydration instead of fetching one memory per hit", () => {
    expect(mcpSrc).toMatch(/getMemoriesByIds/);
    expect(mcpSrc).not.toMatch(/results\.map\(async \(r\) =>[\s\S]*getMemoryById/);
  });

  it("recallMemories batches primary and association hydration", () => {
    expect(recallSrc).toMatch(/ctx\.runQuery\(internal\.crystal\.mcp\.getMemoriesByIds/);
    expect(recallSrc).toMatch(/associatedDocsById/);
  });
});

// ── Retrieval fix: channel visibility for agent-scoped channels ─────────────

describe("channel visibility allows unscoped memories in agent-scoped requests", () => {
  const kbSrc = readFileSync(join(__dirname, "..", "knowledgeBases.ts"), "utf-8");

  it("extracts prefix and suffix from scoped channel for matching", () => {
    // When channel has ":", should extract both prefix (agent) and suffix (base channel)
    expect(kbSrc).toMatch(/prefix\s*=\s*normalizedChannel\.slice\(0,\s*colonIndex\)/);
    expect(kbSrc).toMatch(/suffix\s*=\s*normalizedChannel\.slice\(colonIndex\s*\+\s*1\)/);
  });
});

// ── H-4, H-5, H-12: frontend + plugin consistency fixes ────────────────────

describe("H-4: organicRecallLog validates Convex IDs before mutation", () => {
  const httpSrc = readOrganic("http.ts");

  it("filters topResultIds with a Convex ID regex instead of only non-empty strings", () => {
    expect(httpSrc).toMatch(/CONVEX_ID_RE\s*=\s*\/\^\[a-z0-9\]\{10,40\}\$\/;/);
    expect(httpSrc).toMatch(/topResultIds\s*=\s*rawTopResultIds\.filter\([\s\S]*CONVEX_ID_RE\.test\(id\)/);
  });
});

describe("H-5: idea status values are consistent across plugin, MCP, and HTTP", () => {
  const httpSrc = readOrganic("http.ts");
  const ideaActionSrc = readFileSync(
    join(__dirname, "..", "..", "..", "mcp-server", "src", "tools", "idea-action.ts"),
    "utf-8"
  );
  const pluginSrc = readFileSync(
    join(__dirname, "..", "..", "..", "plugin", "index.js"),
    "utf-8"
  );

  it("HTTP endpoint accepts all four external idea statuses", () => {
    expect(httpSrc).toMatch(/validStatuses = \["read", "dismissed", "starred", "notified"\]/);
  });

  it("MCP idea action maps to the same plugin-facing statuses", () => {
    expect(ideaActionSrc).toContain('star: "starred"');
    expect(ideaActionSrc).toContain('dismiss: "dismissed"');
    expect(ideaActionSrc).toContain('read: "read"');
    expect(ideaActionSrc).not.toContain('"acknowledged"');
  });

  it("plugin notifies ideas using the same notified status string", () => {
    expect(pluginSrc).toContain('status: "notified"');
  });
});

// ── Plugin parity: crystal_why_did_we + crystal_what_do_i_know ───────────────

describe("Plugin parity: crystal_why_did_we uses server-side category filter", () => {
  const pluginSrc = readFileSync(
    join(__dirname, "..", "..", "..", "plugin", "index.js"),
    "utf-8"
  );

  it("passes mode: decision and categories: [decision] in the recall payload", () => {
    // The why_did_we tool should send server-side filters instead of post-filtering
    const whyDidWeBlock = pluginSrc.match(
      /crystal_why_did_we[\s\S]*?execute[\s\S]*?mode:\s*"decision"[\s\S]*?categories:\s*\["decision"\]/
    );
    expect(whyDidWeBlock).not.toBeNull();
  });

  it("does not client-side post-filter by category", () => {
    // Should NOT have the old pattern: mems.filter((m) => m?.category === "decision")
    const whyDidWeSection = pluginSrc.match(
      /crystal_why_did_we[\s\S]*?(?=api\.registerTool|$)/
    );
    expect(whyDidWeSection?.[0]).not.toMatch(/mems\.filter\([^)]*category\s*===\s*"decision"/);
  });
});

describe("Plugin parity: crystal_what_do_i_know supports stores and tags", () => {
  const pluginSrc = readFileSync(
    join(__dirname, "..", "..", "..", "plugin", "index.js"),
    "utf-8"
  );

  it("declares stores parameter in tool schema", () => {
    const whatDoIKnowBlock = pluginSrc.match(
      /crystal_what_do_i_know[\s\S]*?parameters:\s*\{[\s\S]*?stores/
    );
    expect(whatDoIKnowBlock).not.toBeNull();
  });

  it("declares tags parameter in tool schema", () => {
    const whatDoIKnowBlock = pluginSrc.match(
      /crystal_what_do_i_know[\s\S]*?parameters:\s*\{[\s\S]*?tags/
    );
    expect(whatDoIKnowBlock).not.toBeNull();
  });
});

describe("H-12: skills page uses a type-safe Convex query", () => {
  const skillsPageSrc = readFileSync(
    join(__dirname, "..", "..", "..", "apps", "web", "app", "(dashboard)", "organic", "skills", "page.tsx"),
    "utf-8"
  );

  it("does not use Record<string, any> casts to reach getMyOrganicSkills", () => {
    expect(skillsPageSrc).toContain("api.crystal.organic.adminTick.getMyOrganicSkills");
    expect(skillsPageSrc).not.toContain("Record<string, any>");
  });
});
