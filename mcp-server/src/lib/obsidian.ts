import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// Enumerated stores match the Convex schema. Anything outside this set is rejected
// before a path is built so `memory.store` cannot escape the vault directory via
// `..` segments or absolute paths.
const VALID_STORES = new Set(["sensory", "episodic", "semantic", "procedural", "prospective"]);
// Valid memoryId shape — Convex ids are base62-ish. Used to refuse YAML injection
// attempts that would break the frontmatter block via newlines or reserved chars.
const VALID_ID_RE = /^[A-Za-z0-9_-]+$/;

type ObsidianMemory = {
  id: string;
  store: string;
  category: string;
  title: string;
  content: string;
  tags: string[];
  confidence: number;
  strength: number;
  source: string;
  valence: number;
  arousal: number;
  channel?: string;
  createdAt: number;
};

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "memory";

// JSON.stringify produces valid YAML for scalars (strings get quoted, numbers stay
// as numbers) and safely escapes every dangerous character. This prevents a memory
// field that happens to contain a newline, colon, or `---` from injecting arbitrary
// YAML keys into the frontmatter block.
const yamlScalar = (value: unknown): string => JSON.stringify(value);

export async function writeMemoryToObsidian(memory: ObsidianMemory): Promise<string> {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultPath) {
    return "";
  }

  // Defense-in-depth: `memory.store` should already be one of the enum values by the
  // time it reaches us, but the tool schemas are typed as `string` at this boundary.
  // Refuse anything outside the enum so a future caller cannot smuggle `../etc/passwd`.
  if (!VALID_STORES.has(memory.store)) {
    throw new Error(`Invalid Obsidian store: ${JSON.stringify(memory.store)}`);
  }
  if (!VALID_ID_RE.test(memory.id)) {
    throw new Error("Invalid memory id for Obsidian write");
  }

  // Resolve relative to the vault and assert the final directory is still inside it.
  // `path.join` does NOT block `..` traversal; only a resolve + prefix check does.
  const vaultAbsolute = path.resolve(vaultPath);
  const directory = path.resolve(vaultAbsolute, memory.store);
  if (!directory.startsWith(vaultAbsolute + path.sep) && directory !== vaultAbsolute) {
    throw new Error("Obsidian store escaped vault path");
  }
  await mkdir(directory, { recursive: true });

  const filename = `${memory.createdAt}-${slugify(memory.title || memory.content)}.md`;
  const filePath = path.resolve(directory, filename);
  if (!filePath.startsWith(directory + path.sep)) {
    throw new Error("Obsidian filename escaped store directory");
  }

  const frontmatter = [
    "---",
    `id: ${yamlScalar(memory.id)}`,
    `store: ${yamlScalar(memory.store)}`,
    `category: ${yamlScalar(memory.category)}`,
    `title: ${yamlScalar(memory.title)}`,
    `strength: ${Number(memory.strength)}`,
    `confidence: ${Number(memory.confidence)}`,
    `source: ${yamlScalar(memory.source)}`,
    `valence: ${Number(memory.valence)}`,
    `arousal: ${Number(memory.arousal)}`,
    `createdAt: ${yamlScalar(new Date(memory.createdAt).toISOString())}`,
    `tags: [${memory.tags.map((tag) => yamlScalar(tag)).join(", ")}]`,
    ...(memory.channel ? [`channel: ${yamlScalar(memory.channel)}`] : []),
    "---",
    "",
    memory.content,
    "",
  ].join("\n");

  await writeFile(filePath, frontmatter, "utf8");
  return filePath;
}
