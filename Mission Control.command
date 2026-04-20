#!/bin/bash
# Mission Control AI — One-click launcher
# Starts the FastAPI backend + Vite frontend, opens the dashboard in the browser,
# and tears everything down cleanly when the user hits Ctrl+C or closes the window.

# --- Colors for pretty output ----------------------------------------------
RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
BLUE=$'\033[0;34m'
YELLOW=$'\033[0;33m'
BOLD=$'\033[1m'
RESET=$'\033[0m'

info()    { printf "%s[i]%s %s\n" "$BLUE"  "$RESET" "$1"; }
success() { printf "%s[✓]%s %s\n" "$GREEN" "$RESET" "$1"; }
warn()    { printf "%s[!]%s %s\n" "$YELLOW" "$RESET" "$1"; }
error()   { printf "%s[✗]%s %s\n" "$RED"   "$RESET" "$1"; }

# --- Step 1: cd into the script's own directory so paths are stable --------
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR" || { error "Could not cd into $SCRIPT_DIR"; read -r -p "Press Enter to close..."; exit 1; }

# --- Config ---------------------------------------------------------------
PYTHON_BIN="/opt/homebrew/bin/python3.12"
OPENCLAW_BIN="/opt/homebrew/bin/openclaw"
BACKEND_PORT=8001
FRONTEND_PORT=5174
BACKEND_LOG="/tmp/mission-control-backend.log"
FRONTEND_LOG="/tmp/mission-control-frontend.log"
DASHBOARD_URL="http://localhost:${FRONTEND_PORT}"

# --- Step 2: preflight checks ---------------------------------------------
printf "\n%s╔══════════════════════════════════════════════════╗%s\n" "$BOLD" "$RESET"
printf "%s║        MISSION CONTROL AI — LAUNCHER             ║%s\n" "$BOLD" "$RESET"
printf "%s╚══════════════════════════════════════════════════╝%s\n\n" "$BOLD" "$RESET"

info "Running preflight checks..."

missing=0
if [ ! -f "backend/server.py" ]; then
  error "Missing: backend/server.py"
  missing=1
fi
if [ ! -f "package.json" ]; then
  error "Missing: package.json"
  missing=1
fi
if [ ! -x "$OPENCLAW_BIN" ]; then
  error "Missing or not executable: $OPENCLAW_BIN"
  missing=1
fi
if [ ! -x "$PYTHON_BIN" ]; then
  error "Missing or not executable: $PYTHON_BIN"
  missing=1
fi

if [ "$missing" -eq 1 ]; then
  error "Preflight failed. Fix the issues above and try again."
  read -r -p "Press Enter to close..."
  exit 1
fi
success "Preflight OK."

# --- Step 3: cleanup handler (runs on Ctrl+C or normal exit) --------------
BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
  printf "\n"
  info "Shutting down Mission Control..."
  if [ -n "$FRONTEND_PID" ] && kill -0 "$FRONTEND_PID" 2>/dev/null; then
    kill "$FRONTEND_PID" 2>/dev/null
    # also kill any child node/vite processes spawned by npm
    pkill -P "$FRONTEND_PID" 2>/dev/null
    success "Frontend stopped."
  fi
  if [ -n "$BACKEND_PID" ] && kill -0 "$BACKEND_PID" 2>/dev/null; then
    kill "$BACKEND_PID" 2>/dev/null
    success "Backend stopped."
  fi
  info "Logs preserved at:"
  printf "    %s\n    %s\n" "$BACKEND_LOG" "$FRONTEND_LOG"
  exit 0
}
trap cleanup INT TERM

# --- Step 4: start the FastAPI backend ------------------------------------
info "Starting FastAPI backend on port ${BACKEND_PORT}..."
(
  cd backend && \
  "$PYTHON_BIN" -m uvicorn server:app --host 127.0.0.1 --port "$BACKEND_PORT"
) > "$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!
sleep 3
if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
  error "Backend failed to start. Check $BACKEND_LOG"
  read -r -p "Press Enter to close..."
  exit 1
fi
success "Backend running (PID $BACKEND_PID)."

# --- Step 5: start the Vite dev server ------------------------------------
info "Starting Vite frontend on port ${FRONTEND_PORT}..."
npm run dev > "$FRONTEND_LOG" 2>&1 &
FRONTEND_PID=$!
sleep 5
if ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
  error "Frontend failed to start. Check $FRONTEND_LOG"
  cleanup
  exit 1
fi
success "Frontend running (PID $FRONTEND_PID)."

# --- Step 6: open the dashboard -------------------------------------------
info "Opening dashboard at $DASHBOARD_URL ..."
open "$DASHBOARD_URL"

# --- Step 7: status banner ------------------------------------------------
printf "\n%s────────────────────────────────────────────────────%s\n" "$BOLD" "$RESET"
printf "%s  MISSION CONTROL IS LIVE%s\n" "$GREEN$BOLD" "$RESET"
printf "%s────────────────────────────────────────────────────%s\n" "$BOLD" "$RESET"
printf "  Dashboard : %s%s%s\n"           "$BLUE" "$DASHBOARD_URL" "$RESET"
printf "  Backend   : %shttp://127.0.0.1:%s%s\n" "$BLUE" "$BACKEND_PORT" "$RESET"
printf "  OpenClaw  : %s%s%s (daemon)\n"  "$BLUE" "$OPENCLAW_BIN" "$RESET"
printf "\n"
printf "  Logs:\n"
printf "    backend  → %s\n" "$BACKEND_LOG"
printf "    frontend → %s\n" "$FRONTEND_LOG"
printf "\n"
printf "  %sPress Ctrl+C to stop everything and exit.%s\n" "$YELLOW" "$RESET"
printf "%s────────────────────────────────────────────────────%s\n\n" "$BOLD" "$RESET"

# --- Step 8: stay alive until the user quits ------------------------------
# macOS ships with bash 3.2, which doesn't support `wait -n`. We poll both
# PIDs every second instead. Ctrl+C still fires the `trap cleanup` above.
while true; do
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    warn "Backend exited unexpectedly. Check $BACKEND_LOG"
    cleanup
  fi
  if ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
    warn "Frontend exited unexpectedly. Check $FRONTEND_LOG"
    cleanup
  fi
  sleep 1
done
