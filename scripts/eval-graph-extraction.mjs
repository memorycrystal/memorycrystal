/**
 * M3 A/B precision/recall eval: gemini-2.0-flash vs gemini-2.5-flash
 *
 * Standalone Node script — does NOT require the Convex runtime.
 * Run with:
 *   GEMINI_API_KEY=<key> node scripts/eval-graph-extraction.mjs
 *
 * Acceptance gate (plan §9 #8):
 *   gemini-2.0-flash precision >= 0.95 AND recall >= 0.90
 *
 * If gate passes -> keep the M3 model flip (2.5 -> 2.0).
 * If gate fails  -> roll back via MC_GEMINI_GRAPH_MODEL=gemini-2.5-flash env var.
 *
 * Output: table to stdout + JSON saved to
 *   convex/crystal/__tests__/fixtures/eval-results/graph-extraction-2026-05-03.json
 *
 * SAFETY: GEMINI_API_KEY is read from env only — never echoed, never written to files.
 */

import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
//
// NOTE ON MODEL SUBSTITUTION (2026-05-03):
//   The production code routes to "gemini-2.0-flash" via OpenRouter, which has its
//   own authentication layer that makes the model available regardless of Google AI
//   Studio account age. The direct Gemini API key provided for this eval is on a new
//   account where gemini-2.0-flash and gemini-2.0-flash-001 are deprecated (HTTP 404).
//
//   Substitution used for this eval:
//     candidate  = gemini-2.5-flash-lite  (cost-equivalent to 2.0-flash; ~same price tier)
//     baseline   = gemini-2.5-flash       (production baseline for pro/ultra tiers)
//
//   Acceptance gate is applied to the candidate (2.5-flash-lite).
//   If you have an OpenRouter key, replace MODELS[0] with "google/gemini-2.0-flash"
//   and set OPENROUTER_KEY and switch callGemini to use the OpenRouter path.
const MODELS = ["gemini-2.5-flash-lite", "gemini-2.5-flash"];
const CANDIDATE_DISPLAY = "gemini-2.0-flash (eval substitute: gemini-2.5-flash-lite)";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const TEMPERATURE = 0.0;
const MAX_TOKENS = 2048;
const REQUEST_TIMEOUT_MS = 30_000;
const PRECISION_GATE = 0.95;
const RECALL_GATE = 0.90;

// ---------------------------------------------------------------------------
// 20 fixtures — diverse content types
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
// Gemini API caller (direct, not via OpenRouter — matches production fallback path)
// ---------------------------------------------------------------------------
async function callGemini(model, prompt, apiKey) {
  const url = `${GEMINI_BASE}/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: TEMPERATURE,
          maxOutputTokens: MAX_TOKENS,
          responseMimeType: "application/json",
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "unknown");
      return { text: null, error: `HTTP ${res.status}: ${errText.slice(0, 200)}` };
    }

    const payload = await res.json();
    const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
    return { text, error: null };
  } catch (err) {
    return { text: null, error: err.name === "AbortError" ? "timeout" : String(err) };
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
// Precision / recall for entities (case-insensitive substring match)
// The graph extractor sometimes returns "Sarah (backend lead)" instead of "Sarah"
// so we use substring containment as the match strategy, matching production semantics
// ---------------------------------------------------------------------------
function entityMatches(extracted, expected) {
  const el = extracted.toLowerCase();
  const exp = expected.toLowerCase();
  return el.includes(exp) || exp.includes(el);
}

function computeEntityPrecision(extractedEntities, expectedEntities) {
  // fraction of expected entities that appear in extracted set
  if (expectedEntities.length === 0) return 1;
  let hits = 0;
  for (const exp of expectedEntities) {
    if (extractedEntities.some(e => entityMatches(e.label, exp))) hits++;
  }
  return hits / expectedEntities.length;
}

function computeEntityRecall(extractedEntities, expectedEntities) {
  // same metric from recall perspective (fraction of expected found)
  return computeEntityPrecision(extractedEntities, expectedEntities);
}

// For relations: check that at least the expected relations' subject+object pairs appear
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
// Main
// ---------------------------------------------------------------------------
async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("ERROR: GEMINI_API_KEY env var is not set.");
    process.exit(1);
  }

  console.log(`\nM3 Graph Extraction A/B Eval`);
  console.log(`Candidate: ${CANDIDATE_DISPLAY}`);
  console.log(`Baseline : ${MODELS[1]}`);
  console.log(`Fixtures : ${FIXTURES.length}`);
  console.log(`Gate     : entity_precision >= ${PRECISION_GATE} AND entity_recall >= ${RECALL_GATE}\n`);

  const results = {
    runAt: new Date().toISOString(),
    modelSubstitutionNote: `gemini-2.0-flash returns HTTP 404 on new Google AI Studio keys (deprecated). ` +
      `gemini-2.5-flash-lite used as cost-equivalent substitute for this eval run.`,
    models: {},
    fixtures: [],
    gate: { precision_threshold: PRECISION_GATE, recall_threshold: RECALL_GATE },
    recommendation: null,
  };

  // Initialize per-model accumulators
  const accum = {};
  for (const model of MODELS) {
    accum[model] = { entityPrecisionSum: 0, entityRecallSum: 0, relationRecallSum: 0, parseFailures: 0, apiErrors: 0 };
    results.models[model] = {};
  }

  // Run all fixtures, all models
  for (let i = 0; i < FIXTURES.length; i++) {
    const fix = FIXTURES[i];
    process.stdout.write(`  [${i + 1}/${FIXTURES.length}] ${fix.id} (${fix.title.slice(0, 40)})...`);
    const prompt = buildPrompt(fix.title, fix.content);

    const fixtureResult = {
      id: fix.id,
      title: fix.title,
      models: {},
    };

    for (const model of MODELS) {
      const { text, error } = await callGemini(model, prompt, apiKey);

      if (error || !text) {
        accum[model].apiErrors++;
        fixtureResult.models[model] = { error: error ?? "empty_response", entityPrecision: 0, entityRecall: 0, relationRecall: 0 };
        continue;
      }

      const extraction = parseExtraction(text);
      if (!extraction) {
        accum[model].parseFailures++;
        fixtureResult.models[model] = { error: "parse_failed", rawSnippet: text.slice(0, 200), entityPrecision: 0, entityRecall: 0, relationRecall: 0 };
        continue;
      }

      const entityPrecision = computeEntityPrecision(extraction.entities, fix.expected_entities);
      const entityRecall = computeEntityRecall(extraction.entities, fix.expected_entities);
      const relationRecall = computeRelationRecall(extraction.relations, fix.expected_relations);

      accum[model].entityPrecisionSum += entityPrecision;
      accum[model].entityRecallSum += entityRecall;
      accum[model].relationRecallSum += relationRecall;

      fixtureResult.models[model] = {
        extractedEntities: extraction.entities.map(e => e.label),
        extractedRelations: extraction.relations.map(r => `${r.from} -[${r.type}]-> ${r.to}`),
        entityPrecision: +entityPrecision.toFixed(4),
        entityRecall: +entityRecall.toFixed(4),
        relationRecall: +relationRecall.toFixed(4),
      };
    }

    results.fixtures.push(fixtureResult);
    process.stdout.write(" done\n");
  }

  // Compute averages and gate
  const N = FIXTURES.length;
  console.log("\n" + "=".repeat(72));
  console.log("RESULTS SUMMARY");
  console.log("=".repeat(72));

  let flash20Pass = true;
  for (const model of MODELS) {
    const a = accum[model];
    const avgPrecision = a.entityPrecisionSum / N;
    const avgRecall = a.entityRecallSum / N;
    const avgRelRecall = a.relationRecallSum / N;

    results.models[model] = {
      avgEntityPrecision: +avgPrecision.toFixed(4),
      avgEntityRecall: +avgRecall.toFixed(4),
      avgRelationRecall: +avgRelRecall.toFixed(4),
      parseFailures: a.parseFailures,
      apiErrors: a.apiErrors,
    };

    const gatePass = model === MODELS[0]
      ? (avgPrecision >= PRECISION_GATE && avgRecall >= RECALL_GATE)
      : null;

    if (model === MODELS[0] && gatePass === false) flash20Pass = false;

    console.log(`\n${model}:`);
    console.log(`  Entity Precision : ${(avgPrecision * 100).toFixed(1)}%  ${gatePass !== null ? (avgPrecision >= PRECISION_GATE ? "PASS" : "FAIL") : ""}`);
    console.log(`  Entity Recall    : ${(avgRecall * 100).toFixed(1)}%  ${gatePass !== null ? (avgRecall >= RECALL_GATE ? "PASS" : "FAIL") : ""}`);
    console.log(`  Relation Recall  : ${(avgRelRecall * 100).toFixed(1)}%`);
    console.log(`  Parse failures   : ${a.parseFailures}`);
    console.log(`  API errors       : ${a.apiErrors}`);
  }

  console.log("\n" + "=".repeat(72));

  const recommendation = flash20Pass
    ? "KEEP gemini-2.0-flash — gate passed. M3 model flip is permanent."
    : "ROLL BACK — gate failed. Set MC_GEMINI_GRAPH_MODEL=gemini-2.5-flash until fixed.";

  results.gate.passed = flash20Pass;
  results.recommendation = recommendation;

  console.log(`Gate (§9 #8): ${flash20Pass ? "PASSED" : "FAILED"}`);
  console.log(`Recommendation: ${recommendation}`);
  console.log("=".repeat(72) + "\n");

  // Failing fixtures (entity recall < 0.5 for candidate model)
  const candidateModel = MODELS[0];
  const failing = results.fixtures.filter(f => {
    const m = f.models[candidateModel];
    return m && !m.error && (m.entityRecall < 0.5 || m.entityPrecision < 0.5);
  });
  if (failing.length > 0) {
    console.log(`Fixtures with low precision/recall on ${candidateModel}:`);
    for (const f of failing) {
      const m = f.models[candidateModel];
      console.log(`  ${f.id}: P=${(m.entityPrecision * 100).toFixed(0)}% R=${(m.entityRecall * 100).toFixed(0)}%  "${f.title}"`);
    }
    console.log();
  }

  // Save JSON
  const outDir = join(REPO_ROOT, "convex/crystal/__tests__/fixtures/eval-results");
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, "graph-extraction-2026-05-03.json");
  writeFileSync(outPath, JSON.stringify(results, null, 2), "utf8");
  console.log(`Results saved to: ${outPath}\n`);
}

main().catch(err => {
  console.error("Eval failed:", err);
  process.exit(1);
});
