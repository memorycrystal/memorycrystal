# Chaos Test Suite

Unit-level chaos tests for Memory Crystal's two-tier offline UX contract (plan §3.5, §AC3, §10).

These tests run in Node with mocked HTTP — no real network calls, no `docker compose up`, no `convex deploy`.

## Purpose

Verify that every failure mode in the tunnel/stack surface returns either **HTTP 200** or a **structured §10 503 envelope**. Forbidden responses: 502, 504, raw CF HTML, bare 503 with empty body.

The suite covers:

| File | What it tests |
|---|---|
| `offline.matrix.spec.ts` | 4×2 matrix: `{cloudflared, web, mcp, backend} × {up, down}` — Tier-1 vs Tier-2 disambiguation |
| `mac-off.spec.ts` | Tier-2 CF Worker path: CF 1033/1016/530 → structured 503 with KV `last_seen_at` |
| `worker-down.spec.ts` | Worker non-critical for healthy traffic — valid keys still authenticate at local origin |
| `kv-stale.spec.ts` | Stale KV: (a) healthy auth unaffected; (b) Tier-2 503 with stale `last_seen_at` |
| `cf-api-rate-limit.spec.ts` | `cfFetch` exponential backoff (1s → 1.5× → max 30s, 5 attempts) on 429s |
| `bootstrap-pending.spec.ts` | `bootstrapState=pending` → 503 `bootstrap_pending`, NOT 401 |
| `bootstrap-token-expired.spec.ts` | `bootstrapState=expired` → 503 `bootstrap_expired` with recovery docs link |

## How to run

```bash
# From repo root:
pnpm chaos

# Equivalent long form:
pnpm vitest run --config vitest.config.chaos.ts

# Watch mode during development:
pnpm vitest --config vitest.config.chaos.ts
```

## Required env

None for normal runs — all HTTP is mocked via `vi.fn()`. The `CHAOS_TUNNEL_URL` variable defaults to the mock harness and is never used to make real network calls.

Optional:
- `CHAOS_TUNNEL_URL` — if set, future integration variants may use it as the tunnel base URL. The current suite ignores it.

## Adding a new scenario

1. Create `tests/chaos/<name>.spec.ts`.
2. Import helpers from `./__helpers__/`:
   - `mock503Envelope.ts` — `assertValid503Envelope(body)`, `assertStatusIs(body, status)`.
   - `mockCFFetch.ts` — `makeCFFetchMock(steps)` for CF API retry tests.
   - `bootstrapStateMock.ts` — `createBootstrapStateMock(state)` for bootstrap lifecycle tests.
3. Mock `globalThis.fetch` via `vi.stubGlobal("fetch", mockFn)` in `beforeEach`.
4. Restore in `afterEach` via `vi.restoreAllMocks()` or `vi.unstubAllGlobals()`.
5. The test will automatically be picked up by `pnpm chaos` (no config change needed).

## Deferred (post-M3 M10 pass)

The following E2E tests require M3's signup flow and a live staging environment:

- `tests/e2e/onboarding.warm.spec.ts`
- `tests/e2e/onboarding.cold.spec.ts`
- `tests/e2e/cross-machine.spec.ts`
- `tests/e2e/revocation.spec.ts`
- `tests/e2e/offline-launchpad.spec.ts`
