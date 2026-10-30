import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  REQUIRED_TOOL_NAMES,
  assertRequiredTools,
  frameMessage,
  initializeRequest,
  toolsFromListResponse,
  toolsListRequest,
} from "./mcp-pack-smoke.mjs";

describe("mcp pack smoke helpers", () => {
  it("frames newline-delimited JSON-RPC and reads a tools/list result", () => {
    const framed = frameMessage(initializeRequest());
    assert.equal(framed.endsWith("\n"), true);
    assert.equal(JSON.parse(framed).method, "initialize");
    assert.equal(toolsListRequest().method, "tools/list");
    const names = toolsFromListResponse({
      jsonrpc: "2.0",
      id: 2,
      result: { tools: REQUIRED_TOOL_NAMES.map((name) => ({ name, description: name })) },
    });
    assert.deepEqual(names, REQUIRED_TOOL_NAMES);
    assertRequiredTools(names);
  });

  it("rejects a tools/list that drops a required tool", () => {
    assert.throws(
      () => assertRequiredTools(["crystal_remember"]),
      /crystal_recall/,
    );
    assert.throws(
      () => toolsFromListResponse({ result: {} }),
      /tools array/,
    );
  });
});
