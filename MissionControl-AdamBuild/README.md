# Mission Control AI — Install

## Quick install (5 minutes)

1. **Receive this folder** via AirDrop and let macOS save it to `~/Downloads/`.
2. **Open Terminal** (Spotlight → "Terminal") and paste this — it strips the AirDrop quarantine flag from every file in the folder, then runs the installer (the `bash` invocation also bypasses the missing-execute-bit issue):
   ```
   xattr -dr com.apple.quarantine ~/Downloads/MissionControl-AdamBuild
   cd ~/Downloads/MissionControl-AdamBuild
   bash "Install Mission Control.command"
   ```
3. Enter your Mac password when prompted (Homebrew + moving the app into `/Applications`).
4. The installer verifies the bundle is fresh, installs Homebrew + Python 3.12 + the OpenClaw engine + the backend's Python packages if needed, then unzips the app and launches it.
5. **Paste your API keys** in the Setup screen as Mission Control walks you through Anthropic, Companies House, and (optionally) GoHighLevel + Google Workspace.
6. Done.

## Why we use Terminal instead of double-click

Files transferred via AirDrop arrive with two macOS-defensive attributes that block direct double-click:

- `com.apple.quarantine` — Gatekeeper refuses to run unsigned binaries
- The executable bit gets stripped from `.command` files

Running through `bash` from Terminal sidesteps both. If you prefer to double-click in future, run this once after a fresh AirDrop:

```
xattr -dr com.apple.quarantine ~/Downloads/MissionControl-AdamBuild
chmod +x ~/Downloads/MissionControl-AdamBuild/"Install Mission Control.command"
```

## What the installer does

1. **Bundle freshness check** — verifies the `.app.zip` actually contains today's code (catches the "stale zip" trap from the 2026-04-30 deploy session). If anything fails, the installer aborts before touching `/Applications`.
2. **Homebrew** — installs if missing.
3. **Python 3.12** — installs via Homebrew if missing.
4. **OpenClaw** — Mission Control's AI engine; installed as a Homebrew cask.
5. **Backend Python packages** — pip-installs `uvicorn fastapi pydantic keyring anthropic` into the user's site-packages.
6. **Mission Control.app** — unzipped and moved to `/Applications`, quarantine flag stripped.
7. **Workspace template** — `~/.openclaw/workspace/` populated on a fresh Mac (preserves any local edits via `tar -k`).
8. **Launch** — opens Mission Control to the onboarding screen.

## After install — first-run checklist

In the running app, in this order:

1. **Personal chat** → type "hello, what's today's date?" — should respond. Confirms the Anthropic key.
2. **Settings → Companies House** → paste your CH API key → Save.
3. **Marketing chat** → "do you have my Companies House key set up?" — should reply *"Companies House: connected — fields stored: api_key"* (and **never** echo the key value itself).
4. **Marketing chat** → drag a CSV with a "Company Name" column → progress card should appear immediately. No "Process all" button, no "Setting up your workflow" modal. Downloaded CSV should have a "Companies House URL" column right after "Company Number".
5. **Settings → Google Workspace** → connect → Google login popup → grant calendar/email/sheets/docs scopes.
6. **Personal chat** → "what's on my calendar today?" — should return real events.

If any step fails, see Troubleshooting below.

## Troubleshooting

### "ModuleNotFoundError: No module named 'fastapi'" in backend log
The pip-install step in the installer didn't reach the right Python. Run:
```
/opt/homebrew/bin/python3.12 -m pip install --user uvicorn fastapi pydantic keyring anthropic
```
Then quit and re-launch Mission Control.

### Backend doesn't bind port 8001
Check what's holding the port:
```
lsof -iTCP:8001 -sTCP:LISTEN
```
If it's an old `uvicorn` process from a previous session, quit it. If empty but Mission Control still spins, tail the log:
```
tail -f ~/Library/Logs/Mission\ Control/main.log
```

### Marketing agent shows the old "Process all" button or "Pomanda" modal
Workspace SOUL hasn't been refreshed. Quit Mission Control then:
```
mv ~/.openclaw/workspace ~/.openclaw/workspace.preupgrade-$(date +%s)
mkdir -p ~/.openclaw/workspace
tar -xzkf ~/Downloads/MissionControl-AdamBuild/workspace-template.tgz -C ~/.openclaw/workspace
grep -c "enrichment.run" ~/.openclaw/workspace/agents/marketing/SOUL.md  # expect 4
open "/Applications/Mission Control.app"
```
Adam's Keychain credentials (Anthropic, CH, GHL, Google) survive this — only the workspace folder gets sidelined.

### "Bundle freshness check failed"
The zip in the folder doesn't match the v1.30.4 markers. Re-AirDrop from the build Mac, then re-run the install command.

### Anything else
The installer writes a log to `/tmp/mission-control-install-*.log` — send that to Joshua. The app's logs are at `~/Library/Logs/Mission Control/`.

## About Jackson's knowledge base

The installer lays down Jackson's starting knowledge base — agent briefs, skill definitions, and JSP operating rules. If you've customised anything previously (edited `SOUL.md`, added memory notes, etc.), the installer won't overwrite your changes. It only drops the template files on a fresh Mac, or fills in newly-added template files alongside your existing edits.
