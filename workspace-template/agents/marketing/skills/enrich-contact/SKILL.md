# Enrich Contact

## Purpose

Take a named MAN and return verified **email + personal mobile** via the `../../../JSP-CONTEXT.md` cascade: Cognism first, Lusha only on miss, **stop the moment both are found**. Auto-syncs to HubSpot (via the existing Chrome plugin today — behaviour preserved) and pushes marketing-scoped contacts to GHL. Logs every call with cost and outcome so hit-rates are measurable over time.

## Inputs

- Named contact: full name, company, ideally LinkedIn URL.
- Current budget state — remaining cap for each tool this month.
- Destination CRM flags: HubSpot always; GHL when the contact is marketing-scoped.

## Outputs

- Structured result: `{email, mobile, source_per_field, tool_calls:[{tool, credits, £cost}], crm_ids:{hubspot, ghl?}}`.
- Or, if the cascade is exhausted: explicit "not found" with which tools tried, which credits were burned, and recommended next step.

## Status

Scaffold only — implementation pending. Required tools/credentials to activate: Cognism API key + credit-budget config; Lusha API key + credit-budget config; HubSpot and GHL tokens for direct-API sync if/when we move off the Chrome plugin.
