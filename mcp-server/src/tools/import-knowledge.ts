import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ConvexClient } from "../lib/convexClient.js";
import { resolveKnowledgeBaseByName } from "./knowledge-base-utils.js";

type ImportKnowledgeInput = {
  knowledgeBaseId?: string;
  knowledgeBaseName?: string;
  description?: string;
  sourceType?: string;
  agentIds?: string[];
  scope?: string;
  chunks: Array<{
    content: string;
    metadata?: {
      title?: string;
      sourceUrl?: string;
      chunkIndex?: number;
      totalChunks?: number;
      sourceType?: string;
    };
  }>;
};

export const importKnowledgeTool: Tool = {
  name: "crystal_import_knowledge",
  description: "Import text chunks into a Memory Crystal knowledge base.",
  inputSchema: {
    type: "object",
    properties: {
      knowledgeBaseId: { type: "string" },
      knowledgeBaseName: { type: "string" },
      description: { type: "string" },
      sourceType: { type: "string" },
      agentIds: { type: "array", items: { type: "string" } },
      scope: { type: "string" },
      chunks: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string" },
            metadata: {
              type: "object",
              properties: {
                title: { type: "string" },
                sourceUrl: { type: "string" },
                chunkIndex: { type: "number" },
                totalChunks: { type: "number" },
                sourceType: { type: "string" },
              },
              additionalProperties: false,
            },
          },
          required: ["content"],
          additionalProperties: false,
        },
      },
    },
    required: ["chunks"],
    additionalProperties: false,
  },
};

function parseInput(args: unknown): ImportKnowledgeInput {
  if (!args || typeof args !== "object") {
    throw new Error("Invalid arguments");
  }

  const input = args as Record<string, unknown>;
  const chunks = Array.isArray(input.chunks)
    ? input.chunks
        .filter((chunk) => chunk && typeof chunk === "object" && typeof (chunk as any).content === "string" && (chunk as any).content.length > 0)
        .map((chunk) => {
          const rawMetadata = (chunk as any).metadata && typeof (chunk as any).metadata === "object"
            ? (chunk as any).metadata
            : undefined;
          let metadata = rawMetadata;
          if (rawMetadata && typeof rawMetadata.sourceUrl === "string") {
            try {
              new URL(rawMetadata.sourceUrl);
            } catch {
              const { sourceUrl: _dropped, ...rest } = rawMetadata;
              metadata = rest;
            }
          }
          return {
            content: String((chunk as any).content).slice(0, 100_000),
            metadata,
          };
        })
    : [];

  if (chunks.length === 0) {
    throw new Error("chunks must contain at least one item");
  }

  const knowledgeBaseId = typeof input.knowledgeBaseId === "string" ? input.knowledgeBaseId.trim() : undefined;
  const knowledgeBaseName = typeof input.knowledgeBaseName === "string" ? input.knowledgeBaseName.trim() : undefined;
  if (!knowledgeBaseId && !knowledgeBaseName) {
    throw new Error("knowledgeBaseId or knowledgeBaseName is required");
  }

  return {
    knowledgeBaseId,
    knowledgeBaseName,
    description: typeof input.description === "string" ? input.description : undefined,
    sourceType: typeof input.sourceType === "string" ? input.sourceType : undefined,
    agentIds: Array.isArray(input.agentIds) ? input.agentIds.filter((value): value is string => typeof value === "string") : undefined,
    scope: typeof input.scope === "string" ? input.scope : undefined,
    chunks,
  };
}

export async function handleImportKnowledgeTool(args: unknown): Promise<CallToolResult> {
  try {
    const input = parseInput(args);
    const client = new ConvexClient();

    let knowledgeBaseId = input.knowledgeBaseId;
    if (!knowledgeBaseId && input.knowledgeBaseName) {
      const existing = await resolveKnowledgeBaseByName(input.knowledgeBaseName, client, {
        channel: input.scope,
      });
      if (existing) {
        knowledgeBaseId = existing._id;
      } else {
        const created = await client.post<{ knowledgeBaseId: string }>("/api/knowledge-bases", {
          name: input.knowledgeBaseName,
          description: input.description,
          sourceType: input.sourceType,
          agentIds: input.agentIds,
          scope: input.scope,
        });
        knowledgeBaseId = created.knowledgeBaseId;
      }
    }

    if (!knowledgeBaseId) {
      throw new Error("Unable to resolve knowledge base");
    }

    const result = await client.post(`/api/knowledge-bases/${knowledgeBaseId}/import`, {
      chunks: input.chunks,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : "Failed to import knowledge",
        },
      ],
    };
  }
}
