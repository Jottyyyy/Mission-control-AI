"""Google Calendar v3 client — list, get, create.

All calls go through `_authed_request` which fetches a fresh access token via
google_oauth.get_valid_access_token() and retries once on 401 (a stale token
is the most common cause). Returns shape-stable dicts the chat layer can
render without further parsing."""

from __future__ import annotations

import json
from typing import Optional

from . import google_oauth
from ._common import _http_json


BASE = "https://www.googleapis.com/calendar/v3"
TIMEOUT = 12.0


def _authed_request(
    method: str,
    path: str,
    *,
    context: str,
    params: Optional[dict] = None,
    body: Optional[dict] = None,
) -> tuple[int, dict, Optional[dict]]:
    """Returns (status, body_dict, needs_setup_or_None).

    `needs_setup` is non-None only when Google isn't connected — the caller
    short-circuits and surfaces it. Other failures (rate limits, scope
    errors) come back as (status, body, None) and translate to plain errors."""
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
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
    }
    if body is not None:
        headers["Content-Type"] = "application/json"
    status, resp = _http_json(method, url, headers=headers, body=payload, timeout=TIMEOUT)
    if status == 401:
        # Stale token — refresh once and retry.
        new_token = google_oauth.refresh_access_token()
        if new_token:
            headers["Authorization"] = f"Bearer {new_token}"
            status, resp = _http_json(method, url, headers=headers, body=payload, timeout=TIMEOUT)
    return status, resp, None


def _err_dict(status: int, body: dict) -> str:
    if status == 0:
        return f"Couldn't reach Google Calendar: {body.get('error', 'network error')}"
    if status == 403:
        return "Forbidden (403). Check the Calendar scope was granted."
    err = body.get("error") if isinstance(body, dict) else None
    if isinstance(err, dict):
        return err.get("message") or f"HTTP {status}"
    if isinstance(err, str):
        return err
    return f"HTTP {status}"


def _normalise_event(e: dict) -> dict:
    if not isinstance(e, dict):
        return {}
    start = e.get("start") or {}
    end = e.get("end") or {}
    attendees = e.get("attendees") or []
    return {
        "id": e.get("id"),
        "summary": e.get("summary"),
        "description": e.get("description"),
        "location": e.get("location"),
        "start": start.get("dateTime") or start.get("date"),
        "end": end.get("dateTime") or end.get("date"),
        "timezone": start.get("timeZone") or end.get("timeZone"),
        "attendees": [
            {"email": a.get("email"), "response": a.get("responseStatus")}
            for a in attendees if isinstance(a, dict)
        ],
        "html_link": e.get("htmlLink"),
        "organizer_email": (e.get("organizer") or {}).get("email"),
    }


def list_events(time_min: Optional[str] = None, time_max: Optional[str] = None, max_results: int = 20) -> dict:
    """List events on Adam's primary calendar, optionally bounded by time.

    `time_min` / `time_max` are RFC 3339 timestamps (e.g. "2026-04-25T00:00:00Z").
    Both are optional — Google defaults to "now" through "+ ~250 events" when
    omitted, which is fine for an unscoped "what's on my calendar" question."""
    params = {
        "singleEvents": "true",
        "orderBy": "startTime",
        "maxResults": max(1, min(int(max_results or 20), 50)),
    }
    if time_min:
        params["timeMin"] = time_min
    if time_max:
        params["timeMax"] = time_max
    status, body, needs = _authed_request("GET", "/calendars/primary/events", context="to read your calendar", params=params)
    if needs:
        return {"found": False, "events": [], "error": "Google not connected", "needs_setup": needs}
    if status != 200:
        return {"found": False, "events": [], "error": _err_dict(status, body)}
    items = body.get("items") if isinstance(body, dict) else None
    if not isinstance(items, list):
        items = []
    events = [_normalise_event(e) for e in items]
    return {"found": bool(events), "events": events, "error": None}


def get_event(event_id: str) -> dict:
    if not event_id:
        return {"found": False, "event": None, "error": "Missing event_id"}
    status, body, needs = _authed_request("GET", f"/calendars/primary/events/{event_id}", context="to read a calendar event")
    if needs:
        return {"found": False, "event": None, "error": "Google not connected", "needs_setup": needs}
    if status != 200:
        return {"found": False, "event": None, "error": _err_dict(status, body)}
    return {"found": True, "event": _normalise_event(body), "error": None}


def create_event(
    summary: str,
    start: str,
    end: str,
    *,
    timezone: Optional[str] = "Europe/London",
    description: Optional[str] = None,
    location: Optional[str] = None,
    attendees: Optional[list[str]] = None,
) -> dict:
    """Create a single event on Adam's primary calendar.

    `start` / `end` are ISO 8601 local datetimes (no offset). `timezone` is
    paired with them as Google requires both pieces. Returns
    {success, event_id?, html_link?, error?, needs_setup?}."""
    payload: dict = {
        "summary": summary,
        "start": {"dateTime": start, "timeZone": timezone or "Europe/London"},
        "end":   {"dateTime": end,   "timeZone": timezone or "Europe/London"},
    }
    if description:
        payload["description"] = description
    if location:
        payload["location"] = location
    if attendees:
        payload["attendees"] = [{"email": e} for e in attendees if isinstance(e, str) and e.strip()]

    status, body, needs = _authed_request(
        "POST",
        "/calendars/primary/events",
        context="to create a calendar event",
        body=payload,
    )
    if needs:
        return {"success": False, "event_id": None, "html_link": None,
                "error": "Google not connected", "needs_setup": needs}
    if status not in (200, 201):
        return {"success": False, "event_id": None, "html_link": None, "error": _err_dict(status, body)}
    return {
        "success": True,
        "event_id": body.get("id"),
        "html_link": body.get("htmlLink"),
        "summary": body.get("summary"),
        "error": None,
    }
