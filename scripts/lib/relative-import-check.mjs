/**
 * Static check that every relative import inside a packaged Convex tree
 * resolves to a file that shipped. Used by the local-backend artifact smoke.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";

export const SOURCE_EXTENSIONS = [".ts", ".tsx", ".d.ts", ".js", ".mjs", ".cjs", ".json"];
export const IMPORT_PATTERN = /(?:from\s+|import\s*\(\s*)["'](\.{1,2}\/[^"']+)["']/g;

function isFile(path) {
  return existsSync(path) && statSync(path).isFile();
}

/**
 * Resolve `specifier` from `sourceFile` the way the bundler does.
 *
 * `path.extname` reports the last dotted segment of a basename as an
 * extension, so `./distillationPause.helper` and `./buildInfo.generated` look
 * like they already carry one. Only a known source extension counts as one;
 * anything else is treated as extensionless and gets the source-extension and
 * index probes.
 */
export function resolveRelativeImport(sourceFile, specifier) {
  const base = resolve(dirname(sourceFile), specifier);
  const ext = extname(base);
  const candidates = [base];
  if (ext && SOURCE_EXTENSIONS.includes(ext)) {
    if (ext === ".js") candidates.push(`${base.slice(0, -3)}.ts`, `${base.slice(0, -3)}.tsx`);
  } else {
    for (const extension of SOURCE_EXTENSIONS) candidates.push(`${base}${extension}`);
    for (const extension of SOURCE_EXTENSIONS) candidates.push(join(base, `index${extension}`));
  }
  return candidates.find(isFile) ?? null;
}

export function walkSourceFiles(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkSourceFiles(path, files);
    else files.push(path);
  }
  return files;
}

export function stripComments(content) {
  return content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/**
 * Every unresolved relative import under `scanDir`, as `{ file, specifier }`
 * with `file` relative to `displayRoot` (defaults to `scanDir`).
 */
export function findUnresolvedRelativeImports(scanDir, { displayRoot = scanDir, skip = (path) => path.includes("/_generated/") } = {}) {
  const missing = [];
  const sources = walkSourceFiles(scanDir).filter((path) => /\.(?:ts|tsx|js|mjs|cjs)$/.test(path) && !skip(path));
  for (const file of sources) {
    const content = stripComments(readFileSync(file, "utf8"));
    for (const match of content.matchAll(IMPORT_PATTERN)) {
      if (!resolveRelativeImport(file, match[1])) {
        missing.push({ file: file.slice(displayRoot.length + 1), specifier: match[1] });
      }
    }
  }
  return missing;
}
