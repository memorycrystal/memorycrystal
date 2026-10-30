/**
 * Reusable mock for the local Convex `bootstrapState` singleton.
 *
 * The mcp-server bearer middleware calls into local Convex to check whether
 * `bootstrapState` is "ready" before accepting any bearer token. These helpers
 * let chaos tests control that lifecycle without a real Convex deployment.
 *
 * Usage:
 *   const mock = createBootstrapStateMock("pending");
 *   vi.stubGlobal("fetch", mock.fetchStub);
 *   // ... hit the mcp-server handler ...
 *   mock.setState("ready");
 */

import { vi } from "vitest";

export type BootstrapState = "pending" | "ready" | "expired";

/**
 * Minimal representation of the bootstrapState query response.
 * Mirrors the shape returned by `convex/local/bootstrap.ts:getBootstrapState`.
 */
export interface BootstrapStatePayload {
  state: BootstrapState;
  attemptCount: number;
  errorMessage?: string;
  tenantId?: string;
  tenantSlug?: string;
}

/**
 * Create a mock that intercepts HTTP queries to the local Convex
 * `getBootstrapState` query endpoint and returns the configured state.
 *
 * In the chaos test environment we don't run a real Convex process. Instead we
 * stub `globalThis.fetch` to intercept calls to
 * `http://localhost:3210/api/query?name=local/bootstrap:getBootstrapState`
 * (or any URL containing that query path) and return the mock payload.
 * Other fetches pass through to the underlying `originalFetch`.
 */
export function createBootstrapStateMock(initialState: BootstrapState = "pending") {
  let currentState: BootstrapState = initialState;

  function buildPayload(): BootstrapStatePayload {
    const base: BootstrapStatePayload = {
      state: currentState,
      attemptCount: currentState === "pending" ? 0 : 1,
    };
    if (currentState === "expired") {
      base.errorMessage = `bootstrap_token_expired; see https://memorycrystal.ai/docs/bootstrap-recovery`;
    }
    if (currentState === "ready") {
      base.tenantId = "tenant-mock-id";
      base.tenantSlug = "mock-tenant";
    }
    return base;
  }

  // We return a vi.fn() so callers can spy on how many times the state was
  // queried, and so vi.unstubAllGlobals() cleans it up.
  const fetchStub = vi.fn().mockImplementation((url: string | Request) => {
    const href = typeof url === "string" ? url : url.url;
    if (href.includes("getBootstrapState") || href.includes("bootstrap")) {
      const payload = buildPayload();
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ "Content-Type": "application/json" }),
        json: () => Promise.resolve({ value: payload }),
        text: () => Promise.resolve(JSON.stringify({ value: payload })),
      });
    }
    // Unknown URL — return a generic 404.
    return Promise.resolve({
      ok: false,
      status: 404,
      headers: new Headers(),
      json: () => Promise.resolve({ error: "not found" }),
      text: () => Promise.resolve("not found"),
    });
  });

  return {
    fetchStub,
    setState(next: BootstrapState) {
      currentState = next;
    },
    getState() {
      return currentState;
    },
  };
}
