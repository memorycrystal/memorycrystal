# Memory Crystal Installation Guide

Memory Crystal is a drop-in OpenClaw memory plugin with a single-command bootstrap flow.

## Fast path (recommended)

From repo root:

```bash
npm install
npm run crystal:bootstrap
```

`crystal:bootstrap` performs:

- `.env` initialization from `.env.example`
- required key prompts for missing values:
  - `CONVEX_URL`
  - `OPENAI_API_KEY`
  - `OBSIDIAN_VAULT_PATH`
  - `CRYSTAL_MCP_MODE`
  - `CRYSTAL_MCP_HOST`
  - `CRYSTAL_MCP_PORT`
- dependency installs (`npm install` at repo root and `mcp-server`)
- `mcp-server` build
- plugin wiring into detected OpenClaw layout
- final wiring verification

If required keys are already present, bootstrap can run non-interactively in CI-like contexts by keeping `.env` values set.

## Layout detection

The installer auto-detects OpenClaw paths in this order:

1. `OPENCLAW_DIR` environment variable
2. `~/.openclaw`
3. `~/.config/openclaw`
4. `$XDG_CONFIG_HOME/openclaw`
5. `~/Library/Application Support/openclaw`

You can override plugin destination with `OPENCLAW_PLUGIN_DIR`.

## Recommended install / verification flow

1. Run:

```bash
npm run crystal:bootstrap
```

2. Verify with:

```bash
npm run test:smoke
npm run crystal:e2e
```

3. If OpenClaw is not restarted automatically, run:

```bash
openclaw gateway restart
```

## What to check if plugin wiring fails

- Confirm OpenClaw writable config path exists:
  - `~/.openclaw/openclaw.json` or detected equivalent
  - `extensions/internal-hooks/openclaw-hook.json`
- Confirm `.env` is complete and not template placeholders.
- Re-run:

```bash
scripts/crystal-enable.sh --dry-run
scripts/crystal-doctor.sh --dry-run
```

## Uninstall

```bash
npm run crystal:disable
```

Use `npm run crystal:disable -- --purge` to remove copied plugin files from OpenClaw plugin directory.

## Docs map

- `../../README.md` — product summary and quick links.
- `../07-operations/OPERATIONS.md` — operations runbook.
