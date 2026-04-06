# Memory Crystal Operations

## Health checks

Run from repo root:

- `scripts/crystal-doctor.sh --dry-run` (safe mode, no writes)
- `scripts/crystal-doctor.sh` (full check)
- `npm run test:smoke` (alias of doctor smoke mode)
- `npm run crystal:bootstrap` (fresh install flow)
- `npm run crystal:e2e` (full bootstrap + enable + wiring verification)

## Enable / disable

Enable:

```bash
npm run crystal:enable
```

Fresh install:

```bash
npm run crystal:bootstrap
```

Disable:

```bash
npm run crystal:disable
```

If you need a preview:

```bash
scripts/crystal-enable.sh --dry-run
scripts/crystal-disable.sh --dry-run
```

## File checklist

- `plugin/openclaw-hook.json` — manifest consumed by plugin loader.
- `plugin/handler.js` — runtime hook handler and status output.
- `../02-setup-guides/INSTALL.md` — install playbook.

## Troubleshooting

- If doctor fails because dependencies are missing, run `npm run crystal:init`.
- If MCP tools fail at runtime, rebuild with:

```bash
cd mcp-server
npm install
npm run build
```

- If plugin files are not discovered, set one of:
  - `OPENCLAW_PLUGIN_DIR`
  - `OPENCLAW_DIR`

Graph foundation status:

```bash
cd /path/to/openclaw-crystal
npx convex run crystal/graph:getKnowledgeGraphFoundationStatus
```

## Roadmap and future upgrades

See `../../README.md` for the current product overview.

## Secrets and local state

- Keep `.env` out of source control.
- Keep `.env.example` tracked for onboarding.
- Plugin state is stored in `.crystal/` and included in gitignore.

## Canonical docs

- Install and bootstrap: `../02-setup-guides/INSTALL.md`
