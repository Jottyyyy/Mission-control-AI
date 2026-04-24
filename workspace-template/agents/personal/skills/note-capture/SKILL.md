# Note Capture

## Purpose

Capture a quick thought, decision, or follow-up into the right place without interrupting Adam's flow. He speaks or types one line; the skill files it — the day's `memory/YYYY-MM-DD.md` by default, `MEMORY.md` if he flags it long-term, or a named project file if he points to one. Optional: mirror to Apple Notes, Bear, or Obsidian when/if those skills are activated.

## Inputs

- Raw text (or transcribed voice) of the note.
- Optional tag: `today` (default), `keep` (→ `MEMORY.md`), `project:<name>` (→ project file).
- Timestamp (auto).

## Outputs

- Confirmation of where it was filed — path plus a one-line preview.
- Nothing more. No editorial, no rewrite unless he asked.

## Status

Scaffold only — implementation pending. Required tools/credentials to activate: write access to `memory/` and `MEMORY.md` (already available). Optional note-app bridges — `memo` for Apple Notes, `grizzly` for Bear, `obsidian-cli` — not required for v1.
