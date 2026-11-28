// A provider request hedged against a slow answer: one identical request races it after a delay, and the first answer
// that ends the race wins. Recall's query embedding and its answer check use it.
import { awaitEnqueue, settleBeforeReturn } from "./requestEnqueues";

/** A hedge request counted before it is sent; `release` takes the count back when it is not sent. */
export type HedgeAdmission = { release: () => Promise<void> };

/** A provider response; a failure carries the HTTP status when there was one. */
type ProviderResponse = { ok: boolean; status?: number };

type SettledAttempt<T> = { attempt: Attempt<T>; outcome: PromiseSettledResult<T> };
type Attempt<T> = { controller: AbortController; inFlight: boolean; settled: Promise<SettledAttempt<T>> };

function sendAttempt<T>(ctx: object, send: (signal: AbortSignal) => Promise<T>): Attempt<T> {
  const controller = new AbortController();
  // An aborted request records nothing, but one that answered before its abort records its outcome after the race
  // returns; the draining request waits for it.
  const request = settleBeforeReturn(ctx, send(controller.signal));
  const settle = (outcome: PromiseSettledResult<T>): SettledAttempt<T> => {
    attempt.inFlight = false;
    return { attempt, outcome };
  };
  const attempt: Attempt<T> = {
    controller,
    inFlight: true,
    settled: request.then(
      (value) => settle({ status: "fulfilled", value }),
      (reason: unknown) => settle({ status: "rejected", reason }),
    ),
  };
  return attempt;
}

/** A success, an error thrown or a 4xx other than 408 and 429 answers the race; the other request cannot do better. */
function endsRace(outcome: PromiseSettledResult<ProviderResponse>): boolean {
  if (outcome.status === "rejected" || outcome.value.ok) return true;
  const status = outcome.value.status ?? 0;
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/** A deadline both requests share; `expired` is the answer when a request would be dispatched at or past it. */
export type HedgeDeadline<T> = { at: number; expired: () => T };

/**
 * Sends the request and, when it has not answered within `delayMs`, one identical request that `admit` counts before
 * it is sent and `onSent` hears about as it is sent. `send` passes the signal on to the provider call. With a
 * `deadline`, the time left is read once at each dispatch and passed to `send` as `remainingMs`; nothing is sent when
 * none is left: the first request answers `deadline.expired()` without a call, and an admitted hedge stays unsent and
 * its count is taken back. The first answer that ends the race wins and the other request is aborted. A transient
 * failure waits for the other request while one is in flight, so a failure before the delay returns at once.
 */
export async function requestHedged<T extends ProviderResponse>(
  ctx: object,
  hedge: {
    delayMs: number;
    send: (signal: AbortSignal, remainingMs?: number) => Promise<T>;
    admit: () => Promise<HedgeAdmission | null>;
    deadline?: HedgeDeadline<T>;
    onSent?: () => void;
  },
): Promise<T> {
  // One clock read decides whether a request goes out and how long it may take.
  const dispatch = (): Attempt<T> | null => {
    if (!hedge.deadline) return sendAttempt(ctx, (signal) => hedge.send(signal));
    const remainingMs = hedge.deadline.at - Date.now();
    return remainingMs > 0 ? sendAttempt(ctx, (signal) => hedge.send(signal, remainingMs)) : null;
  };
  const first = dispatch();
  if (!first) return hedge.deadline!.expired();
  let racing = [first];
  let hedgeTimer: ReturnType<typeof setTimeout> | undefined;
  let hedgeDue: Promise<"hedge"> | null = new Promise((resolve) => {
    hedgeTimer = setTimeout(() => resolve("hedge"), hedge.delayMs);
  });
  try {
    for (;;) {
      const next = await Promise.race([...racing.map((attempt) => attempt.settled), ...(hedgeDue ? [hedgeDue] : [])]);
      if (next === "hedge") {
        hedgeDue = null;
        const admission = await hedge.admit();
        const second = admission && racing[0].inFlight ? dispatch() : null;
        if (second) {
          racing.push(second);
          hedge.onSent?.();
        } else if (admission) {
          // The first request answered during admission, or the hedge can no longer be sent; its count is taken back.
          await awaitEnqueue(ctx, admission.release());
        }
        continue;
      }
      racing = racing.filter((attempt) => attempt !== next.attempt);
      if (racing.length > 0 && !endsRace(next.outcome)) continue;
      if (next.outcome.status === "rejected") throw next.outcome.reason;
      return next.outcome.value;
    }
  } finally {
    clearTimeout(hedgeTimer);
    for (const attempt of racing) attempt.controller.abort();
  }
}
