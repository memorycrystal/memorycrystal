/**
 * Mock factory for infra/cloudflare/api.ts's underlying `fetch`.
 *
 * Produces a vi.fn() that returns programmable CF API responses:
 *   - success   → HTTP 200 with { result, success: true }
 *   - rate429   → HTTP 429 with { errors: [{code:11111, message:"rate limited"}] }
 *   - server5xx → HTTP 503 with { errors: [{code:99, message:"server error"}] }
 *   - timeout   → thrown TypeError("network timeout") (simulates ETIMEDOUT)
 *
 * Usage:
 *   const mock = makeCFFetchMock([
 *     { type: "rate429" },
 *     { type: "rate429" },
 *     { type: "success", result: { id: "tun-1" } },
 *   ]);
 *   vi.stubGlobal("fetch", mock);
 */

import { vi } from "vitest";

export type CFMockResponseType = "success" | "rate429" | "server5xx" | "timeout";

export interface CFMockStep {
  type: CFMockResponseType;
  /** Arbitrary result payload for "success" responses. */
  result?: unknown;
  /** Override the error code for rate429/server5xx. */
  status?: number;
}

function makeOk(result: unknown = {}) {
  const body = { result, success: true, errors: [] };
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  };
}

function makeErr(status: number, code: number, message: string) {
  const body = { success: false, errors: [{ code, message }] };
  return {
    ok: false,
    status,
    headers: new Headers({ "cf-ray": "test-ray" }),
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  };
}

/**
 * Build a vi.fn() that cycles through `steps` in order.
 * Once all steps are consumed the mock returns the last step's response
 * repeatedly (or throws if the last step was a timeout).
 */
export function makeCFFetchMock(steps: CFMockStep[]): ReturnType<typeof vi.fn> {
  if (steps.length === 0) {
    throw new Error("makeCFFetchMock: steps must be non-empty");
  }

  const mock = vi.fn();

  function responseFor(step: CFMockStep): Promise<unknown> | never {
    switch (step.type) {
      case "success":
        return Promise.resolve(makeOk(step.result ?? {}));
      case "rate429":
        return Promise.resolve(makeErr(step.status ?? 429, 11111, "rate limited"));
      case "server5xx":
        return Promise.resolve(makeErr(step.status ?? 503, 99, "server error"));
      case "timeout":
        return Promise.reject(new TypeError("network timeout (mock)"));
    }
  }

  let callIndex = 0;
  mock.mockImplementation(() => {
    const step = steps[Math.min(callIndex, steps.length - 1)];
    callIndex += 1;
    return responseFor(step);
  });

  return mock;
}

/**
 * Convenience: returns a mock that succeeds after exactly `nFailures` 429s.
 */
export function makeCFFetchMockWithRateLimit(
  nFailures: number,
  successResult: unknown = {},
): ReturnType<typeof vi.fn> {
  const steps: CFMockStep[] = [
    ...Array.from({ length: nFailures }, (): CFMockStep => ({ type: "rate429" })),
    { type: "success", result: successResult },
  ];
  return makeCFFetchMock(steps);
}
