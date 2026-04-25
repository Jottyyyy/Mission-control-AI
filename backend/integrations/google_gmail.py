"""Google Gmail v1 client — list, get, send.

Gmail's REST shape is unusual: messages list returns IDs only, so we batch a
metadata fetch alongside to surface From/Subject/snippet for the chat layer.
For send we build a base64url-encoded RFC 5322 message because that's what
the API expects."""

from __future__ import annotations

import base64
import json
from email.message import EmailMessage
from typing import Optional

from . import google_oauth
from ._common import _http_json


BASE = "https://gmail.googleapis.com/gmail/v1/users/me"
TIMEOUT = 12.0


def _authed_request(
    method: str,
    path: str,
    *,
    context: str,
    params: Optional[dict] = None,
    body: Optional[dict] = None,
) -> tuple[int, dict, Optional[dict]]:
    token, err = google_oauth.access_or_error(context)
    if err:
        return 0, {}, err["needs_setup"]
    url = BASE + path
    if params:
        from urllib.parse import urlencode
        clean = {k: v for k, v in params.items() if v not in (None, "")}
        if clean:
            url = f"{url}?{urlencode(clean, doseq=True)}"
    payload = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    status, resp = _http_json(method, url, headers=headers, body=payload, timeout=TIMEOUT)
    if status == 401:
        new_token = google_oauth.refresh_access_token()
        if new_token:
            headers["Authorization"] = f"Bearer {new_token}"
            status, resp = _http_json(method, url, headers=headers, body=payload, timeout=TIMEOUT)
    return status, resp, None


def _err(status: int, body: dict) -> str:
    if status == 0:
        return f"Couldn't reach Gmail: {body.get('error', 'network error')}"
    err = body.get("error") if isinstance(body, dict) else None
    if isinstance(err, dict):
        return err.get("message") or f"HTTP {status}"
    return f"HTTP {status}"


def _header_value(headers: list[dict], name: str) -> Optional[str]:
    for h in headers or []:
        if isinstance(h, dict) and (h.get("name") or "").lower() == name.lower():
            return h.get("value")
    return None


def _normalise_summary(msg_id: str, meta: dict) -> dict:
    """Build a list-row entry from a `format=metadata` fetch."""
    payload = meta.get("payload") if isinstance(meta, dict) else None
    headers = (payload or {}).get("headers") or []
    return {
        "id": msg_id,
        "thread_id": meta.get("threadId"),
        "subject": _header_value(headers, "Subject") or "(no subject)",
        "from": _header_value(headers, "From"),
        "to": _header_value(headers, "To"),
        "date": _header_value(headers, "Date"),
        "snippet": meta.get("snippet"),
        "label_ids": meta.get("labelIds") or [],
    }


def list_messages(query: str = "is:inbox", max_results: int = 20) -> dict:
    """List messages matching a Gmail search query.

    The list endpoint only returns IDs — we then issue a metadata fetch per
    message. For 20 messages that's ~21 round-trips total; fine for a chat
    request, slow for batch jobs (out of scope here)."""
    max_results = max(1, min(int(max_results or 20), 50))
    params = {"q": query or "is:inbox", "maxResults": max_results}
    status, body, needs = _authed_request("GET", "/messages", context="to read your inbox", params=params)
    if needs:
        return {"found": False, "messages": [], "error": "Google not connected", "needs_setup": needs}
    if status != 200:
        return {"found": False, "messages": [], "error": _err(status, body)}
    ids = [m.get("id") for m in (body.get("messages") or []) if isinstance(m, dict) and m.get("id")]
    summaries: list[dict] = []
    for mid in ids:
        s, mbody, _n = _authed_request(
            "GET", f"/messages/{mid}",
            context="to read your inbox",
            params={"format": "metadata", "metadataHeaders": ["Subject", "From", "To", "Date"]},
        )
        if s == 200 and isinstance(mbody, dict):
            summaries.append(_normalise_summary(mid, mbody))
    return {"found": bool(summaries), "messages": summaries, "error": None}


def get_message(message_id: str) -> dict:
    if not message_id:
        return {"found": False, "message": None, "error": "Missing message_id"}
    status, body, needs = _authed_request(
        "GET", f"/messages/{message_id}",
        context="to read an email",
        params={"format": "full"},
    )
    if needs:
        return {"found": False, "message": None, "error": "Google not connected", "needs_setup": needs}
    if status != 200:
        return {"found": False, "message": None, "error": _err(status, body)}
    payload = body.get("payload") if isinstance(body, dict) else None
    headers = (payload or {}).get("headers") or []
    text = _extract_plaintext(payload)
    return {
        "found": True,
        "message": {
            "id": body.get("id"),
            "thread_id": body.get("threadId"),
            "subject": _header_value(headers, "Subject") or "(no subject)",
            "from": _header_value(headers, "From"),
            "to": _header_value(headers, "To"),
            "date": _header_value(headers, "Date"),
            "snippet": body.get("snippet"),
            "body_text": text,
            "label_ids": body.get("labelIds") or [],
        },
        "error": None,
    }


def _extract_plaintext(payload: Optional[dict]) -> str:
    """Walk a Gmail MIME tree looking for text/plain. Returns "" on failure."""
    if not isinstance(payload, dict):
        return ""
    mime = payload.get("mimeType") or ""
    body = payload.get("body") or {}
    data = body.get("data")
    if mime.startswith("text/plain") and data:
        try:
            return base64.urlsafe_b64decode(data + "==").decode("utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            return ""
    parts = payload.get("parts") or []
    for p in parts:
        out = _extract_plaintext(p)
        if out:
            return out
    # Fall through to text/html if no plain part exists.
    if mime.startswith("text/html") and data:
        try:
            return base64.urlsafe_b64decode(data + "==").decode("utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            return ""
    return ""


def send_message(
    to: str,
    subject: str,
    body: str,
    *,
    cc: Optional[str] = None,
    bcc: Optional[str] = None,
) -> dict:
    """Send a plain-text email from Adam's account."""
    msg = EmailMessage()
    msg["To"] = to
    if cc:
        msg["Cc"] = cc
    if bcc:
        msg["Bcc"] = bcc
    msg["Subject"] = subject or ""
    msg.set_content(body or "")
    raw = base64.urlsafe_b64encode(msg.as_bytes()).decode("ascii")

    status, resp, needs = _authed_request(
        "POST",
        "/messages/send",
        context="to send an email",
        body={"raw": raw},
    )
    if needs:
        return {"success": False, "message_id": None,
                "error": "Google not connected", "needs_setup": needs}
    if status not in (200, 201):
        return {"success": False, "message_id": None, "error": _err(status, resp)}
    return {
        "success": True,
        "message_id": resp.get("id"),
        "thread_id": resp.get("threadId"),
        "error": None,
    }
