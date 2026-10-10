#!/usr/bin/env node

import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

async function main() {
  const width = 32;
  const mask = (1n << 256n) - 1n;
  const xor = Buffer.alloc(width);
  let sum = 0n;
  let records = 0;

  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.length === 0) continue;
    const digest = createHash("sha256").update(line).digest();
    for (let i = 0; i < width; i += 1) xor[i] ^= digest[i];
    sum = (sum + BigInt(`0x${digest.toString("hex")}`)) & mask;
    records += 1;
  }

  const sumHex = sum.toString(16).padStart(width * 2, "0");
  const fingerprint = createHash("sha256")
    .update(`memorycrystal-jsonl-multiset-v1\0${records}\0`)
    .update(xor)
    .update(Buffer.from(sumHex, "hex"))
    .digest("hex");

  process.stdout.write(`${records}\t${fingerprint}\n`);
}

if (isDirectRun()) {
  await main();
}
