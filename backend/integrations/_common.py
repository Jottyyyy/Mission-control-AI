"""Shared helpers for integration clients.

Kept as local copies of the helpers already defined in server.py so the
integration modules don't need to import from server (which would create a
circular dependency — server.py imports from this package)."""

from typing import Optional
import json
import urllib.error
import urllib.request

import keyring
import keyring.errors


KEYCHAIN_SERVICE = "mission-control-ai"


def _kc_get(tool_id: str, field: str) -> Optional[str]:
    try:
        return keyring.get_password(KEYCHAIN_SERVICE, f"{tool_id}:{field}")
    except keyring.errors.KeyringError:
        return None


def _http_json(
    method: str,
    url: str,
    *,
    headers: dict,
    body: Optional[bytes] = None,
    timeout: float = 8.0,
) -> tuple[int, dict]:
    req = urllib.request.Request(url, data=body, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw) if raw else {"error": str(e)}
        except ValueError:
            return e.code, {"error": raw.decode("utf-8", errors="replace")[:300]}
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return 0, {"error": str(e)}


def _error_from_status(status: int, body: dict, vendor: str) -> str:
    """Translate an HTTP status into a human-friendly error string."""
    if status == 0:
        return f"Couldn't reach {vendor}: {body.get('error', 'network error')}"
    if status in (401, 403):
        return f"{vendor} rejected the API key ({status}). Re-check the key and plan tier."
    if status == 429:
        return f"{vendor} rate-limited the request (429). Try again shortly."
    msg = body.get("message") or body.get("error") or body.get("detail")
    if isinstance(msg, dict):
        msg = msg.get("message") or str(msg)
    return msg or f"{vendor} returned HTTP {status}"
