import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { MCP_TOOLS, toolInputSchema } from "./toolContract.js";

export function stdioTool(name: string): Tool {
  const tool = MCP_TOOLS[name];
  if (!tool) throw new Error(`Unknown shared MCP tool: ${name}`);
  const inputSchema = toolInputSchema(tool.input);
  return {
    name: tool.name,
    description: tool.description,
    inputSchema,
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  };
}
