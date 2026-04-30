#!/bin/bash
# scripts/verify_bundle_fresh.sh
# ----------------------------------------------------------------------------
# v1.30.4 — pre-deploy guard against shipping a stale MissionControl.app.zip.
#
# Two contexts this runs in:
#
# 1. BUILD MAC (full check): zip mtime ≥ dist-electron .app mtime AND content
#    grep AND SOUL grep all asserted.
#
# 2. TARGET MAC, called by `Install Mission Control.command` before extract:
#    only the bundle-internal checks run (zip exists + content grep + SOUL
#    grep). The dist-electron mtime check is skipped silently because that
#    folder doesn't exist on the target.
#
# Usage:
#   bash verify_bundle_fresh.sh                # auto-detect bundle dir
#   bash verify_bundle_fresh.sh <bundle-dir>   # explicit bundle dir
#
# Exits 0 on PASS. Exits non-zero with a clear reason on FAIL.

set -e

# Bundle dir resolution: explicit arg wins; otherwise prefer
# <script_parent>/MissionControl-AdamBuild (build-mac default), and if
# that doesn't exist, try <script_parent> itself (the install command
# ships a copy of this script INSIDE the bundle).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -n "$1" ]; then
  BUNDLE="$1"
elif [ -d "$SCRIPT_DIR/../MissionControl-AdamBuild" ]; then
  BUNDLE="$(cd "$SCRIPT_DIR/../MissionControl-AdamBuild" && pwd)"
elif [ -f "$SCRIPT_DIR/MissionControl.app.zip" ]; then
  BUNDLE="$SCRIPT_DIR"
else
  echo "❌ STALE — could not locate MissionControl-AdamBuild folder. Pass the bundle dir as the first arg."
  exit 1
fi

ZIP="$BUNDLE/MissionControl.app.zip"
TGZ="$BUNDLE/workspace-template.tgz"
# Try repo-root inference for the dist-electron mtime check (build-mac only).
REPO_ROOT="$(cd "$BUNDLE/.." 2>/dev/null && pwd)"
DIST_APP="$REPO_ROOT/dist-electron/mac-arm64/Mission Control.app"

WORKDIR=$(mktemp -d -t mc-bundle-check)
trap 'rm -rf "$WORKDIR"' EXIT

fail() {
  echo "❌ STALE — $1"
  exit 1
}

pass() {
  echo "  ✓ $1"
}

echo "=== bundle freshness check ==="
echo "bundle: $BUNDLE"

# --- 0. Files exist ---------------------------------------------------------
[ -f "$ZIP" ] || fail "$ZIP missing"
[ -f "$TGZ" ] || fail "$TGZ missing"
pass "zip + tgz present"

# --- 1. zip mtime vs dist-electron mtime (build mac only) -------------------
if [ -d "$DIST_APP" ]; then
  ZIP_MTIME=$(stat -f "%m" "$ZIP")
  APP_MTIME=$(stat -f "%m" "$DIST_APP")
  if [ "$ZIP_MTIME" -lt "$APP_MTIME" ]; then
    fail "zip ($(date -r "$ZIP_MTIME" '+%F %T')) is OLDER than dist-electron .app ($(date -r "$APP_MTIME" '+%F %T')). Re-run ditto."
  fi
  pass "zip newer than dist-electron .app"
else
  echo "  - dist-electron .app not present (target-mac context, skipping mtime check)"
fi

# --- 2. zip contents grep — v1.30.3 + v1.30.4 markers -----------------------
APP_NAME="Mission Control.app"
ENRICHER_PATH="$APP_NAME/Contents/Resources/app/backend/enrichment/companies_house_enricher.py"
SERVER_PATH="$APP_NAME/Contents/Resources/app/backend/server.py"

unzip -q -o "$ZIP" "$ENRICHER_PATH" "$SERVER_PATH" -d "$WORKDIR" \
  || fail "couldn't extract backend files from zip — corrupt zip?"

CH_HITS=$(grep -c "Companies House URL" "$WORKDIR/$ENRICHER_PATH" || true)
[ "$CH_HITS" -ge 1 ] || fail "'Companies House URL' missing from companies_house_enricher.py (got $CH_HITS, expected ≥1)"
pass "v1.30.3 'Companies House URL' present (×$CH_HITS) in enricher"

ENRICHRUN_HITS=$(grep -c "enrichment\\.run" "$WORKDIR/$SERVER_PATH" || true)
[ "$ENRICHRUN_HITS" -ge 1 ] || fail "'enrichment.run' handler missing from server.py (got $ENRICHRUN_HITS, expected ≥1)"
pass "v1.30 'enrichment.run' present (×$ENRICHRUN_HITS) in server"

INTSTATUS_HITS=$(grep -c "_read_integration_status" "$WORKDIR/$SERVER_PATH" || true)
[ "$INTSTATUS_HITS" -ge 1 ] || fail "v1.30.4 'integration.status' read-action missing from server.py (got $INTSTATUS_HITS)"
pass "v1.30.4 '_read_integration_status' present (×$INTSTATUS_HITS) in server"

SCRUBOUT_HITS=$(grep -c "_scrub_outbound" "$WORKDIR/$SERVER_PATH" || true)
[ "$SCRUBOUT_HITS" -ge 1 ] || fail "v1.30.4 outbound scrubber missing from server.py (got $SCRUBOUT_HITS)"
pass "v1.30.4 '_scrub_outbound' present (×$SCRUBOUT_HITS) in server"

# --- 3. workspace-template.tgz SOUL grep ------------------------------------
SOUL_HITS=$(tar -xzOf "$TGZ" agents/marketing/SOUL.md 2>/dev/null | grep -c "enrichment.run" || true)
[ "$SOUL_HITS" -ge 4 ] || fail "Marketing SOUL inside tgz has only $SOUL_HITS 'enrichment.run' mentions — expected ≥4. Tgz is stale."
pass "Marketing SOUL: 'enrichment.run' present (×$SOUL_HITS)"

INT_HITS=$(tar -xzOf "$TGZ" agents/marketing/SOUL.md 2>/dev/null | grep -c "integration.status" || true)
[ "$INT_HITS" -ge 1 ] || fail "Marketing SOUL inside tgz missing 'integration.status' rule (v1.30.4) — got $INT_HITS"
pass "Marketing SOUL: 'integration.status' rule present (×$INT_HITS)"

# --- 4. zip size sanity check -----------------------------------------------
ZIP_SIZE=$(stat -f "%z" "$ZIP")
ZIP_MIB=$((ZIP_SIZE / 1024 / 1024))
if [ "$ZIP_MIB" -lt 50 ]; then
  fail "zip is suspiciously small ($ZIP_MIB MiB, expected ~90 MiB) — likely empty or corrupted"
fi
pass "zip size: ${ZIP_MIB} MiB (sanity OK)"

echo ""
echo "✅ bundle fresh — safe to deploy"
