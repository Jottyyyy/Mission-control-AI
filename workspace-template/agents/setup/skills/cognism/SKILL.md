# Cognism

## Purpose

Cognism is the marketing specialist's primary enrichment source — roughly 70% UK hit rate on email + mobile, cheapest per credit, and hard-capped at 10k credits/month per JSP-CONTEXT.md. Connecting Cognism lets `enrich-contact` start the cascade from the right place.

## Prerequisites

- A Cognism workspace with admin permissions (required to issue an API key).
- Awareness that the monthly cap is non-negotiable: when the 10k credits are burned, the marketing specialist stops using the tool and tells Adam. No auto-top-up, no workaround — that's a rule from leadership, not a suggestion.

## The flow

### Finding the API keys area

Adam signs in at [app.cognism.com](https://app.cognism.com) and opens `Settings → Integrations → API Keys`. The exact label moves around between Cognism releases; if it's not there, try `Admin → API` or search the settings sidebar for "API".

### Generating the key

Adam clicks `Generate new API key`, labels it `Mission Control`, and copies the value immediately. Cognism reveals the full key once, then stores it hashed.

### Pasting the credentials

`[[credential-form:cognism]]`

A password-masked field for the API key appears. The value goes straight to macOS Keychain.

### Testing the connection

Adam clicks `Test Connection`. The backend makes a lightweight account-level call against the Cognism API with the stored key. Green tick = the marketing specialist can now run `enrich-contact` with Cognism as the primary step. No credits are burned by the test — it's an account probe, not an enrichment query.

## Troubleshooting

- `401 Unauthorized` → wrong key, partial paste, or the key was revoked in the Cognism dashboard. Regenerate.
- `403 Forbidden` → the user who generated the key doesn't have admin permission. Cognism requires admin to mint API keys.
- Monthly cap hit mid-month → the backend will report it on the first failed enrichment call (not here). The rule is stop; don't top up without Adam's approval.

## Status

Scaffold — guide text is authoritative. Backend wiring lives in `backend/server.py` under `/integrations/cognism/*`. The test-endpoint shape is best-guess pending real-credential verification by Mara.
