# Scripts AGENTS

## Package Identity

- Purpose: bootstrap, wiring, smoke testing, and lifecycle automation for the Memory Crystal plugin.
- Scope: `scripts/*.sh`.

## Setup Commands

- Install plugin dependencies: `npm install`
- Run bootstrap: `npm run crystal:bootstrap`
- Validate environment and wiring: `npm run crystal:doctor`
- Enable integration: `npm run crystal:enable`
- Disable integration: `npm run crystal:disable`
- Smoke validation: `npm run test:smoke`

## Conventions

- Use `bash` with `set -euo pipefail` (or at minimum `set -e`) for all scripts.
- Prefer strict argument parsing and explicit exit handling.
- Keep idempotent behavior for `--dry-run` modes.
- Resolve repo paths defensively from script location.
- Shell-only changes should keep behavior backwards-compatible with existing `crystal-*` command names.

### ✅ DO / ❌ DON'T

- ✅ `scripts/crystal-doctor.sh`
- ✅ `scripts/crystal-bootstrap.sh`
- ❌ `scripts/*.sh` with silent partial writes or no validation.

## Touch Points / Key Files

- `./crystal-doctor.sh`
- `./crystal-bootstrap.sh`
- `./crystal-init.sh`
- `./crystal-enable.sh`
- `./crystal-disable.sh`
- `./crystal-e2e.sh`

## JIT Index Hints

- List scripts: `rg --files scripts/*.sh`
- Search integration checks: `rg -n "OPENCLAW_DIR|DRY_RUN|--dry-run|--purge" scripts/*.sh`
- Find env requirements: `rg -n "CONVEX_URL|OPENAI_API_KEY|OBSIDIAN_VAULT_PATH|CRYSTAL_" scripts/*.sh`

## Common Gotchas

- `openclaw` CLI may be absent in non-interactive environments, so scripts should tolerate restart failures and emit explicit guidance.
- Some flows are warning-heavy when `.env` contains placeholder values (`sk-...` / `your-deployment.convex.cloud`).

## Pre-PR Checks

- `npm run test:smoke`
