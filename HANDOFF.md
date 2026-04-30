# Mission Control — Handoff Notes (as of v1.28, 2026-04-29)

This is a snapshot of where things stand mid-build. It supersedes any verbal status — read this first when picking the work back up.

## Demo posture (Sunday)

**Demo from Mission Control desktop only.** WhatsApp is configured but inbound delivery is unverified — see "WhatsApp" below. Do not promise WhatsApp during the demo.

## WhatsApp (v1.28) — PARTIAL, demo-blocked

State as of stop: plugin scaffolded and installed at `whatsapp-bridge/` (top of repo). Suppression of OpenClaw's default agent on WhatsApp inbound currently flows through a **SOUL.md NO_REPLY rule**, not the plugin.

| Component | State |
|---|---|
| `whatsapp-bridge/` plugin (package.json + index.js + openclaw.plugin.json) | installed, **disabled** (`openclaw plugins disable whatsapp-bridge` was run) |
| Plugin's `before_dispatch` typed-hook handler | wired to POST `http://127.0.0.1:8001/whatsapp/event` and return `{handled: true}`; **never observed firing end-to-end** |
| `~/.openclaw/workspace/SOUL.md` "WhatsApp inbound — Mission Control owns the reply path" section | active. Tells Jackson to emit `NO_REPLY` for any whatsapp-channel turn. This is the **only** active suppressor. |
| `~/.openclaw/openclaw.json` | `plugins.entries.whatsapp-bridge.enabled = false`; stale `hooks.internal.*` blocks removed |
| MC FastAPI `/whatsapp/event` receiver | **not built** (Step 4 of original plan — blocked on CP2 verification that never happened) |

## Why v1.28 stopped where it did

`gateway/channels/whatsapp/inbound` log lines never appeared during testing despite three test messages over two relink cycles. `openclaw channels status --probe` reported "linked, running, connected" the whole time, but the heartbeat subsystem reported "No messages received in 30m" at every 30-min interval — inbound delivery is broken at the WhatsApp Web protocol layer for this account/session, not at the OpenClaw or plugin layer.

The plugin shape was solved (CP1 met cleanly: `definePluginEntry`-shaped object, hand-rolled to avoid `openclaw/plugin-sdk` resolution from outside the openclaw npm tree, `before_dispatch` typed hook registered, plugin shows `loaded` with the right hook). What couldn't be tested is whether `before_dispatch` actually short-circuits the agent path under live inbound — because no live inbound arrived.

## v1.29 task list (priority order)

1. **Reproduce inbound delivery** before anything else.
   - Send to `+639193640226` from a different WhatsApp account (not Note-to-Self). Does `gateway/channels/whatsapp/inbound` log?
   - If no inbound from external sender either: open WhatsApp on phone → Linked Devices → remove all OpenClaw sessions → fresh `openclaw channels login --channel whatsapp` from native Terminal (NOT from Claude Code's UI — ASCII QR doesn't render reliably for phone scan).
   - If still no: WhatsApp account-level issue, possibly Linked Devices count cap, possibly account flagged. May need different test number.
2. **Verify plugin `before_dispatch` end-to-end** once inbound is reliable.
   - Re-enable plugin: `openclaw plugins enable whatsapp-bridge`, restart gateway.
   - Temporarily comment-out the SOUL `NO_REPLY` block.
   - Send a WA message. Expect: `[whatsapp-bridge] intercepted before_dispatch` line in `openclaw logs --plain --follow`, AND no main-agent reply on phone, AND no `gateway/channels/whatsapp/outbound...send` line (only the 👀 reaction).
3. **If plugin doesn't fire** when inbound is verified live:
   - Add a `gateway_start` hook log to confirm `register(api)` runs.
   - Try `kind: "channel-bridge"` (or any non-`memory` kind) in `openclaw.plugin.json` — currently absent.
   - Try `import { definePluginEntry } from 'openclaw/plugin-sdk'` via `npm link openclaw` from the plugin dir, replacing the hand-rolled entry literal.
4. **Build MC FastAPI receiver** (Step 4 of original v1.28 plan) — only after (2) is green.
   - `POST /whatsapp/event` in `backend/server.py` parses hook payload (sessionKey, from, bodyForAgent, transcript, conversationId, messageId, isGroup).
   - Maps to internal `/chat` invocation with `channel="whatsapp"`, session keyed by `sessionKey` (or `from` if empty).
   - On Jackson's reply, shells out: `subprocess.run(["openclaw", "message", "send", "--channel", "whatsapp", "--target", from_jid, "--message", reply_text], check=True, timeout=30)`.
   - Action-card-triggering replies → `"Card waiting on your Mac to confirm — [summary]"` instead of card markup over WA.
   - Persists `origin_channel="whatsapp"` + `origin_jid` + `origin_message_id` on `pending_actions` rows.
   - Returns 200 fast; agent processing in background task to avoid blocking the hook timeout.
5. **Approval echo** ("✓ Done" outbound after Mac confirms a card) — Step 4.5, defer if needed.
6. **Documentation lessons** from this session, in case future plugin work needs them:
   - Linked plugin layout must be **flat**: `package.json` + `index.js` + `openclaw.plugin.json` at the linked-dir top. (Hook packs use a nested layout instead — install command branches on whether HOOK.md or `openclaw.extensions` exists at the top.)
   - `openclaw.plugin.json` is required separately from `package.json` for plugin installs and must contain at minimum `id` and `configSchema` (install fails with `plugin manifest requires configSchema` otherwise).
   - The install security scanner blocks `process.env.X || fetch(...)` patterns as "credential harvesting." Use `cfg.plugins.entries.<id>.config` for runtime overrides instead of env vars.
   - Third-party plugins outside the `openclaw` npm tree should hand-roll the entry-object literal (it's just an identity-function output anyway), since `definePluginEntry` lives at `openclaw/plugin-sdk` and won't resolve from arbitrary paths without an `npm link`.

## Where things live

- Plugin source: `whatsapp-bridge/{package.json, openclaw.plugin.json, index.js}`
- OpenClaw config: `~/.openclaw/openclaw.json` (mostly auto-managed by `openclaw plugins/channels` commands)
- Workspace SOUL: `~/.openclaw/workspace/SOUL.md` (Jackson's persona, currently has the WhatsApp NO_REPLY rule)
- Gateway log: `/tmp/openclaw/openclaw-YYYY-MM-DD.log`
- MC backend: `backend/server.py` (FastAPI on port 8001)
- MC frontend: `src/` (React/Vite, electron wrapper in `electron/`)
