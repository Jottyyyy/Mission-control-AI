# Email Triage

## Purpose

Process Adam's inbox and return the handful he actually needs to see. Runs on request and as a dependency of `daily-briefing`. Buckets mail into categories — action-needed, FYI, noise, likely spam — and surfaces only the action-needed bucket up front. Never replies, never archives silently; Adam decides, the skill just sorts.

## Inputs

- Inbox source (TBD — IMAP via himalaya, or Gmail via `gog`).
- Lookback window (default: since last triage).
- Optional: priority-sender list kept in `MEMORY.md` or `USER.md`.

## Outputs

- Bucketed list with counts. For each action-needed item: sender, one-line subject, one-line "why it matters".
- Suggested next action per item (reply / defer / delete) — flagged, never executed.

## Status

Live. `action:google.gmail_list_messages` and `action:google.gmail_get_message` are wired through the Google Workspace integration (v1.20). Use a Gmail search query (e.g. `is:inbox newer_than:2d`, `is:unread label:^starred`) to scope the triage. Sending replies stays out of scope here — drafting outgoing email goes via `action:google.gmail_send` and always needs Adam's confirmation on the action card.
