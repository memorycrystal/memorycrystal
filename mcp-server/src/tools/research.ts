import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { ConvexClient } from "../lib/convexClient.js";

type Input = Record<string, unknown>;

const collectionId = { type: "string", description: "Research collection Convex id" } as const;

export const researchCreateCollectionTool: Tool = {
  name: "crystal_research_create_collection",
  description: "Create a durable, owner-scoped research collection.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      domain: { type: "string" },
      description: { type: "string" },
      retentionPolicy: { type: "string" },
      workspaceId: { type: "string" },
      agentId: { type: "string" },
      channel: { type: "string" },
      visibility: { type: "string", enum: ["private", "scoped"] },
    },
    required: ["name", "domain"],
    additionalProperties: false,
  },
};

export const researchIngestTool: Tool = {
  name: "crystal_research_ingest",
  description: "Submit one idempotent research record or create/advance a durable ingestion job shard. Raw third-party code is stored as quarantined artifacts and is never executed.",
  inputSchema: {
    type: "object",
    properties: {
      operation: {
        type: "string",
        enum: ["source", "item", "variant", "dataset", "run", "create_job", "create_shard", "claim_shard", "heartbeat_shard", "complete_shard", "set_job_state"],
      },
      collectionId,
      jobId: { type: "string" },
      shardId: { type: "string" },
      payload: { type: "object", description: "Operation-specific payload using the research HTTP schema." },
    },
    required: ["operation", "payload"],
    additionalProperties: false,
  },
};

export const researchStatusTool: Tool = {
  name: "crystal_research_status",
  description: "Get bounded collection counters or durable job progress.",
  inputSchema: {
    type: "object",
    properties: { collectionId, jobId: { type: "string" } },
    additionalProperties: false,
  },
};

export const researchQueryTool: Tool = {
  name: "crystal_research_query",
  description: "Query bounded canonical items or experiment summaries with exact filters and cursor pagination.",
  inputSchema: {
    type: "object",
    properties: {
      collectionId,
      kind: { type: "string", enum: ["items", "runs", "semantic"] },
      itemType: { type: "string" },
      reviewStatus: { type: "string" },
      status: { type: "string", enum: ["queued", "running", "completed", "failed", "rejected", "cancelled"] },
      agentId: { type: "string" },
      channel: { type: "string" },
      cursor: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 100 },
      query: { type: "string" },
      embedding: { type: "array", items: { type: "number" }, minItems: 3072, maxItems: 3072 },
      model: { type: "string" },
    },
    required: ["collectionId", "kind"],
    additionalProperties: false,
  },
};

export const researchTraceTool: Tool = {
  name: "crystal_research_trace",
  description: "Trace one finalist run to its canonical item, variant, dataset, artifacts, immutable sources, licenses, and security dispositions.",
  inputSchema: {
    type: "object",
    properties: { runId: { type: "string" } },
    required: ["runId"],
    additionalProperties: false,
  },
};

export const researchPromoteTool: Tool = {
  name: "crystal_research_promote",
  description: "Promote a qualified, clean, completed, causality-valid research finding into a Memory Crystal knowledge base, or demote an existing promotion.",
  inputSchema: {
    type: "object",
    properties: {
      operation: { type: "string", enum: ["promote", "demote"] },
      collectionId,
      itemId: { type: "string" },
      runId: { type: "string" },
      datasetId: { type: "string" },
      knowledgeBaseId: { type: "string" },
      promotionId: { type: "string" },
      reason: { type: "string" },
    },
    required: ["operation", "reason"],
    additionalProperties: false,
  },
};

export const researchTools: Tool[] = [
  researchCreateCollectionTool,
  researchIngestTool,
  researchStatusTool,
  researchQueryTool,
  researchTraceTool,
  researchPromoteTool,
];

function input(value: unknown): Input {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid research tool arguments");
  return value as Input;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} is required`);
  return value.trim();
}

function result(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

async function safe(handler: () => Promise<unknown>): Promise<CallToolResult> {
  try {
    return result(await handler());
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: `Error: ${error instanceof Error ? error.message : String(error)}` }] };
  }
}

export function handleResearchCreateCollection(args: unknown): Promise<CallToolResult> {
  return safe(async () => {
    const parsed = input(args);
    return new ConvexClient().post("/api/research/collections", parsed);
  });
}

export function handleResearchIngest(args: unknown): Promise<CallToolResult> {
  return safe(async () => {
    const parsed = input(args);
    const operation = requiredString(parsed.operation, "operation");
    const payload = input(parsed.payload);
    const collection = typeof parsed.collectionId === "string" ? parsed.collectionId : undefined;
    const client = new ConvexClient();
    if (["source", "item", "variant", "dataset", "run"].includes(operation)) {
      return client.post(`/api/research/${operation === "source" ? "sources" : `${operation}s`}`, {
        collectionId: collection,
        [operation]: payload,
      });
    }
    if (operation === "create_job") return client.post("/api/research/jobs", { collectionId: collection, ...payload });
    const jobId = typeof parsed.jobId === "string" ? parsed.jobId : undefined;
    const shardId = typeof parsed.shardId === "string" ? parsed.shardId : undefined;
    if (operation === "create_shard") return client.post(`/api/research/jobs/${requiredString(jobId, "jobId")}/shards`, payload);
    if (operation === "claim_shard") return client.post(`/api/research/jobs/${requiredString(jobId, "jobId")}/claim`, payload);
    if (operation === "heartbeat_shard") return client.post(`/api/research/shards/${requiredString(shardId, "shardId")}/heartbeat`, payload);
    if (operation === "complete_shard") return client.post(`/api/research/shards/${requiredString(shardId, "shardId")}/complete`, payload);
    if (operation === "set_job_state") return client.post(`/api/research/jobs/${requiredString(jobId, "jobId")}/state`, payload);
    throw new Error("Unsupported research ingest operation");
  });
}

export function handleResearchStatus(args: unknown): Promise<CallToolResult> {
  return safe(async () => {
    const parsed = input(args);
    const client = new ConvexClient();
    if (typeof parsed.jobId === "string") return client.get(`/api/research/jobs/${parsed.jobId}/status`);
    return client.get(`/api/research/collections/${requiredString(parsed.collectionId, "collectionId")}/stats`);
  });
}

export function handleResearchQuery(args: unknown): Promise<CallToolResult> {
  return safe(async () => new ConvexClient().post("/api/research/query", input(args)));
}

export function handleResearchTrace(args: unknown): Promise<CallToolResult> {
  return safe(async () => {
    const parsed = input(args);
    return new ConvexClient().get(`/api/research/trace?runId=${encodeURIComponent(requiredString(parsed.runId, "runId"))}`);
  });
}

export function handleResearchPromote(args: unknown): Promise<CallToolResult> {
  return safe(async () => {
    const parsed = input(args);
    const operation = requiredString(parsed.operation, "operation");
    return new ConvexClient().post(`/api/research/${operation}`, parsed);
  });
}
