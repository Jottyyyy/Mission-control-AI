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

Scaffold only — implementation pending. Required tools/credentials to activate: calendar read access, email-history access, and a query path into the marketing specialist's contact store (HubSpot API, or a shared workspace-side file).
