#!/usr/bin/env node
/**
 * Record production-input embeddings for the recall v2 gold set.
 * Reads OPENROUTER_API_KEY from the environment. Prints the text count
 * before any provider call. Does not log the key or the input text.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { register } from "node:module";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BATCH = 32;
const OUTPUT = path.join(repoRoot, "convex/crystal/eval/recorded-embeddings.json");

export function collectRecordingTexts(legacy, gold, cases, buildMemoryEmbeddingInput, buildRecallQueryEmbeddingInput) {
  const texts = [];
  for (const item of [...legacy.corpus, ...gold.corpus]) texts.push(buildMemoryEmbeddingInput(item));
  for (const knowledgeBase of gold.knowledgeBases ?? []) {
    for (const chunk of knowledgeBase.chunks) {
      texts.push(buildMemoryEmbeddingInput({ content: chunk.content }));
    }
  }
  for (const testCase of cases) texts.push(buildRecallQueryEmbeddingInput(testCase.query));
  return texts;
}

export function encodeFloat32(vector) {
  const bytes = new Uint8Array(new Float32Array(vector).buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export async function runRecorder({ texts, model, builderVersion, key, fetch: doFetch, embeddingFixtureKey, log = console.log }) {
  const unique = [...new Set(texts)];
  const requests = Math.ceil(unique.length / BATCH);
  log(`record-eval-embeddings: ${unique.length} texts in ${requests} requests will be embedded before any provider call`);
  if (!key) throw new Error("OPENROUTER_API_KEY is required");
  const vectors = {};
  for (let index = 0; index < unique.length; index += BATCH) {
    const batch = unique.slice(index, index + BATCH);
    const response = await doFetch("https://openrouter.ai/api/v1/embeddings", {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model, input: batch }),
    });
    if (!response.ok) {
      throw new Error(`OpenRouter embeddings failed with HTTP ${response.status}`);
    }
    const payload = await response.json();
    const data = Array.isArray(payload?.data) ? payload.data : [];
    if (data.length !== batch.length) {
      throw new Error(`OpenRouter embeddings returned ${data.length} vectors for ${batch.length} texts`);
    }
    for (let item = 0; item < batch.length; item += 1) {
      const embedding = data[item]?.embedding;
      if (!Array.isArray(embedding)) throw new Error("OpenRouter embeddings response missing a vector");
      vectors[await embeddingFixtureKey(model, builderVersion, batch[item])] = encodeFloat32(embedding);
    }
  }
  return { model, builderVersion, vectors };
}

async function main() {
  await register(new URL("./lib/ts-extension-resolve.mjs", import.meta.url));
  const builders = await import("../convex/crystal/embeddingInput.ts");
  const legacy = JSON.parse(readFileSync(path.join(repoRoot, "convex/crystal/eval/goldset.json"), "utf8"));
  const gold = JSON.parse(readFileSync(path.join(repoRoot, "convex/crystal/eval/goldset-v2.json"), "utf8"));
  const cases = [
    ...legacy.cases.map((testCase) => ({ query: testCase.query })),
    ...gold.cases,
  ];
  const texts = collectRecordingTexts(
    legacy,
    gold,
    cases,
    builders.buildMemoryEmbeddingInput,
    builders.buildRecallQueryEmbeddingInput,
  );
  const fixture = await runRecorder({
    texts,
    model: builders.EVAL_RECORDING_MODEL,
    builderVersion: builders.EMBEDDING_INPUT_BUILDER_VERSION,
    key: process.env.OPENROUTER_API_KEY,
    fetch: globalThis.fetch,
    embeddingFixtureKey: builders.embeddingFixtureKey,
  });
  writeFileSync(OUTPUT, `${JSON.stringify(fixture)}\n`);
  process.stdout.write(`wrote ${OUTPUT} (${Object.keys(fixture.vectors).length} vectors)\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "record-eval-embeddings failed"}\n`);
    process.exit(1);
  });
}
