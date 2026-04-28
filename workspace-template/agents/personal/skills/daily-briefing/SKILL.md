# Daily Briefing

## Purpose

Produce Adam's morning readout. Runs on request, or as the first step of a heartbeat when he's online. Covers today's calendar, yesterday's residual items, unread inbox items that actually matter, and anything flagged overnight from the marketing pipeline. The aim is a scan-in-30-seconds page that tells him what moves today and what he can ignore.

## Inputs

- Today's date and Adam's timezone (default UK — GMT / BST).
- Access to calendar source (TBD — likely Google/Outlook via `gog`, or via himalaya for mail).
- Email source for triaged items.
- Optional: overnight deltas from the marketing pipeline (blocked leads, batch completion).

## Outputs

- Short structured brief: top 3 "must see", calendar at-a-glance, follow-ups outstanding, overnight flags.
- Under 150 words unless Adam asks for depth.

## Status

Live. The dependencies — `calendar-check` (via `action:google.calendar_list_events`) and `email-triage` (via `action:google.gmail_list_messages`) — are both wired through the Google Workspace integration (v1.20). Build the briefing by emitting those read markers; the results are spliced inline so the briefing can quote them.
