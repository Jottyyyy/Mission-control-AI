#!/bin/bash
# Mission Control AI — one-double-click installer.
#
# Double-click this file and macOS opens it in Terminal. It:
#   1. Finds MissionControl.app.zip next to itself.
#   2. Installs Homebrew, Python 3.12, OpenClaw if missing.
#   3. Installs the Python packages the backend needs.
#   4. Unzips the app, strips quarantine, moves it to /Applications.
#   5. Launches it so Adam lands on the onboarding screen.
#
# Idempotent — running it a second time re-installs the app and skips
# anything already present.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INSTALL_LOG="/tmp/mission-control-install-$(date +%Y%m%d-%H%M%S).log"

# Mirror all output to the log so we have something to send Joshua on failure.
exec > >(tee -a "$INSTALL_LOG") 2>&1

# On any failure, tell the user where the log is and keep the window open so
# they can read it. Without this, `set -e` would close Terminal on error and
# leave them staring at a disappearing window.
handle_error() {
  local code=$?
  echo ""
  echo "=============================================="
  echo "  Install hit a snag (exit code $code)"
  echo "=============================================="
  echo ""
  echo "Full log: $INSTALL_LOG"
  echo ""
  echo "Send that file to Joshua and he'll take a look."
  echo ""
  read -r -p "Press Enter to close this window..." _
  exit "$code"
}
trap handle_error ERR

clear
cat <<'BANNER'

  +------------------------------------------+
  |                                          |
  |       Mission Control AI                 |
  |       Installer                          |
  |                                          |
  +------------------------------------------+

  This takes about 2-3 minutes on a fresh Mac
  (less if Homebrew and Python are already
  installed).

BANNER
echo "  Log: $INSTALL_LOG"
echo ""

# --- Locate the .app.zip next to this script --------------------------------
# Accept a few filename variants — OneDrive sometimes renames things on the
# way through, and we don't want to force Adam to rename anything by hand.
APP_ZIP=""
for candidate in \
    "$SCRIPT_DIR/MissionControl.app.zip" \
    "$SCRIPT_DIR"/*.app.zip \
    "$SCRIPT_DIR"/MissionControl*.zip; do
  if [ -f "$candidate" ]; then
    APP_ZIP="$candidate"
    break
  fi
done

if [ -z "$APP_ZIP" ]; then
  echo "ERROR: Couldn't find MissionControl.app.zip next to this installer."
  echo "       Looked in: $SCRIPT_DIR"
  echo ""
  echo "       Make sure both the .zip file and this .command file are in"
  echo "       the same folder, then double-click this installer again."
  echo ""
  read -r -p "Press Enter to close..." _
  exit 1
fi
echo "-> Found installer bundle: $(basename "$APP_ZIP")"
echo ""

# --- Bundle freshness guard (v1.30.4) ---------------------------------------
# Catches the failure mode from the 2026-04-30 deploy session where a zip
# from a previous build was sitting in the bundle folder and would have
# shipped pre-v1.30 code. The script asserts internal markers and SOUL
# content; if any check fails, we abort BEFORE touching /Applications so
# the user can re-AirDrop the right bundle.
GUARD="$SCRIPT_DIR/verify_bundle_fresh.sh"
if [ -f "$GUARD" ]; then
  echo "-> Verifying bundle freshness..."
  if ! bash "$GUARD" "$SCRIPT_DIR" 2>&1 | sed 's/^/   /'; then
    echo ""
    echo "ERROR: Bundle freshness check failed. The zip in this folder"
    echo "       does not contain the expected v1.30.4 markers."
    echo "       Re-AirDrop the bundle from the build Mac and try again."
    echo ""
    read -r -p "Press Enter to close..." _
    exit 1
  fi
else
  echo "   (verify_bundle_fresh.sh not present — skipping freshness check;"
  echo "    older bundles may not include this guard)"
fi
echo ""

# --- Homebrew ---------------------------------------------------------------
# Homebrew's own installer shells out to sudo and xcode-select. If Xcode
# command-line tools aren't present, macOS pops a GUI dialog that the user
# has to click through. We pass CI=1 to make the installer non-interactive
# where possible, but the first-time CLT install still requires a click.
if ! command -v brew >/dev/null 2>&1 && ! [ -x /opt/homebrew/bin/brew ]; then
  echo "-> Installing Homebrew..."
  echo "   (you may be asked for your Mac password — that's for Homebrew,"
  echo "   not us — type it when the cursor blinks; it stays invisible)"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
else
  echo "-> Homebrew already installed"
fi

# Make sure brew is on PATH for the rest of this shell.
if [ -x /opt/homebrew/bin/brew ]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
fi

# --- Python 3.12 ------------------------------------------------------------
if /opt/homebrew/bin/python3.12 --version >/dev/null 2>&1; then
  echo "-> Python 3.12 already installed"
else
  echo "-> Installing Python 3.12..."
  brew install python@3.12
fi

# --- OpenClaw (Homebrew cask — installs OpenClaw.app + /opt/homebrew/bin/openclaw) ---
if command -v openclaw >/dev/null 2>&1 || [ -x /opt/homebrew/bin/openclaw ]; then
  echo "-> OpenClaw already installed"
else
  echo "-> Installing OpenClaw (the AI engine that powers chat)..."
  brew install --cask openclaw
fi

# --- Python backend dependencies --------------------------------------------
# Homebrew Python is PEP-668-marked ("externally managed"). --user works on
# most installs; fall back to --break-system-packages if user-site is blocked.
echo "-> Installing backend Python packages..."
PY=/opt/homebrew/bin/python3.12
PIP_PACKAGES=(uvicorn fastapi pydantic keyring anthropic)
if ! "$PY" -m pip install --user --quiet "${PIP_PACKAGES[@]}" 2>/tmp/mc-pip.log; then
  echo "   --user failed, retrying with --break-system-packages..."
  "$PY" -m pip install --break-system-packages --quiet "${PIP_PACKAGES[@]}" 2>>/tmp/mc-pip.log
fi

# --- Unzip the .app into a temp dir -----------------------------------------
# ditto -x -k handles the Apple-specific archive format that preserves
# Framework symlinks inside the bundle. Using a tempdir keeps the handoff
# folder clean — no stray "Mission Control.app" appearing next to the zip.
echo "-> Unpacking Mission Control.app..."
UNZIP_TEMP="$(mktemp -d -t mc-install)"
# Clean the tempdir on normal exit AND on error, so a half-installed state
# doesn't leave gigabytes sitting in /tmp.
trap 'rm -rf "$UNZIP_TEMP"; handle_error' ERR
ditto -x -k "$APP_ZIP" "$UNZIP_TEMP"

APP_SOURCE="$UNZIP_TEMP/Mission Control.app"
if [ ! -d "$APP_SOURCE" ]; then
  echo "ERROR: Unzip completed but Mission Control.app wasn't inside."
  echo "       The .app.zip may be corrupted — re-download it from OneDrive."
  read -r -p "Press Enter to close..." _
  rm -rf "$UNZIP_TEMP"
  exit 1
fi

# --- Strip quarantine on the freshly extracted bundle -----------------------
# Safari / Mail / OneDrive all apply com.apple.quarantine to downloaded
# zips, which propagates to extracted contents. Strip on both the source and
# the final destination to cover both code paths.
echo "-> Removing macOS quarantine flag..."
xattr -dr com.apple.quarantine "$APP_SOURCE" 2>/dev/null || true

# --- If an old copy is running, quit it cleanly -----------------------------
# Moving over a running bundle works on macOS (launchd keeps handles open)
# but can leave the old backend on port 8001, which the new launch will have
# to kill. Quit proactively so we don't race with ourselves.
if pgrep -f "Mission Control.app/Contents/MacOS" >/dev/null 2>&1; then
  echo "-> Quitting the running Mission Control before replacing it..."
  osascript -e 'tell application "Mission Control" to quit' 2>/dev/null || true
  # Give it a moment to tear down the backend subprocess.
  sleep 2
fi

# --- Move to /Applications --------------------------------------------------
# /Applications is writable by admins on most installs — try without sudo
# first, fall back to sudo only if that fails. This saves Adam the password
# prompt on the common case.
APP_DEST="/Applications/Mission Control.app"
NEEDS_SUDO=0

if [ -d "$APP_DEST" ]; then
  echo "-> Removing previous install at $APP_DEST..."
  if ! rm -rf "$APP_DEST" 2>/dev/null; then
    NEEDS_SUDO=1
  fi
fi

if [ "$NEEDS_SUDO" = "1" ] || ! mv "$APP_SOURCE" "$APP_DEST" 2>/dev/null; then
  echo "-> Moving to Applications (type your Mac password if prompted)..."
  # Re-remove under sudo in case the earlier rm failed, then move.
  if [ -d "$APP_DEST" ]; then
    sudo rm -rf "$APP_DEST"
  fi
  sudo mv "$APP_SOURCE" "$APP_DEST"
else
  echo "-> Installed to /Applications"
fi

# Strip quarantine at the final destination too — downloaded-zip lineage
# sometimes sticks around after the move on APFS.
xattr -dr com.apple.quarantine "$APP_DEST" 2>/dev/null || \
  sudo xattr -dr com.apple.quarantine "$APP_DEST" 2>/dev/null || true

# --- Workspace template (first-run only) ------------------------------------
# Mission Control reads SKILL.md / SOUL.md / AGENTS.md out of
# ~/.openclaw/workspace/. On a fresh Mac those files don't exist, so every
# tool in the Connections tab 404s.
#
# We ship the snapshot in workspace-template.tgz and extract it ONLY if the
# sentinel file is missing. Picking the setup/google-workspace SKILL as the
# sentinel because it's the one file we know for sure gets fetched within
# seconds of the Connections tab loading — if it's present, the workspace
# has already been initialised (either by this installer, by a previous
# install, or by the user manually) and we must not touch anything.
WORKSPACE_DIR="$HOME/.openclaw/workspace"
WORKSPACE_MARKER="$WORKSPACE_DIR/agents/setup/skills/google-workspace/SKILL.md"
WORKSPACE_TGZ="$SCRIPT_DIR/workspace-template.tgz"

if [ ! -f "$WORKSPACE_TGZ" ]; then
  echo "-> Skipping workspace template (workspace-template.tgz not found next to installer)"
elif [ -f "$WORKSPACE_MARKER" ]; then
  echo "-> Knowledge base already present — leaving your files alone"
else
  echo "-> Installing Jackson's knowledge base..."
  mkdir -p "$WORKSPACE_DIR"
  tar -xzkf "$WORKSPACE_TGZ" -C "$WORKSPACE_DIR"
  echo "-> Knowledge base ready"
fi

# --- Cleanup ----------------------------------------------------------------
rm -rf "$UNZIP_TEMP"
trap handle_error ERR   # restore the simple error trap for the tail end

# --- Launch -----------------------------------------------------------------
echo ""
echo "=============================================="
echo "  Installation complete"
echo "=============================================="
echo ""
echo "Opening Mission Control now — finish setup in"
echo "the welcome screen (paste the API key Joshua"
echo "sent you)."
echo ""
open "$APP_DEST"

echo "This Terminal window will close in 10 seconds."
echo ""

# Fire the window-close in the background so the shell can actually exit.
# The `disown` detaches it from the shell's job table; without it the
# `sleep` would keep the exit handler hanging.
(
  sleep 10
  osascript -e 'tell application "Terminal" to close (every window whose name contains "Install Mission Control")' 2>/dev/null || true
) &
disown || true

exit 0
