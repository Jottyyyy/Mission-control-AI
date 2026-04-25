# GHL (GoHighLevel)

## Purpose

Help Adam mint a Private Integration Token and bind it to the JSP Location so Mission Control can sync verified contacts, opportunities, and conversations.

## Prerequisites

- GHL Location admin (or Agency admin acting on behalf of the JSP Location).
- The Location ID for the JSP sub-account — Tom or Mara can confirm which one.

## The flow

### 1. Open GHL Settings

Inside GHL, Adam clicks the gear icon (top-right) to open Settings.

### 2. Find Private Integrations

Navigate to **Integrations → Private Integrations**. (On older accounts this lives under **My Agency → API Keys**, but new accounts only expose Private Integrations.) Click **Create new integration**.

### 3. Configure scopes

Name the integration `Mission Control AI` and tick:

- `contacts.readonly` + `contacts.write`
- `opportunities.readonly` + `opportunities.write`
- `conversations.readonly` + `conversations.write`
- `calendars.readonly` + `calendars.write`
- `users.readonly` + `locations.readonly`

Click **Generate token**. The token starts with `pit-` followed by a UUID. GHL only reveals it once — copy it immediately.

### 4. Find the Location ID

Open **Settings → Business Profile**. The Location ID is a short alphanumeric string near the top of the page (it's also the long suffix in your dashboard URL when you're inside a Location).

### 5. Paste both into the form

Emit `[[credential-form:ghl]]` on its own line. The frontend renders two fields — masked Private Integration Token and plain-text Location ID — that write straight to macOS Keychain.

### 6. Test the connection

Adam clicks **Test Connection**. The backend calls `GET /locations/{location_id}` against `services.leadconnectorhq.com` with the V2 `Version: 2021-07-28` header. A green tick means both pieces of the credential are good.

## Troubleshooting

- `401 Unauthorized` → Token rejected. Regenerate in Settings → Private Integrations.
- `404 Not Found` → Location ID wrong. Check Settings → Business Profile.
- `403 Forbidden` → A required scope is missing — re-check the boxes ticked above and regenerate.
- Token doesn't start with `pit-` → Likely a legacy v1 key. Switch to Private Integrations.

## Status

Wired. Backend client: `backend/integrations/ghl.py`. Test endpoint: `POST /integrations/ghl/test`. Read-only HTTP wrappers under `/integrations/ghl/{contacts,opportunities,conversations,calendars}`. Write paths require an action card (`action:ghl.create_contact`).
