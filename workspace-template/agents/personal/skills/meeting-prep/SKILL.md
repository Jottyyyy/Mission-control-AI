# Meeting Prep

## Purpose

Produce a pre-meeting brief: who Adam is meeting, recent relevant context, the likely agenda, any open threads from previous encounters, and — if the meeting touches a lead — the marketing specialist's current file on that contact. Runs on demand, and as an auto-step before any meeting in `daily-briefing` output.

## Inputs

- Meeting identifier: calendar event, or attendee name + time.
- Attendee details (names, companies) — pulled from the calendar invite or supplied.
- Optional: lead ID from the marketing pipeline if an attendee matches an enriched contact.

## Outputs

- A one-page brief: attendees and their roles, last-contact summary, likely agenda / talking points, flagged open items, suggested questions.
- Clearly separates known facts from inferences.

## Status

Live. Calendar context comes from `action:google.calendar_list_events`; email history from `action:google.gmail_list_messages` (Gmail search syntax — e.g. `from:<attendee> newer_than:30d`); CRM context from `action:ghl.search_contacts`. Compose the brief by emitting those read markers and summarising the spliced results.
