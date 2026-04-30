"""Companies House client — official UK public-record source.

The user-facing concept is "shareholders" but the Companies House public API
does not expose a shareholder register. The closest legally-required
disclosure is the **Persons with Significant Control (PSC) register**, which
captures anyone with >25% shares, >25% voting rights, the right to appoint
or remove a majority of directors, or other significant influence/control.
Every "Companies House shareholder lookup" tool in the market actually
surfaces PSC data — we do the same here, with the field labelled
`shareholders` to match the workflow vocabulary, and a `source: "PSC register"`
marker so callers can be precise when it matters.

Auth: HTTP Basic with the API key as the username and an empty password.
Public docs: https://developer.company-information.service.gov.uk/
"""

import base64
import re
import urllib.parse
from typing import Optional

from ._common import _kc_get, _http_json, _error_from_status


BASE = "https://api.company-information.service.gov.uk"
# Companies House is typically 200–500 ms per call. 8s is generous enough to
# survive a transient slowdown but tight enough that a hung request doesn't
# block a 15-company batch past the frontend's 60s chat timeout.
TIMEOUT = 8.0

# Companies House numbers are 8 chars: either all digits (e.g. 12345678) or
# 2 letters + 6 digits (e.g. SC123456 for Scottish, NI123456 for Northern
# Irish). We use this to short-circuit "is this a number or a name?".
_COMPANY_NUMBER_RE = re.compile(r"^[A-Za-z]{0,2}\d{6,8}$")


def _auth_header(api_key: str) -> dict:
    token = base64.b64encode(f"{api_key}:".encode("utf-8")).decode("ascii")
    return {"Authorization": f"Basic {token}", "Accept": "application/json"}


def _auth() -> tuple[Optional[str], Optional[dict]]:
    api_key = _kc_get("companies_house", "api_key")
    if not api_key:
        return None, {
            "ok": False,
            "error": "Companies House not configured",
            "needs_setup": {
                "tools": ["companies_house"],
                "context": "to look up UK companies via Companies House",
            },
        }
    return api_key, None


def _looks_like_number(s: str) -> bool:
    return bool(_COMPANY_NUMBER_RE.match((s or "").strip()))


def _normalise_number(s: str) -> str:
    """Companies House numbers are case-insensitive but the API wants the
    canonical form: uppercase prefix, 8 chars total (left-pad digits with 0).

    Examples:
      "12345678" -> "12345678"
      "sc123456" -> "SC123456"
      "12345"    -> "00012345"
    """
    raw = (s or "").strip().upper()
    m = re.match(r"^([A-Z]{0,2})(\d+)$", raw)
    if not m:
        return raw
    prefix, digits = m.groups()
    width = 8 - len(prefix)
    return prefix + digits.rjust(width, "0")


def search_companies(query: str, limit: int = 5) -> dict:
    api_key, err = _auth()
    if err:
        return err
    qs = urllib.parse.urlencode({"q": query, "items_per_page": limit})
    status, body = _http_json(
        "GET",
        f"{BASE}/search/companies?{qs}",
        headers=_auth_header(api_key),
        timeout=TIMEOUT,
    )
    if status != 200:
        return {"ok": False, "error": _error_from_status(status, body, "Companies House")}
    items = body.get("items") or []
    return {"ok": True, "items": items}


def _get_company_profile(api_key: str, number: str) -> tuple[int, dict]:
    return _http_json(
        "GET",
        f"{BASE}/company/{urllib.parse.quote(number)}",
        headers=_auth_header(api_key),
        timeout=TIMEOUT,
    )


def _get_officers(api_key: str, number: str) -> list[dict]:
    status, body = _http_json(
        "GET",
        f"{BASE}/company/{urllib.parse.quote(number)}/officers?items_per_page=50",
        headers=_auth_header(api_key),
        timeout=TIMEOUT,
    )
    if status != 200:
        return []
    out = []
    for o in body.get("items") or []:
        # Skip resigned officers — they're noise for "who runs this company today".
        if o.get("resigned_on"):
            continue
        out.append({
            "name": o.get("name") or "",
            "role": (o.get("officer_role") or "").replace("-", " ").title() or "Officer",
        })
    return out


def _get_pscs(api_key: str, number: str) -> list[dict]:
    """Return PSC entries normalised into the shareholder-ish shape callers expect.

    Companies House encodes ownership as a `natures_of_control` list of strings
    like "ownership-of-shares-25-to-50-percent" or
    "voting-rights-75-to-100-percent". We surface the most-specific shares band
    when present, falling back to the first nature otherwise. We don't try to
    derive a single percentage — the API doesn't give one — but we keep the
    raw natures_of_control list so the caller can be precise if it matters.
    """
    status, body = _http_json(
        "GET",
        f"{BASE}/company/{urllib.parse.quote(number)}/persons-with-significant-control?items_per_page=50",
        headers=_auth_header(api_key),
        timeout=TIMEOUT,
    )
    if status != 200:
        return []
    out = []
    for p in body.get("items") or []:
        if p.get("ceased_on"):
            continue
        kind = (p.get("kind") or "").lower()
        if "corporate" in kind or "legal" in kind:
            ptype = "company"
        elif "individual" in kind:
            ptype = "individual"
        else:
            ptype = "other"
        natures = p.get("natures_of_control") or []
        out.append({
            "name": p.get("name") or "",
            "type": ptype,
            "percentage": _summarise_natures(natures),
            "natures_of_control": natures,
            "nationality": (p.get("nationality") or "") if ptype == "individual" else None,
        })
    return out


_SHARES_BAND_RE = re.compile(r"ownership-of-shares-(\d+)-to-(\d+)-percent")
_VOTING_BAND_RE = re.compile(r"voting-rights-(\d+)-to-(\d+)-percent")


def _summarise_natures(natures: list[str]) -> str:
    """Pull a human-friendly band string out of natures_of_control.

    Prefer share-ownership bands over voting-rights bands; fall back to the
    raw nature string with hyphens flattened."""
    if not natures:
        return "unknown"
    for n in natures:
        m = _SHARES_BAND_RE.search(n)
        if m:
            return f"{m.group(1)}-{m.group(2)}% shares"
    for n in natures:
        m = _VOTING_BAND_RE.search(n)
        if m:
            return f"{m.group(1)}-{m.group(2)}% voting rights"
    # Strip the kind prefix and tidy.
    first = natures[0].replace("-", " ")
    return first


def query_companies_house(company_name_or_number: str) -> dict:
    """One-call lookup: profile + officers + PSCs (shareholders) for a company.

    Accepts either a Companies House number or a free-text name. If a name,
    we search and use the top hit. Returns the shape v1.29 specifies:

        {
          "company_name": str,
          "company_number": str,
          "status": str,
          "incorporation_date": str,
          "sic_codes": list[str],
          "officers": [{"name", "role"}],
          "shareholders": [{"name", "percentage", "type", "natures_of_control"}],
          "shareholders_source": "PSC register",
          "error": None | str,
        }

    On failure: every field is None / [] and `error` carries a human message.
    `needs_setup` is included when the API key isn't configured, so the chat
    layer can pop SetupModal."""
    raw = (company_name_or_number or "").strip()
    if not raw:
        return _empty_result(error="No company name or number supplied.")

    api_key, err = _auth()
    if err:
        out = _empty_result(error=err["error"])
        out["needs_setup"] = err["needs_setup"]
        return out

    # Resolve to a company number.
    if _looks_like_number(raw):
        number = _normalise_number(raw)
        # Fetch profile directly; if it 404s we fall back to a name search
        # (e.g. user typed "12345" expecting a name lookup).
        status, profile = _get_company_profile(api_key, number)
        if status == 404:
            search = search_companies(raw, limit=1)
            if not search.get("ok") or not search.get("items"):
                return _empty_result(error=f"Company '{raw}' not found")
            number = search["items"][0].get("company_number") or ""
            if not number:
                return _empty_result(error=f"Company '{raw}' not found")
            status, profile = _get_company_profile(api_key, number)
    else:
        search = search_companies(raw, limit=1)
        if not search.get("ok"):
            return _empty_result(error=search.get("error") or "Search failed")
        items = search.get("items") or []
        if not items:
            return _empty_result(error=f"Company '{raw}' not found")
        number = items[0].get("company_number") or ""
        if not number:
            return _empty_result(error=f"Company '{raw}' not found")
        status, profile = _get_company_profile(api_key, number)

    if status != 200:
        return _empty_result(error=_error_from_status(status, profile, "Companies House"))

    officers = _get_officers(api_key, number)
    pscs = _get_pscs(api_key, number)

    return {
        "company_name": profile.get("company_name") or "",
        "company_number": profile.get("company_number") or number,
        "status": (profile.get("company_status") or "").replace("-", " ").title() or "Unknown",
        "incorporation_date": profile.get("date_of_creation") or "",
        "sic_codes": profile.get("sic_codes") or [],
        "officers": officers,
        "shareholders": pscs,
        "shareholders_source": "PSC register",
        "error": None,
    }


def _empty_result(error: Optional[str]) -> dict:
    return {
        "company_name": "",
        "company_number": "",
        "status": "",
        "incorporation_date": "",
        "sic_codes": [],
        "officers": [],
        "shareholders": [],
        "shareholders_source": "PSC register",
        "error": error,
    }
