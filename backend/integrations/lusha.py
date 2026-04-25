"""Lusha client — fallback enrichment source (premium, expensive per hit).

Called only when Cognism misses. Same return shape as
cognism.enrich_person so the workflow can treat them interchangeably."""

import json
from typing import Optional

from ._common import _kc_get, _http_json, _error_from_status


BASE = "https://api.lusha.com/v2"
ENRICH_URL = f"{BASE}/person"
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
    api_key = _kc_get("lusha", "api_key")
    if not api_key:
        out = _empty_result(error="Lusha not configured")
        out["needs_setup"] = {"tools": ["lusha"], "context": "to enrich contacts via Lusha"}
        return out

    first, last = _split_name(name)
    payload: dict = {
        "firstName": first,
        "lastName": last,
        "companies": [{"name": company}],
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
        return _empty_result(error=_error_from_status(status, resp, "Lusha"))

    credits_used = 1  # pessimistic — verify against Lusha's credit field later.

    data = resp.get("data") or resp
    email = _extract_email(data)
    mobile = _extract_mobile(data)
    linkedin = _first(data, ["linkedinUrl", "linkedin"])
    title = _first(data, ["title", "jobTitle"])

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


def _extract_email(data: dict) -> Optional[str]:
    if not isinstance(data, dict):
        return None
    direct = _first(data, ["email", "emailAddress"])
    if direct:
        return direct
    emails = data.get("emailAddresses") or data.get("emails") or []
    if isinstance(emails, list):
        for e in emails:
            if isinstance(e, dict):
                v = e.get("email") or e.get("address") or e.get("value")
                if v:
                    return v
            elif isinstance(e, str) and e.strip():
                return e.strip()
    return None


def _extract_mobile(data: dict) -> Optional[str]:
    if not isinstance(data, dict):
        return None
    direct = _first(data, ["mobile", "mobilePhone", "cellPhone"])
    if direct:
        return direct
    phones = data.get("phoneNumbers") or data.get("phones") or []
    if isinstance(phones, list):
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
