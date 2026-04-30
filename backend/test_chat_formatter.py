"""Unit tests for chat_formatter.format_for_whatsapp.

Run from backend/:
    python3 -m pytest test_chat_formatter.py -v
or:
    python3 test_chat_formatter.py
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone, timedelta

from chat_formatter import format_for_whatsapp, summarize_tool_output, parse_tool_fences


# A fixed "today" for the calendar/time-sensitive tests. 2026-04-29 is the
# day v1.28 Step 4.5 was built — same as the live trace timestamps.
PHT = timezone(timedelta(hours=8))
NOW = datetime(2026, 4, 29, 21, 30, 0, tzinfo=PHT)


def _fence(label: str, payload: dict) -> str:
    return f"```{label}\n{json.dumps(payload, indent=2)}\n```"


CASES: list[tuple[str, str, dict, str]] = [
    # --- v1.28 Step 4 cases (carried over) -------------------------------
    (
        "plain prose passes through",
        "Morning, Adam. Two events today — 11am MAN review, 3pm Tom call.",
        {},
        "Morning, Adam.&&MAN review&&Tom call",
    ),
    (
        "markdown table flattens to bullets",
        "Today's events:\n\n| Time | Title | Where |\n|------|-------|-------|\n| 11am | MAN review | Office |\n| 3pm | Tom call | Zoom |\n\nNothing else booked.",
        {},
        "• Time: 11am — Title: MAN review — Where: Office&&• Time: 3pm — Title: Tom call — Where: Zoom&&Nothing else booked.",
    ),
    (
        "action card marker becomes 'Card waiting' with summary",
        "Drafted the email — confirm on your Mac:\n\n[[action-card:abc12345-6789-aaaa-bbbb-ccccddddeeff]]",
        {"action_summaries": {"abc12345-6789-aaaa-bbbb-ccccddddeeff": "Send Tom a 'running 10min late' note"}},
        "Card waiting on your Mac to confirm — Send Tom a 'running 10min late' note",
    ),
    (
        "action card without summary falls back to generic",
        "Here's the card:\n[[action-card:00000000-1111-2222-3333-444444444444]]",
        {},
        "Card waiting on your Mac to confirm — open Mission Control to review.",
    ),
    (
        "very long reply truncates with continuation hint",
        ("Here's a long briefing. " * 60).strip(),
        {"max_chars": 200},
        "…reply 'full' for the rest.",
    ),

    # --- v1.28 Step 4.5 — tool-output fence summarization ---------------
    (
        "google-calendar-events: empty list → 'Nothing on your calendar today.'",
        _fence("google-calendar-events", {
            "time_min": "2026-04-29T00:00:00+08:00",
            "time_max": "2026-04-29T23:59:59+08:00",
            "events": [],
        }),
        {"now": NOW},
        "Nothing on your calendar today.",
    ),
    (
        "google-calendar-events: single event → 'Today: one event — Work, 8:30 PM to 2 AM tomorrow.'",
        _fence("google-calendar-events", {
            "events": [{
                "id": "abc",
                "summary": "Work",
                "start": "2026-04-29T20:30:00+08:00",
                "end":   "2026-04-30T02:00:00+08:00",
                "all_day": False,
            }],
        }),
        {"now": NOW},
        "Today: one event — Work, 8:30 PM to 2 AM tomorrow.",
    ),
    (
        "google-calendar-events: 5 events → headlines + 'Reply full for the rest.'",
        _fence("google-calendar-events", {
            "events": [
                {"summary": "Standup",     "start": "2026-04-29T09:00:00+08:00", "end": "2026-04-29T09:30:00+08:00"},
                {"summary": "MAN review",  "start": "2026-04-29T11:00:00+08:00", "end": "2026-04-29T12:00:00+08:00"},
                {"summary": "Tom call",    "start": "2026-04-29T15:00:00+08:00", "end": "2026-04-29T15:30:00+08:00"},
                {"summary": "Vendor demo", "start": "2026-04-29T17:00:00+08:00", "end": "2026-04-29T18:00:00+08:00"},
                {"summary": "Work",        "start": "2026-04-29T20:30:00+08:00", "end": "2026-04-30T02:00:00+08:00"},
            ],
        }),
        {"now": NOW},
        "Today: 5 events. Headlines — Standup at 9 AM, MAN review at 11 AM, Tom call at 3 PM. Reply 'full' for the rest.",
    ),
    (
        "google-gmail-messages: empty inbox → 'Inbox clean.'",
        _fence("google-gmail-messages", {"messages": []}),
        {},
        "Inbox clean.",
    ),
    (
        "google-gmail-messages: multiple unread → top senders + latest subject",
        _fence("google-gmail-messages", {
            "messages": [
                {"from": "Tom <tom@example.com>", "subject": "Re: pitch deck", "unread": True},
                {"from": "Tom <tom@example.com>", "subject": "Old thread",     "unread": True},
                {"from": "Stripe <noreply@stripe.com>", "subject": "Invoice ready", "unread": True},
                {"from": "GitHub <noreply@github.com>", "subject": "PR review",     "unread": False},
            ],
        }),
        {},
        "3 unread from Tom, Stripe. Latest: Re: pitch deck.",
    ),
    (
        "google-drive-files: list of three → 'Recent: A, B, C'",
        _fence("google-drive-files", {
            "files": [
                {"name": "Pitch deck v3.pdf"},
                {"name": "MAN brief — Q2.docx"},
                {"name": "FX rates 2026.xlsx"},
            ],
        }),
        {},
        "3 files. Recent: Pitch deck v3.pdf, MAN brief — Q2.docx, FX rates 2026.xlsx.",
    ),
    (
        "google-sheets-data: rows/cols + first-row preview",
        _fence("google-sheets-data", {
            "values": [
                ["Name", "Email", "Phone"],
                ["Adam", "adam@jsp.co.uk", "+44 7..."],
                ["Tom",  "tom@example.com", ""],
            ],
        }),
        {},
        "3 rows, 3 columns. First row: Name, Email, Phone.",
    ),
    (
        "google-docs-content: title + word count + excerpt",
        _fence("google-docs-content", {
            "title": "Q2 priorities",
            "word_count": 312,
            "content": "Top priorities for the quarter: hiring two SDRs, launching the new pitch deck, and closing the deal with…",
        }),
        {},
        "Q2 priorities: 312 words. Excerpt: Top priorities for the quarter: hiring two SDRs",
    ),
    (
        "unknown ghl-* fence → generic fallback ('Got <pretty> results — full data on your Mac.')",
        _fence("ghl-search-contacts", {"contacts": [{"name": "X"}, {"name": "Y"}]}),
        {},
        "Got ghl search contacts — 2 result(s). Full data on your Mac.",
    ),
    (
        "mixed prose + tool fence: prose preserved, fence replaced",
        "Here's what's on today:\n\n"
        + _fence("google-calendar-events", {"events": []})
        + "\n\nLet me know if anything else.",
        {"now": NOW},
        "Here's what's on today:&&Nothing on your calendar today.&&Let me know if anything else.",
    ),

    # --- defense in depth: never leak raw JSON ----------------------------
    (
        "calendar fence with malformed JSON → still no JSON in output (generic fallback)",
        "```google-calendar-events\nthis is not json\n```",
        {"now": NOW},
        "Got google calendar events results — full data on your Mac.",
    ),
]


def run_one(name: str, text: str, kwargs: dict, expected_substr: str) -> tuple[bool, str]:
    actual = format_for_whatsapp(text, **kwargs)
    expected_parts = [p for p in expected_substr.split("&&") if p]
    missing = [p for p in expected_parts if p not in actual]
    if missing:
        return False, f"  expected substring(s) not found: {missing!r}\n  actual:\n  ---\n{actual}\n  ---"
    # Defence in depth — never leak raw JSON markers in egress text.
    leaks = [tok for tok in ("```google-", "```ghl-", '"events":', '"messages":', '"files":') if tok in actual]
    if leaks:
        return False, f"  leaked raw fence/JSON tokens: {leaks!r}\n  actual:\n  ---\n{actual}\n  ---"
    return True, ""


def main() -> int:
    passed = 0
    failed = 0
    for name, text, kwargs, expected in CASES:
        ok, msg = run_one(name, text, kwargs, expected)
        status = "PASS" if ok else "FAIL"
        print(f"[{status}] {name}")
        if not ok:
            print(msg)
            failed += 1
        else:
            passed += 1
    print(f"\n{passed} passed, {failed} failed.")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
