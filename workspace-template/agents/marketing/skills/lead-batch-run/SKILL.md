# Lead Batch Run

## Purpose

Process a full batch of sourced companies end-to-end: for each row, run `identify-man`, then `enrich-contact` on each returned MAN, logging results and respecting the cascade and budget rules. Stops immediately if a tool hits its monthly cap. Produces a run summary that feeds directly into `pipeline-review`.

## Inputs

- Batch file or identifier (CSV, or a row set in the pipeline store).
- Source tag for provenance (Zint / Cognism-batch / Fame / Lusha-batch / Zoom Info).
- Optional: concurrency cap (default low, to avoid API throttling and accidental overspend).

## Outputs

- Per-company result: MAN(s), enrichment outcome, tool calls with cost, CRM IDs.
- Run summary: totals, blockers, spend vs cap per tool, wallclock time.
- All writes go to the pipeline store so `pipeline-review` can read without re-running any lookup.

## Status

Scaffold only — implementation pending. Required tools/credentials to activate: everything `identify-man` and `enrich-contact` need (Pomanda, LinkedIn, Cognism, Lusha, HubSpot, GHL), plus the pipeline state store. Dry-run mode (log without calling paid APIs) should ship before live.
