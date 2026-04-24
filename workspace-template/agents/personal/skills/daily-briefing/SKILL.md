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

Scaffold only — implementation pending. Required tools/credentials to activate: Google Workspace CLI (`gog`) or himalaya + calendar read access; authenticated session for whichever source is chosen. Also needs `calendar-check` and `email-triage` as dependencies.
