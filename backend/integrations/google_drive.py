"""Google Drive v3 client — list, get, search, create.

Drive's `q` query language drives both list and search. We expose `list_files`
for "show me recent files" and `search_files` for "find anything matching X"."""

from __future__ import annotations

import json
from typing import Optional

from . import google_oauth
from ._common import _http_json


BASE = "https://www.googleapis.com/drive/v3"
UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3"
TIMEOUT = 12.0

DEFAULT_FIELDS = "id, name, mimeType, modifiedTime, size, webViewLink, owners(displayName,emailAddress)"


def _authed_request(
    method: str,
    url: str,
    *,
    context: str,
    params: Optional[dict] = None,
    body: Optional[dict] = None,
    raw_body: Optional[bytes] = None,
    extra_headers: Optional[dict] = None,
) -> tuple[int, dict, Optional[dict]]:
    token, err = google_oauth.access_or_error(context)
    if err:
        return 0, {}, err["needs_setup"]
    if params:
        from urllib.parse import urlencode
        clean = {k: v for k, v in params.items() if v not in (None, "")}
        if clean:
            url = f"{url}?{urlencode(clean, doseq=True)}"
    payload = json.dumps(body).encode("utf-8") if body is not None else raw_body
    headers = {"Authorization": f"Bearer {token}", "Accept": "application/json"}
    if body is not None:
        headers["Content-Type"] = "application/json"
    if extra_headers:
        headers.update(extra_headers)
    status, resp = _http_json(method, url, headers=headers, body=payload, timeout=TIMEOUT)
    if status == 401:
        new_token = google_oauth.refresh_access_token()
        if new_token:
            headers["Authorization"] = f"Bearer {new_token}"
            status, resp = _http_json(method, url, headers=headers, body=payload, timeout=TIMEOUT)
    return status, resp, None


def _err(status: int, body: dict) -> str:
    if status == 0:
        return f"Couldn't reach Google Drive: {body.get('error', 'network error')}"
    err = body.get("error") if isinstance(body, dict) else None
    if isinstance(err, dict):
        return err.get("message") or f"HTTP {status}"
    return f"HTTP {status}"


def _normalise_file(f: dict) -> dict:
    if not isinstance(f, dict):
        return {}
    owners = f.get("owners") or []
    return {
        "id": f.get("id"),
        "name": f.get("name"),
        "mime_type": f.get("mimeType"),
        "modified_time": f.get("modifiedTime"),
        "size": f.get("size"),
        "web_link": f.get("webViewLink"),
        "owner_name": (owners[0].get("displayName") if owners else None),
        "owner_email": (owners[0].get("emailAddress") if owners else None),
    }


def list_files(query: Optional[str] = None, max_results: int = 20) -> dict:
    """List files visible to Adam, optionally filtered with a Drive `q` query.

    A bare query string is wrapped as `name contains 'X' and trashed=false`
    to keep the chat surface ergonomic — Adam doesn't write Drive query
    syntax, he says "find files about GRAIL"."""
    max_results = max(1, min(int(max_results or 20), 50))
    q_parts = ["trashed=false"]
    if query:
        # Already-formed Drive queries (containing operators) pass through;
        # plain strings get wrapped into a name-contains expression.
        if any(op in query for op in (" and ", " or ", " contains ", "=", "modifiedTime", "mimeType")):
            q_parts.append(f"({query})")
        else:
            safe = query.replace("'", "\\'")
            q_parts.append(f"name contains '{safe}'")
    params = {
        "q": " and ".join(q_parts),
        "pageSize": max_results,
        "fields": f"files({DEFAULT_FIELDS})",
        "orderBy": "modifiedTime desc",
    }
    status, body, needs = _authed_request("GET", f"{BASE}/files", context="to list your Drive files", params=params)
    if needs:
        return {"found": False, "files": [], "error": "Google not connected", "needs_setup": needs}
    if status != 200:
        return {"found": False, "files": [], "error": _err(status, body)}
    items = body.get("files") if isinstance(body, dict) else None
    if not isinstance(items, list):
        items = []
    return {"found": bool(items), "files": [_normalise_file(f) for f in items], "error": None}


def search_files(name_contains: str, max_results: int = 20) -> dict:
    """Substring-on-name search, ranked by recently modified."""
    if not name_contains:
        return {"found": False, "files": [], "error": "Missing search term"}
    return list_files(query=name_contains, max_results=max_results)


def get_file(file_id: str) -> dict:
    if not file_id:
        return {"found": False, "file": None, "error": "Missing file_id"}
    status, body, needs = _authed_request(
        "GET", f"{BASE}/files/{file_id}",
        context="to fetch a Drive file",
        params={"fields": DEFAULT_FIELDS},
    )
    if needs:
        return {"found": False, "file": None, "error": "Google not connected", "needs_setup": needs}
    if status != 200:
        return {"found": False, "file": None, "error": _err(status, body)}
    return {"found": True, "file": _normalise_file(body), "error": None}
