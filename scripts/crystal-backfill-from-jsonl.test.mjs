import test from "node:test";
import assert from "node:assert/strict";
import { extractFirstTurnFromText, parseArgs, runBackfill } from "./crystal-backfill-from-jsonl.mjs";

test("backfill prefers queue-operation enqueue content over later transcript user text", () => {
  const turn = extractFirstTurnFromText([
    JSON.stringify({ type: "queue-operation", operation: "enqueue", content: "queued prompt", sessionId: "s1", timestamp: "2026-04-24T00:00:00.000Z" }),
    JSON.stringify({ type: "user", message: { role: "user", content: "wrapped prompt" } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } }),
  ].join("\n"));

  assert.deepEqual(
    {
      userText: turn.userText,
      assistantText: turn.assistantText,
      userSource: turn.userSource,
      sessionId: turn.sessionId,
    },
    { userText: "queued prompt", assistantText: "answer", userSource: "queue-operation-enqueue", sessionId: "s1" },
  );
});

test("backfill extracts plain transcript user and assistant text", () => {
  const turn = extractFirstTurnFromText([
    JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "hello" }] } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: "hi" } }),
  ].join("\n"));

  assert.equal(turn.userText, "hello");
  assert.equal(turn.assistantText, "hi");
  assert.equal(turn.abandonedBeforeAssistant, false);
});

test("backfill reports abandoned first turns without assistant text", () => {
  const turn = extractFirstTurnFromText(JSON.stringify({ type: "queue-operation", operation: "enqueue", content: "ping", sessionId: "s2" }));

  assert.equal(turn.userText, "ping");
  assert.equal(turn.assistantText, "");
  assert.equal(turn.abandonedBeforeAssistant, true);
});

test("backfill is dry-run by default and counts candidates without writes", async () => {
  const options = parseArgs(["--since", "2026-04-21", "--until", "2026-04-24"]);
  const summary = await runBackfill(options, {
    files: ["fixture.jsonl"],
    readText: () => [
      JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "hi" } }),
    ].join("\n"),
  });

  assert.equal(options.commit, false);
  assert.deepEqual(
    {
      scanned: summary.scanned,
      candidates: summary.candidates,
      userWrites: summary.userWrites,
      assistantWrites: summary.assistantWrites,
      abandoned: summary.abandoned,
    },
    { scanned: 1, candidates: 1, userWrites: 0, assistantWrites: 0, abandoned: 0 },
  );
});
