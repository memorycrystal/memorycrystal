# Config Guide — openclaw.json

Memory Crystal registers two components with OpenClaw. Both require entries in `~/.openclaw/openclaw.json`.

## Rule: Never Edit Config at Runtime

Config edits must be applied outside the OpenClaw runtime. Always use `jq` surgically, validate after, then restart the gateway manually.

---

## Component 1 — Recall Hook (already applied)

Registered under `hooks.internal.entries`. This fires before every model response via `before_model_resolve`.

No action needed — this was applied during initial setup.

---

## Component 2 — Capture Plugin

Registered under `plugins.entries`. This fires after every AI response via `llm_output`.

### Files required

```
~/.openclaw/extensions/crystal-capture/
  index.js      ← copy of plugin/capture-hook.js from this repo
```

### Setup commands (run outside OpenClaw runtime)

```bash
# 1. Create extension dir and copy plugin
mkdir -p ~/.openclaw/extensions/crystal-capture
cp /path/to/openclaw-crystal/plugin/capture-hook.js ~/.openclaw/extensions/crystal-capture/index.js

# 2. Add to plugins.allow
jq '.plugins.allow += ["crystal-capture"]' ~/.openclaw/openclaw.json > /tmp/oc.json \
  && mv /tmp/oc.json ~/.openclaw/openclaw.json

# 3. Add to plugins.entries
jq '.plugins.entries["crystal-capture"] = {"enabled": true}' ~/.openclaw/openclaw.json > /tmp/oc.json \
  && mv /tmp/oc.json ~/.openclaw/openclaw.json

# 4. Validate
jq empty ~/.openclaw/openclaw.json && echo "JSON valid"
openclaw doctor --non-interactive

# 5. Restart gateway
openclaw gateway restart
```

### Verification

After restart, check the gateway log for:
```
[crystal] capture hooks registered (message_received + llm_output)
```

---

## Environment Variables

Memory Crystal reads env vars from `mcp-server/.env`. These must also be present in OpenClaw's environment for the plugin to work.

Required vars in `openclaw.json` under `hooks.internal.entries.crystal-memory.env` (or system env):

| Variable | Purpose |
|---|---|
| `CONVEX_URL` | `https://<your-deployment>.convex.cloud` |
| `OPENAI_API_KEY` | For embeddings (text-embedding-3-small) and extraction (gpt-4o-mini) |
| `OBSIDIAN_VAULT_PATH` | Absolute path to your Obsidian vault |
| `CRYSTAL_ROOT` | Absolute path to the openclaw-crystal repo |
| `CRYSTAL_ENV_FILE` | Absolute path to mcp-server/.env |

---

## What Each Config Key Does

```jsonc
{
  "hooks": {
    "internal": {
      "entries": {
        "crystal-memory": {
          // Loads handler.js from ~/.openclaw/extensions/crystal-memory/
          // Registers before_model_resolve recall hook
          // Runs recall-hook.js as a subprocess before each AI response
          "enabled": true
        }
      }
    }
  },
  "plugins": {
    "allow": ["crystal-capture"],   // Trusts the plugin as local code
    "entries": {
      "crystal-capture": {
        // Loads index.js from ~/.openclaw/extensions/crystal-capture/
        // Registers message_received + llm_output hooks
        // Runs capture-hook.js as a subprocess after each AI response
        "enabled": true
      }
    }
  }
}
```

---

## Troubleshooting

**Config reload skipped (invalid config)** — you used an unrecognized key like `source` or `path` in `plugins.entries`. Only `enabled` and plugin-specific known keys are valid.

**Plugin not listed in gateway log** — the extension directory doesn't exist or `index.js` is missing.

**Capture not firing** — check `plugins.allow` includes `"crystal-capture"` and gateway was restarted after config change.
