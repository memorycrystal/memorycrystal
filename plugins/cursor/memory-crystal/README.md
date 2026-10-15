# Memory Crystal for Cursor

Local Cursor Plugin bundle for Memory Crystal.

The official installer remains the credentialed path:

```bash
curl -fsSL https://memorycrystal.ai/crystal | bash -s -- --targets cursor
```

That writes `~/.cursor/mcp.json`, `~/.cursor/hooks.json`, skills, and copies this bundle to `~/.cursor/plugins/local/memory-crystal`.

To load the plugin during development without the installer:

```bash
ln -s /path/to/memorycrystal/plugins/cursor/memory-crystal ~/.cursor/plugins/local/memory-crystal
```

Then reload Cursor. Set `MEMORY_CRYSTAL_API_KEY` in Customize → Plugins → Configure. Do not commit secrets.

Marketplace listing is a follow-up after local verification. See [MARKETPLACE.md](./MARKETPLACE.md) for the submit checklist. Listing cannot be finished from this repo — it needs a Cursor-side submit plus a plugin icon.
