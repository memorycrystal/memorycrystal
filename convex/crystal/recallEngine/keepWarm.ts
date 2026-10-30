const DISABLED = new Set(["0", "false", "off", "no"]);

/** On by default. 0, false, off or no (any case, trimmed) turns vector keep-warm off, per run. */
export function vectorKeepWarmEnabled(): boolean {
  const raw = process.env.CRYSTAL_VECTOR_KEEP_WARM?.trim().toLowerCase();
  return raw === undefined || !DISABLED.has(raw);
}
