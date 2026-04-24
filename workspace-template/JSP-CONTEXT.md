# JSP-CONTEXT.md — Firm Operating Rules

Jackson Swiss ("JSP") is a UK firm in foreign exchange and lending. This file is the **source of truth** for how the marketing specialist — and anything else touching firm business — must operate. The main agent and both specialists consult it before acting on a business task. Cite it by name when a decision flows from it.

## Lead sourcing

Batches are already purchased from **Zint, Cognism, Fame, Lusha, and Zoom Info**. **Do not source new leads.** Work from whatever batch Adam hands over.

## Identify the MAN (Money, Authority, Need)

For each company in a batch, identify the named MAN in **strict priority order**:

1. **Largest private shareholder of the company.**
2. **Largest private shareholder of the parent company.**
3. **CEO or Managing Director.**
4. **CFO or Finance Director.**

Use **Pomanda first** — it wraps the Companies House API. Fall back to **LinkedIn** only when Pomanda is thin. Larger companies may legitimately surface two or three appropriate contacts — return them all, ranked.

## Contact enrichment cascade

Goal: **email + personal mobile** for each named MAN.

1. **Cognism first.** ~70% UK hit rate, 10,000 credits/month, cheapest per hit.
2. **Lusha fallback.** Premium, limited credits. Use only when Cognism misses.
3. **Stop the cascade the moment both email and mobile are found.** No extra lookups "while we're here".

## CRM routing

- All enriched contacts → **HubSpot** (already auto-syncs today via a Chrome plugin; preserve that behaviour).
- Marketing-specific contacts also → **GHL (GoHighLevel)**, the separate marketing CRM.

## Budget — non-negotiable (from the boss)

- **Every tool has a hard monthly cap.** When it's hit, stop using that tool and say so.
- **No auto-renew** on any subscription. Ever.
- **No auto-top-up** on credits. Ever.
- **Log every tool call:** tool, credits used, £ cost, outcome. Underused subscriptions get cut on review.
- **Never spend more than £1 per contact without asking first.**

## Outreach

- **Nothing goes out without Adam's explicit approval.** Not email. Not LinkedIn. Not SMS. Draft, present, wait.
- Track which tool produced each contact so hit-rates are measurable over time.

## Escalation

If a batch is blocked — cascade exhausted, caps hit, priority contacts unreachable — **stop and report.** Do not improvise workarounds.
