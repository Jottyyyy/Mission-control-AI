"""Google Docs v1 client — create, get, update.

Docs's REST API splits creation (sets the title only) from content insertion
(a `batchUpdate` of structural mutations). For v1 we expose `create_doc(title,
content)` that does both in sequence and `update_doc(doc_id, content)` that
replaces the body via a single delete+insert pair."""

from __future__ import annotations

import json
from typing import Optional

from . import google_oauth
from ._common import _http_json


BASE = "https://docs.googleapis.com/v1"
TIMEOUT = 15.0
SERVICE_KEY = "docs"


def _authed_request(
    method: str,
    url: str,
    *,
    context: str,
    body: Optional[dict] = None,
) -> tuple[int, dict, Optional[dict]]:
    token, err = google_oauth.access_or_error(context)
    if err:
        return 0, {}, err["needs_setup"]
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
        return f"Couldn't reach Google Docs: {body.get('error', 'network error')}"
    if status == 403:
        api = google_oauth.detect_api_not_enabled(body, SERVICE_KEY)
        if api:
            return f"{api['service_label']} isn't enabled in your Google Cloud project."
    err = body.get("error") if isinstance(body, dict) else None
    if isinstance(err, dict):
        return err.get("message") or f"HTTP {status}"
    return f"HTTP {status}"


def _failure(base: dict, status: int, body: dict) -> dict:
    out = {**base, "error": _err(status, body)}
    api = google_oauth.detect_api_not_enabled(body, SERVICE_KEY)
    if api:
        out["needs_api_enable"] = api
    return out


def create_doc(title: str, content: Optional[str] = None) -> dict:
    """Create a new Google Doc. Optionally seed it with `content`.

    Two-call sequence: POST /documents creates an empty doc; if content is
    supplied, batchUpdate inserts it at index 1 (the very start of the body).
    Returns {success, doc_id?, url?, error?}."""
    if not title:
        return {"success": False, "doc_id": None, "url": None, "error": "Missing title"}
    status, body, needs = _authed_request(
        "POST", f"{BASE}/documents",
        context="to create a Google Doc",
        body={"title": title},
    )
    if needs:
        return {"success": False, "doc_id": None, "url": None,
                "error": "Google not connected", "needs_setup": needs}
    if status not in (200, 201) or not isinstance(body, dict):
        return _failure({"success": False, "doc_id": None, "url": None}, status, body)
    doc_id = body.get("documentId")
    if not doc_id:
        return {"success": False, "doc_id": None, "url": None, "error": "No documentId in response."}

    if content:
        # First batchUpdate seeds content. Failure here keeps the (empty) doc
        # — surface the error so Adam can retry, but report success on the
        # creation itself.
        u_status, u_body, _ = _authed_request(
            "POST", f"{BASE}/documents/{doc_id}:batchUpdate",
            context="to write content to a Google Doc",
            body={"requests": [{"insertText": {"location": {"index": 1}, "text": content}}]},
        )
        if u_status not in (200, 201):
            return {
                "success": True,  # doc exists, content insert failed
                "doc_id": doc_id,
                "url": f"https://docs.google.com/document/d/{doc_id}/edit",
                "title": title,
                "error": f"Doc created but content insert failed: {_err(u_status, u_body)}",
            }

    return {
        "success": True,
        "doc_id": doc_id,
        "url": f"https://docs.google.com/document/d/{doc_id}/edit",
        "title": body.get("title") or title,
        "error": None,
    }


def get_doc(doc_id: str) -> dict:
    """Read a doc's title + plain text rendering of the body."""
    if not doc_id:
        return {"found": False, "title": None, "content": None, "error": "Missing doc_id"}
    status, body, needs = _authed_request("GET", f"{BASE}/documents/{doc_id}", context="to read a Google Doc")
    if needs:
        return {"found": False, "title": None, "content": None,
                "error": "Google not connected", "needs_setup": needs}
    if status != 200 or not isinstance(body, dict):
        return _failure({"found": False, "title": None, "content": None}, status, body)
    return {
        "found": True,
        "doc_id": body.get("documentId"),
        "title": body.get("title"),
        "content": _flatten_doc_text(body.get("body") or {}),
        "url": f"https://docs.google.com/document/d/{body.get('documentId')}/edit",
        "error": None,
    }


def _flatten_doc_text(doc_body: dict) -> str:
    """Walk a Docs body's `content` array and concatenate textRun strings.

    Doesn't reproduce headings / bullets / tables verbatim — Adam reads the
    output as a chat-friendly summary, not a fully styled render."""
    out: list[str] = []
    content = doc_body.get("content") if isinstance(doc_body, dict) else None
    if not isinstance(content, list):
        return ""
    for el in content:
        para = el.get("paragraph") if isinstance(el, dict) else None
        if not isinstance(para, dict):
            continue
        elems = para.get("elements") or []
        line = "".join(
            (e.get("textRun") or {}).get("content") or ""
            for e in elems
            if isinstance(e, dict)
        )
        if line:
            out.append(line)
    return "".join(out)


def update_doc(doc_id: str, content: str) -> dict:
    """Replace the entire body with `content`.

    Strategy: read the current end index, delete from 1 to (end-1), then
    insert the new content at index 1. Two requests in a single batchUpdate
    so the operations are atomic from Docs's perspective."""
    if not doc_id:
        return {"success": False, "error": "Missing doc_id"}
    if content is None:
        return {"success": False, "error": "Missing content"}

    # Fetch the existing doc to discover its end index.
    g_status, g_body, needs = _authed_request("GET", f"{BASE}/documents/{doc_id}", context="to update a Google Doc")
    if needs:
        return {"success": False, "error": "Google not connected", "needs_setup": needs}
    if g_status != 200 or not isinstance(g_body, dict):
        return _failure({"success": False}, g_status, g_body)

    body_section = g_body.get("body") or {}
    contents = body_section.get("content") or []
    end_index = 1
    if isinstance(contents, list) and contents:
        last = contents[-1]
        if isinstance(last, dict):
            end_index = int(last.get("endIndex") or 1)

    requests: list[dict] = []
    # Delete current body if there's anything beyond the implicit start.
    if end_index > 2:
        requests.append({
            "deleteContentRange": {
                "range": {"startIndex": 1, "endIndex": end_index - 1}
            }
        })
    requests.append({"insertText": {"location": {"index": 1}, "text": content}})

    u_status, u_body, _ = _authed_request(
        "POST", f"{BASE}/documents/{doc_id}:batchUpdate",
        context="to update a Google Doc",
        body={"requests": requests},
    )
    if u_status not in (200, 201):
        return _failure({"success": False}, u_status, u_body)
    return {
        "success": True,
        "doc_id": doc_id,
        "url": f"https://docs.google.com/document/d/{doc_id}/edit",
        "error": None,
    }
