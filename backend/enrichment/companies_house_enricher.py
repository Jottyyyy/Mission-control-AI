"""Companies House enricher — wraps backend/integrations/companies_house.py
and maps its response shape onto canonical spreadsheet column names.

Field mapping is intentionally permissive on the input side: a column
named "Company Number", "company_number", or "Companies House #" all
match the same canonical field. Output columns use the canonical names.

What this enricher fills (when missing):
    - Company Number
    - Status
    - Incorporation Date
    - SIC Code
    - Registered Address
    - Directors             (joined by ", ")
    - Shareholders          (PSC names + ownership band, joined)
    - Officer Count

What it leaves alone (other enrichers' territory):
    Email, Phone, Mobile, Job Title, LinkedIn, Revenue, Headcount,
    Domain — Companies House does not provide any of these.

Author note: Companies House calls "shareholders" the PSC register —
see integrations/companies_house.py for the legal context. We surface
both names + ownership band in the joined string so a sales rep can
read the cell directly without re-querying.
"""

from __future__ import annotations

from typing import Optional

from integrations import companies_house


# Canonical column names. The first entry of each value tuple is what
# we WRITE; the rest are aliases we MATCH on input. Matching ignores
# case and collapses non-alphanumerics (so "Companies House #" and
# "companies_house_number" both resolve to "Company Number").
_FIELD_ALIASES: dict[str, tuple[str, ...]] = {
    "Company Number": (
        "Company Number",
        "Companies House Number",
        "Companies House #",
        "CH Number",
        "Registration Number",
        "Registration",
        "company_number",
        "number",
    ),
    "Status": (
        "Status",
        "Company Status",
        "company_status",
    ),
    "Incorporation Date": (
        "Incorporation Date",
        "Incorporated",
        "Date Incorporated",
        "incorporation_date",
        "date_of_creation",
    ),
    "SIC Code": (
        "SIC Code",
        "SIC Codes",
        "SIC",
        "sic_code",
        "sic_codes",
        "industry_code",
    ),
    "Registered Address": (
        "Registered Address",
        "Address",
        "registered_address",
    ),
    "Directors": (
        "Directors",
        "Officers",
        "directors",
        "officers",
    ),
    "Shareholders": (
        "Shareholders",
        "PSC",
        "Persons with Significant Control",
        "Largest Shareholders",
        "shareholders",
        "psc",
    ),
    "Officer Count": (
        "Officer Count",
        "officer_count",
        "Number of Officers",
    ),
}

# Canonical name of the column we use as our primary INPUT signal.
_COMPANY_NAME_ALIASES = (
    "Company Name",
    "Company",
    "Name",
    "Account Name",
    "Organisation",
    "Organization",
    "company_name",
    "company",
    "name",
)

# Canonical name of the column we'll PREFER as input if present (more
# precise than name search — no fuzzy matching needed).
_NUMBER_INPUT_ALIASES = _FIELD_ALIASES["Company Number"]


def _norm_key(s: str) -> str:
    """Collapse a column name for forgiving matching.

    "Companies House #" → "companieshouse"
    "company_number"    → "companynumber"
    "Company Number"    → "companynumber"
    """
    return "".join(ch.lower() for ch in (s or "") if ch.isalnum())


def _match_column(row: dict, aliases: tuple[str, ...]) -> Optional[str]:
    """Return the actual key in `row` that matches one of `aliases`,
    or None if nothing matches. Matching is case- and punctuation-insensitive."""
    if not row:
        return None
    norm_to_orig = {_norm_key(k): k for k in row.keys() if k}
    for alias in aliases:
        hit = norm_to_orig.get(_norm_key(alias))
        if hit:
            return hit
    return None


def _value_for(row: dict, aliases: tuple[str, ...]) -> str:
    key = _match_column(row, aliases)
    if not key:
        return ""
    raw = row.get(key, "")
    return str(raw or "").strip()


def _format_directors(officers: list[dict]) -> str:
    """Top officers, joined. Roles included so a sales rep sees Director vs
    Secretary at a glance. We cap at 5 to keep cells readable — Adam can
    re-query Companies House for the full list if needed."""
    if not officers:
        return ""
    parts: list[str] = []
    for o in officers[:5]:
        name = (o.get("name") or "").strip()
        if not name:
            continue
        role = (o.get("role") or "").strip()
        parts.append(f"{name} ({role})" if role else name)
    return ", ".join(parts)


def _format_shareholders(pscs: list[dict]) -> str:
    """Top 3 PSCs (the closest public proxy for "shareholders" — see
    integrations/companies_house.py for the legal nuance). Each entry is
    "Name — band" where band is "50-75% shares" or similar. Three is the
    sweet spot: enough to capture the ownership story for a typical
    private company, short enough to fit a spreadsheet cell."""
    if not pscs:
        return ""
    parts: list[str] = []
    for p in pscs[:3]:
        name = (p.get("name") or "").strip()
        if not name:
            continue
        band = (p.get("percentage") or "").strip()
        parts.append(f"{name} — {band}" if band and band != "unknown" else name)
    return ", ".join(parts)


class CompaniesHouseEnricher:
    name = "companies_house"

    enriches_fields: list[str] = list(_FIELD_ALIASES.keys())

    # We need EITHER a name OR a Companies House number to query. The
    # pipeline's "all required must be present" rule treats this list
    # as alternates by design — see `requires_any` below; we expose the
    # union here so the pipeline's default skip logic stays simple.
    requires_fields: list[str] = ["Company Name"]

    # Marker the pipeline can read to know "presence of ANY of these
    # is enough". Without this, a row that has only a Companies House
    # number would be skipped because "Company Name" looks empty.
    requires_any: list[tuple[str, ...]] = [
        _COMPANY_NAME_ALIASES,
        _NUMBER_INPUT_ALIASES,
    ]

    def enrich(self, row: dict, missing_only: bool = True) -> dict:
        """Look the company up in Companies House and return the canonical
        fields we can fill. Pipeline post-filters by missing-only — but
        we still respect missing_only here to skip the network call when
        every output field is already populated."""
        if missing_only and not self._has_any_missing_output(row):
            return {}

        # Prefer number → falls back to name. Number lookups skip the
        # search step in the integration so they're faster and unambiguous.
        target = _value_for(row, _NUMBER_INPUT_ALIASES) or _value_for(row, _COMPANY_NAME_ALIASES)
        if not target:
            return {}

        res = companies_house.query_companies_house(target)
        if res.get("error") or res.get("needs_setup"):
            # Surface the error via the pipeline's status accounting; no
            # cells filled, no exception raised. The pipeline catches
            # exceptions but we'd rather not raise on a clean "no match".
            return {}

        out: dict[str, str] = {}

        if res.get("company_number"):
            out["Company Number"] = str(res["company_number"])
        if res.get("status"):
            out["Status"] = str(res["status"])
        if res.get("incorporation_date"):
            out["Incorporation Date"] = str(res["incorporation_date"])

        sic = res.get("sic_codes") or []
        if sic:
            out["SIC Code"] = ", ".join(str(c) for c in sic if c)

        # Companies House profile doesn't include an address in the
        # one-call shape we use (see integrations/companies_house.py —
        # the profile call returns it under registered_office_address
        # in raw form, but the wrapper currently strips it). Future
        # work: thread the address through. For now this stays blank
        # so we never write a stale value.
        # Note: not calling _format_address because the integration
        # doesn't surface the field today — wired here for when it does.

        directors = _format_directors(res.get("officers") or [])
        if directors:
            out["Directors"] = directors

        shareholders = _format_shareholders(res.get("shareholders") or [])
        if shareholders:
            out["Shareholders"] = shareholders

        officers_list = res.get("officers") or []
        if officers_list:
            out["Officer Count"] = str(len(officers_list))

        return out

    def _has_any_missing_output(self, row: dict) -> bool:
        for canonical in self.enriches_fields:
            aliases = _FIELD_ALIASES[canonical]
            existing = _value_for(row, aliases)
            if not existing:
                return True
        return False


companies_house_enricher = CompaniesHouseEnricher()
