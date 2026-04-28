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

Live. Notes write directly into the workspace — `memory/YYYY-MM-DD.md` for the running daily log, `MEMORY.md` for curated long-term keepers (main sessions only). For notes Adam wants in Google Docs, emit `action:google.docs_create` for confirmation via the action card.
