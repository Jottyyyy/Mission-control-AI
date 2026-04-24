# Google Workspace

## Purpose

Help Adam set up a Google Cloud OAuth project that enables Calendar, Gmail, Drive, and People (Contacts) APIs for Mission Control. Once done, Jackson's personal specialist can read Adam's calendar and inbox and — with Adam's explicit confirmation in chat — draft and send emails, create calendar events, make Drive files, and edit contacts on his behalf. Adam always confirms each action before it fires.

## Prerequisites

- A Google account that has permission to create Cloud projects.
- Owner/admin on the Workspace domain if JSP's domain is managed (so the OAuth consent screen can be Internal).

## The flow

### Creating the project

Adam opens [console.cloud.google.com](https://console.cloud.google.com) and signs in with the account that'll own this (usually his JSP Google Workspace account). In the top-left project dropdown he picks `New Project`, names it `JSP-MissionControl`, clicks `Create`, waits ten to twenty seconds, then switches into the new project via the same dropdown.

### Enabling the APIs

From `APIs & Services → Library`, Adam searches for and enables these four, one by one: Google Calendar API, Gmail API, Google Drive API, People API. Each has its own Enable button; the button flips to `Manage` once the API is on.

### Configuring the OAuth consent screen

From `APIs & Services → OAuth consent screen`, Adam picks `Internal` if the Workspace domain is managed (cleanest path), or `External` if it's a personal Google account.

Fields to fill in:

- App name: `Mission Control`
- User support email: Adam's email
- Developer contact: Adam's email

Scopes — read-only first, then the write scopes Jackson needs to draft and perform actions on Adam's say-so:

- `.../auth/calendar.readonly`
- `.../auth/calendar.events`
- `.../auth/gmail.readonly`
- `.../auth/gmail.modify`
- `.../auth/gmail.compose`
- `.../auth/drive.readonly`
- `.../auth/drive.file`
- `.../auth/contacts.readonly`
- `.../auth/contacts`

A word on the consent screen Adam will see when he authorises: because of the write scopes, Google's dialog mentions "send email on your behalf" and "manage your calendar." That's expected — Jackson needs those permissions to do the work. The golden rule still holds: Jackson never fires an action without Adam hitting Confirm on a card in chat.

If Adam picked External, he adds his own email under `Test users` before continuing.

### Creating the OAuth credentials

From `APIs & Services → Credentials → Create Credentials → OAuth client ID`, Adam picks `Desktop app` as the application type, names it `Mission Control Desktop`, and clicks Create. Google returns a Client ID and a Client Secret.

### Pasting the credentials

Emit `[[credential-form:google-workspace]]` on its own line. The frontend replaces the marker with a password-masked form that writes the Client ID and Client Secret straight to macOS Keychain. Values never pass through chat or the database.

### Authorising access

Once the form is saved, Adam clicks Authorize. A browser popup asks him to sign in and grant the four read scopes. On approval, the refresh token is saved to Keychain.

### Testing the connection

Adam clicks Test Connection. The backend runs a `calendar.freeBusy` query with the stored tokens. Green tick = Jackson can read his calendar.

## Troubleshooting

- "This app isn't verified" → click `Advanced → Continue`. Safe for internal / testing use.
- `redirect_uri_mismatch` → shouldn't happen with the Desktop application type. If it does, re-check the application-type choice on the OAuth client.
- `invalid_scope` → one of the four read-only scopes was missed on the consent screen.
- `access_denied` on authorise → Adam closed or declined the popup. He can click Authorize again.
- External + "not a test user" → add Adam's email under `Test users` on the consent screen.

## Status

Scaffold — guide text is authoritative. Backend wiring: `backend/server.py` under `/integrations/google-workspace/*`.
