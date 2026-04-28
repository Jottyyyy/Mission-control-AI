# Calendar Check

## Purpose

Answer calendar questions — "am I free Thursday afternoon?", "what conflicts with moving the 3pm?", "block two hours tomorrow for deep work". Used ad-hoc and as a dependency of `daily-briefing` and `meeting-prep`. Always surfaces conflicts, travel time, and realistic prep buffers; never silently over-commits Adam.

## Inputs

- Query in plain English, or structured: date range + intent (find slot, check conflict, propose reschedule).
- Optional: meeting duration, participants, preferred time-of-day window.
- Calendar credentials (TBD — Google Calendar via `gog`, or Outlook equivalent).

## Outputs

- A compact answer: available slots or the specific conflict, with travel / prep implications spelled out.
- Draft calendar changes (never applied automatically — Adam approves, and the skill surfaces the action for him to confirm).

## Status

Live. The `google.calendar_list_events` and `google.calendar_create_event` actions are wired through Mission Control's Google Workspace integration (v1.20). For any calendar question, emit `action:google.calendar_list_events` and read the spliced result. For new events or moves, emit `action:google.calendar_create_event` for Adam to confirm via the action card. No auto-accept / auto-decline.
