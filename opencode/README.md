# OpenCode → Agent Office bridge

Global OpenCode **2.x** plugin that forwards session / tool / task / permission / todo
activity to Agent Office (`POST /event`) with `connection: "opencode"`.

**Not an LLM provider.** OpenCode still uses DeepSeek / Anthropic / … for models.
This plugin only mirrors OpenCode activity into the Torin-Office UI.

## Install

From the Torin-Office / Claude-Office checkout:

```bash
npm run install-opencode
```

Copies this directory to `~/.config/opencode/plugins/agent-office/` (directory only —
OpenCode 2 rejects bare `.js` files) and registers it in `opencode.json`.
**Restart OpenCode** (new session), then check `/plugins` — `agent-office` should be loaded, not failed.

```bash
npm run uninstall-opencode
```

## How to use

1. `npm run server` + `npm run open -- --dev` (office window)
2. Restart OpenCode after install
3. Chat / run tools / spawn `task` subagents in OpenCode as usual
4. Watch the office — main character labelled **OpenCode**

## Layout

| File | Role |
|------|------|
| `index.js` | Plugin entry (hooks) |
| `map-events.js` | Pure OpenCode → office payload mapper |
| `post-event.js` | HMAC-signed POST + permission long-poll |
| `roles.js` | `subagent_type` → office role |
| `classify-bash.js` | deploy/test/build/push signals |

## Auth

Reads `~/.agent-office/auth-token` (same as Claude hooks) and signs requests
with `x-office-timestamp` / `x-office-signature`.
