"""Pomanda client — Companies-House-backed company data.

Exposes three read-only functions the MAN workflow depends on:
  - find_company_by_name(name)
  - get_shareholders(number)
  - get_officers(number)

API URLs and response shapes are best-guesses derived from the existing
_test_pomanda probe in server.py. Expect path/field adjustments once real
credentials are in hand."""

import json
import urllib.parse
from typing import Optional

from ._common import _kc_get, _http_json, _error_from_status


BASE = "https://api.pomanda.com/v1"
KEY_HEADER = "x-api-key"
TIMEOUT = 20.0  # Pomanda tends to be slower than the 8s default.


def _headers(api_key: str) -> dict:
    return {KEY_HEADER: api_key, "Accept": "application/json"}


def _auth() -> tuple[Optional[str], Optional[dict]]:
    """Return (api_key, None) or (None, error_dict)."""
    api_key = _kc_get("pomanda", "api_key")
    if not api_key:
        return None, {
            "ok": False,
            "error": "Pomanda not configured",
            "needs_setup": {"tools": ["pomanda"], "context": "to identify the MAN via Pomanda"},
        }
    return api_key, None


def find_company_by_name(name: str) -> dict:
    """Search Pomanda by name, return the best match.

    Returns {ok, match: {number, name, status}} or {ok: False, error}."""
    api_key, err = _auth()
    if err:
        return err
    query = urllib.parse.urlencode({"query": name, "limit": 5})
    status, body = _http_json(
        "GET",
        f"{BASE}/companies?{query}",
        headers=_headers(api_key),
        timeout=TIMEOUT,
    )
    if status != 200:
        return {"ok": False, "error": _error_from_status(status, body, "Pomanda")}
    results = body.get("companies") or body.get("results") or body.get("data") or []
    if not results:
        return {"ok": False, "error": f"No Pomanda match for '{name}'"}
    best = results[0]
    return {
        "ok": True,
        "match": {
            "number": best.get("company_number") or best.get("number") or best.get("id"),
            "name": best.get("company_name") or best.get("name"),
            "status": best.get("company_status") or best.get("status"),
        },
    }


def get_shareholders(company_number: str) -> dict:
    """Return the company's shareholders, normalised.

    Each shareholder: {name, type: "individual"|"company", pct: float}."""
    api_key, err = _auth()
    if err:
        return err
    status, body = _http_json(
        "GET",
        f"{BASE}/companies/{urllib.parse.quote(company_number)}/shareholders",
        headers=_headers(api_key),
        timeout=TIMEOUT,
    )
    if status != 200:
        return {"ok": False, "error": _error_from_status(status, body, "Pomanda")}

    raw_list = body.get("shareholders") or body.get("data") or []
    normalised = []
    for s in raw_list:
        raw_type = (s.get("type") or s.get("holder_type") or s.get("kind") or "").lower()
        # Pomanda/Companies House commonly use "person" / "company" / "corporate".
        if raw_type in ("person", "individual", "natural"):
            stype = "individual"
        elif raw_type in ("company", "corporate", "organisation", "organization", "entity"):
            stype = "company"
        else:
            # Fall back by inspecting the name — conservative, but real-world
            # Pomanda payloads occasionally drop the type field.
            name = s.get("name") or ""
            stype = "company" if _looks_like_company_name(name) else "individual"

        pct_raw = s.get("pct") or s.get("percentage") or s.get("shareholding_pct") or 0
        try:
            pct = float(pct_raw)
        except (TypeError, ValueError):
            pct = 0.0

        normalised.append({
            "name": s.get("name") or "",
            "type": stype,
            "pct": pct,
        })
    return {"ok": True, "shareholders": normalised}


def get_officers(company_number: str) -> dict:
    """Return the company's officers, normalised.

    Each officer: {name, role_raw, role_normalized: "CEO"|"MD"|"CFO"|"FD"|"Director"|None}."""
    api_key, err = _auth()
    if err:
        return err
    status, body = _http_json(
        "GET",
        f"{BASE}/companies/{urllib.parse.quote(company_number)}/officers",
        headers=_headers(api_key),
        timeout=TIMEOUT,
    )
    if status != 200:
        return {"ok": False, "error": _error_from_status(status, body, "Pomanda")}

    raw_list = body.get("officers") or body.get("data") or []
    normalised = []
    for o in raw_list:
        # Skip resigned officers.
        if o.get("resigned") or o.get("resigned_on"):
            continue
        role_raw = o.get("role") or o.get("officer_role") or o.get("title") or ""
        normalised.append({
            "name": o.get("name") or "",
            "role_raw": role_raw,
            "role_normalized": _normalise_role(role_raw),
        })
    return {"ok": True, "officers": normalised}


# ---------------------------------------------------------------------------
# Role normalisation
# ---------------------------------------------------------------------------

# Maps we recognise for the JSP priority rules (3) and (4).
_CEO_PATTERNS = ("chief executive", "ceo")
_MD_PATTERNS = ("managing director", " md ", "md,", "md;")
_CFO_PATTERNS = ("chief financial", "chief finance", "cfo")
_FD_PATTERNS = ("finance director", "financial director", " fd ", "fd,", "fd;")


def _normalise_role(role_raw: str) -> Optional[str]:
    if not role_raw:
        return None
    r = f" {role_raw.lower().strip()} "
    if any(p in r for p in _CEO_PATTERNS):
        return "CEO"
    if any(p in r for p in _MD_PATTERNS):
        return "MD"
    if any(p in r for p in _CFO_PATTERNS):
        return "CFO"
    if any(p in r for p in _FD_PATTERNS):
        return "FD"
    if "director" in r:
        return "Director"
    return None


_COMPANY_NAME_HINTS = (
    " ltd", " limited", " llp", " plc", " inc", " corp",
    " corporation", " company", " holdings", " group", " capital",
    " partners", " fund",
)


def _looks_like_company_name(name: str) -> bool:
    n = f" {name.lower()} "
    return any(h in n for h in _COMPANY_NAME_HINTS)
