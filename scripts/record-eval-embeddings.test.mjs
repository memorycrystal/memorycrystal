import assert from "node:assert/strict";
import { test } from "node:test";
import { runRecorder } from "./record-eval-embeddings.mjs";

test("prints the text count before any provider call and reads only the supplied key", async () => {
  const logs = [];
  let fetched = 0;
  await assert.rejects(
    () => runRecorder({
      texts: ["one", "one", "two"],
      model: "google/gemini-embedding-2-preview",
      builderVersion: "recall-v2-r1-v1",
      key: "",
      log: (line) => logs.push(line),
      fetch: async () => {
        fetched += 1;
        return new Response("{}", { status: 200 });
      },
      embeddingFixtureKey: async (model, version, text) => `${model}|${version}|${text}`,
    }),
    /OPENROUTER_API_KEY/,
  );
  assert.equal(fetched, 0);
  assert.match(logs[0], /2 texts/);

  const seen = [];
  const fixture = await runRecorder({
    texts: ["alpha"],
    model: "google/gemini-embedding-2-preview",
    builderVersion: "recall-v2-r1-v1",
    key: "sk-or-v1-test-only",
    log: (line) => seen.push(line),
    fetch: async (_url, init) => {
      assert.match(seen[0], /1 texts/);
      assert.match(init.headers.authorization, /sk-or-v1-test-only/);
      return Response.json({ data: [{ embedding: [1, 2, 3, 4] }] });
    },
    embeddingFixtureKey: async (model, version, text) => `${model}|${version}|${text}`,
  });
  assert.equal(typeof fixture.vectors["google/gemini-embedding-2-preview|recall-v2-r1-v1|alpha"], "string");
});

test("CLI entry point loads the production builders and counts texts before refusing without a key", async () => {
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const script = fileURLToPath(new URL("./record-eval-embeddings.mjs", import.meta.url));
  const env = { ...process.env };
  delete env.OPENROUTER_API_KEY;
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", script],
    { env, encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout, /record-eval-embeddings: \d+ texts in \d+ requests/);
  assert.match(result.stderr, /OPENROUTER_API_KEY is required/);
});
