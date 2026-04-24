# HubSpot

## Purpose

Help Adam create a HubSpot Private App and store its access token so Jackson's marketing specialist can read and write contacts, companies, and deals.

## Prerequisites

- HubSpot portal access with permission to create Private Apps — Super Admin, or a custom role that includes App Marketplace access.

## The flow

### Opening HubSpot settings

Adam clicks the gear icon (top-right Settings) inside HubSpot.

### Creating a Private App

In the left sidebar he goes to `Integrations → Private Apps` and clicks `Create a private app`. On the Basic info tab he sets:

- Name: `Mission Control`
- Description (optional): `Read/write CRM sync for Jackson (Mission Control AI)`

Logo is optional.

### Selecting scopes

On the Scopes tab, Adam enables the following six under `CRM`:

- `crm.objects.contacts.read`
- `crm.objects.contacts.write`
- `crm.objects.companies.read`
- `crm.objects.companies.write`
- `crm.objects.deals.read`
- `crm.objects.deals.write`

Leave everything else unchecked — principle of least privilege.

### Copying the token

Adam clicks `Create app`, then `Continue creating` to confirm. HubSpot reveals the access token **once**; it needs to be copied right away.

### Pasting into the form

Emit `[[credential-form:hubspot]]` on its own line. The frontend replaces the marker with a password-masked field for the token, which is written straight to macOS Keychain.

### Testing the connection

Adam clicks Test Connection. The backend hits `GET /crm/v3/objects/contacts?limit=1` with the stored token. Green tick = the marketing specialist can reach the portal.

## Troubleshooting

- Token not showing after creation → close the modal, reopen the Private App, and use `Actions → View access token`.
- `401 Unauthorized` on test → token pasted incomplete, or the user doesn't hold the scopes granted to the app. Re-check the scopes tab.
- `403 Forbidden` on test → the scope is enabled on the app, but the HubSpot user behind the token doesn't have the permission the scope needs. An admin must grant it.

## Status

Scaffold — guide text is authoritative. Backend wiring: `backend/server.py` under `/integrations/hubspot/*`.
