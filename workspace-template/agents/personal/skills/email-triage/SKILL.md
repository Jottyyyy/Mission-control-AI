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

Scaffold only — implementation pending. Required tools/credentials to activate: himalaya configured with IMAP creds, or `gog` with Gmail read scope. Sending is out of scope for this skill — drafting replies belongs elsewhere and always needs Adam's approval.
