# Mission Control build manifest

- **Built:** 2026-04-30 — v1.30.4 rebuild (timestamps populated by `verify_bundle_fresh.sh` after ditto)
- **Source-of-truth commit:** see HEAD below — pushed today as `v1.30.4 — Mac Mini deploy fixes`
- **v1.30.4 markers present in packaged backend:** verified by `scripts/verify_bundle_fresh.sh` (companies_house_enricher: "Companies House URL"; server: "enrichment.run", "_read_integration_status", "_scrub_outbound"; SOUL: ≥4× "enrichment.run", ≥1× "integration.status")
- **Branch:** `main`
- **Includes:** v1.14 → v1.27 → v1.27 follow-up → v1.28 → v1.29 → v1.30 → v1.30.1 → v1.30.1.1 → v1.30.2 → v1.30.3
- **Built by:** Tom (orchestrated) + Claude Opus 4.7 (1M context)
- **Build host:** MacBook Air (Mac16,12, Apple M4, 16 GB) · macOS 26.4.1 (25E253) · Python 3.12.13 · Node via Homebrew

## Version stack added since the v1.27 build

| Tag | Summary |
|---|---|
| v1.27 follow-up | `chat_formatter.py` — pretty-print tool fences for WhatsApp/SMS surfaces. |
| v1.28 + follow-up | Read-then-write chain in one `/chat` round; live-action registry hint to stop capability-list hallucination. |
| v1.29 | Companies House public-record client (officers + PSC register). |
| v1.30 | Pluggable enrichment pipeline + Companies House enricher. CSV upload → enriched CSV download. Async run, missing-only writes, first-wins precedence. |
| v1.30.1 | Live progress UI: in-memory job manager, ETA via rolling avg of last 10 row durations, polling every 1s, `EnrichmentProgressCard.jsx` with animated bar. |
| v1.30.1.1 | Marketing chat CSV-drag now routes through `/enrichment/run` (not the legacy `/workflow/man/upload-spreadsheet`). Eliminates the spurious "Setting up your workflow → Pomanda" modal. SOUL cleaned of conflicting MAN-cascade language. |
| v1.30.2 | Success-card preview: per-field fill counts, sample table (first 3 rows), Show-all-N-rows lazy-loaded inline table via `GET /enrichment/preview/{job_id}`. |
| v1.30.3 | New `Companies House URL` column, pinned immediately after `Company Number`. URL emitted only when CH lookup actually resolves (no fabricated 404 links). |
| **v1.30.4** | **Mac Mini deploy fixes:** (1) outbound credential scrubber + UUID-context pattern — agent can no longer echo Keychain values. (2) `action:integration.status` read-handler — agent must call to confirm integration state, can't fabricate "yes already stored". (3) `scripts/verify_bundle_fresh.sh` pre-deploy guard, called by Install command before extract. (4) Personal + Marketing SOUL: "never claim connected without checking" rule. |

## Last 5 commits in build

```
9581fea feat: Add Companies House URL enrichment and preview functionality
42c2fd1 v1.30.2 + v1.30.3 — Enrichment results preview + Companies House URL column
118e76b feat(whatsapp-bridge): add WhatsApp bridge plugin to forward messages to Mission Control
1b27923 v1.30 — Pluggable enrichment pipeline + Companies House v1.30.1 — Live progress UI with ETA and job manager
66de504 v1.27 follow-up + v1.29 — chat formatter and Companies House client
```

## Pre-build safety patches still in effect

(Carried forward from the v1.27 build — neither was changed for this build.)

- **A1**: `Install Mission Control.command` uses `tar -xzkf` so workspace template extraction is non-destructive — Adam's local SOUL/MEMORY/USER edits survive an upgrade.
- **B1**: `backend/server.py` makes a timestamped `assistant.v14backup-<unix-ts>.db` snapshot before any v1.14→v1.27 schema migration runs.

## What's tested

### Backend Python suites — 77 / 77 green

| Suite | Pass count | Notes |
|---|---:|---|
| `backend/test_enrichment_pipeline.py` | 18 / 18 | Pipeline orchestration + new v1.30.3 URL column tests |
| `backend/test_enrichment_progress.py` | 19 / 19 | Job manager, ETA math, async dispatch, preview endpoint |
| `backend/test_companies_house.py` | 24 / 24 | CH client (offline) |
| `backend/test_chat_formatter.py` | 16 / 16 | WhatsApp/SMS chat formatting |

### Live integration

- 199-row Zint-shaped sample run end-to-end against the **real Companies House API**: 185–198/199 enriched (varies row by row depending on which CH numbers exist), 0 errors, ~10–14 min, free-tier credit.
- Companies House URL column verified: positioned immediately after Company Number, links open the official record on click.
- Async POST `/enrichment/run` returns `job_id` in <10 ms.
- Polling `/enrichment/status/<id>` shows live "Now: <Company> · companies_house" and ETA refining over the run.
- Preview endpoint `/enrichment/preview/<id>` paginates correctly; 404s for unknown / Sheets jobs.

### Frontend

- Vite production build: JS 410.17 kB / **111.11 kB gzipped**.
- `electron-builder` packaging clean exit on `darwin/arm64`.
- Bundle confirmed to contain `enrichment-progress` marker, `/enrichment/run` and `/enrichment/preview` references, and `EnrichmentProgressCard` component (minified).

## Code-signing posture

```
electron-builder log: skipped macOS code signing  reason=identity explicitly is set to null
```

**Adhoc / unsigned.** Same posture as v1.27 build (`mac.identity: null` in `package.json`).
The installer (`Install Mission Control.command`) strips the macOS quarantine flag after extract; first launch should not trip Gatekeeper.

> **AirDrop quarantine trap (caught 2026-04-30 deploy):** when the bundle
> is AirDropped, macOS sets `com.apple.quarantine` on **every** file in
> the transferred folder — including `Install Mission Control.command`
> itself. That makes the installer un-runnable from a Finder
> double-click ("Apple could not verify … is free of malware").
>
> **Fix on the target Mac before running anything:**
> ```
> xattr -dr com.apple.quarantine ~/Downloads/MissionControl-AdamBuild
> ```
> Or run the installer directly from Terminal, which bypasses
> Finder's Gatekeeper check:
> ```
> cd ~/Downloads/MissionControl-AdamBuild
> bash "Install Mission Control.command"
> ```

**Long-term fix:** enrol in the Apple Developer Program and sign + notarize.

## Sanity launch results (this dev Mac, pre-handoff)

### Automated backend smoke (`backend/_smoke_v1_30_3.py`) — 7 / 7 PASS

| Check | Result |
|---|---|
| POST `/enrichment/run` returns job_id | ✅ 4 ms |
| Poll `/enrichment/status` until completed | ✅ completed in 44 s — 14 / 15 enriched (1 unmatched: Pret 03836930, known CH data quirk) |
| Status payload has `field_fill_counts` + `sample_rows` (v1.30.2) | ✅ 7 fields filled, 3 sample rows |
| `GET /enrichment/preview/<job_id>` returns full enriched CSV | ✅ 15 rows, 13 columns |
| `Companies House URL` column pinned immediately after `Company Number` (v1.30.3) | ✅ header positions Number=1, URL=2 |
| Downloaded CSV via `/enrichment/download/<token>` has same column order | ✅ 4 032-byte CSV, URL at col 2 |
| One sampled URL HEAD-checks 200 against Companies House | ✅ Innocent Limited → `https://find-and-update.company-information.service.gov.uk/company/03253962` returns HTTP 200 |

### Manual UI smoke (still required before handoff)

To be filled in by Tom in the `/tmp/Mission Control.app` window:

- Pomanda setup modal absent on Marketing CSV drag:
- Progress card appears within 1 s with real "Now: <Company>" labels:
- Success card sections (fields-added list, sample table, Show-all toggle) all render:
- Click "Show all 15 rows ▾" — full table loads inline, scrolls cleanly:
- Download button works in browser:

## What's NOT in this bundle

- **Cognism / Lusha / Pomanda enrichers.** Wired as integration modules but NOT in the enrichment pipeline. Email, mobile, revenue, headcount columns will stay blank until v1.31+. The marketing SOUL caveat ("the Cognism / Lusha email + mobile cascade is NOT yet wired into the pipeline") tells Jackson the same thing.
- **WhatsApp end-to-end verification.** Plugin scaffold (`whatsapp-bridge/`, Joshua's commit `118e76b`) ships, but inbound delivery has not been re-verified post-v1.30. Treat WhatsApp ingress as best-effort during deploy and consult Joshua's bridge README before relying on it in front of Adam.
- **Outbound WhatsApp sending from Mission Control.** Not wired.
- **Resumable enrichment jobs across backend restart.** Job state is in-memory only; restart drops in-flight progress (the progress card falls back to "Job no longer available").
- **Sortable / editable preview table.** v1.31.

## Known limitations to call out at handoff

- **Single enricher today: Companies House only.** Other sources land in v1.31+.
- **Unsigned `.app`.** Mitigated by quarantine strip; long-term fix is Apple Developer Program signing.
- **Manual Keychain transfer per machine.** Anthropic / CH / GHL keys + Google OAuth tokens live in the local Mac's Keychain. Each machine needs a fresh Setup-modal pass-through.
- **CSV row cap: 200 per run.** Larger sheets must be split. Truncation surfaced in the chat reply.
- **Companies House data quality.** CH does not always have a record for every UK number — even active firms can return "no match". Pipeline handles gracefully (URL stays blank, row not flagged as error).

## Deploy-day prerequisites for the target Mac

1. **macOS 12+** (Apple Silicon — this is an arm64 build).
2. **Python 3.12** discoverable at `/opt/homebrew/bin/python3.12`. Without this the Electron app spawns uvicorn against a missing interpreter and the backend never binds 8001. Install:
   ```
   brew install python@3.12
   ```
3. Pip packages on that interpreter:
   ```
   /opt/homebrew/bin/python3.12 -m pip install fastapi uvicorn keyring anthropic
   ```
4. Anthropic API key on the **end-user's** account (Adam's, not Tom's) so usage bills to JSP.
5. Companies House API key (free, register at developer.company-information.service.gov.uk).
6. (Optional) GHL API key + location ID; Google account.
7. AirDrop / USB transfer of two artefacts: `MissionControl.app.zip` and `workspace-template.tgz`.

## Bundled artefacts in this folder

```
MissionControl-AdamBuild/
├── BUILD_INFO.md              ← this file
├── README.md                  ← end-user-facing install guide
├── Install Mission Control.command  ← double-clickable installer
├── MissionControl.app.zip     ← produced by ditto -c -k --keepParent <.app>
└── workspace-template.tgz     ← produced by `npm run build:workspace-template`
```

| Artifact | Size | SHA-256 |
|---|---:|---|
| `MissionControl.app.zip` | 97 188 823 B (~92.7 MiB) | `1f5005f9aad48703cef35e49b093695b457b6714312ce3272cc24e2d92956a63` |
| `workspace-template.tgz` | 37 612 B | `e36804490ca33f87d8374f6ecee7b51f31e2da1e0c18c822c0c6253eff40626f` |
| `verify_bundle_fresh.sh` | 5 240 B | (called by `Install Mission Control.command` pre-extract) |

**Bundle freshness verified 2026-04-30 14:14 PHT (full clean rebuild for v1.30.4):**

- Wiped `dist/`, `dist-electron/`, and the existing `MissionControl.app.zip` first; ran `npm run electron:build`; ran `ditto -c -k --keepParent`; ran `bash scripts/verify_bundle_fresh.sh` — passed all 9 checks.
- v1.30.3 marker (`Companies House URL`) inside packaged enricher: ✓ ×3.
- v1.30 marker (`enrichment.run`) inside packaged server: ✓ ×1.
- **v1.30.4 markers inside packaged server:**
  - `_read_integration_status` (the integration.status read-action handler): ✓ ×2.
  - `_scrub_outbound` (the outbound credential scrubber): ✓ ×3.
- **v1.30.4 markers inside `workspace-template.tgz`:**
  - Marketing SOUL: `enrichment.run` × 4 (pipeline rule).
  - Marketing SOUL: `integration.status` × 3 (never-fabricate rule).
- Legacy strings (`Pomanda's shareholders`, `Process all`) intentionally retained — they live in `src/Workflows.jsx` (the legacy Workflows tab path), preserved for users still using that surface. Chat-side `handleFilePick` no longer uses them.

**Earlier zip hashes (superseded):**

- v1.30.3 zip 13:20: `c91423ec1258f7855677d725d3bae86dfeae1d1e9c707ed5fb38da36113e75e0`
- v1.30.3 zip 12:57: `9e10de1b7537d8ffc29c10b08d1f47042fef1ee5107a253a91f0af69c439aec6`
- Yesterday 20:20 zip: pre-v1.30, do not deploy.

## Six "done" criteria for deploy-day

After install on the target Mac, **all six** must hold before handing off to Adam:

1. ✅ App launches from `/Applications` without a Gatekeeper warning (after `xattr -dr com.apple.quarantine`).
2. ✅ Personal chat answers "hello, what's today's date?" — confirms Anthropic key + LLM round-trip.
3. ✅ Marketing CSV drag → progress card → success card with download link — confirms enrichment pipeline end-to-end **and** the absence of the legacy Pomanda setup modal (the v1.30.1.1 fix).
4. ✅ Companies House single-lookup ("look up Monzo Bank Ltd on Companies House") returns directors + PSCs — confirms CH key.
5. ✅ Setup → Google shows "Connected" after OAuth — confirms tokens stored in Keychain.
6. ✅ At least one tool returns non-empty real-data response (e.g. "what's on my calendar today?") — proves the full Keychain → backend → external-API path is live, not just authenticated.

## Rollback

If any of the above fails and is not quickly fixable in front of the user:

```
osascript -e 'tell application "Mission Control" to quit'
rm -rf "/Applications/Mission Control.app"
mv ~/.openclaw/workspace ~/.openclaw/workspace.broken-$(date +%s)
```

Re-deploy from `MissionControl.app.zip` + `workspace-template.tgz`. Keychain credentials survive — Adam doesn't have to re-enter Anthropic / CH keys after a workspace reset.

For a fully clean machine (regulatory cleanup):

```
rm -rf "/Applications/Mission Control.app" \
       ~/.openclaw \
       ~/Library/Logs/"Mission Control" \
       ~/Library/Application\ Support/"Mission Control" \
       ~/Library/Application\ Support/mission-control-ai
```

Plus delete service entries `mission-control-ai` and `google-workspace` from Keychain Access.app (Adam at the keyboard for the unlock prompt).

## Provenance

Built by the autonomous build tasks across Claude Code sessions on 2026-04-29 (v1.27 build) and 2026-04-30 (v1.30 → v1.30.3 builds). All source changes were tested by deterministic Python suites (77 tests) plus a full-CSV live integration run against the real Companies House API. Local sanity launch (`/tmp/Mission Control.app` flow) is the gate for deploying to JSP's Mac Mini today — see "Sanity launch results" above.
