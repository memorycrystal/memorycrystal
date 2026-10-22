export const metric = (name: string, tags?: Record<string, string | number | null>): void => {
  // Structured prefix "[mc.metric]" — greppable in Convex log drain.
  // No-throw: metric emission must never break a recall path.
  try {
    const payload = { name, ts: Date.now(), ...(tags ?? {}) };
    // eslint-disable-next-line no-console
    console.log("[mc.metric]", JSON.stringify(payload));
  } catch {
    // swallow — observability is best-effort
  }
};
