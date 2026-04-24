# Pomanda

## Purpose

Pomanda wraps the Companies House dataset with enriched shareholder information, which is what the marketing specialist needs to identify the MAN per JSP's priority order — largest private shareholder, then parent-company shareholder, then CEO/MD, then CFO/FD. Connecting Pomanda unlocks step one of every `lead-batch-run`.

## Prerequisites

- A Pomanda account with API access. Pomanda gates the API behind paid tiers — if Adam doesn't already have it, Mara (JSP ops) manages the subscription and should be asked first.
- Admin permission on the Pomanda workspace (needed to generate an API key).

## The flow

### Finding the API keys area

Adam signs in at [pomanda.com](https://pomanda.com), clicks the avatar (top-right) and opens `Settings`. The API key controls are usually under `Settings → API` or `Settings → Integrations` depending on the Pomanda version.

### Generating the key

Adam clicks `Generate new API key`, names it `Mission Control`, and copies the key as soon as Pomanda reveals it — Pomanda only shows the full value once.

### Pasting the credentials

`[[credential-form:pomanda]]`

A password-masked field for the API key appears. The value is written straight to macOS Keychain; it doesn't touch the chat, the database, or Anthropic.

### Testing the connection

Adam clicks `Test Connection`. The backend hits Pomanda with a tiny, read-only company probe. Green tick = the marketing specialist can now call `identify-man` with Pomanda as the primary source.

## Troubleshooting

- `401 Unauthorized` → the key was pasted incomplete or Pomanda rejected it. Regenerate and paste again.
- `403 Forbidden` → the key is valid but the plan doesn't include API access. Ask Mara to check the Pomanda subscription tier.
- "Can't reach Pomanda" → the backend couldn't open a TCP connection. Usually the Mac Mini is offline; try again once the network is back.

## Status

Scaffold — guide text is authoritative. Backend wiring lives in `backend/server.py` under `/integrations/pomanda/*`. The test-endpoint shape is best-guess pending real-credential verification by Mara.
