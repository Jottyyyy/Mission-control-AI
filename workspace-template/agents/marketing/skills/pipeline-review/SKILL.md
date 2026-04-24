# Pipeline Review

## Purpose

Report the state of the current batch: how many companies processed, how many MANs identified, how many fully enriched, how many blocked and why, and spend-to-date per tool against the monthly cap. Runs on request and as the tail step of `lead-batch-run`. Gives Adam a scan-in-a-minute view of where the pipeline stands so he can make the stop/continue call.

## Inputs

- Batch identifier (default: the active batch).
- Optional: date range for a historical view across batches.

## Outputs

- Funnel: `companies → MANs identified → emails found → mobiles found → CRM-synced`.
- Blocker list with reasons: no shareholder data, cascade exhausted, cap hit, etc.
- Spend table per tool: `used / cap / remaining` in credits and £.
- Hit-rate per tool (Cognism vs Lusha) for the current batch — for later review.

## Status

Scaffold only — implementation pending. Required tools/credentials to activate: a durable pipeline state store (SQLite in `data/`, or equivalent) that `enrich-contact` and `lead-batch-run` both write to.
