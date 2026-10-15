#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const defaultFixturePath = resolve(repoRoot, "fixtures", "crystal-memories.json");
const embeddingDimensions = 3072;

const insertFixtureRef = makeFunctionReference<"mutation">("crystal/seed:insertFixture");
const embedFixtureContentRef = makeFunctionReference<"action">("crystal/seed:embedFixtureContent");
const vectorDivergenceCanaryRef = makeFunctionReference<"action">("crystal/seed:vectorDivergenceCanary");
const seedStatusRef = makeFunctionReference<"query">("crystal/seed:seedStatus");

type Embedding = number[] | "REGENERATE";

type SeedMemory = {
  key: string;
  title: string;
  content: string;
  embedding: Embedding;
};

type SeedFixture = {
  fixtureVersion: string;
  userId?: string;
  channel?: string;
  memories: SeedMemory[];
  [key: string]: unknown;
};

type Options = {
  fixturePath: string;
  convexUrl: string;
  adminKey?: string;
  dryRun: boolean;
  replaceExisting: boolean;
  skipCanary: boolean;
  fromCloud: boolean;
  help: boolean;
};

function usage() {
  return `Usage: npx tsx scripts/convex-local-seed.ts [options]

Seeds a local/self-hosted Convex deployment with deterministic Memory Crystal fixtures.

Options:
  --fixture <path>      Fixture JSON path (default: fixtures/crystal-memories.json)
  --convex-url <url>    Convex RPC URL (default: CONVEX_URL, CONVEX_SELF_HOSTED_URL, or http://127.0.0.1:3210)
  --admin-key <key>     Self-hosted admin key (default: CONVEX_SELF_HOSTED_ADMIN_KEY)
  --dry-run            Validate and print the planned seed without writing
  --no-replace         Do not clear the dedicated local seed user before inserting
  --skip-canary        Skip vector canary after inserting fixtures
  --from-cloud         Reserved for manual sanitized snapshot seeding; not part of default fixture mode
  -h, --help           Show help
`;
}

function readValue(argv: string[], index: number, name: string) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function parseArgs(argv = process.argv.slice(2)): Options {
  const options: Options = {
    fixturePath: defaultFixturePath,
    convexUrl: process.env.CONVEX_URL || process.env.CONVEX_SELF_HOSTED_URL || "http://127.0.0.1:3210",
    adminKey: process.env.CONVEX_SELF_HOSTED_ADMIN_KEY,
    dryRun: false,
    replaceExisting: true,
    skipCanary: false,
    fromCloud: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--fixture") {
      options.fixturePath = resolve(readValue(argv, index, arg));
      index += 1;
    } else if (arg === "--convex-url") {
      options.convexUrl = readValue(argv, index, arg);
      index += 1;
    } else if (arg === "--admin-key") {
      options.adminKey = readValue(argv, index, arg);
      index += 1;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--no-replace") {
      options.replaceExisting = false;
    } else if (arg === "--skip-canary") {
      options.skipCanary = true;
    } else if (arg === "--from-cloud") {
      options.fromCloud = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function loadFixture(fixturePath: string): SeedFixture {
  if (!existsSync(fixturePath)) throw new Error(`Fixture file not found: ${fixturePath}`);
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as SeedFixture;
  validateFixture(fixture);
  return fixture;
}

function validateFixture(fixture: SeedFixture) {
  if (!fixture.fixtureVersion) throw new Error("Fixture is missing fixtureVersion");
  if (!Array.isArray(fixture.memories) || fixture.memories.length === 0) {
    throw new Error("Fixture must include at least one memory");
  }
  const keys = new Set<string>();
  for (const memory of fixture.memories) {
    if (!memory.key || keys.has(memory.key)) throw new Error(`Duplicate or missing memory key: ${memory.key}`);
    keys.add(memory.key);
    if (!memory.title?.trim() || !memory.content?.trim()) {
      throw new Error(`Fixture memory ${memory.key} must include title and content`);
    }
    if (memory.embedding === "REGENERATE") continue;
    if (!Array.isArray(memory.embedding)) throw new Error(`Fixture memory ${memory.key} has invalid embedding`);
    if (memory.embedding.length !== embeddingDimensions) {
      throw new Error(`Fixture memory ${memory.key} embedding has ${memory.embedding.length} dimensions; expected ${embeddingDimensions}`);
    }
    if (!memory.embedding.every((value) => Number.isFinite(value))) {
      throw new Error(`Fixture memory ${memory.key} embedding contains non-finite values`);
    }
  }
}

async function fillRegeneratedEmbeddings(client: ConvexHttpClient, fixture: SeedFixture) {
  let regenerated = 0;
  for (const memory of fixture.memories) {
    if (memory.embedding !== "REGENERATE") continue;
    memory.embedding = await client.action(embedFixtureContentRef, { content: `${memory.title}\n\n${memory.content}` }) as number[];
    regenerated += 1;
  }
  validateFixture(fixture);
  return regenerated;
}

function pickCanaryMemory(fixture: SeedFixture) {
  const byTag = fixture.memories.find((memory) => /memory crystal onboarding/i.test(`${memory.title}\n${memory.content}`));
  return byTag ?? fixture.memories[0];
}

async function run(options: Options) {
  if (options.fromCloud) {
    throw new Error(
      "--from-cloud sanitized snapshot seeding is intentionally not automated in the default local seed path. " +
      "Use fixture mode, or implement the manual export/sanitize/import flow with an explicit confirmation gate."
    );
  }

  const fixture = loadFixture(options.fixturePath);
  const regenerateCount = fixture.memories.filter((memory) => memory.embedding === "REGENERATE").length;
  if (options.dryRun) {
    return {
      mode: "dry-run",
      fixturePath: options.fixturePath,
      convexUrl: options.convexUrl,
      fixtureVersion: fixture.fixtureVersion,
      userId: fixture.userId,
      channel: fixture.channel,
      memories: fixture.memories.length,
      regenerateCount,
    };
  }

  const client = new ConvexHttpClient(options.convexUrl);
  if (options.adminKey) (client as any).setAdminAuth(options.adminKey);

  const regenerated = await fillRegeneratedEmbeddings(client, fixture);
  const insertResult = await client.mutation(insertFixtureRef, {
    fixture,
    replaceExisting: options.replaceExisting,
  });
  const status = await client.query(seedStatusRef, {
    userId: fixture.userId,
    channel: fixture.channel,
  });

  let canary = null;
  if (!options.skipCanary) {
    const canaryMemory = pickCanaryMemory(fixture);
    canary = await client.action(vectorDivergenceCanaryRef, {
      embedding: canaryMemory.embedding,
      query: "memory crystal onboarding",
      userId: fixture.userId,
      channel: fixture.channel,
      minScore: 0.6,
    });
    if (!(canary as { ok?: boolean }).ok) {
      throw new Error(`Vector canary failed: ${JSON.stringify(canary)}`);
    }
  }

  return {
    mode: "seeded",
    fixturePath: options.fixturePath,
    convexUrl: options.convexUrl,
    regenerated,
    insertResult,
    status,
    canary,
  };
}

async function main() {
  const options = parseArgs();
  if (options.help) {
    console.log(usage());
    return;
  }
  const result = await run(options);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

export { loadFixture, parseArgs, run, validateFixture };
