r"""
Channel-specific reply formatting.

Jackson's /chat replies are written for the desktop surface — markdown
tables, inline `[[action-card:UUID]]` placeholders, and fenced JSON blocks
(triple-backtick `google-calendar-events\n{...}\n` triple-backtick) that
the React renderers in `src/GoogleRenderers.jsx` turn into pretty cards.
WhatsApp Web has none of that, so for the WhatsApp egress we reshape:

- Tool-output fences (`google-*` and `ghl-*` languages) become plain-prose
  summaries — never raw JSON. v1.28 Step 4.5 fix.
- Markdown table blocks (sequences of lines starting with ``|``) become
  bullet lists.
- Inline `[[action-card:UUID]]` placeholders become a single line:
  "Card waiting on your Mac to confirm — <summary>".
- Reply caps at `max_chars` with a "reply 'full' for the rest" hint.

Pure functions — no I/O, no DB, easy to unit-test.
"""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone, timedelta
from typing import Any, Optional


_ACTION_CARD_RE = re.compile(r"\[\[action-card:([0-9a-fA-F\-]+)\]\]")
_TABLE_LINE_RE = re.compile(r"^\s*\|.*\|\s*$")
_TABLE_DIVIDER_RE = re.compile(r"^\s*\|?[\s:\-|]+\|?\s*$")

# Fence labels emitted by backend/server.py read handlers (search for
# `_google_fence(`). Mirrored here so we can identify them on egress.
_TOOL_FENCE_RE = re.compile(
    r"```(google-[\w-]+|ghl-[\w-]+)\n(.*?)\n```", re.S
)


# ---------------------------------------------------------------------------
# Friendly time helpers
# ---------------------------------------------------------------------------

def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    """Parse an RFC 3339 / ISO 8601 string; tolerate trailing ``Z`` and
    date-only forms (``YYYY-MM-DD``). Returns None on garbage input."""
    if not value or not isinstance(value, str):
        return None
    raw = value.strip()
    if not raw:
        return None
    # Date-only (all-day events from Google Calendar).
    if len(raw) == 10 and raw[4] == "-" and raw[7] == "-":
        try:
            return datetime.fromisoformat(raw + "T00:00:00")
        except ValueError:
            return None
    # Normalise "Z" to "+00:00" so fromisoformat accepts it on 3.10+.
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        return None


def _format_clock(dt: datetime) -> str:
    """``20:30`` → ``8:30 PM``; ``20:00`` → ``8 PM`` (drop minutes when they
    add no information)."""
    h = dt.hour
    m = dt.minute
    suffix = "AM" if h < 12 else "PM"
    h12 = 12 if h % 12 == 0 else h % 12
    if m == 0:
        return f"{h12} {suffix}"
    return f"{h12}:{m:02d} {suffix}"


def _date_label(dt: datetime, now: datetime) -> str:
    """Return ``""`` for "same day as `now`", ``"tomorrow"``, ``"yesterday"``,
    or ``"<weekday>"`` for anything within ±6 days, else ``"<Mon> <day>"``."""
    delta_days = (dt.date() - now.date()).days
    if delta_days == 0:
        return ""
    if delta_days == 1:
        return "tomorrow"
    if delta_days == -1:
        return "yesterday"
    if -6 <= delta_days <= 6:
        return dt.strftime("%A")
    return dt.strftime("%b %-d")


def _friendly_time(value: Optional[str], now: Optional[datetime] = None) -> str:
    """ISO-8601 → human time, e.g. ``"8:30 PM"`` or ``"8:30 PM tomorrow"``."""
    dt = _parse_iso(value)
    if not dt:
        return value or ""
    if now is None:
        now = datetime.now(dt.tzinfo) if dt.tzinfo else datetime.now()
    elif dt.tzinfo and not now.tzinfo:
        now = now.replace(tzinfo=dt.tzinfo)
    label = _date_label(dt, now)
    clock = _format_clock(dt)
    return f"{clock} {label}".strip()


def _friendly_range(
    start: Optional[str], end: Optional[str], now: Optional[datetime] = None
) -> str:
    """Friendly start→end. Drops the date suffix from the start when both
    sides land on the same day."""
    s_dt = _parse_iso(start)
    e_dt = _parse_iso(end)
    if not s_dt and not e_dt:
        return ""
    if not e_dt:
        return _friendly_time(start, now)
    if not s_dt:
        return f"by {_friendly_time(end, now)}"
    if now is None:
        now = datetime.now(s_dt.tzinfo) if s_dt.tzinfo else datetime.now()
    same_day = s_dt.date() == e_dt.date()
    if same_day:
        s_clock = _format_clock(s_dt)
        e_friendly = _friendly_time(end, now)
        return f"{s_clock} to {e_friendly}"
    return f"{_friendly_time(start, now)} to {_friendly_time(end, now)}"


# ---------------------------------------------------------------------------
# Tool-output summarizers — ONE per fence label
# ---------------------------------------------------------------------------

_MAX_HEADLINE_EVENTS = 3


def _summarize_calendar_events(payload: dict, now: Optional[datetime] = None) -> str:
    events = payload.get("events") or []
    if not events:
        return "Nothing on your calendar today."
    if len(events) == 1:
        ev = events[0]
        title = (ev.get("summary") or "Untitled event").strip()
        if ev.get("all_day"):
            return f"Today: one event — {title} (all day)."
        rng = _friendly_range(ev.get("start"), ev.get("end"), now)
        if rng:
            return f"Today: one event — {title}, {rng}."
        return f"Today: one event — {title}."
    headlines = []
    for ev in events[:_MAX_HEADLINE_EVENTS]:
        title = (ev.get("summary") or "Untitled").strip()
        if ev.get("all_day"):
            headlines.append(f"{title} (all day)")
        else:
            t = _friendly_time(ev.get("start"), now)
            headlines.append(f"{title} at {t}" if t else title)
    head = ", ".join(headlines)
    extras = len(events) - _MAX_HEADLINE_EVENTS
    if extras > 0:
        return (
            f"Today: {len(events)} events. Headlines — {head}. "
            f"Reply 'full' for the rest."
        )
    return f"Today: {len(events)} events. {head}."


def _summarize_gmail_messages(payload: dict) -> str:
    msgs = payload.get("messages") or []
    if not msgs:
        return "Inbox clean."
    unread = [m for m in msgs if m.get("unread")]
    relevant = unread or msgs
    senders: list[str] = []
    seen: set[str] = set()
    for m in relevant:
        sender_raw = (m.get("from") or "").strip()
        if not sender_raw:
            continue
        # Pluck the friendly name part out of "Name <email>" if present.
        name = sender_raw.split("<", 1)[0].strip().strip('"') or sender_raw
        if name not in seen:
            seen.add(name)
            senders.append(name)
        if len(senders) >= 3:
            break
    top = ", ".join(senders) if senders else "—"
    latest = (relevant[0].get("subject") or "(no subject)").strip()
    label = "unread" if unread else "messages"
    extra = " Reply 'full' for the list." if len(msgs) > len(senders) else ""
    return f"{len(unread) if unread else len(msgs)} {label} from {top}. Latest: {latest}.{extra}"


def _summarize_gmail_message(payload: dict) -> str:
    sender = (payload.get("from") or "—").split("<", 1)[0].strip().strip('"') or "—"
    subject = (payload.get("subject") or "(no subject)").strip()
    body = (payload.get("body_text") or "").strip().replace("\n", " ")
    snippet = body[:120] + ("…" if len(body) > 120 else "")
    return f"From {sender} — '{subject}'. {snippet}".rstrip()


def _summarize_drive_files(payload: dict) -> str:
    files = payload.get("files") or []
    if not files:
        return "No matching Drive files."
    names = [(f.get("name") or "").strip() for f in files[:3] if f.get("name")]
    head = ", ".join(names) if names else "—"
    extra = "" if len(files) <= 3 else f" (+{len(files) - 3} more)"
    return f"{len(files)} files. Recent: {head}{extra}."


def _summarize_sheets_data(payload: dict) -> str:
    values = payload.get("values") or []
    rows = len(values)
    cols = max((len(r) for r in values), default=0)
    if rows == 0:
        return "Sheet is empty."
    first_row = values[0] if values else []
    joined = ", ".join(str(c) for c in first_row if str(c).strip())
    if len(joined) > 80:
        joined = joined[:77] + "…"
    return f"{rows} rows, {cols} columns. First row: {joined}." if joined else f"{rows} rows, {cols} columns."


def _summarize_docs_content(payload: dict) -> str:
    title = (payload.get("title") or "Untitled").strip()
    word_count = payload.get("word_count") or 0
    body = (payload.get("content") or "").strip().replace("\n", " ")
    excerpt = body[:80] + "…" if len(body) > 80 else body
    if excerpt:
        return f"{title}: {word_count} words. Excerpt: {excerpt}"
    return f"{title}: {word_count} words."


def _summarize_generic(language: str, payload: Any) -> str:
    """Catch-all when we don't have a bespoke summarizer for this fence
    label. Never dump JSON — point Adam at his Mac for the full data."""
    pretty = language.replace("-", " ").replace("_", " ").strip()
    if isinstance(payload, dict):
        # Surface any obvious "count" hint we can find without hard-coding.
        for key in ("count", "total", "total_rows", "n", "size"):
            if isinstance(payload.get(key), int):
                return f"Got {pretty} — {payload[key]} result(s). Full data on your Mac."
        # If it looks like a list-of-things payload, surface the length.
        for key in ("messages", "events", "files", "values", "items", "contacts", "opportunities", "conversations"):
            if isinstance(payload.get(key), list):
                return f"Got {pretty} — {len(payload[key])} result(s). Full data on your Mac."
    return f"Got {pretty} results — full data on your Mac."


_TOOL_SUMMARIZERS = {
    "google-calendar-events": _summarize_calendar_events,
    "google-gmail-messages": lambda p, now=None: _summarize_gmail_messages(p),
    "google-gmail-message": lambda p, now=None: _summarize_gmail_message(p),
    "google-drive-files": lambda p, now=None: _summarize_drive_files(p),
    "google-sheets-data": lambda p, now=None: _summarize_sheets_data(p),
    "google-docs-content": lambda p, now=None: _summarize_docs_content(p),
}


def parse_tool_fences(text: str) -> list[dict]:
    """Find every fenced tool-output block in ``text``. Returns a list of
    ``{language, payload, full_block, span}`` dicts (``payload`` is the
    decoded JSON or None on parse error; ``span`` is the (start, end)
    indices in the source string)."""
    out: list[dict] = []
    for m in _TOOL_FENCE_RE.finditer(text or ""):
        lang = m.group(1)
        body = m.group(2)
        try:
            data = json.loads(body)
        except (ValueError, TypeError):
            data = None
        out.append({
            "language": lang,
            "payload": data,
            "full_block": m.group(0),
            "span": m.span(),
        })
    return out


def summarize_tool_output(language: str, payload: Any, now: Optional[datetime] = None) -> str:
    """One-line plain-text summary of a tool-output fence. Never returns
    raw JSON — falls back to a generic "results on your Mac" line for
    languages we don't know."""
    summarizer = _TOOL_SUMMARIZERS.get(language)
    if summarizer is None or not isinstance(payload, dict):
        return _summarize_generic(language, payload)
    try:
        return summarizer(payload, now=now)
    except Exception:  # noqa: BLE001 — never let a bad payload break egress
        return _summarize_generic(language, payload)


def _replace_tool_fences(text: str, now: Optional[datetime] = None) -> str:
    """Substitute every tool-output fence with its prose summary."""

    def sub(match: re.Match) -> str:
        lang = match.group(1)
        body = match.group(2)
        try:
            data = json.loads(body)
        except (ValueError, TypeError):
            data = None
        return summarize_tool_output(lang, data, now=now)

    return _TOOL_FENCE_RE.sub(sub, text)


# ---------------------------------------------------------------------------
# Markdown table & action-card transforms (carried over from Step 4)
# ---------------------------------------------------------------------------

def _convert_table_block(lines: list[str]) -> list[str]:
    if not lines:
        return []
    header_cells = [c.strip() for c in lines[0].strip().strip("|").split("|")]
    body_rows: list[list[str]] = []
    for raw in lines[1:]:
        if _TABLE_DIVIDER_RE.match(raw) and "-" in raw:
            continue
        cells = [c.strip() for c in raw.strip().strip("|").split("|")]
        if len(cells) < len(header_cells):
            cells.extend([""] * (len(header_cells) - len(cells)))
        body_rows.append(cells[: len(header_cells)])
    out: list[str] = []
    for row in body_rows:
        if not any(row):
            continue
        if len(header_cells) <= 1 or not any(header_cells):
            out.append("• " + " ".join(c for c in row if c))
            continue
        parts = []
        for h, v in zip(header_cells, row):
            if not v:
                continue
            if h:
                parts.append(f"{h}: {v}")
            else:
                parts.append(v)
        out.append("• " + " — ".join(parts))
    return out


def _strip_markdown_tables(text: str) -> str:
    lines = text.splitlines()
    result: list[str] = []
    i = 0
    while i < len(lines):
        if _TABLE_LINE_RE.match(lines[i]):
            block = []
            while i < len(lines) and _TABLE_LINE_RE.match(lines[i]):
                block.append(lines[i])
                i += 1
            result.extend(_convert_table_block(block))
            continue
        result.append(lines[i])
        i += 1
    return "\n".join(result)


def _replace_action_cards(text: str, summaries: Optional[dict[str, str]]) -> str:
    def sub(match: re.Match) -> str:
        token = match.group(1)
        summary = (summaries or {}).get(token, "").strip()
        if summary:
            return f"Card waiting on your Mac to confirm — {summary}"
        return "Card waiting on your Mac to confirm — open Mission Control to review."

    return _ACTION_CARD_RE.sub(sub, text)


def _collapse_blank_runs(text: str) -> str:
    return re.sub(r"\n\s*\n\s*\n+", "\n\n", text)


def _truncate(text: str, max_chars: int) -> str:
    if max_chars <= 0 or len(text) <= max_chars:
        return text
    cut = text.rfind("\n\n", 0, max_chars)
    if cut < max_chars // 2:
        cut = text.rfind(". ", 0, max_chars)
        if cut < max_chars // 2:
            cut = max_chars
        else:
            cut += 1
    head = text[:cut].rstrip()
    return f"{head}\n\n…reply 'full' for the rest."


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def format_for_whatsapp(
    text: str,
    action_summaries: Optional[dict[str, str]] = None,
    max_chars: int = 500,
    now: Optional[datetime] = None,
) -> str:
    """Reshape Jackson's desktop-flavoured reply for WhatsApp egress.

    - Tool-output fences (google-*, ghl-*) become prose summaries.
    - Markdown tables become bullets.
    - Action-card markers become "Card waiting on your Mac to confirm — ...".
    - Capped at ``max_chars`` with a continuation hint.

    ``now`` is overridable for deterministic tests; defaults to the wall
    clock at call time (with the timezone of any ISO timestamp in scope)."""
    if not text:
        return ""
    out = _replace_tool_fences(text, now=now)
    out = _strip_markdown_tables(out)
    out = _replace_action_cards(out, action_summaries)
    out = _collapse_blank_runs(out)
    out = out.strip()
    out = _truncate(out, max_chars)
    return out
