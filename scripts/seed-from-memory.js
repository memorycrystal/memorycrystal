#!/usr/bin/env node
/**
 * seed-from-memory.js
 * Ingests existing flat-file memory into Memory Crystal (Convex + Obsidian).
 * Usage:
 *   node scripts/seed-from-memory.js           # full run
 *   node scripts/seed-from-memory.js --dry-run # preview only
 *   node scripts/seed-from-memory.js --source tacit/policies
 */

const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");

// ── Config ────────────────────────────────────────────────────────────────────

const SCRIPT_DIR = path.resolve(__dirname);
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const ENV_FILE = path.resolve(REPO_ROOT, "mcp-server", ".env");
const HOME = process.env.HOME || "";

const EXTRACTION_MODEL = "gpt-4o-mini";
const GEMINI_EMBEDDING_MODEL = "gemini-embedding-2-preview";
const GEMINI_EMBED_URL_BASE = "https://generativelanguage.googleapis.com/v1beta";
const OPENAI_CHAT_URL = "https://api.openai.com/v1/chat/completions";
const CONVEX_MUTATION_PATH = "crystal/memories:createMemory";
const CONVEX_RECALL_PATH = "crystal/recall:recallMemories";
const DEDUPE_THRESHOLD = 0.92;

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const SOURCE_FILTER = (() => {
  const idx = args.indexOf("--source");
  return idx >= 0 ? args[idx + 1] : null;
})();

// ── Env loading ───────────────────────────────────────────────────────────────

function readEnvFile(filePath) {
  const vals = {};
  if (!fs.existsSync(filePath)) return vals;
  for (const line of fs.readFileSync(filePath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#") || !t.includes("=")) continue;
    const [k, ...rest] = t.split("=");
    vals[k.trim()] = rest.join("=").trim().replace(/^"+|"+$/g, "");
  }
  return vals;
}

const env = { ...readEnvFile(ENV_FILE), ...process.env };
const CONVEX_URL = env.CONVEX_URL;
const OPENAI_API_KEY = (env.OPENAI_API_KEY || "").replace(/^"+|"+$/g, "");
const GEMINI_API_KEY = (env.GEMINI_API_KEY || "").replace(/^"+|"+$/g, "");
const OBSIDIAN_VAULT = env.OBSIDIAN_VAULT_PATH || path.join(HOME, "Documents", "Memory");

if (!CONVEX_URL || !OPENAI_API_KEY) {
  console.error("❌ Missing CONVEX_URL or OPENAI_API_KEY in mcp-server/.env");
  process.exit(1);
}
if (!GEMINI_API_KEY) {
  console.warn("⚠️  GEMINI_API_KEY not set — embeddings will be skipped (Gemini is the sole embedding provider)");
}

// ── Source map ────────────────────────────────────────────────────────────────

const SOURCES = [
  { glob: path.join(HOME, ".openclaw/memory/tacit/policies"),    store: "procedural", category: "rule"      },
  { glob: path.join(HOME, ".openclaw/memory/tacit/preferences"),  store: "semantic",   category: "rule"      },
  { glob: path.join(HOME, ".openclaw/memory/tacit/boundaries"),   store: "procedural", category: "rule"      },
  { glob: path.join(HOME, ".openclaw/memory/knowledge/decisions"),store: "episodic",   category: "decision"  },
  { glob: path.join(HOME, ".openclaw/memory/knowledge/reference"),store: "semantic",   category: "fact"      },
  { glob: path.join(HOME, ".openclaw/memory/knowledge/runbooks"), store: "procedural", category: "workflow"  },
  { glob: path.join(HOME, ".openclaw/memory/knowledge/entities"), store: "semantic",   category: "person"    },
  { glob: path.join(HOME, ".openclaw/memory/daily"),              store: "episodic",   category: "event"     },
  { file: path.join(HOME, "openclaw/MEMORY.md"),                  store: "semantic",   category: "fact"      },
  { file: path.join(HOME, "openclaw/USER.md"),                    store: "semantic",   category: "person"    },
];

const SKIP_PATTERNS = [/^_template/, /^README/, /^_index/, /^\.dedupe/, /^_sources/];

function shouldSkip(filename) {
  return SKIP_PATTERNS.some(p => p.test(path.basename(filename)));
}

function collectFiles() {
  const files = [];
  for (const src of SOURCES) {
    const label = src.file ? path.relative(HOME, src.file) : path.relative(HOME, src.glob);
    if (SOURCE_FILTER && !label.includes(SOURCE_FILTER)) continue;

    if (src.file) {
      if (fs.existsSync(src.file) && !shouldSkip(src.file)) {
        files.push({ path: src.file, store: src.store, category: src.category });
      }
    } else if (src.glob) {
      if (!fs.existsSync(src.glob)) continue;
      for (const f of fs.readdirSync(src.glob)) {
        if (!f.endsWith(".md") || shouldSkip(f)) continue;
        files.push({ path: path.join(src.glob, f), store: src.store, category: src.category });
      }
    }
  }
  return files;
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function httpPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname + u.search,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data), ...headers },
    }, (res) => {
      let buf = "";
      res.on("data", c => buf += c);
      res.on("end", () => {
        try { resolve(JSON.parse(buf)); }
        catch { resolve({ _raw: buf }); }
      });
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ── OpenAI helpers ────────────────────────────────────────────────────────────

const AUTH = { Authorization: `Bearer ${OPENAI_API_KEY}` };

async function extractMemories(content, store, category) {
  const resp = await httpPost(OPENAI_CHAT_URL, AUTH, {
    model: EXTRACTION_MODEL,
    response_format: { type: "json_object" },
    messages: [{
      role: "system",
      content: `You are a memory extraction AI. Extract key memories from the text and return JSON with this exact structure: {"memories": [...]}. Each memory object must have: title (string, short 5-10 word summary), content (string, the full memory detail), store ("${store}"), category ("${category}"), tags (string array), importance (0.0-1.0), confidence (0.0-1.0). Extract 1-8 memories. Be concise and factual.`
    }, {
      role: "user",
      content: content.slice(0, 6000)
    }]
  });

  const raw = resp.choices?.[0]?.message?.content;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.memories)) return parsed.memories;
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch { return []; }
}

async function embed(text) {
  const geminiKey = GEMINI_API_KEY;
  if (!geminiKey) {
    console.warn("[seed] GEMINI_API_KEY not set — skipping embedding");
    return null;
  }
  const model = GEMINI_EMBEDDING_MODEL;
  const url = `${GEMINI_EMBED_URL_BASE}/models/${model}:embedContent?key=${encodeURIComponent(geminiKey)}`;
  const resp = await httpPost(url, {}, {
    model: `models/${model}`,
    content: { parts: [{ text: text.slice(0, 8000) }] },
  });
  const vector = resp?.embedding?.values;
  if (!Array.isArray(vector)) return null;
  if (vector.length !== 3072) {
    console.warn(`[seed] Unexpected embedding dimensions: ${vector.length} (expected 3072)`);
  }
  return vector;
}

// ── Convex helpers ────────────────────────────────────────────────────────────

async function convexMutation(fnPath, args) {
  const resp = await httpPost(`${CONVEX_URL}/api/mutation`, {}, { path: fnPath, args });
  if (resp && typeof resp === "object" && resp.status === "error") {
    return null;
  }
  const value = (resp && typeof resp === "object" && Object.prototype.hasOwnProperty.call(resp, "value")) ? resp.value : resp;
  return value ?? null;
}

async function convexQuery(fnPath, args) {
  return httpPost(`${CONVEX_URL}/api/query`, {}, { path: fnPath, args });
}

// ── Obsidian write ────────────────────────────────────────────────────────────

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

function writeObsidian(memory, embedding) {
  const dir = path.join(OBSIDIAN_VAULT, memory.store);
  fs.mkdirSync(dir, { recursive: true });
  const slug = slugify(memory.content);
  const filename = `${Date.now()}-${slug}.md`;
  const frontmatter = [
    "---",
    `store: ${memory.store}`,
    `category: ${memory.category}`,
    `strength: ${memory.importance || memory.strength || 0.5}`,
    `confidence: ${memory.confidence}`,
    `tags: [${(memory.tags || []).join(", ")}]`,
    `seeded: true`,
    `createdAt: ${new Date().toISOString()}`,
    "---",
    "",
    memory.content,
  ].join("\n");
  fs.writeFileSync(path.join(dir, filename), frontmatter);
  return filename;
}

// ── Cosine similarity ─────────────────────────────────────────────────────────

function cosine(a, b) {
  let dot = 0, ma = 0, mb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; ma += a[i] ** 2; mb += b[i] ** 2; }
  return dot / (Math.sqrt(ma) * Math.sqrt(mb));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🧠 Memory Crystal Memory Seed${DRY_RUN ? " [DRY RUN]" : ""}`);
  console.log(`   Convex: ${CONVEX_URL}`);
  console.log(`   Obsidian: ${OBSIDIAN_VAULT}`);
  if (SOURCE_FILTER) console.log(`   Source filter: ${SOURCE_FILTER}`);
  console.log();

  const files = collectFiles();
  console.log(`📂 Found ${files.length} source files to process\n`);

  if (DRY_RUN) {
    for (const f of files) {
      console.log(`  [${f.store}/${f.category}] ${f.path}`);
    }
    console.log("\n✅ Dry run complete — no data written");
    return;
  }

  let totalSaved = 0, totalSkipped = 0, totalErrors = 0;

  // Fetch existing embeddings for deduplication (broad recall)
  let existingEmbeddings = [];
  try {
    const existing = await convexQuery(CONVEX_RECALL_PATH, { query: "memory", limit: 500 });
    if (Array.isArray(existing)) {
      existingEmbeddings = existing.filter(m => m.embedding).map(m => m.embedding);
    }
    console.log(`🔍 Loaded ${existingEmbeddings.length} existing embeddings for dedup\n`);
  } catch (e) {
    console.warn(`⚠️  Could not load existing memories for dedup: ${e.message}`);
  }

  for (const file of files) {
    console.log(`📄 Processing: ${path.relative(HOME, file.path)}`);
    try {
      const content = fs.readFileSync(file.path, "utf8");
      if (content.trim().length < 20) { console.log("   ⏭  Skipping (too short)"); continue; }

      const memories = await extractMemories(content, file.store, file.category);
      if (!memories.length) { console.log("   ⏭  No memories extracted"); continue; }
      console.log(`   🧩 Extracted ${memories.length} memories`);

      for (const mem of memories) {
        if (!mem.content || typeof mem.content !== "string") continue;
        try {
          const embedding = await embed(mem.content);
          if (!embedding) { totalErrors++; continue; }

          // Dedup check
          const isDupe = existingEmbeddings.some(e => cosine(e, embedding) >= DEDUPE_THRESHOLD);
          if (isDupe) { console.log(`   ♻️  Skipped duplicate: "${mem.content.slice(0, 60)}..."`); totalSkipped++; continue; }

          const saved = await convexMutation(CONVEX_MUTATION_PATH, {
            title: (typeof mem.title === "string" && mem.title.trim()) ? mem.title.trim().slice(0, 120) : mem.content.slice(0, 80),
            content: mem.content,
            store: mem.store || file.store,
            category: mem.category || file.category,
            tags: Array.isArray(mem.tags) ? mem.tags : [],
            strength: typeof mem.importance === "number" ? Math.min(1, Math.max(0, mem.importance)) : 0.5,
            confidence: typeof mem.confidence === "number" ? Math.min(1, Math.max(0, mem.confidence)) : 0.8,
            embedding,
            source: "external",
          });

          if (!saved) {
            totalErrors++;
            console.warn("   ❌ Convex rejected memory save");
            continue;
          }

          writeObsidian(mem, embedding);
          existingEmbeddings.push(embedding); // prevent within-run dupes
          totalSaved++;
          console.log(`   ✅ Saved: "${mem.content.slice(0, 60)}..."`);
        } catch (e) {
          console.warn(`   ❌ Error on memory: ${e.message}`);
          totalErrors++;
        }
      }
    } catch (e) {
      console.warn(`   ❌ Failed to process file: ${e.message}`);
      totalErrors++;
    }
  }

  console.log(`\n📊 Seed complete:`);
  console.log(`   ✅ Saved:   ${totalSaved}`);
  console.log(`   ♻️  Skipped: ${totalSkipped} (dupes)`);
  console.log(`   ❌ Errors:  ${totalErrors}`);
}

main().catch(e => { console.error("Fatal:", e); process.exit(1); });
