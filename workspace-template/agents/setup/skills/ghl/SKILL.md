# GHL (GoHighLevel)

## Purpose

Help Adam generate a GoHighLevel API key and bind it to the right sub-account so Jackson's marketing specialist can push enriched contacts into the firm's marketing CRM.

## Prerequisites

- GHL Agency admin (for Agency-level keys) or Location admin (for a single sub-account).
- The Sub-account (Location) ID that the firm uses for JSP outreach — Adam or Mara will confirm which one.

## The flow

### Finding the API keys panel

Inside GHL, Adam clicks the gear icon (top-right Settings). For an Agency account the panel lives under `My Agency → API Keys`; for a Location account it's a top-level `API Keys` entry in Settings.

### Generating a new Agency API key

Adam clicks `Generate new API key`. If his account has sub-accounts, he picks the sub-account used by JSP; otherwise the key is Agency-wide. He labels it `Mission Control` and copies the key the moment GHL reveals it — GHL only shows the key once.

### Selecting the correct sub-account

From the top-left account switcher, Adam hovers or clicks the sub-account and copies its ID from the URL or the account details panel. If the firm runs GHL Agency-wide without sub-accounts, this field stays blank.

### Pasting into the form

Emit `[[credential-form:ghl]]` on its own line. The frontend replaces the marker with two password-masked fields (API Key, Sub-account ID) that write straight to macOS Keychain.

### Testing the connection

Adam clicks Test Connection. The backend calls `GET /v1/locations/`, or the sub-account detail endpoint when a Sub-account ID is stored. Green tick = the marketing specialist can reach the firm's GHL instance.

## Troubleshooting

- `401 Unauthorized` → key pasted incomplete, or generated at the wrong tier (Agency vs Location). Regenerate at the level that matches.
- `403 Forbidden` → key is valid but doesn't have access to the Sub-account ID supplied. Either use a matching Agency-level key or pick the right sub-account.
- Empty locations list → key works but no sub-accounts are attached. Confirm with Adam / Mara which account JSP actually uses.

## Status

Scaffold — guide text is authoritative. Backend wiring: `backend/server.py` under `/integrations/ghl/*`.
