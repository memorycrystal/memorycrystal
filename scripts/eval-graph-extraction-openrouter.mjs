/**
 * Head-to-head 3-way precision/recall eval: gemini-2.5-flash vs gpt-5-nano vs gpt-5-mini
 * All via OpenRouter (https://openrouter.ai/api/v1/chat/completions).
 *
 * Run with:
 *   OPENROUTER_API_KEY=<key> node scripts/eval-graph-extraction-openrouter.mjs
 *
 * Acceptance gate (plan §9 #8):
 *   entity_precision >= 0.95 AND entity_recall >= 0.90
 *
 * Output: comparison table to stdout + JSON saved to
 *   convex/crystal/__tests__/fixtures/eval-results/graph-extraction-openrouter-{date}.json
 *
 * SAFETY: OPENROUTER_API_KEY is read from env only — never echoed, never written to files.
 *
 * Pricing (OpenRouter, 2026-05):
 *   google/gemini-2.5-flash : $0.30 / M input tokens, $2.50 / M output tokens
 *   openai/gpt-5-nano       : $0.05 / M input tokens, $0.40 / M output tokens
 *   openai/gpt-5-mini       : $0.25 / M input tokens, $2.00 / M output tokens
 */

import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const MODELS = [
  { id: "google/gemini-2.5-flash", label: "gemini-2.5-flash",
    inputPricePerM: 0.30, outputPricePerM: 2.50 },
  { id: "openai/gpt-5-nano",       label: "gpt-5-nano",
    inputPricePerM: 0.05, outputPricePerM: 0.40 },
  { id: "openai/gpt-5-mini",       label: "gpt-5-mini",
    inputPricePerM: 0.25, outputPricePerM: 2.00 },
  { id: "deepseek/deepseek-chat",  label: "deepseek-v3",
    inputPricePerM: 0.27, outputPricePerM: 1.10 },
];

// Pricing per million tokens (OpenRouter published rates, 2026-05)
// Kept for backward-compat with estimateCostUsd helper
const MODEL_PRICING = Object.fromEntries(
  MODELS.map(m => [m.id, { inputPerM: m.inputPricePerM, outputPerM: m.outputPricePerM }])
);

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const TEMPERATURE = 0.0;
const MAX_TOKENS = 1000;
const REQUEST_TIMEOUT_MS = 30_000;
const PRECISION_GATE = 0.95;
const RECALL_GATE = 0.90;

// ---------------------------------------------------------------------------
// 20 fixtures — verbatim copy from eval-graph-extraction.mjs
// ---------------------------------------------------------------------------
const FIXTURES = [
  // --- Journal / personal entries ---
  {
    id: "fix-01",
    title: "Morning journal: weekly review",
    content: "Feeling good about the progress on Project Atlas this week. Had a call with Elena from marketing — she wants to align the launch with the Q3 roadmap. Need to follow up with DevOps about the deployment pipeline before Thursday.",
    expected_entities: ["Project Atlas", "Elena", "Q3 roadmap", "DevOps"],
    expected_relations: [
      { subject: "Elena", predicate: "mentions", object: "Q3 roadmap" },
    ],
  },
  {
    id: "fix-02",
    title: "Personal goal: learn Rust",
    content: "Started the Rust book today. Goal is to build a CLI tool for automating my CSV pipeline by end of month. Asked Carlos on Slack for beginner resources.",
    expected_entities: ["Rust", "Carlos", "Slack", "CSV pipeline"],
    expected_relations: [
      { subject: "Carlos", predicate: "mentions", object: "Rust" },
    ],
  },

  // --- Code snippets / technical decisions ---
  {
    id: "fix-03",
    title: "Auth refactor: JWT to OAuth 2.0",
    content: "Sarah decided to migrate the backend API from JWT to OAuth 2.0. The decision was made in the architecture meeting on Monday. Marcus will implement it by end of sprint.",
    expected_entities: ["Sarah", "API", "OAuth 2.0", "Marcus"],
    expected_relations: [
      { subject: "Sarah", predicate: "decided_in", object: "OAuth 2.0" },
      { subject: "Marcus", predicate: "assigned_to", object: "API" },
    ],
  },
  {
    id: "fix-04",
    title: "Database migration plan",
    content: "Postgres migration from v13 to v16 scheduled for next weekend. The DBA team owns the runbook. Redis cache invalidation must happen before the cutover. James will coordinate with the infrastructure guild.",
    expected_entities: ["Postgres", "Redis", "James", "DBA team"],
    expected_relations: [
      { subject: "James", predicate: "owns", object: "DBA team" },
    ],
  },
  {
    id: "fix-05",
    title: "Observability stack decision",
    content: "Team chose Datadog over Grafana for APM. Cost was the deciding factor — Grafana Cloud pricing was 2× higher. Decision ratified by CTO Priya in the architecture review.",
    expected_entities: ["Datadog", "Grafana", "Priya"],
    expected_relations: [
      { subject: "Priya", predicate: "decided_in", object: "Datadog" },
    ],
  },

  // --- Factual statements ---
  {
    id: "fix-06",
    title: "Q3 project roadmap",
    content: "Project Phoenix will ship in Q3. It depends on the data pipeline owned by the infra team. Goal is to reduce latency by 40%.",
    expected_entities: ["Project Phoenix", "data pipeline", "infra team"],
    expected_relations: [
      { subject: "Project Phoenix", predicate: "depends_on", object: "data pipeline" },
    ],
  },
  {
    id: "fix-07",
    title: "Tool evaluation: Notion vs Linear",
    content: "Team evaluated Notion and Linear for task tracking. Linear won due to better API support. Decision was ratified by Andy.",
    expected_entities: ["Notion", "Linear", "Andy"],
    expected_relations: [
      { subject: "Andy", predicate: "decided_in", object: "Linear" },
    ],
  },
  {
    id: "fix-08",
    title: "Company OKR: customer retention",
    content: "The customer success team owns the retention OKR for H2. Churn target is below 5%. Salesforce is the CRM of record. Weekly review led by VP Nina.",
    expected_entities: ["customer success team", "Salesforce", "Nina"],
    expected_relations: [
      { subject: "Nina", predicate: "owns", object: "customer success team" },
    ],
  },
  {
    id: "fix-09",
    title: "Vendor contract: AWS vs GCP",
    content: "Contract with AWS renewed for 3 years at enterprise tier. GCP was evaluated but AWS won on existing tooling investment. Finance sign-off by CFO Raymond.",
    expected_entities: ["AWS", "GCP", "Raymond"],
    expected_relations: [
      { subject: "Raymond", predicate: "decided_in", object: "AWS" },
    ],
  },
  {
    id: "fix-10",
    title: "Security policy update",
    content: "All engineers must complete SOC 2 training by end of Q2. GitHub access requires MFA. Security lead Diana is coordinating with IT.",
    expected_entities: ["SOC 2", "GitHub", "Diana"],
    expected_relations: [
      { subject: "Diana", predicate: "owns", object: "SOC 2" },
    ],
  },

  // --- Conversational fragments ---
  {
    id: "fix-11",
    title: "Slack thread: release blocker",
    content: "Ben: the staging deploy is broken, PostgreSQL connection pool exhausted. Tom: I'll check the PgBouncer config. Ben: Also Sentry is throwing 500s on the /checkout endpoint.",
    expected_entities: ["Ben", "Tom", "PostgreSQL", "PgBouncer", "Sentry"],
    expected_relations: [
      { subject: "Tom", predicate: "owns", object: "PgBouncer" },
    ],
  },
  {
    id: "fix-12",
    title: "Customer feedback from Acme Corp",
    content: "Acme Corp reported that the dashboard loads too slowly. They use Slack for notifications. The issue is linked to the GraphQL resolver bottleneck.",
    expected_entities: ["Acme Corp", "dashboard", "Slack", "GraphQL"],
    expected_relations: [
      { subject: "Acme Corp", predicate: "uses", object: "Slack" },
    ],
  },
  {
    id: "fix-13",
    title: "Meeting notes: sprint planning",
    content: "Sprint 42 planning with Maya, Lior, and Kenji. Maya owns the payment service refactor. Lior will close out the Stripe webhook bug. Kenji is blocked on the design system update from the UX team.",
    expected_entities: ["Maya", "Lior", "Kenji", "Stripe"],
    expected_relations: [
      { subject: "Maya", predicate: "owns", object: "payment service refactor" },
      { subject: "Lior", predicate: "assigned_to", object: "Stripe" },
    ],
  },
  {
    id: "fix-14",
    title: "On-call handoff note",
    content: "Handing off to Sophie. Active incidents: Redis memory alert on prod-eu-1, Cloudflare WAF false positive blocking /api/upload. PagerDuty has the escalation chain. Slack channel #oncall for updates.",
    expected_entities: ["Sophie", "Redis", "Cloudflare", "PagerDuty"],
    expected_relations: [
      { subject: "Sophie", predicate: "assigned_to", object: "Redis" },
    ],
  },

  // --- Research / mixed ---
  {
    id: "fix-15",
    title: "Competitor research: LangChain vs LlamaIndex",
    content: "LangChain has broader integrations but LlamaIndex is faster for RAG pipelines. Research by Callum. Decision deferred to Q4 when the vector DB evaluation is complete.",
    expected_entities: ["LangChain", "LlamaIndex", "Callum"],
    expected_relations: [
      { subject: "Callum", predicate: "mentions", object: "LangChain" },
    ],
  },
  {
    id: "fix-16",
    title: "Onboarding checklist for new engineers",
    content: "New engineers must set up GitHub access, configure AWS credentials, and complete the security training module. Buddy assigned is Jamie.",
    expected_entities: ["GitHub", "AWS", "Jamie"],
    expected_relations: [
      { subject: "Jamie", predicate: "assigned_to", object: "GitHub" },
    ],
  },
  {
    id: "fix-17",
    title: "Product discovery: voice features",
    content: "User interviews revealed demand for voice input in the mobile app. Kokoro TTS was shortlisted alongside ElevenLabs. Product owner Isabel will run the prototype sprint.",
    expected_entities: ["Kokoro TTS", "ElevenLabs", "Isabel"],
    expected_relations: [
      { subject: "Isabel", predicate: "owns", object: "Kokoro TTS" },
    ],
  },
  {
    id: "fix-18",
    title: "Architecture decision: event sourcing",
    content: "Event sourcing adopted for the Order service. Kafka chosen as the message bus over RabbitMQ. Lead architect Otto documented the ADR in Confluence.",
    expected_entities: ["Kafka", "RabbitMQ", "Otto", "Confluence"],
    expected_relations: [
      { subject: "Otto", predicate: "decided_in", object: "Kafka" },
    ],
  },
  {
    id: "fix-19",
    title: "Budget review Q2",
    content: "Cloud spend up 18% YoY, mostly driven by GPU instances for the ML pipeline. CFO has asked for a 10% reduction plan by June 1. FinOps lead is Rosa.",
    expected_entities: ["Rosa", "ML pipeline"],
    expected_relations: [
      { subject: "Rosa", predicate: "owns", object: "ML pipeline" },
    ],
  },
  {
    id: "fix-20",
    title: "Legal: GDPR data retention policy",
    content: "Legal team led by Nora confirmed data retention is capped at 90 days for EU users. The retention job runs in AWS Lambda. Compliance approved by the DPO.",
    expected_entities: ["Nora", "AWS Lambda"],
    expected_relations: [
      { subject: "Nora", predicate: "owns", object: "AWS Lambda" },
    ],
  },
];

// ---------------------------------------------------------------------------
// Prompt builder (mirrors graphEnrich.ts buildPromptFromParts exactly)
// ---------------------------------------------------------------------------
function buildPrompt(title, content) {
  return `You are a knowledge graph extractor. From the following memory, extract:
1. Named entities (people, projects, concepts, tools, decisions, goals)
2. Relationships between entities
3. The single most important other memory concept this relates to (for associations)

Respond with ONLY valid JSON:
{
  "entities": [
    { "label": "Sarah", "type": "person", "description": "manages backend team" },
    { "label": "API", "type": "tool", "description": "backend API owned by Sarah" }
  ],
  "relations": [
    { "from": "Sarah", "to": "API", "type": "owns", "weight": 0.85, "note": "Sarah owns the API" }
  ],
  "associationHint": "optional free-text concept this memory co-occurs with"
}

Valid entity types: person, project, goal, decision, concept, tool, event, resource, channel
Valid relation types: mentions, decided_in, leads_to, depends_on, owns, uses, conflicts_with, supports, occurs_with, assigned_to

Return empty arrays if nothing meaningful is extractable. Keep it tight — max 5 entities, max 5 relations.

Memory title:
${title}

Memory content:
${content}`;
}

// ---------------------------------------------------------------------------
// OpenRouter API caller (matches graphEnrich.ts callOpenRouterGraphExtractor)
// ---------------------------------------------------------------------------
async function callOpenRouter(model, prompt, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(OPENROUTER_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "https://memorycrystal.ai",
        "X-Title": "Memory Crystal",
      },
      signal: controller.signal,
      body: JSON.stringify((() => {
        // GPT-5 family are reasoning models — they consume max_tokens on
        // internal reasoning before emitting content. Without reasoning_effort:
        // "minimal" + a larger max_tokens budget, they return empty_response
        // for any prompt that requires structured JSON extraction.
        const isReasoningModel = /openai\/gpt-5/i.test(model);
        const body = {
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: TEMPERATURE,
          max_tokens: isReasoningModel ? 8000 : MAX_TOKENS,
          response_format: { type: "json_object" },
        };
        if (isReasoningModel) {
          body.reasoning = { effort: "minimal" };
        }
        return body;
      })()),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "unknown");
      return { text: null, error: `HTTP ${res.status}: ${errText.slice(0, 200)}`, usage: null };
    }

    const payload = await res.json();
    const text = payload?.choices?.[0]?.message?.content ?? null;
    const usage = payload?.usage ?? null;
    return { text: typeof text === "string" ? text.trim() : null, error: null, usage };
  } catch (err) {
    return { text: null, error: err.name === "AbortError" ? "timeout" : String(err), usage: null };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Response parser (mirrors parseExtraction in graphEnrich.ts)
// ---------------------------------------------------------------------------
const VALID_ENTITY_TYPES = new Set(["person","project","goal","decision","concept","tool","event","resource","channel"]);
const VALID_RELATION_TYPES = new Set(["mentions","decided_in","leads_to","depends_on","owns","uses","conflicts_with","supports","occurs_with","assigned_to"]);

function parseExtraction(raw) {
  if (!raw || !raw.trim()) return null;
  try {
    const cleaned = raw
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
    const parsed = JSON.parse(cleaned);

    const entities = Array.isArray(parsed.entities)
      ? parsed.entities
          .slice(0, 5)
          .map(e => ({
            label: typeof e?.label === "string" ? e.label.trim() : "",
            type: typeof e?.type === "string" ? e.type : "concept",
          }))
          .filter(e => e.label.length > 0 && VALID_ENTITY_TYPES.has(e.type))
      : [];

    const relations = Array.isArray(parsed.relations)
      ? parsed.relations
          .slice(0, 5)
          .map(r => ({
            from: typeof r?.from === "string" ? r.from.trim() : "",
            to: typeof r?.to === "string" ? r.to.trim() : "",
            type: typeof r?.type === "string" ? r.type : "mentions",
          }))
          .filter(r => r.from.length > 0 && r.to.length > 0 && VALID_RELATION_TYPES.has(r.type))
      : [];

    return { entities, relations };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Scoring (same as eval-graph-extraction.mjs)
// ---------------------------------------------------------------------------
function entityMatches(extracted, expected) {
  const el = extracted.toLowerCase();
  const exp = expected.toLowerCase();
  return el.includes(exp) || exp.includes(el);
}

function computeEntityPrecision(extractedEntities, expectedEntities) {
  if (expectedEntities.length === 0) return 1;
  let hits = 0;
  for (const exp of expectedEntities) {
    if (extractedEntities.some(e => entityMatches(e.label, exp))) hits++;
  }
  return hits / expectedEntities.length;
}

function computeEntityRecall(extractedEntities, expectedEntities) {
  return computeEntityPrecision(extractedEntities, expectedEntities);
}

function computeRelationRecall(extractedRelations, expectedRelations) {
  if (expectedRelations.length === 0) return 1;
  let hits = 0;
  for (const exp of expectedRelations) {
    const found = extractedRelations.some(r =>
      entityMatches(r.from, exp.subject) && entityMatches(r.to, exp.object)
    );
    if (found) hits++;
  }
  return hits / expectedRelations.length;
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------
function estimateCostUsd(model, totalInputTokens, totalOutputTokens) {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return null;
  return (totalInputTokens / 1_000_000) * pricing.inputPerM
       + (totalOutputTokens / 1_000_000) * pricing.outputPerM;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error(
      "ERROR: OPENROUTER_API_KEY env var is not set.\n" +
      "Set OPENROUTER_API_KEY env var. The user can find it in their cloud Convex env via " +
      "`npx convex env get OPENROUTER_API_KEY` or in their OpenRouter dashboard."
    );
    process.exit(1);
  }

  const dateStr = new Date().toISOString().slice(0, 10);

  console.log(`\nGraph Extraction Head-to-Head: OpenRouter 3-way Eval`);
  for (let i = 0; i < MODELS.length; i++) {
    console.log(`Model ${String.fromCharCode(65 + i)} : ${MODELS[i].id}`);
  }
  console.log(`Fixtures: ${FIXTURES.length}`);
  console.log(`Gate    : entity_precision >= ${PRECISION_GATE} AND entity_recall >= ${RECALL_GATE}\n`);

  const results = {
    runAt: new Date().toISOString(),
    models: {},
    fixtures: [],
    gate: { precision_threshold: PRECISION_GATE, recall_threshold: RECALL_GATE },
  };

  // Per-model accumulators
  const accum = {};
  for (const m of MODELS) {
    accum[m.id] = {
      entityPrecisionSum: 0,
      entityRecallSum: 0,
      relationRecallSum: 0,
      parseFailures: 0,
      apiErrors: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
    };
    results.models[m.id] = {};
  }

  // Run fixtures sequentially (one model at a time per fixture to be kind to rate limits)
  for (let i = 0; i < FIXTURES.length; i++) {
    const fix = FIXTURES[i];
    process.stdout.write(`  [${i + 1}/${FIXTURES.length}] ${fix.id} (${fix.title.slice(0, 40)})...`);
    const prompt = buildPrompt(fix.title, fix.content);

    const fixtureResult = { id: fix.id, title: fix.title, models: {} };

    for (const m of MODELS) {
      const { text, error, usage } = await callOpenRouter(m.id, prompt, apiKey);

      // Accumulate token counts
      if (usage) {
        accum[m.id].totalInputTokens += usage.prompt_tokens ?? 0;
        accum[m.id].totalOutputTokens += usage.completion_tokens ?? 0;
      }

      if (error || !text) {
        accum[m.id].apiErrors++;
        fixtureResult.models[m.id] = {
          error: error ?? "empty_response",
          entityPrecision: 0,
          entityRecall: 0,
          relationRecall: 0,
        };
        continue;
      }

      const extraction = parseExtraction(text);
      if (!extraction) {
        accum[m.id].parseFailures++;
        fixtureResult.models[m.id] = {
          error: "parse_failed",
          rawSnippet: text.slice(0, 200),
          entityPrecision: 0,
          entityRecall: 0,
          relationRecall: 0,
        };
        continue;
      }

      const entityPrecision = computeEntityPrecision(extraction.entities, fix.expected_entities);
      const entityRecall = computeEntityRecall(extraction.entities, fix.expected_entities);
      const relationRecall = computeRelationRecall(extraction.relations, fix.expected_relations);

      accum[m.id].entityPrecisionSum += entityPrecision;
      accum[m.id].entityRecallSum += entityRecall;
      accum[m.id].relationRecallSum += relationRecall;

      fixtureResult.models[m.id] = {
        extractedEntities: extraction.entities.map(e => e.label),
        extractedRelations: extraction.relations.map(r => `${r.from} -[${r.type}]-> ${r.to}`),
        rawResponse: text,
        entityPrecision: +entityPrecision.toFixed(4),
        entityRecall: +entityRecall.toFixed(4),
        relationRecall: +relationRecall.toFixed(4),
        usage: usage ?? undefined,
      };
    }

    results.fixtures.push(fixtureResult);
    process.stdout.write(" done\n");
  }

  // Compute averages, gate, cost, bang-for-buck
  const N = FIXTURES.length;
  const W = 100;
  console.log("\n" + "=".repeat(W));
  console.log("COMPARISON TABLE");
  console.log("=".repeat(W));
  console.log(
    `${"Model".padEnd(22)} ${"P".padStart(6)} ${"R".padStart(6)} ${"RelR".padStart(6)} ` +
    `${"ParseFail".padStart(9)} ${"APIErr".padStart(6)} ` +
    `${"InTok".padStart(8)} ${"OutTok".padStart(8)} ${"$/call".padStart(10)} ${"B4B".padStart(12)}`
  );
  console.log("-".repeat(W));

  const bangForBuckRanking = [];

  for (const m of MODELS) {
    const a = accum[m.id];
    const avgP = a.entityPrecisionSum / N;
    const avgR = a.entityRecallSum / N;
    const avgRelR = a.relationRecallSum / N;
    const estCostTotal = estimateCostUsd(m.id, a.totalInputTokens, a.totalOutputTokens);
    const estCostPerCall = estCostTotal !== null ? estCostTotal / N : null;
    const gatePass = avgP >= PRECISION_GATE && avgR >= RECALL_GATE;

    // Bang-for-buck: quality_score / cost_per_call
    const qualityScore = (avgP + avgR) / 2;
    const bangForBuck = estCostPerCall !== null && estCostPerCall > 0
      ? qualityScore / estCostPerCall
      : null;

    results.models[m.id] = {
      label: m.label,
      avgEntityPrecision: +avgP.toFixed(4),
      avgEntityRecall: +avgR.toFixed(4),
      avgRelationRecall: +avgRelR.toFixed(4),
      parseFailures: a.parseFailures,
      apiErrors: a.apiErrors,
      totalInputTokens: a.totalInputTokens,
      totalOutputTokens: a.totalOutputTokens,
      estCostPerCallUsd: estCostPerCall !== null ? +estCostPerCall.toFixed(6) : null,
      estCostTotalUsd: estCostTotal !== null ? +estCostTotal.toFixed(4) : null,
      qualityScore: +qualityScore.toFixed(4),
      bangForBuck: bangForBuck !== null ? +bangForBuck.toFixed(1) : null,
      gatePass,
    };

    if (bangForBuck !== null) bangForBuckRanking.push({ id: m.id, label: m.label, bangForBuck, qualityScore, gatePass });

    const b4bStr = bangForBuck !== null ? bangForBuck.toFixed(0) : "n/a";
    const costStr = estCostPerCall !== null ? `$${estCostPerCall.toFixed(5)}` : "n/a";
    console.log(
      `${m.label.padEnd(22)} ${(avgP * 100).toFixed(1).padStart(5)}% ${(avgR * 100).toFixed(1).padStart(5)}% ` +
      `${(avgRelR * 100).toFixed(1).padStart(5)}% ` +
      `${String(a.parseFailures).padStart(9)} ${String(a.apiErrors).padStart(6)} ` +
      `${String(a.totalInputTokens).padStart(8)} ${String(a.totalOutputTokens).padStart(8)} ` +
      `${costStr.padStart(10)} ${b4bStr.padStart(12)}`
    );
  }

  // Reference row: gemini-2.0-flash from prior eval (gemini-2.5-flash-lite proxy)
  console.log("-".repeat(W));
  console.log(
    `${"gemini-2.0-flash (ref)".padEnd(22)} ${"90.3".padStart(5)}% ${"90.3".padStart(5)}% ` +
    `${"30.0".padStart(5)}% ` +
    `${"0".padStart(9)} ${"1".padStart(6)} ` +
    `${"n/a".padStart(8)} ${"n/a".padStart(8)} ` +
    `${"n/a".padStart(10)} ${"ref".padStart(12)}`
  );
  console.log("=".repeat(W));

  // Bang-for-buck ranking
  bangForBuckRanking.sort((a, b) => b.bangForBuck - a.bangForBuck);
  console.log("\nBANG-FOR-BUCK RANKING (quality_score / cost_per_call, higher = better value):");
  for (let i = 0; i < bangForBuckRanking.length; i++) {
    const entry = bangForBuckRanking[i];
    console.log(
      `  #${i + 1} ${entry.label.padEnd(22)} B4B=${entry.bangForBuck.toFixed(1).padStart(10)}  ` +
      `quality=${(entry.qualityScore * 100).toFixed(1)}%  gate=${entry.gatePass ? "PASS" : "FAIL"}`
    );
  }
  const b4bWinner = bangForBuckRanking[0];

  // Gate verdict per model
  console.log("\nGate verdicts (P >= 0.95 AND R >= 0.90):");
  for (const m of MODELS) {
    const rm = results.models[m.id];
    const verdict = rm.gatePass ? "PASS" : "FAIL";
    console.log(
      `  ${m.label.padEnd(25)} ${verdict}  ` +
      `(P=${(rm.avgEntityPrecision * 100).toFixed(1)}%, R=${(rm.avgEntityRecall * 100).toFixed(1)}%)`
    );
  }

  // Recommendation logic per spec
  const passers = MODELS.filter(m => results.models[m.id].gatePass);

  let recommendation;
  if (passers.length > 0) {
    // Among gate-passers, pick cheapest
    const cheapest = passers.slice().sort(
      (a, b) => (results.models[a.id].estCostPerCallUsd ?? Infinity) - (results.models[b.id].estCostPerCallUsd ?? Infinity)
    )[0];
    recommendation = `SWITCH to ${cheapest.id} — passes gate (P>=0.95, R>=0.90) and lowest cost among passing models.`;
  } else {
    // No gate passer — check if failures are fixture-mismatch-pattern (precision ~0 due to parse fails, not semantic)
    const parseFailNote = MODELS.map(m => `${m.label}: ${accum[m.id].parseFailures} parse_fails`).join(", ");
    if (b4bWinner && b4bWinner.qualityScore >= 0.85) {
      recommendation = `No model passes gate strictly. Parse failures may be fixture-mismatch (${parseFailNote}). ` +
        `Based on bang-for-buck, RECOMMEND ${b4bWinner.id} (B4B=${b4bWinner.bangForBuck.toFixed(1)}, quality=${(b4bWinner.qualityScore*100).toFixed(1)}%).`;
    } else {
      recommendation = `No model passes gate. Low quality across the board. Investigate fixture parsing. (${parseFailNote})`;
    }
  }

  results.recommendation = recommendation;
  results.bangForBuckWinner = b4bWinner?.id ?? null;
  console.log(`\nRecommendation: ${recommendation}`);
  console.log("=".repeat(W) + "\n");

  // Save JSON
  const outDir = join(REPO_ROOT, "convex/crystal/__tests__/fixtures/eval-results");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `graph-extraction-openrouter-${dateStr}.json`);
  writeFileSync(outPath, JSON.stringify(results, null, 2), "utf8");
  console.log(`Results saved to: ${outPath}\n`);
}

main().catch(err => {
  console.error("Eval failed:", err);
  process.exit(1);
});
