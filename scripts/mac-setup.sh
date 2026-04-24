#!/bin/bash
# Mission Control — Mac Mini setup
# Run once before first launch.
#
# Usage (from inside the MissionControl-AdamBuild folder):
#   bash mac-setup.sh

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
APP_NAME="Mission Control.app"
APP_PATH="$SCRIPT_DIR/$APP_NAME"

# --- Unzip the app if needed ------------------------------------------------
# We ship the .app inside a ditto-zip because OneDrive / Dropbox / Google Drive
# often corrupt .app bundles in-transit (they flatten the Versions/ symlinks
# inside .framework directories). Unzipping with ditto on the destination Mac
# rehydrates the bundle exactly as it was built.
#
# We accept any *.app.zip in the script's directory — OneDrive sometimes
# renames files (e.g. "MissionControl.app (1).zip") and we don't want to
# require an exact filename match.
if [ ! -d "$APP_PATH" ]; then
  APP_ZIP=""
  for candidate in "$SCRIPT_DIR"/*.app.zip "$SCRIPT_DIR"/MissionControl*.zip; do
    if [ -f "$candidate" ]; then
      APP_ZIP="$candidate"
      break
    fi
  done
  if [ -z "$APP_ZIP" ]; then
    echo "ERROR: Could not find $APP_NAME or any *.app.zip in $SCRIPT_DIR"
    echo "Files I can see in this directory:"
    ls -la "$SCRIPT_DIR"
    echo
    echo "If MissionControl.app.zip shows in Finder but isn't listed above,"
    echo "it's a OneDrive cloud-only stub. Right-click it in Finder ->"
    echo "\"Always Keep on This Device\" or \"Download Now\", wait for the"
    echo "green checkmark, then re-run this script."
    exit 1
  fi
  echo "Extracting Mission Control.app from $(basename "$APP_ZIP")..."
  ditto -x -k "$APP_ZIP" "$SCRIPT_DIR"
fi

# --- Strip macOS quarantine -------------------------------------------------
# Anything downloaded from the internet (Safari, Mail, OneDrive) is marked with
# com.apple.quarantine, which makes Gatekeeper block opening. Strip it.
echo "Removing quarantine attribute..."
xattr -dr com.apple.quarantine "$APP_PATH" 2>/dev/null || true
xattr -d  com.apple.quarantine "$SCRIPT_DIR/mac-setup.sh" 2>/dev/null || true

# --- Homebrew ---------------------------------------------------------------
if ! command -v brew &> /dev/null && ! [ -x /opt/homebrew/bin/brew ]; then
  echo "Installing Homebrew (you'll be prompted for your password)..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi

# Make sure brew is on PATH for this shell session.
if [ -x /opt/homebrew/bin/brew ]; then
  eval "$(/opt/homebrew/bin/brew shellenv)"
fi

# --- Python 3.12 ------------------------------------------------------------
if ! /opt/homebrew/bin/python3.12 --version &> /dev/null; then
  echo "Installing Python 3.12..."
  brew install python@3.12
fi

# --- OpenClaw CLI -----------------------------------------------------------
# Mission Control's chat backend shells out to /opt/homebrew/bin/openclaw.
# Without it, every chat message returns a 500 and the UI shows
# "Something went wrong". OpenClaw is a Homebrew cask.
if ! command -v openclaw &> /dev/null && ! [ -x /opt/homebrew/bin/openclaw ]; then
  echo "Installing OpenClaw (this is what powers chat)..."
  brew install --cask openclaw
fi

# --- Backend dependencies ---------------------------------------------------
echo "Installing Mission Control backend dependencies..."
PY=/opt/homebrew/bin/python3.12

# Try the fast path: install for the current user, no system-wide perms needed.
if ! "$PY" -m pip install --user \
      uvicorn fastapi pydantic keyring anthropic 2>/tmp/mc-pip.log; then
  echo "User install failed, retrying with --break-system-packages..."
  if ! "$PY" -m pip install --break-system-packages \
        uvicorn fastapi pydantic keyring anthropic 2>>/tmp/mc-pip.log; then
    echo
    echo "ERROR: pip install failed. See /tmp/mc-pip.log for details."
    echo "If you see a permission error, try:"
    echo "    sudo /opt/homebrew/bin/python3.12 -m pip install \\"
    echo "      --break-system-packages \\"
    echo "      uvicorn fastapi pydantic keyring anthropic"
    exit 1
  fi
fi

echo
echo "==========================================================="
echo "  Done. Almost ready — one manual step left."
echo "==========================================================="
echo
echo "1. Initialize OpenClaw (interactive, takes 1-2 minutes):"
echo
echo "       openclaw setup"
echo
echo "   Follow the prompts to sign in / configure credentials."
echo
echo "2. Then launch Mission Control:"
echo
echo "       The app is at: $APP_PATH"
echo "       Drag it into your Applications folder and double-click."
echo
echo "If chat shows \"Something went wrong\", open OpenClaw.app once from"
echo "Applications and complete its first-run flow, then try chat again."
