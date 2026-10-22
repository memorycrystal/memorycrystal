import type { Tool } from "@modelcontextprotocol/sdk/types.js";
// The SDK does not re-export this converter from its public server entrypoint.
// Keep the compatibility import in the stdio package; hosted startup never loads it.
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import { z } from "zod";
import { MCP_TOOLS } from "./toolContract.js";

export function stdioTool(name: string): Tool {
  const tool = MCP_TOOLS[name];
  if (!tool) throw new Error(`Unknown shared MCP tool: ${name}`);
  const inputSchema = toJsonSchemaCompat(z.object(tool.input), {
    strictUnions: true,
    pipeStrategy: "input",
  }) as Tool["inputSchema"];
  return {
    name: tool.name,
    description: tool.description,
    inputSchema,
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  };
}
