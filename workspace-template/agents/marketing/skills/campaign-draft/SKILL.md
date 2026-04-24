# Campaign Draft

## Purpose

Produce outreach copy drafts for Adam to review and send. **Never sends.** Given a segment (a list of enriched contacts) and a brief (product angle, tone, call-to-action), returns per-contact email and LinkedIn-note drafts — each personalised by role, company, and any public signal picked up during enrichment. Flags any draft that slips below JSP's bar or strays from the brief.

## Inputs

- Segment: list of enriched contacts (name, title, company, source notes).
- Brief: product angle, desired tone, CTA, any no-go phrases.
- Channel: email, LinkedIn connection note, LinkedIn InMail.

## Outputs

- One draft per contact per channel: subject (email), body, and a one-line rationale (why this angle for this person).
- Batch-level quality flags: too generic, missing personalisation, off-tone.
- Every draft is marked `status: awaiting_approval`. Nothing goes out from this skill.

## Status

Scaffold only — implementation pending. Required tools/credentials to activate: access to the enriched contact store, and Adam's approved tone / phrase library (to be captured in `MEMORY.md` or a dedicated `campaign-style.md` over time).
