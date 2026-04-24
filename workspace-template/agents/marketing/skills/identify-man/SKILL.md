# Identify MAN

## Purpose

For a given company, return the named MAN (Money, Authority, Need) contacts in strict priority order per `../../../JSP-CONTEXT.md`: largest private shareholder → largest private shareholder of parent → CEO / MD → CFO / FD. Used as step 1 of `lead-batch-run` and available ad-hoc when Adam names a single target company.

## Inputs

- Company identifier: legal name, or Companies House number, or website domain.
- Optional: parent-company hint if already known.
- Target count (default 1; larger companies may return 2–3 ranked candidates).

## Outputs

- Ranked list of named candidates. Per candidate: full name, title, why they qualify under the priority rule, source (Pomanda / LinkedIn), and confidence.
- If no candidate found at any priority level, an explicit "exhausted" signal with reason, not a blank.

## Status

Scaffold only — implementation pending. Required tools/credentials to activate: Pomanda account + API key (primary, wraps Companies House), and LinkedIn access (secondary — either a logged-in session via browser tooling or Sales Navigator API).
