"""Google Workspace OAuth — single-tenant authorization-code flow.

One OAuth client unlocks Calendar, Gmail, Drive, Sheets, and Docs in a single
consent screen. Tokens (access + refresh + expiry) live in macOS Keychain
under service="mission-control-ai" and account="google:<field>". Service
clients call `get_valid_access_token()` for every request — that helper owns
the refresh flow so callers never need to know whether the cached token is
still alive.

Distinct from the legacy `google-workspace` integration (different Keychain
namespace, different redirect URI) so the two coexist while we migrate the
older inline executors over to the new client modules.
"""

from __future__ import annotations

import json
import secrets
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from typing import Optional

from ._common import _kc_get, _http_json

import keyring
import keyring.errors


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

KEYCHAIN_SERVICE = "mission-control-ai"
TOOL_ID = "google"

# Adam runs the redirect URI on his backend's localhost — Google explicitly
# accepts loopback URLs without verification, which is what makes a desktop
# app workable. If the backend port ever moves off 8001, this constant + the
# matching `Authorized redirect URIs` entry in Cloud Console must change in
# lockstep.
REDIRECT_URI = "http://localhost:8001/auth/google/callback"

# Five workspace surfaces in one consent prompt. `userinfo.email` lets us
# stash the account address so the SetupModal can show "Connected as adam@…".
SCOPES = [
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/documents",
    "https://www.googleapis.com/auth/userinfo.email",
]

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo"

# Refresh `expires_at - REFRESH_LEEWAY_S` so a token mid-flight doesn't expire
# between the freshness check and the network round-trip.
REFRESH_LEEWAY_S = 30


# ---------------------------------------------------------------------------
# Keychain helpers — namespaced under "google:<field>"
# ---------------------------------------------------------------------------

def _kc_set(field: str, value: str) -> None:
    keyring.set_password(KEYCHAIN_SERVICE, f"{TOOL_ID}:{field}", value)


def _kc_del(field: str) -> None:
    try:
        keyring.delete_password(KEYCHAIN_SERVICE, f"{TOOL_ID}:{field}")
    except (keyring.errors.PasswordDeleteError, keyring.errors.KeyringError):
        pass


def _kc_field(field: str) -> Optional[str]:
    return _kc_get(TOOL_ID, field)


# ---------------------------------------------------------------------------
# State token store — the OAuth callback validates this so an attacker can't
# trick the backend into accepting a code minted for a different tab. We keep
# a tiny in-memory set rather than persisting; if the backend restarts mid-
# OAuth flow, Adam just has to click Authorize again.
# ---------------------------------------------------------------------------

_PENDING_STATES: set[str] = set()


def issue_state() -> str:
    s = secrets.token_urlsafe(24)
    _PENDING_STATES.add(s)
    return s


def consume_state(state: str) -> bool:
    """Returns True if the state was issued (and pops it). Single-use."""
    if state and state in _PENDING_STATES:
        _PENDING_STATES.discard(state)
        return True
    return False


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def has_client_credentials() -> bool:
    """True when Adam has saved the OAuth client_id + client_secret. Required
    before /auth/google/start can build a valid auth URL."""
    return bool(_kc_field("client_id") and _kc_field("client_secret"))


def is_connected() -> bool:
    """We treat a stored refresh_token as the source of truth — access_tokens
    expire and we can always mint a fresh one as long as the refresh is good."""
    return bool(_kc_field("refresh_token"))


def get_status() -> dict:
    """Public status surface used by the SetupModal poll loop."""
    return {
        "connected": is_connected(),
        "has_credentials": has_client_credentials(),
        "email": _kc_field("email"),
        "expires_at": _kc_field("expires_at"),
    }


def build_auth_url(state: str) -> Optional[str]:
    """Return the consent URL or None if client_id isn't stored yet."""
    client_id = _kc_field("client_id")
    if not client_id:
        return None
    params = urllib.parse.urlencode({
        "client_id": client_id,
        "redirect_uri": REDIRECT_URI,
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "access_type": "offline",       # send a refresh_token
        "prompt": "consent",            # force re-grant so refresh_token is reissued
        "include_granted_scopes": "true",
        "state": state,
    })
    return f"{AUTH_URL}?{params}"


def exchange_code_for_tokens(code: str) -> dict:
    """Exchange the authorization code for tokens and persist them.

    Side effect: writes access_token, refresh_token, expires_at, and email to
    Keychain. Returns {success, email?, error?}. Refresh tokens are sticky on
    Google's side — if Adam re-runs the flow without revoking, Google MAY
    omit refresh_token from the response, in which case we keep whatever we
    already had stashed."""
    client_id = _kc_field("client_id")
    client_secret = _kc_field("client_secret")
    if not (client_id and client_secret):
        return {"success": False, "error": "Client credentials missing — paste them first."}

    form = urllib.parse.urlencode({
        "code": code,
        "client_id": client_id,
        "client_secret": client_secret,
        "redirect_uri": REDIRECT_URI,
        "grant_type": "authorization_code",
    }).encode("utf-8")
    status, body = _http_json(
        "POST",
        TOKEN_URL,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        body=form,
        timeout=15.0,
    )
    if status != 200 or not isinstance(body, dict):
        msg = (body.get("error_description") or body.get("error") or f"HTTP {status}") if isinstance(body, dict) else f"HTTP {status}"
        return {"success": False, "error": str(msg)}

    access = body.get("access_token")
    if not access:
        return {"success": False, "error": "No access_token in Google response."}
    _kc_set("access_token", access)

    refresh = body.get("refresh_token")
    if refresh:
        _kc_set("refresh_token", refresh)

    expires_in = body.get("expires_in") or 3600
    try:
        ttl = int(expires_in)
    except (TypeError, ValueError):
        ttl = 3600
    expires_at = (datetime.utcnow() + timedelta(seconds=ttl)).isoformat(timespec="seconds")
    _kc_set("expires_at", expires_at)

    # Resolve email (best-effort — failure here doesn't break the connect flow).
    email = _fetch_userinfo_email(access)
    if email:
        _kc_set("email", email)

    return {"success": True, "email": email}


def refresh_access_token() -> Optional[str]:
    """Mint a new access_token from the stored refresh_token. Returns the new
    token or None on failure. Updates Keychain in place."""
    refresh = _kc_field("refresh_token")
    client_id = _kc_field("client_id")
    client_secret = _kc_field("client_secret")
    if not (refresh and client_id and client_secret):
        return None
    form = urllib.parse.urlencode({
        "grant_type": "refresh_token",
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh,
    }).encode("utf-8")
    status, body = _http_json(
        "POST",
        TOKEN_URL,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        body=form,
        timeout=15.0,
    )
    if status != 200 or not isinstance(body, dict):
        return None
    new_access = body.get("access_token")
    if not new_access:
        return None
    _kc_set("access_token", new_access)
    expires_in = body.get("expires_in") or 3600
    try:
        ttl = int(expires_in)
    except (TypeError, ValueError):
        ttl = 3600
    _kc_set("expires_at", (datetime.utcnow() + timedelta(seconds=ttl)).isoformat(timespec="seconds"))
    # If Google rotated the refresh_token (rare for desktop clients but
    # possible) capture the new one.
    new_refresh = body.get("refresh_token")
    if new_refresh:
        _kc_set("refresh_token", new_refresh)
    return new_access


def get_valid_access_token() -> Optional[str]:
    """Return a token guaranteed to be live for the next ~30 seconds.

    Skips the refresh roundtrip when the cached token is still fresh, so a
    burst of read calls in one chat turn doesn't multiply OAuth traffic."""
    access = _kc_field("access_token")
    expires_raw = _kc_field("expires_at")
    if access and expires_raw:
        try:
            expires_at = datetime.fromisoformat(expires_raw)
            if expires_at - datetime.utcnow() > timedelta(seconds=REFRESH_LEEWAY_S):
                return access
        except ValueError:
            pass
    return refresh_access_token()


def disconnect() -> None:
    """Wipe everything Google-related from Keychain.

    Leaves client_id and client_secret in place — those are the OAuth client
    config, not Adam's session. If he wants to fully reset he can delete via
    /integrations/google/credentials DELETE (a separate concern)."""
    for f in ("access_token", "refresh_token", "expires_at", "email"):
        _kc_del(f)


def hard_disconnect() -> None:
    """Wipe session AND client config. Used when Adam wants to forget the
    Cloud Console project entirely (e.g. rotating a leaked secret)."""
    disconnect()
    for f in ("client_id", "client_secret"):
        _kc_del(f)


def _fetch_userinfo_email(access_token: str) -> Optional[str]:
    """Best-effort lookup of the connected account's email."""
    status, body = _http_json(
        "GET",
        USERINFO_URL,
        headers={"Authorization": f"Bearer {access_token}"},
        timeout=10.0,
    )
    if status == 200 and isinstance(body, dict):
        return body.get("email")
    return None


# ---------------------------------------------------------------------------
# Shared helper for service modules — returns (token, error_dict_or_None).
# Service modules call this and short-circuit when error_dict is set so the
# needs_setup signal makes it back to the chat surface.
# ---------------------------------------------------------------------------

def _not_configured(context: str) -> dict:
    return {
        "error": "Google not connected",
        "needs_setup": {"tools": ["google"], "context": context},
    }


def access_or_error(context: str) -> tuple[Optional[str], Optional[dict]]:
    """Resolve a live access token or return a needs_setup error dict.

    `context` is shown verbatim in the SetupModal subtitle, so phrase it so
    "to <context>" reads naturally — e.g. "to read your calendar"."""
    if not is_connected():
        return None, _not_configured(context)
    token = get_valid_access_token()
    if not token:
        return None, _not_configured(context)
    return token, None
