# Memory Crystal E2E Tests

Playwright tests covering the AC1 / AC2 / AC3 acceptance criteria and revocation flow. All tests run against a **mocked harness** — no real Convex or Cloudflare calls are made.

## Quick start

```bash
# Fast suite (skips the slow cold-cache test)
pnpm e2e

# Full suite including cold-cache (≤ 300 s wall-clock)
RUN_COLD_E2E=1 pnpm e2e

# Run a single spec
pnpm e2e --grep "AC1"

# Run in headed mode for debugging
pnpm e2e --headed
```

Before first run, install Playwright browsers once:

```bash
npx playwright install --with-deps chromium webkit
```

## Test files

| File | AC | Description |
|------|-----|-------------|
| `onboarding.warm.spec.ts` | AC1 | Warm-cache onboarding flow, ≤ 180 s budget |
| `onboarding.cold.spec.ts` | AC1 | Cold-cache + 25 Mbps throttle, ≤ 300 s budget (opt-in) |
| `cross-machine.spec.ts` | AC2 | Same API key from two browser contexts, response schema |
| `offline-launchpad.spec.ts` | AC3 | Offline page = HTTP 200, relative lastSeenAt, Refresh works |
| `revocation.spec.ts` | AC2 | Revoked key → 401 within 30 s |

## Mock harness

`_helpers/mockHarness.ts` exports `setupMockHarness(page, options?)` which registers `page.route()` intercepts for:

- Convex actions/queries (`provisionTenantPublic`, `isSlugAvailable`, `getTenantBySlug`, `getMyTenant`, bootstrap token lifecycle)
- `/api/cloud/bootstrap/fetchInitialState`
- `{slug}.tunnels.memorycrystal.ai/api/mcp/**` — returns 200 or 401 based on `apiKeyRevoked` option
- `/_e2e/local-stack-mock` — stub local-stack landing page

Convenience wrappers:

```ts
setupOfflineHarness(page, lastSeenAt?)  // lastSeenAt defaults to 5 min ago
setupRevokedKeyHarness(page)            // sets apiKeyRevoked: true
```

Shared tenant fixtures (slug, keys, tokens, IDs) live in `_helpers/tenantFixtures.ts`.

## Adding a new test

1. Create `tests/e2e/<name>.spec.ts`.
2. Import `setupMockHarness` and any fixtures you need.
3. Add any additional `page.route()` overrides for test-specific behaviour after `setupMockHarness`.
4. Keep assertions focused on what the AC requires — avoid testing UI copy that may change.

## What the mock harness covers

- Convex auth token stubs (prevents redirect to /login in headless mode)
- Provisioning action returning `ProvisionResult` with stable fixtures
- Slug availability check (always returns available unless overridden)
- Tunnel health endpoint
- MCP recall endpoint (valid key → 200, invalid/revoked key → 401)
- Bootstrap token lifecycle (issue, consume, expire)
- Local-stack stub page

## CI

The fast suite runs on every PR and push to main via `.github/workflows/e2e.yml`. The cold-cache test is excluded from CI (`RUN_COLD_E2E` is not set). Playwright traces and HTML reports are uploaded as artifacts on failure.
