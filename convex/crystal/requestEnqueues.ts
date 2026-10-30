// Writes a request enqueues (scheduler.runAfter) while it carries on. Convex may
// drop promises an invocation leaves pending, so a request that drains its
// enqueues waits for every one of them, not for the scheduled work, before it
// returns, whatever the outcome. Outside such a request nothing waits at the
// end, so the caller waits for its own enqueue.

const pendingByCtx = new WeakMap<object, Promise<void>[]>();

/** Runs `handle`, then waits for everything handed to `awaitEnqueue` or `settleBeforeReturn` with this ctx. */
export async function drainEnqueuesAfter<T>(ctx: object, handle: () => Promise<T>): Promise<T> {
  const pending: Promise<void>[] = [];
  pendingByCtx.set(ctx, pending);
  try {
    return await handle();
  } finally {
    // Settled, not fulfilled: an enqueue logs its own failure, and draining never replaces the result or error.
    while (pending.length > 0) await Promise.allSettled(pending.splice(0));
    pendingByCtx.delete(ctx);
  }
}

/** Leaves `enqueue` to the draining request when there is one; otherwise waits for it now. */
export async function awaitEnqueue(ctx: object, enqueue: Promise<void>): Promise<void> {
  const pending = pendingByCtx.get(ctx);
  if (pending) pending.push(enqueue);
  else await enqueue;
}

/**
 * Keeps the draining request open until `work` settles, for work its caller may leave unawaited, and returns `work`.
 * The enqueues it makes before it settles join the drain. Outside such a request it only returns `work`.
 */
export function settleBeforeReturn<T>(ctx: object, work: Promise<T>): Promise<T> {
  pendingByCtx.get(ctx)?.push(work.then(() => undefined, () => undefined));
  return work;
}
