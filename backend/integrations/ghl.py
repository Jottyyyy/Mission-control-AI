"""GoHighLevel V2 client — marketing CRM bridge for Adam.

Wraps the GHL V2 REST API at https://services.leadconnectorhq.com. Auth uses
a Private Integration Token (Settings → Private Integrations) plus a Location
ID — both pulled from the macOS Keychain via the shared `_kc_get` helper.

All public functions return shape-stable dicts the frontend can render
without further normalisation. They never raise — network/HTTP errors are
captured into `{found|success: false, error: "..."}` so the chat layer can
handle them like any other empty result.

Confirmation pattern:
  - Read-only calls (list/search/get) execute directly.
  - Write calls (create_contact, create_opportunity) are designed to be
    invoked by the action-card path in server.py — Jackson never executes
    them, he proposes the action and Adam confirms via /tools/execute.
"""

import json
import time
from typing import Optional

from ._common import _kc_get, _http_json, _error_from_status


BASE_URL = "https://services.leadconnectorhq.com"
API_VERSION = "2021-07-28"
TIMEOUT = 12.0
RATE_LIMIT_RETRIES = 2  # one initial + retry on 429 with backoff
RATE_LIMIT_BACKOFF = (1.5, 4.0)  # seconds — tiny because /chat is interactive

# Structured signal returned alongside `error` when GHL credentials are missing.
# The frontend reads this to auto-open SetupModal instead of showing the raw
# "GHL not configured" string. `context` is set per-call site so the modal
# subtitle matches what Jackson was attempting.
NOT_CONFIGURED_ERROR = "GHL not configured"


def _needs_setup(context: str) -> dict:
    return {"tools": ["ghl"], "context": context}


def _get_credentials() -> tuple[Optional[str], Optional[str]]:
    """Return (api_key, location_id). Either may be None when unconfigured."""
    api_key = _kc_get("ghl", "api_key")
    location_id = _kc_get("ghl", "location_id")
    return api_key, location_id


def _headers(api_key: str) -> dict:
    return {
        "Authorization": f"Bearer {api_key}",
        "Version": API_VERSION,
        "Accept": "application/json",
        "Content-Type": "application/json",
    }


def _request(
    method: str,
    path: str,
    *,
    api_key: str,
    params: Optional[dict] = None,
    body: Optional[dict] = None,
) -> tuple[int, dict]:
    """Single GHL request with light 429 backoff.

    GHL's V2 limits are 100 req/10s per location for burst and 200k/day total;
    /chat traffic shouldn't approach either, but we handle 429 cleanly so a
    misbehaving caller doesn't surface a raw HTTP error to Adam."""
    url = BASE_URL + path
    if params:
        from urllib.parse import urlencode
        # Drop None values so callers can pass a flat dict without filtering.
        clean = {k: v for k, v in params.items() if v not in (None, "")}
        if clean:
            url = f"{url}?{urlencode(clean, doseq=True)}"

    payload = json.dumps(body).encode("utf-8") if body is not None else None

    for attempt in range(RATE_LIMIT_RETRIES + 1):
        status, resp = _http_json(
            method,
            url,
            headers=_headers(api_key),
            body=payload,
            timeout=TIMEOUT,
        )
        if status != 429 or attempt == RATE_LIMIT_RETRIES:
            return status, resp
        time.sleep(RATE_LIMIT_BACKOFF[min(attempt, len(RATE_LIMIT_BACKOFF) - 1)])
    return status, resp  # unreachable — keeps type-checkers happy


def _err(status: int, body: dict) -> str:
    """Translate GHL's error envelope into a human string."""
    if status == 0:
        return f"Couldn't reach GHL: {body.get('error', 'network error')}"
    if status == 401:
        return "Token rejected (401). Regenerate in GHL Settings → Private Integrations."
    if status == 403:
        return "Forbidden (403). Token is missing the required scope."
    if status == 404:
        return "Not found (404). Check the ID or Location ID."
    if status == 429:
        return "GHL rate-limited the request (429). Try again shortly."
    msg = None
    if isinstance(body, dict):
        msg = body.get("message") or body.get("error") or body.get("detail")
        if isinstance(msg, dict):
            msg = msg.get("message") or str(msg)
    return msg or f"GHL returned HTTP {status}"


# ---------------------------------------------------------------------------
# Contacts
# ---------------------------------------------------------------------------

def _normalise_contact(c: dict) -> dict:
    """Flatten the most useful fields from a GHL contact for UI rendering."""
    if not isinstance(c, dict):
        return {}
    return {
        "id": c.get("id"),
        "first_name": c.get("firstName") or c.get("first_name"),
        "last_name": c.get("lastName") or c.get("last_name"),
        "name": c.get("contactName") or c.get("name") or _full_name(c),
        "email": c.get("email"),
        "phone": c.get("phone"),
        "company": c.get("companyName") or c.get("businessName"),
        "tags": c.get("tags") or [],
        "source": c.get("source"),
        "created_at": c.get("dateAdded") or c.get("createdAt"),
    }


def _full_name(c: dict) -> Optional[str]:
    first = c.get("firstName") or c.get("first_name") or ""
    last = c.get("lastName") or c.get("last_name") or ""
    full = f"{first} {last}".strip()
    return full or None


def list_contacts(query: Optional[str] = None, limit: int = 20) -> dict:
    """Search/list contacts in the configured Location.

    Returns {found: bool, contacts: [...], error?: str}. `query` is matched by
    GHL against name/email/phone — empty query lists the most recent."""
    api_key, location_id = _get_credentials()
    if not api_key or not location_id:
        return {"found": False, "contacts": [], "error": NOT_CONFIGURED_ERROR,
                "needs_setup": _needs_setup("to search GHL contacts")}

    params: dict = {"locationId": location_id, "limit": max(1, min(limit, 100))}
    if query:
        params["query"] = query

    status, body = _request("GET", "/contacts/", api_key=api_key, params=params)
    if status != 200:
        return {"found": False, "contacts": [], "error": _err(status, body)}

    raw = body.get("contacts") if isinstance(body, dict) else None
    if not isinstance(raw, list):
        raw = []
    contacts = [_normalise_contact(c) for c in raw]
    return {"found": bool(contacts), "contacts": contacts, "error": None}


def get_contact(contact_id: str) -> dict:
    """Fetch a single contact by GHL ID."""
    api_key, _location_id = _get_credentials()
    if not api_key:
        return {"found": False, "contact": None, "error": NOT_CONFIGURED_ERROR,
                "needs_setup": _needs_setup("to fetch a GHL contact")}
    if not contact_id:
        return {"found": False, "contact": None, "error": "Missing contact_id"}

    status, body = _request("GET", f"/contacts/{contact_id}", api_key=api_key)
    if status != 200:
        return {"found": False, "contact": None, "error": _err(status, body)}
    raw = body.get("contact") if isinstance(body, dict) else body
    return {"found": True, "contact": _normalise_contact(raw or {}), "error": None}


def create_contact(contact_data: dict) -> dict:
    """Create a contact in the configured Location.

    Accepts any of: firstName, lastName, name, email, phone, companyName,
    address1, city, state, country, postalCode, website, source, tags (list),
    customField (dict). We forward whatever the caller supplied and always
    inject `locationId` from Keychain so a hallucinated payload can't write
    to a different Location."""
    api_key, location_id = _get_credentials()
    if not api_key or not location_id:
        return {"success": False, "contact_id": None, "contact": None,
                "error": NOT_CONFIGURED_ERROR,
                "needs_setup": _needs_setup("to create a GHL contact")}

    payload = {k: v for k, v in (contact_data or {}).items() if v not in (None, "")}
    payload["locationId"] = location_id

    status, body = _request("POST", "/contacts/", api_key=api_key, body=payload)
    if status not in (200, 201):
        return {"success": False, "contact_id": None, "contact": None, "error": _err(status, body)}

    raw = body.get("contact") if isinstance(body, dict) else None
    if not isinstance(raw, dict):
        raw = body if isinstance(body, dict) else {}
    normalised = _normalise_contact(raw)
    return {
        "success": True,
        "contact_id": normalised.get("id"),
        "contact": normalised,
        "error": None,
    }


def update_contact(contact_id: str, updates: dict) -> dict:
    """Patch fields on an existing contact."""
    api_key, _location_id = _get_credentials()
    if not api_key:
        return {"success": False, "contact": None, "error": NOT_CONFIGURED_ERROR,
                "needs_setup": _needs_setup("to update a GHL contact")}
    if not contact_id:
        return {"success": False, "contact": None, "error": "Missing contact_id"}

    payload = {k: v for k, v in (updates or {}).items() if v not in (None, "")}
    if not payload:
        return {"success": False, "contact": None, "error": "No fields to update"}

    status, body = _request("PUT", f"/contacts/{contact_id}", api_key=api_key, body=payload)
    if status not in (200, 201):
        return {"success": False, "contact": None, "error": _err(status, body)}

    raw = body.get("contact") if isinstance(body, dict) else body
    return {"success": True, "contact": _normalise_contact(raw or {}), "error": None}


def add_note(contact_id: str, body: str) -> dict:
    """Attach a note to a GHL contact.

    Notes use the contact-scoped POST /contacts/{id}/notes endpoint. GHL
    returns the new note as `{note: {id, body, dateAdded, ...}}` on success."""
    api_key, _location_id = _get_credentials()
    if not api_key:
        return {"success": False, "note_id": None, "error": NOT_CONFIGURED_ERROR,
                "needs_setup": _needs_setup("to add a note in GHL")}
    if not contact_id:
        return {"success": False, "note_id": None, "error": "Missing contact_id"}
    text = (body or "").strip()
    if not text:
        return {"success": False, "note_id": None, "error": "Note body is empty"}

    status, resp = _request(
        "POST",
        f"/contacts/{contact_id}/notes",
        api_key=api_key,
        body={"body": text},
    )
    if status not in (200, 201):
        return {"success": False, "note_id": None, "error": _err(status, resp)}

    note = resp.get("note") if isinstance(resp, dict) else None
    if not isinstance(note, dict):
        note = resp if isinstance(resp, dict) else {}
    return {
        "success": True,
        "note_id": note.get("id"),
        "note": {
            "id": note.get("id"),
            "body": note.get("body") or text,
            "created_at": note.get("dateAdded") or note.get("createdAt"),
        },
        "error": None,
    }


# ---------------------------------------------------------------------------
# Opportunities
# ---------------------------------------------------------------------------

def _normalise_opportunity(o: dict) -> dict:
    if not isinstance(o, dict):
        return {}
    contact = o.get("contact") if isinstance(o.get("contact"), dict) else {}
    return {
        "id": o.get("id"),
        "name": o.get("name"),
        "status": o.get("status"),
        "pipeline_id": o.get("pipelineId"),
        "pipeline_stage_id": o.get("pipelineStageId"),
        "monetary_value": o.get("monetaryValue"),
        "source": o.get("source"),
        "contact_id": o.get("contactId") or contact.get("id"),
        "contact_name": contact.get("name") or _full_name(contact),
        "created_at": o.get("createdAt") or o.get("dateAdded"),
        "updated_at": o.get("updatedAt"),
    }


def list_opportunities(pipeline_id: Optional[str] = None, limit: int = 20) -> dict:
    """List opportunities, optionally filtered by pipeline."""
    api_key, location_id = _get_credentials()
    if not api_key or not location_id:
        return {"found": False, "opportunities": [], "error": NOT_CONFIGURED_ERROR,
                "needs_setup": _needs_setup("to list GHL opportunities")}

    params: dict = {"location_id": location_id, "limit": max(1, min(limit, 100))}
    if pipeline_id:
        params["pipeline_id"] = pipeline_id

    status, body = _request("GET", "/opportunities/search", api_key=api_key, params=params)
    if status != 200:
        return {"found": False, "opportunities": [], "error": _err(status, body)}

    raw = body.get("opportunities") if isinstance(body, dict) else None
    if not isinstance(raw, list):
        raw = []
    opps = [_normalise_opportunity(o) for o in raw]
    return {"found": bool(opps), "opportunities": opps, "error": None}


def create_opportunity(opp_data: dict) -> dict:
    """Create an opportunity. Required: pipelineId, name. Optional: contactId,
    status, monetaryValue, source, pipelineStageId."""
    api_key, location_id = _get_credentials()
    if not api_key or not location_id:
        return {"success": False, "opportunity_id": None,
                "error": NOT_CONFIGURED_ERROR,
                "needs_setup": _needs_setup("to create a GHL opportunity")}

    payload = {k: v for k, v in (opp_data or {}).items() if v not in (None, "")}
    payload["locationId"] = location_id
    if not payload.get("pipelineId"):
        return {"success": False, "opportunity_id": None, "error": "Missing pipelineId"}
    if not payload.get("name"):
        return {"success": False, "opportunity_id": None, "error": "Missing name"}

    status, body = _request("POST", "/opportunities/", api_key=api_key, body=payload)
    if status not in (200, 201):
        return {"success": False, "opportunity_id": None, "error": _err(status, body)}

    raw = body.get("opportunity") if isinstance(body, dict) else body
    normalised = _normalise_opportunity(raw or {})
    return {
        "success": True,
        "opportunity_id": normalised.get("id"),
        "opportunity": normalised,
        "error": None,
    }


# ---------------------------------------------------------------------------
# Conversations
# ---------------------------------------------------------------------------

def _normalise_conversation(c: dict) -> dict:
    if not isinstance(c, dict):
        return {}
    return {
        "id": c.get("id"),
        "contact_id": c.get("contactId"),
        "contact_name": c.get("fullName") or c.get("contactName"),
        "last_message_body": c.get("lastMessageBody"),
        "last_message_type": c.get("lastMessageType"),
        "last_message_at": c.get("lastMessageDate"),
        "unread_count": c.get("unreadCount"),
        "type": c.get("type"),
    }


def list_conversations(contact_id: Optional[str] = None, limit: int = 20) -> dict:
    """List conversations in the Location, optionally narrowed to one contact."""
    api_key, location_id = _get_credentials()
    if not api_key or not location_id:
        return {"found": False, "conversations": [], "error": NOT_CONFIGURED_ERROR,
                "needs_setup": _needs_setup("to list GHL conversations")}

    params: dict = {"locationId": location_id, "limit": max(1, min(limit, 100))}
    if contact_id:
        params["contactId"] = contact_id

    status, body = _request("GET", "/conversations/search", api_key=api_key, params=params)
    if status != 200:
        return {"found": False, "conversations": [], "error": _err(status, body)}

    raw = body.get("conversations") if isinstance(body, dict) else None
    if not isinstance(raw, list):
        raw = []
    convos = [_normalise_conversation(c) for c in raw]
    return {"found": bool(convos), "conversations": convos, "error": None}


def get_conversation_messages(conversation_id: str) -> dict:
    """Return the message thread for one conversation."""
    api_key, _location_id = _get_credentials()
    if not api_key:
        return {"found": False, "messages": [], "error": NOT_CONFIGURED_ERROR,
                "needs_setup": _needs_setup("to read a GHL conversation")}
    if not conversation_id:
        return {"found": False, "messages": [], "error": "Missing conversation_id"}

    status, body = _request("GET", f"/conversations/{conversation_id}/messages", api_key=api_key)
    if status != 200:
        return {"found": False, "messages": [], "error": _err(status, body)}

    # GHL nests messages under body.messages.messages on V2.
    raw = body.get("messages") if isinstance(body, dict) else None
    if isinstance(raw, dict):
        raw = raw.get("messages")
    if not isinstance(raw, list):
        raw = []
    msgs = [{
        "id": m.get("id"),
        "type": m.get("type") or m.get("messageType"),
        "direction": m.get("direction"),
        "body": m.get("body"),
        "from": m.get("from"),
        "to": m.get("to"),
        "date": m.get("dateAdded") or m.get("date"),
        "status": m.get("status"),
    } for m in raw if isinstance(m, dict)]
    return {"found": bool(msgs), "messages": msgs, "error": None}


_VALID_MESSAGE_TYPES = {"SMS", "Email"}


def send_message(
    contact_id: str,
    message_type: str,
    body: str,
    subject: Optional[str] = None,
) -> dict:
    """Send an outbound SMS or Email via the GHL conversations API.

    GHL's V2 endpoint is `POST /conversations/messages`. The body needs
    `type`, `contactId`, and `message`; `subject` is required for Email.
    On success the response carries a `messageId` and the resolved
    `conversationId`."""
    api_key, _location_id = _get_credentials()
    if not api_key:
        return {"success": False, "message_id": None, "conversation_id": None,
                "error": NOT_CONFIGURED_ERROR,
                "needs_setup": _needs_setup("to send a message via GHL")}
    if not contact_id:
        return {"success": False, "message_id": None, "conversation_id": None, "error": "Missing contact_id"}
    if message_type not in _VALID_MESSAGE_TYPES:
        return {"success": False, "message_id": None, "conversation_id": None,
                "error": f"message_type must be one of {sorted(_VALID_MESSAGE_TYPES)}"}
    text = (body or "").strip()
    if not text:
        return {"success": False, "message_id": None, "conversation_id": None, "error": "Message body is empty"}
    if message_type == "Email" and not (subject or "").strip():
        return {"success": False, "message_id": None, "conversation_id": None, "error": "Email requires a subject"}

    payload: dict = {
        "type": message_type,
        "contactId": contact_id,
        "message": text,
    }
    if message_type == "Email":
        payload["subject"] = subject.strip()
        payload["html"] = text  # GHL accepts plain text in `html` for simple sends.

    status, resp = _request("POST", "/conversations/messages", api_key=api_key, body=payload)
    if status not in (200, 201):
        return {"success": False, "message_id": None, "conversation_id": None, "error": _err(status, resp)}

    return {
        "success": True,
        "message_id": resp.get("messageId") or resp.get("id"),
        "conversation_id": resp.get("conversationId"),
        "error": None,
    }


# ---------------------------------------------------------------------------
# Calendars
# ---------------------------------------------------------------------------

def list_calendars() -> dict:
    """List calendars attached to the configured Location."""
    api_key, location_id = _get_credentials()
    if not api_key or not location_id:
        return {"found": False, "calendars": [], "error": NOT_CONFIGURED_ERROR,
                "needs_setup": _needs_setup("to list GHL calendars")}

    status, body = _request("GET", "/calendars/", api_key=api_key, params={"locationId": location_id})
    if status != 200:
        return {"found": False, "calendars": [], "error": _err(status, body)}

    raw = body.get("calendars") if isinstance(body, dict) else None
    if not isinstance(raw, list):
        raw = []
    cals = [{
        "id": c.get("id"),
        "name": c.get("name"),
        "description": c.get("description"),
        "is_active": c.get("isActive"),
    } for c in raw if isinstance(c, dict)]
    return {"found": bool(cals), "calendars": cals, "error": None}


def list_calendar_events(
    calendar_id: str,
    start: Optional[str] = None,
    end: Optional[str] = None,
) -> dict:
    """List events on one calendar between optional ISO start/end."""
    api_key, location_id = _get_credentials()
    if not api_key or not location_id:
        return {"found": False, "events": [], "error": NOT_CONFIGURED_ERROR,
                "needs_setup": _needs_setup("to list GHL calendar events")}
    if not calendar_id:
        return {"found": False, "events": [], "error": "Missing calendar_id"}

    params: dict = {"locationId": location_id, "calendarId": calendar_id}
    if start:
        params["startTime"] = start
    if end:
        params["endTime"] = end

    status, body = _request("GET", "/calendars/events", api_key=api_key, params=params)
    if status != 200:
        return {"found": False, "events": [], "error": _err(status, body)}

    raw = body.get("events") if isinstance(body, dict) else None
    if not isinstance(raw, list):
        raw = []
    events = [{
        "id": e.get("id"),
        "calendar_id": e.get("calendarId"),
        "title": e.get("title") or e.get("appointmentTitle"),
        "start": e.get("startTime"),
        "end": e.get("endTime"),
        "contact_id": e.get("contactId"),
        "status": e.get("appointmentStatus") or e.get("status"),
    } for e in raw if isinstance(e, dict)]
    return {"found": bool(events), "events": events, "error": None}


# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------

def verify_credentials() -> dict:
    """Probe the configured credentials with a single read against the Location.

    Mirrors `_test_ghl()` in server.py but lives here for direct programmatic
    use (e.g. by future health-check scripts). Returns:
      {success: bool, location_name?: str, scopes_active?: str, error?: str,
       warning?: str}"""
    api_key, location_id = _get_credentials()
    if not api_key:
        return {"success": False, "error": "API key not configured",
                "needs_setup": _needs_setup("to verify GHL credentials")}
    if not location_id:
        return {"success": False, "error": "Location ID not configured",
                "needs_setup": _needs_setup("to verify GHL credentials")}

    warning = None
    if not api_key.startswith("pit-"):
        warning = (
            "Token doesn't start with 'pit-' — make sure you generated a "
            "Private Integration token, not a legacy v1 key."
        )

    status, body = _request("GET", f"/locations/{location_id}", api_key=api_key)
    if status == 200:
        loc = body.get("location") if isinstance(body, dict) else None
        name = loc.get("name") if isinstance(loc, dict) else None
        out = {"success": True, "location_name": name, "scopes_active": "verified"}
        if warning:
            out["warning"] = warning
        return out
    if status == 401:
        return {"success": False, "error": "Token rejected — regenerate in GHL Settings → Private Integrations."}
    if status == 404:
        return {"success": False, "error": "Location ID not found — check Settings → Business Profile."}
    return {"success": False, "error": _err(status, body)}
