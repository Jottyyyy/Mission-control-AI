# Lusha

## Purpose

Lusha is the **premium fallback** in JSP's enrichment cascade — the marketing specialist only calls it when Cognism misses. Lusha is the expensive one, so the `£1 per contact` ceiling from JSP-CONTEXT.md applies strictly: anything that would cost more without explicit approval, the specialist stops and asks.

## Prerequisites

- A Lusha Premium or Scale plan — the free and entry tiers don't expose the API.
- Admin permission on the Lusha workspace to issue the key.

## The flow

### Finding the API keys area

Adam signs in at [lusha.com](https://lusha.com), clicks the avatar (top-right) → `Settings`, then `API` in the left sidebar. On some plans it appears as `Developer → API Keys` instead.

### Generating the key

Adam clicks `Generate API key` (or `Create token`), labels it `Mission Control`, and copies the value. Lusha shows the key once at creation.

### Pasting the credentials

`[[credential-form:lusha]]`

A password-masked field for the API key appears. The value goes straight to macOS Keychain.

### Testing the connection

Adam clicks `Test Connection`. The backend calls Lusha's credit-usage endpoint with the stored key — a read-only call that doesn't consume enrichment credits. Green tick = Lusha is ready as the cascade fallback.

## Troubleshooting

- `401 Unauthorized` → the key is invalid, partial, or revoked. Regenerate.
- `403 Forbidden` → the plan tier doesn't include API access. Upgrade to Premium/Scale or raise it with Mara before trying again.
- Credit usage already near zero → Lusha's monthly credits are small by design. The specialist will surface spend-to-date in `pipeline-review`; when a batch looks like it'll blow through the remaining credits, Adam approves or stops. £1/contact is the hard line.

## Status

Scaffold — guide text is authoritative. Backend wiring lives in `backend/server.py` under `/integrations/lusha/*`. The test-endpoint shape is best-guess pending real-credential verification by Mara.
