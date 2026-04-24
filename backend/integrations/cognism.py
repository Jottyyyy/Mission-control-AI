"""Cognism client — primary enrichment source.

Exposes a single function, enrich_person(name, company, linkedin_url?),
returning a normalised {found, email, mobile, linkedin, title, credits_used, error}
dict. Credit counting is pessimistic (1 per 200 response) until real-credential
testing reveals the actual usage headers."""

import json
from typing import Optional

from ._common import _kc_get, _http_json, _error_from_status


# Cognism API host matches the _test_cognism probe in server.py.
# The /v1/search/redeem-person path is best-guess; verify once real keys land.
BASE = "https://app.cognism.com/api"
ENRICH_URL = f"{BASE}/v1/search/redeem-person"
TIMEOUT = 15.0


def _split_name(name: str) -> tuple[str, str]:
    parts = (name or "").strip().split()
    if not parts:
        return "", ""
    if len(parts) == 1:
        return parts[0], ""
    return " ".join(parts[:-1]), parts[-1]


def _empty_result(error: Optional[str] = None, credits_used: int = 0) -> dict:
    return {
        "found": False,
        "email": None,
        "mobile": None,
        "linkedin": None,
        "title": None,
        "credits_used": credits_used,
        "error": error,
    }


def enrich_person(
    name: str,
    company: str,
    linkedin_url: Optional[str] = None,
) -> dict:
    api_key = _kc_get("cognism", "api_key")
    if not api_key:
        return _empty_result(error="Cognism not configured")

    first, last = _split_name(name)
    payload = {
        "firstName": first,
        "lastName": last,
        "companyName": company,
    }
    if linkedin_url:
        payload["linkedinUrl"] = linkedin_url
    body = json.dumps(payload).encode("utf-8")

    status, resp = _http_json(
        "POST",
        ENRICH_URL,
        headers={
            "api_key": api_key,
            "Content-Type": "application/json",
            "Accept": "application/json",
        },
        body=body,
        timeout=TIMEOUT,
    )

    if status != 200:
        return _empty_result(error=_error_from_status(status, resp, "Cognism"))

    # Pessimistic credit count: assume any 200 cost 1 credit until we can
    # inspect the real response for a usage field.
    credits_used = 1

    data = resp.get("data") or resp.get("person") or resp
    email = _first(data, ["email", "emailAddress", "workEmail", "businessEmail"])
    mobile = _extract_mobile(data)
    linkedin = _first(data, ["linkedinUrl", "linkedin", "liUrl"])
    title = _first(data, ["title", "jobTitle", "position"])

    return {
        "found": bool(email or mobile),
        "email": email,
        "mobile": mobile,
        "linkedin": linkedin,
        "title": title,
        "credits_used": credits_used,
        "error": None,
    }


def _first(d: dict, keys: list[str]) -> Optional[str]:
    if not isinstance(d, dict):
        return None
    for k in keys:
        v = d.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return None


def _extract_mobile(data: dict) -> Optional[str]:
    if not isinstance(data, dict):
        return None
    # Prefer an explicit mobile field.
    direct = _first(data, ["mobile", "mobilePhone", "cellPhone", "cell"])
    if direct:
        return direct
    phones = data.get("phoneNumbers") or data.get("phones") or []
    if isinstance(phones, list):
        # Two passes: mobile-typed first, then any non-empty number.
        for p in phones:
            if not isinstance(p, dict):
                continue
            ptype = (p.get("type") or p.get("phoneType") or "").lower()
            num = p.get("number") or p.get("phoneNumber") or p.get("value")
            if num and ptype in ("mobile", "cell", "cellphone"):
                return num
        for p in phones:
            if isinstance(p, dict):
                num = p.get("number") or p.get("phoneNumber") or p.get("value")
                if num:
                    return num
    return None
