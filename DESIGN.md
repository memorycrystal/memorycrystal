# Design

## Source of truth
- Status: Active
- Last refreshed: 2026-05-29
- Primary product surfaces: Memory Crystal marketing site, authenticated dashboard, storage/asset management, telemetry and operational observability.
- Evidence reviewed: `AGENTS.md`, `apps/web/app/globals.css`, `apps/web/app/(dashboard)/telemetry/page.tsx`, `apps/web/app/(dashboard)/storage/page.tsx`, `apps/web/app/(dashboard)/layout.tsx`.

## Brand
- Personality: precise, technical, operational, trustworthy, memory-native.
- Trust signals: exact counts, clear provenance, explicit limits, visible processing state, no overclaiming.
- Avoid: soft rounded SaaS cards, decorative gradients/orbs, vague AI copy, unsupported native multimodal claims.

## Product goals
- Goals: help users understand what Memory Crystal captured, stored, recalled, and processed; keep operational controls fast and legible.
- Non-goals: marketing-heavy dashboard pages, decorative hero layouts inside authenticated tools, speculative provider abstractions in UI copy.
- Success signals: dashboard pages are scannable, dense enough for repeated use, and consistent with Telemetry's visual system.

## Personas and jobs
- Primary personas: developers, agent operators, and admins running Memory Crystal across tools.
- User jobs: inspect memory/storage health, find evidence rows, retry failed processing, understand limits and quality signals.
- Key contexts of use: desktop admin work, mobile spot checks, production troubleshooting.

## Information architecture
- Primary navigation: dashboard sidebar with product-facing labels; `Storage` is the user-facing route for asset/file management.
- Core routes/screens: Dashboard, Memories, Knowledge, Storage, Brain, Telemetry, Usage, API Keys, Settings/Admin.
- Content hierarchy: compact page title, secondary explanatory copy, summary surface, metric cards, operational lists/tables.

## Design principles
- Principle 1: Telemetry is the dashboard visual baseline.
- Principle 2: Show exact operational state plainly before explanations.
- Tradeoffs: dense dashboards are preferred over marketing spaciousness; exact backend summaries may sit above capped fast client lists when the distinction is explicit.

## Visual language
- Color: dashboard tokens from `apps/web/app/globals.css`; page void `#0D1820`, surfaces `#111C28`, nested panels `#162636`, controls `#1A3042`, accent `#2180D6`.
- Typography: compact mono uppercase page headings, uppercase tracking labels, strong numeric values, secondary explanatory copy.
- Spacing/layout rhythm: Telemetry-style stacked sections with `mb-6`, `p-5 sm:p-6`, responsive metric grids, and compact row gaps.
- Shape/radius/elevation: `border-radius: 0` everywhere; no shadows as primary hierarchy; borders and color depth carry structure.
- Motion: restrained progress transitions only where state changes benefit from feedback.
- Imagery/iconography: lucide icons for controls and section signals; no decorative illustration inside dashboard tools.

## Components
- Existing components to reuse: dashboard shell tokens, Telemetry `StatCard`/pill/panel patterns, lucide icons, dashboard form controls.
- New/changed components: page-local helpers are acceptable when they mirror Telemetry and avoid new dependencies.
- Variants and states: loading, empty, failed, ready/queued/processing, retry/delete actions, capped-list notices.
- Token/component ownership: `globals.css` owns dashboard tokens; pages should consume token classes instead of inline colors when practical.

## Accessibility
- Target standard: keyboard-operable dashboard controls with readable contrast.
- Keyboard/focus behavior: buttons/selects/inputs must remain native or visibly focusable.
- Contrast/readability: primary text on dashboard surfaces uses `text-primary`; helper copy uses `text-secondary`.
- Screen-reader semantics: icon buttons require `aria-label`; headings and sections should preserve meaningful hierarchy.
- Reduced motion and sensory considerations: avoid unnecessary animation; progress transitions are acceptable and nonessential.

## Responsive behavior
- Supported breakpoints/devices: mobile drawer dashboard and desktop sidebar dashboard.
- Layout adaptations: metric grids collapse cleanly; operational rows stack before desktop columns.
- Touch/hover differences: mobile must not depend on hover-only affordances.

## Interaction states
- Loading: use terse `Loading...` or neutral zero state when local E2E bypass skips data.
- Empty: explain what will appear and why, without tutorial copy.
- Error: surface the failing operation when possible; do not hide backend failures behind success copy.
- Success: keep success states factual.
- Disabled: use lower contrast and preserve layout.
- Offline/slow network, if applicable: prefer stable panels over layout shifts.

## Content voice
- Tone: factual, specific, operational.
- Terminology: use `Storage` for product navigation; keep `assets` as internal/backend terminology where appropriate.
- Microcopy rules: distinguish exact account-wide summaries from capped/latest loaded tables; never imply native raw image/audio/video embeddings until implemented.

## Implementation constraints
- Framework/styling system: Next.js App Router, React client components where Convex hooks are used, Tailwind 4 token classes.
- Design-token constraints: dashboard pages should use `bg-surface`, `bg-dashboard-panel`, `bg-dashboard-control`, `text-primary`, `text-secondary`, and `border-white/[0.07]`.
- Performance constraints: keep dashboard lists bounded; make exact scans explicit or graduate them to rollups before large-volume claims.
- Compatibility constraints: `/assets` remains a redirect to `/storage`; backend table names can remain `crystalAssets`.
- Test/screenshot expectations: run typecheck/build and browser-check desktop/mobile for dashboard visual changes.

## Open questions
- [ ] When asset volume grows beyond V1 expectations, decide whether Storage needs server-side pagination/filtering and summary rollups.
