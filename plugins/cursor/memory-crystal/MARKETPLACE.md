# Cursor Marketplace listing

The in-repo bundle is marketplace-shaped. Listing still needs a human submit
in Cursor after a public-repo review. This file is the checklist, not a ticket.

## Already in the bundle

- `.cursor-plugin/plugin.json` — name `memory-crystal`, MIT, v1.0.0
- MCP URL `https://api.memorycrystal.ai/mcp`
- Required variable `MEMORY_CRYSTAL_API_KEY`
- Hooks + five crystal skills + always-apply rule
- Local install path: `~/.cursor/plugins/local/memory-crystal`

## Blocked in-repo

- Cursor-side marketplace publish (Andy submits in Cursor)
- Icon/logo asset (none in `plugins/cursor/` yet)

## Submit when ready

1. Add a square plugin icon under `plugins/cursor/memory-crystal/` and reference it from `plugin.json` if Cursor requires it.
2. Confirm the public GitHub repo is the listing source.
3. In Cursor: Marketplace → Submit plugin → point at this folder / repo.
4. After listing is live, drop the “Marketplace listing is a follow-up” line from `README.md`.

Do not invent a Linear ticket for this. The local plugin (ILL-195) is already shipped.
