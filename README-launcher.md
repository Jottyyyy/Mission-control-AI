# Mission Control AI — One-Click Launcher

## What it does

`Mission Control.command` starts the entire Mission Control stack with a
single double-click:

1. **FastAPI backend** — `backend/server.py` on `http://127.0.0.1:8001`
2. **Vite frontend** — `npm run dev` on `http://localhost:5174`
3. **Dashboard** — auto-opens in your default browser
4. **OpenClaw** — already runs as a global daemon (the launcher just
   verifies the binary is present at `/opt/homebrew/bin/openclaw`)

The launcher keeps the Terminal window alive so you can see status and
logs, and shuts everything down cleanly when you quit.

## How to use it

**Option A — double-click in Finder**
1. Open Finder and navigate to `~/Documents/GitHub/Mission-control-AI`
2. Double-click **`Mission Control.command`**
3. A Terminal window opens, the stack boots, and your browser pops open
   on the dashboard.

**Option B — keep it in the Dock**
1. Drag `Mission Control.command` onto the right side of your Dock
   (next to the Trash). Now one Dock click launches the whole stack.

**Option C — from the Terminal**
```bash
cd ~/Documents/GitHub/Mission-control-AI
./"Mission Control.command"
```

## How to stop it

- **Ctrl+C** in the Terminal window that the launcher opened — this
  kills the backend and frontend cleanly.
- **Close the Terminal window** — macOS will prompt you to confirm;
  choose "Terminate". The cleanup trap still runs.

You should **not** have any leftover node/uvicorn processes after
quitting. If you ever do, run:
```bash
pkill -f "uvicorn server:app"
pkill -f "vite"
```

## Where are the logs?

- Backend: `/tmp/mission-control-backend.log`
- Frontend: `/tmp/mission-control-frontend.log`

Both files are overwritten on each launch. Tail them live with:
```bash
tail -f /tmp/mission-control-backend.log
tail -f /tmp/mission-control-frontend.log
```

## Troubleshooting

### "Port already in use"
Something is already running on 8001 or 5174. Find and kill it:
```bash
lsof -iTCP:8001 -sTCP:LISTEN
lsof -iTCP:5174 -sTCP:LISTEN
kill <PID>
```

### "Missing: backend/server.py" or similar
The launcher's preflight check found a missing file. Make sure you're
running the launcher from inside the project folder and that the repo
is intact. A fresh `git status` will show what's off.

### "command not found: npm"
Node.js isn't installed or isn't on your PATH. Install Node (we
recommend via Homebrew: `brew install node`), then try again.

### "Missing or not executable: /opt/homebrew/bin/python3.12"
Python 3.12 isn't installed via Homebrew. Install it:
```bash
brew install python@3.12
```

### "Missing or not executable: /opt/homebrew/bin/openclaw"
OpenClaw isn't installed globally. Reinstall it per the OpenClaw setup
instructions so the binary lands at `/opt/homebrew/bin/openclaw`.

### Backend starts but dashboard shows errors
Check `/tmp/mission-control-backend.log` for Python tracebacks. The
SQLite DB lives at `data/assistant.db` — if it's corrupt or missing,
the backend will log that on startup.

### Frontend shows a blank page
Check `/tmp/mission-control-frontend.log` for Vite build errors. If
dependencies look off, re-install them:
```bash
cd ~/Documents/GitHub/Mission-control-AI
npm install
```

## Notes

- The launcher uses absolute paths for Python and OpenClaw
  (`/opt/homebrew/bin/...`), which matches a standard Apple-silicon
  Homebrew setup. Intel Macs with Homebrew at `/usr/local/bin` would
  need the paths adjusted.
- Ports are hard-coded: **8001** (backend) and **5174** (frontend).
- Phase 2 will wrap this in an Electron app with its own dock icon and
  window. For now, the `.command` file + browser is the supported
  workflow.
