import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

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

export async function writeMemoryToObsidian(memory: ObsidianMemory): Promise<string> {
  const vaultPath = process.env.OBSIDIAN_VAULT_PATH;
  if (!vaultPath) {
    return "";
  }

  const directory = path.join(vaultPath, memory.store);
  await mkdir(directory, { recursive: true });

  const filename = `${memory.createdAt}-${slugify(memory.title || memory.content)}.md`;
  const filePath = path.join(directory, filename);
  const frontmatter = [
    "---",
    `id: ${memory.id}`,
    `store: ${memory.store}`,
    `category: ${memory.category}`,
    `title: ${JSON.stringify(memory.title)}`,
    `strength: ${memory.strength}`,
    `confidence: ${memory.confidence}`,
    `source: ${memory.source}`,
    `valence: ${memory.valence}`,
    `arousal: ${memory.arousal}`,
    `createdAt: ${new Date(memory.createdAt).toISOString()}`,
    `tags: [${memory.tags.map((tag) => JSON.stringify(tag)).join(", ")}]`,
    ...(memory.channel ? [`channel: ${JSON.stringify(memory.channel)}`] : []),
    "---",
    "",
    memory.content,
    "",
  ].join("\n");

  await writeFile(filePath, frontmatter, "utf8");
  return filePath;
}
