# TODO

## Enrichment pipeline (v1.30 → v1.31+)

v1.30 ships the pluggable framework + the Companies House enricher. Each
item below is a new enricher that slots into `backend/enrichment/__init__.py`
behind Companies House without changing the chat surface (`action:enrichment.run`)
or the I/O contract (CSV in → CSV out, Sheets in → Sheets out, missing-only).

### v1.31 — Cognism enricher

- New file: `backend/enrichment/cognism_enricher.py`
- `enriches_fields`: `Email`, `Mobile`, `Phone`, `LinkedIn`
- `requires_fields`: `Company Name` AND ideally one of `First Name` / `Last Name` / `Email`
- Wraps `backend/integrations/cognism.py` (already present).
- Append to `ENRICHERS` AFTER `companies_house_enricher` so structural
  data is already filled before we spend Cognism credits searching for
  contacts at the right company.
- Per-row credit accounting in `summarise()` — Cognism charges per hit.

### v1.32 — Lusha fallback enricher

- New file: `backend/enrichment/lusha_enricher.py`
- Same field list as Cognism; only fires when Cognism returned nothing
  (the pipeline's "first wins, no overwrite" rule handles this naturally).
- Wraps `backend/integrations/lusha.py`.

### v1.33 — Pomanda enricher (deeper financials)

- New file: `backend/enrichment/pomanda_enricher.py`
- `enriches_fields`: `Revenue`, `Gross Profit`, `Headcount`, `Industry`
- `requires_fields`: `Company Name` OR `Company Number`
- Wraps `backend/integrations/pomanda.py`.

## Out of scope (deliberate, see v1.30 spec)

- Domain inference from company name (separate workstream).
- Email validation / verification.
- Pagination of >200 row Sheets — we cap at `enrichment.io.MAX_ROWS`
  (200) for v1 and document the cap.
- Custom column-name mapping UI. Today the enricher's alias list is
  edited in code; v1.31+ may surface a per-agent `field_map.json`.
