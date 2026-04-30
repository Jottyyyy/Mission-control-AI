"""Google Sheets v4 client — read range, append rows, create spreadsheet.

The chat surface only needs the most common ops — full range reads, plain
append, and bare-bones create. Cell formatting / chart manipulation / batch
update sit out of scope for v1."""

from __future__ import annotations

import json
from typing import Optional

from . import google_oauth
from ._common import _http_json


BASE = "https://sheets.googleapis.com/v4"
TIMEOUT = 12.0
SERVICE_KEY = "sheets"


def _authed_request(
    method: str,
    url: str,
    *,
    context: str,
    params: Optional[dict] = None,
    body: Optional[dict] = None,
) -> tuple[int, dict, Optional[dict]]:
    token, err = google_oauth.access_or_error(context)
    if err:
        return 0, {}, err["needs_setup"]
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
        return f"Couldn't reach Google Sheets: {body.get('error', 'network error')}"
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


def read_range(spreadsheet_id: str, range: str = "A1:Z100") -> dict:
    """Read a rectangular range from a spreadsheet. Returns a 2D values list,
    rows-major. Empty cells come back as empty strings (Google's default)."""
    if not spreadsheet_id:
        return {"found": False, "values": [], "error": "Missing spreadsheet_id"}
    url = f"{BASE}/spreadsheets/{spreadsheet_id}/values/{range or 'A1:Z100'}"
    status, body, needs = _authed_request("GET", url, context="to read a spreadsheet")
    if needs:
        return {"found": False, "values": [], "error": "Google not connected", "needs_setup": needs}
    if status != 200:
        return _failure({"found": False, "values": []}, status, body)
    values = body.get("values") if isinstance(body, dict) else None
    if not isinstance(values, list):
        values = []
    return {"found": bool(values), "values": values, "range": body.get("range"), "error": None}


def append_rows(spreadsheet_id: str, range: str, rows: list[list]) -> dict:
    """Append rows to a sheet. Google decides where the next free row is —
    `range` just identifies which sheet/tab to append to (e.g. "Sheet1!A:Z")."""
    if not spreadsheet_id:
        return {"success": False, "updated_range": None, "error": "Missing spreadsheet_id"}
    if not isinstance(rows, list) or not rows:
        return {"success": False, "updated_range": None, "error": "Missing rows"}

    url = f"{BASE}/spreadsheets/{spreadsheet_id}/values/{range or 'Sheet1!A:Z'}:append"
    status, body, needs = _authed_request(
        "POST",
        url,
        context="to append rows to a spreadsheet",
        params={"valueInputOption": "USER_ENTERED", "insertDataOption": "INSERT_ROWS"},
        body={"values": rows},
    )
    if needs:
        return {"success": False, "updated_range": None,
                "error": "Google not connected", "needs_setup": needs}
    if status not in (200, 201):
        return _failure({"success": False, "updated_range": None}, status, body)
    updates = body.get("updates") if isinstance(body, dict) else None
    return {
        "success": True,
        "updated_range": (updates or {}).get("updatedRange"),
        "updated_rows": (updates or {}).get("updatedRows"),
        "spreadsheet_id": spreadsheet_id,
        "error": None,
    }


def values_batch_update(
    spreadsheet_id: str,
    updates: list[dict],
) -> dict:
    """In-place batch update — write specific cells without disturbing others.

    `updates` is a list of {"range": "<A1>", "values": [[...]]} entries
    in the same shape Google's spreadsheets.values.batchUpdate accepts.
    Use this for the "fill missing cells in place" enrichment flow
    where blanket overwrites would clobber unrelated work.
    """
    if not spreadsheet_id:
        return {"success": False, "updated_cells": 0, "error": "Missing spreadsheet_id"}
    if not isinstance(updates, list) or not updates:
        return {"success": False, "updated_cells": 0, "error": "No updates provided"}

    url = f"{BASE}/spreadsheets/{spreadsheet_id}/values:batchUpdate"
    status, body, needs = _authed_request(
        "POST",
        url,
        context="to update specific cells in a spreadsheet",
        body={"valueInputOption": "USER_ENTERED", "data": updates},
    )
    if needs:
        return {"success": False, "updated_cells": 0,
                "error": "Google not connected", "needs_setup": needs}
    if status not in (200, 201):
        return _failure({"success": False, "updated_cells": 0}, status, body)
    return {
        "success": True,
        "updated_cells": (body or {}).get("totalUpdatedCells") or 0,
        "updated_ranges": [
            r.get("updatedRange") for r in (body or {}).get("responses", [])
            if isinstance(r, dict)
        ],
        "spreadsheet_id": spreadsheet_id,
        "error": None,
    }


def create_sheet(title: str) -> dict:
    """Create a new spreadsheet titled `title`. Returns its ID + URL."""
    if not title:
        return {"success": False, "spreadsheet_id": None, "url": None, "error": "Missing title"}
    status, body, needs = _authed_request(
        "POST",
        f"{BASE}/spreadsheets",
        context="to create a spreadsheet",
        body={"properties": {"title": title}},
    )
    if needs:
        return {"success": False, "spreadsheet_id": None, "url": None,
                "error": "Google not connected", "needs_setup": needs}
    if status not in (200, 201):
        return _failure({"success": False, "spreadsheet_id": None, "url": None}, status, body)
    sid = body.get("spreadsheetId")
    url = body.get("spreadsheetUrl") or (f"https://docs.google.com/spreadsheets/d/{sid}/edit" if sid else None)
    return {
        "success": True,
        "spreadsheet_id": sid,
        "url": url,
        "title": (body.get("properties") or {}).get("title") or title,
        "error": None,
    }
