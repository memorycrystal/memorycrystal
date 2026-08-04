import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractFirstTurn, extractLastTurn } from "../apps/web/public/plugins/shared/_lib.mjs";

function writeJsonl(rows) {
  const dir = mkdtempSync(join(tmpdir(), "mc-hooks-jsonl-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n"));
  return file;
}

test("extractLastTurn parses Codex Desktop response_item payload messages", () => {
  const file = writeJsonl([
    {
      timestamp: "2026-04-27T12:00:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "older user" }],
      },
    },
    {
      timestamp: "2026-04-27T12:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "older assistant" }],
      },
    },
    {
      timestamp: "2026-04-27T12:01:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "latest desktop prompt" }],
      },
    },
    {
      timestamp: "2026-04-27T12:01:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "latest desktop answer" }],
      },
    },
  ]);

  assert.deepEqual(
    {
      userText: extractLastTurn(file).userText,
      assistantText: extractLastTurn(file).assistantText,
      status: extractLastTurn(file).status,
    },
    {
      userText: "latest desktop prompt",
      assistantText: "latest desktop answer",
      status: "complete",
    },
  );
});

test("extractFirstTurn still parses Claude-style first assistant turn", () => {
  const file = writeJsonl([
    { type: "user", message: { role: "user", content: [{ type: "text", text: "first user" }] } },
    { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "first assistant" }] } },
  ]);

  const turn = extractFirstTurn(file);
  assert.equal(turn.userText, "first user");
  assert.equal(turn.assistantText, "first assistant");
  assert.equal(turn.status, "complete");
});
