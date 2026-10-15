/**
 * Reproducible tar.gz and zip writers for release artifacts.
 *
 * Both formats are written from one sorted entry list with normalized
 * ownership (0/0), a fixed mtime (SOURCE_DATE_EPOCH) and modes reduced to
 * 0644 / 0755 so the executable bit survives while umask noise does not.
 * No system `tar` or `zip` is involved, so the bytes do not depend on the
 * host's archiver, locale or timezone.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

export const FILE_MODE = 0o644;
export const EXEC_MODE = 0o755;
export const DIR_MODE = 0o755;

function byCodeUnit(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Walk `rootDir` and return archive entries under `topLevelName/`, sorted by
 * archive path. Directories are emitted before their children.
 */
export function collectArchiveEntries(rootDir, topLevelName) {
  const entries = [{ archivePath: topLevelName, kind: "dir", mode: DIR_MODE }];
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir).sort(byCodeUnit)) {
      const full = join(dir, name);
      const stat = statSync(full);
      const archivePath = `${prefix}/${name}`;
      if (stat.isDirectory()) {
        entries.push({ archivePath, kind: "dir", mode: DIR_MODE });
        walk(full, archivePath);
      } else if (stat.isFile()) {
        entries.push({
          archivePath,
          kind: "file",
          mode: (stat.mode & 0o111) !== 0 ? EXEC_MODE : FILE_MODE,
          data: readFileSync(full),
        });
      } else {
        throw new Error(`Unsupported archive member (not a file or directory): ${full}`);
      }
    }
  };
  walk(rootDir, topLevelName);
  return entries;
}

// ── tar (ustar) ───────────────────────────────────────────────────────────────

function writeString(block, offset, length, value) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > length) throw new Error(`tar field overflow: ${value}`);
  bytes.copy(block, offset);
}

function writeOctal(block, offset, length, value) {
  writeString(block, offset, length, value.toString(8).padStart(length - 1, "0"));
}

function splitUstarName(archivePath) {
  if (Buffer.byteLength(archivePath) <= 100) return { name: archivePath, prefix: "" };
  // ustar: prefix (<=155) + "/" + name (<=100). Split at a slash.
  for (let i = archivePath.length - 1; i > 0; i -= 1) {
    if (archivePath[i] !== "/") continue;
    const prefix = archivePath.slice(0, i);
    const name = archivePath.slice(i + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name.length > 0) return { name, prefix };
  }
  throw new Error(`archive path is too long for ustar: ${archivePath}`);
}

function tarHeader(entry, mtimeSeconds) {
  const block = Buffer.alloc(512, 0);
  const isDir = entry.kind === "dir";
  const { name, prefix } = splitUstarName(isDir ? `${entry.archivePath}/` : entry.archivePath);
  writeString(block, 0, 100, name);
  writeOctal(block, 100, 8, entry.mode);
  writeOctal(block, 108, 8, 0); // uid
  writeOctal(block, 116, 8, 0); // gid
  writeOctal(block, 124, 12, isDir ? 0 : entry.data.length);
  writeOctal(block, 136, 12, mtimeSeconds);
  block.fill(0x20, 148, 156); // checksum placeholder: spaces
  block.write(isDir ? "5" : "0", 156, 1, "ascii");
  writeString(block, 257, 6, "ustar");
  block.write("00", 263, 2, "ascii");
  // uname/gname stay empty: numeric owner 0/0 only.
  writeOctal(block, 329, 8, 0);
  writeOctal(block, 337, 8, 0);
  writeString(block, 345, 155, prefix);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
  return block;
}

export function createTar(entries, { mtime }) {
  const mtimeSeconds = Math.floor(mtime.getTime() / 1000);
  const chunks = [];
  for (const entry of entries) {
    chunks.push(tarHeader(entry, mtimeSeconds));
    if (entry.kind === "file" && entry.data.length > 0) {
      chunks.push(entry.data);
      const remainder = entry.data.length % 512;
      if (remainder) chunks.push(Buffer.alloc(512 - remainder, 0));
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(chunks);
}

export function createTarGz(entries, options) {
  // Node's gzip header carries mtime 0 and OS 3 (Unix), so the wrapper is stable too.
  return gzipSync(createTar(entries, options), { level: 9 });
}

// ── zip ───────────────────────────────────────────────────────────────────────

/**
 * fflate encodes DOS timestamps from the *local* wall clock. Feeding it a Date
 * whose local fields equal the epoch's UTC fields makes the stored timestamp
 * independent of the builder's timezone.
 */
function utcAsLocalDate(mtime) {
  return new Date(
    mtime.getUTCFullYear(),
    mtime.getUTCMonth(),
    mtime.getUTCDate(),
    mtime.getUTCHours(),
    mtime.getUTCMinutes(),
    mtime.getUTCSeconds(),
  );
}

export async function createZip(entries, { mtime }) {
  const { zipSync } = await import("fflate");
  const stamp = utcAsLocalDate(mtime);
  const files = {};
  for (const entry of entries) {
    const isDir = entry.kind === "dir";
    const unixMode = entry.mode | (isDir ? 0o040000 : 0o100000);
    const attrs = ((unixMode << 16) | (isDir ? 0x10 : 0)) >>> 0;
    files[isDir ? `${entry.archivePath}/` : entry.archivePath] = [
      isDir ? new Uint8Array(0) : new Uint8Array(entry.data),
      { level: isDir ? 0 : 9, mtime: stamp, os: 3, attrs },
    ];
  }
  return Buffer.from(zipSync(files));
}
