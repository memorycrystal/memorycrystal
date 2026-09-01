import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { emitCursorContext, normalizeCursorInput } from "./cursor-hooks.mjs";

test("normalizeCursorInput maps camelCase Cursor events and workspace roots", () => {
  const input = normalizeCursorInput({
    hookEventName: "beforeSubmitPrompt",
    conversation_id: "conv-1",
    workspace_roots: ["/tmp/project"],
    prompt: "remember this",
  });
  assert.equal(input.hook_event_name, "beforeSubmitPrompt");
  assert.equal(input.session_id, "conv-1");
  assert.equal(input.cwd, "/tmp/project");
  assert.equal(input.prompt, "remember this");
});

test("normalizeCursorInput treats UserPromptSubmit as capture-only beforeSubmitPrompt", () => {
  const input = normalizeCursorInput({ hook_event_name: "UserPromptSubmit", text: "hello" });
  assert.equal(input.hook_event_name, "beforeSubmitPrompt");
  assert.equal(input.prompt, "hello");
});

test("emitCursorContext writes additional_context and never hookSpecificOutput", () => {
  const chunks = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    emitCursorContext("wake text");
  } finally {
    process.stdout.write = original;
  }
  assert.equal(chunks.join(""), `${JSON.stringify({ additional_context: "wake text" })}\n`);
  assert.doesNotMatch(chunks.join(""), /hookSpecificOutput/);
});

test("beforeSubmitPrompt handler captures only and does not emit additional_context", () => {
  const src = readFileSync(fileURLToPath(new URL("./cursor-hooks.mjs", import.meta.url)), "utf8");
  const before = src.split('case "beforeSubmitPrompt"')[1]?.split("case \"")[0] ?? "";
  assert.match(before, /void capture\(/);
  assert.match(before, /void logMessage\(/);
  assert.doesNotMatch(before, /emitCursorContext/);
  assert.doesNotMatch(before, /additional_context/);
  assert.doesNotMatch(before, /hookSpecificOutput/);
});

test("sessionStart and postToolUse emit additional_context; afterAgentResponse captures platform cursor", () => {
  const src = readFileSync(fileURLToPath(new URL("./cursor-hooks.mjs", import.meta.url)), "utf8");
  const sessionStart = src.split('case "sessionStart"')[1]?.split("case \"")[0] ?? "";
  const afterAgent = src.split('case "afterAgentResponse"')[1]?.split('case "postToolUse"')[0] ?? "";
  const postTool = src.split('case "postToolUse"')[1]?.split("if (process.argv")[0] ?? "";
  assert.match(sessionStart, /emitCursorContext/);
  assert.match(postTool, /emitCursorContext/);
  assert.match(postTool, /applyDisciplineFooter/);
  assert.doesNotMatch(afterAgent, /emitCursorContext/);
  assert.match(src, /const platform = "cursor"/);
});
