"""MAN identification workflow — verify Zint + enrich where needed.

Starting in v1.14, Zint exports carry a candidate MAN (first+last+title) and
candidate contact (email+mobile). The workflow is therefore a *verify + enrich*
flow, not a *identify from scratch* flow:

  1. Parse the Zint row into a structured lead.
  2. Verify the MAN against Pomanda's shareholders — upgrade if Pomanda finds
     a larger private shareholder, verify if it confirms Zint's candidate,
     keep Zint's candidate if Pomanda returns nothing or isn't configured.
  3. Skip enrichment entirely if Zint already provided email + mobile.
  4. Otherwise call Cognism for whatever's missing.
  5. Cascade to Lusha only if Cognism still left something missing."""

from typing import Optional

from integrations import pomanda, cognism, lusha


MAX_BATCH = 200


# ---------------------------------------------------------------------------
# JSP priority rules — retained for back-compat with tests and for the "no Zint
# candidate" path. Given a raw Pomanda response, pick the best MAN.
# ---------------------------------------------------------------------------

def _apply_jsp_priority_rules(
    shareholders: list,
    officers: list,
    company: dict,
) -> Optional[dict]:
    """Returns the MAN per JSP's strict priority (or None if nothing matches).

    1. Largest private individual shareholder.
    2. Parent company >50% → flag needs_review (v1 doesn't recurse).
    3. CEO / Managing Director.
    4. CFO / Finance Director."""

    individuals = [
        s for s in (shareholders or [])
        if s.get("type") == "individual" and (s.get("pct") or 0) > 0
    ]
    if individuals:
        largest = max(individuals, key=lambda s: s.get("pct") or 0)
        pct = largest.get("pct") or 0
        pct_str = f"{pct:g}" if isinstance(pct, float) else str(pct)
        return {
            "name": largest.get("name"),
            "role": f"Shareholder ({pct_str}%)",
            "shareholder_pct": pct,
            "priority_rule": 1,
        }

    parent_companies = [
        s for s in (shareholders or [])
        if s.get("type") == "company" and (s.get("pct") or 0) > 50
    ]
    if parent_companies:
        biggest = max(parent_companies, key=lambda s: s.get("pct") or 0)
        return {
            "name": None,
            "role": "needs_parent_lookup",
            "parent_company": biggest.get("name"),
            "priority_rule": 2,
            "needs_review": True,
        }

    ceo = next(
        (o for o in (officers or []) if o.get("role_normalized") in ("CEO", "MD")),
        None,
    )
    if ceo:
        return {
            "name": ceo.get("name"),
            "role": ceo.get("role_raw"),
            "priority_rule": 3,
        }

    cfo = next(
        (o for o in (officers or []) if o.get("role_normalized") in ("CFO", "FD")),
        None,
    )
    if cfo:
        return {
            "name": cfo.get("name"),
            "role": cfo.get("role_raw"),
            "priority_rule": 4,
        }

    return None


# ---------------------------------------------------------------------------
# Zint helpers
# ---------------------------------------------------------------------------

def _zint_full_name(lead: dict) -> str:
    first = (lead.get("first_name") or "").strip()
    last = (lead.get("last_name") or "").strip()
    return f"{first} {last}".strip()


def _zint_has_candidate_man(lead: dict) -> bool:
    return bool(_zint_full_name(lead))


def _zint_has_complete_contact(lead: dict) -> bool:
    return bool(lead.get("email")) and bool(lead.get("mobile"))


def _names_match(a: Optional[str], b: Optional[str]) -> bool:
    """Loose name match — case-insensitive, whitespace-normalised, handles
    "LAST, First" (Pomanda) vs "First Last" (Zint)."""
    if not a or not b:
        return False
    a_tokens = set(a.lower().replace(",", " ").split())
    b_tokens = set(b.lower().replace(",", " ").split())
    if not a_tokens or not b_tokens:
        return False
    # Same full token set (regardless of order) → match.
    # Covers "SALMON, Neil" ↔ "Neil Salmon" since both tokenise to {neil, salmon}.
    if a_tokens == b_tokens:
        return True
    # Last-name + another token in common — e.g. "Neil Salmon" ↔ "Neil J Salmon".
    a_parts = a.lower().replace(",", " ").split()
    b_parts = b.lower().replace(",", " ").split()
    if a_parts and b_parts and a_parts[-1] == b_parts[-1]:
        return bool((a_tokens - {a_parts[-1]}) & (b_tokens - {b_parts[-1]}))
    return False


def _compare_man_candidates(zint_candidate: dict, pomanda_man: Optional[dict]) -> str:
    """Return 'upgrade' | 'verify' | 'keep_zint'.

    Semantics:
      upgrade   — Pomanda found a different, larger private shareholder than Zint's person.
      verify    — Pomanda's top MAN matches Zint's person (same name OR Zint's person *is*
                  a significant shareholder).
      keep_zint — Pomanda returned nothing useful, or only officer-tier info that
                  doesn't beat Zint's CEO-with-no-shares candidate.
    """
    if not pomanda_man or not pomanda_man.get("name"):
        return "keep_zint"

    # Needs_review (parent-company case) — treat as keep_zint for this lead; the
    # UI surfaces the parent-company hint separately.
    if pomanda_man.get("needs_review"):
        return "keep_zint"

    zint_name = _zint_full_name(zint_candidate)
    if _names_match(zint_name, pomanda_man.get("name")):
        return "verify"

    # Different person. Only upgrade when Pomanda's MAN is a shareholder (rules 1/2),
    # not when it's a CEO/CFO-fallback (rules 3/4) — Zint's named contact outranks
    # an unnamed officer fallback.
    pm_rule = pomanda_man.get("priority_rule")
    if pm_rule in (1, 2):
        return "upgrade"
    return "keep_zint"


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

def process_lead(company: dict) -> dict:
    """Full MAN workflow for a single company — verify + enrich."""

    name = (company.get("name") or "").strip()
    if not name:
        return _err("", "Missing company name", company)

    zint_candidate = {
        "first_name": (company.get("first_name") or "").strip(),
        "last_name": (company.get("last_name") or "").strip(),
        "job_title": (company.get("job_title") or "").strip(),
        "linkedin": (company.get("linkedin") or "").strip() or None,
        "email": (company.get("email") or "").strip() or None,
        "mobile": (company.get("mobile") or "").strip() or None,
    }
    zint_has_candidate = _zint_has_candidate_man(zint_candidate)

    # Step 1 — try to verify the MAN via Pomanda.
    pomanda_man, pomanda_error, pomanda_ran = _try_pomanda_verify(company)

    # Step 2 — decide what to do with the candidate.
    if not zint_has_candidate:
        # No Zint candidate — fall back to Pomanda's pick (classic identification).
        if pomanda_man and not pomanda_man.get("needs_review"):
            chosen_man = dict(pomanda_man)
            man_source = "pomanda"
            enrichment_status = "man_from_pomanda"
        elif pomanda_man and pomanda_man.get("needs_review"):
            return _needs_review_result(name, company, pomanda_man)
        else:
            return _err(
                name,
                pomanda_error or "No MAN identifiable — Zint row has no first/last name and Pomanda returned nothing.",
                company,
            )
    else:
        decision = _compare_man_candidates(zint_candidate, pomanda_man)
        if decision == "upgrade":
            chosen_man = dict(pomanda_man)
            man_source = "upgraded"
            enrichment_status = "man_upgraded"
        elif decision == "verify":
            chosen_man = {
                "name": _zint_full_name(zint_candidate),
                "role": zint_candidate["job_title"] or pomanda_man.get("role"),
                "shareholder_pct": pomanda_man.get("shareholder_pct"),
            }
            man_source = "pomanda"  # verified by Pomanda
            enrichment_status = "man_verified"
        else:
            # keep_zint
            chosen_man = {
                "name": _zint_full_name(zint_candidate),
                "role": zint_candidate["job_title"] or "Unknown",
            }
            man_source = "zint"
            enrichment_status = "man_from_zint" if pomanda_ran else "man_from_zint_unverified"

    # Preserve LinkedIn when we're keeping Zint's candidate (Pomanda doesn't have it).
    if man_source in ("zint", "upgraded") and zint_candidate["linkedin"] and not chosen_man.get("linkedin"):
        if man_source == "zint":
            chosen_man["linkedin"] = zint_candidate["linkedin"]

    # Step 3 — decide what enrichment is needed.
    needed_email = not (man_source != "upgraded" and zint_candidate["email"])
    needed_mobile = not (man_source != "upgraded" and zint_candidate["mobile"])
    # If we upgraded the MAN to a different person, Zint's email/mobile belonged
    # to the old candidate — treat them as missing.
    have_email = zint_candidate["email"] if man_source != "upgraded" else None
    have_mobile = zint_candidate["mobile"] if man_source != "upgraded" else None

    cog_result = None
    lsh_result = None
    cog_credits = 0
    lsh_credits = 0

    if have_email and have_mobile:
        contact_status = "contact_from_zint"
    else:
        # Step 4 — Cognism for missing fields.
        cog_result = cognism.enrich_person(chosen_man["name"], name, zint_candidate["linkedin"])
        cog_credits = cog_result.get("credits_used", 0) or 0
        if not have_email and cog_result.get("email"):
            have_email = cog_result["email"]
        if not have_mobile and cog_result.get("mobile"):
            have_mobile = cog_result["mobile"]

        if have_email and have_mobile:
            contact_status = "contact_enriched_cognism"
        else:
            # Step 5 — Lusha fallback.
            lsh_result = lusha.enrich_person(chosen_man["name"], name, zint_candidate["linkedin"])
            lsh_credits = lsh_result.get("credits_used", 0) or 0
            if not have_email and lsh_result.get("email"):
                have_email = lsh_result["email"]
            if not have_mobile and lsh_result.get("mobile"):
                have_mobile = lsh_result["mobile"]

            if have_email and have_mobile:
                contact_status = "contact_enriched_lusha"
            else:
                contact_status = "contact_partial"

    # Attribute each field to its source.
    email_source = _attribute(zint_candidate["email"] if man_source != "upgraded" else None,
                              cog_result, lsh_result, "email", have_email)
    mobile_source = _attribute(zint_candidate["mobile"] if man_source != "upgraded" else None,
                               cog_result, lsh_result, "mobile", have_mobile)

    status = "success" if (have_email and have_mobile) else "partial"
    # If the chosen MAN is missing name (defensive), downgrade to error.
    if not chosen_man.get("name"):
        status = "error"

    return {
        "company_name": name,
        "company_number": company.get("number"),
        "domain": company.get("domain") or company.get("website"),
        "status": status,
        "enrichment_status": enrichment_status,
        "contact_status": contact_status,
        "man": {
            "name": chosen_man.get("name"),
            "role": chosen_man.get("role"),
            "job_title": chosen_man.get("role"),
            "linkedin": chosen_man.get("linkedin") or zint_candidate.get("linkedin"),
            "email": have_email,
            "mobile": have_mobile,
            "shareholder_pct": chosen_man.get("shareholder_pct"),
        },
        "sources": {
            "man": man_source,
            "email": email_source,
            "mobile": mobile_source,
        },
        "credits_used": {"cognism": cog_credits, "lusha": lsh_credits},
        "error": pomanda_error if enrichment_status == "man_from_zint_unverified" and pomanda_error else None,
        "context": {
            "revenue": company.get("revenue"),
            "industry": company.get("industry"),
            "hubspot_crm": company.get("hubspot_crm"),
            "pipeline_priority": company.get("pipeline_priority"),
            "headcount": company.get("headcount"),
            "ubo": company.get("ubo"),
        },
        "original_row": company.get("original_row") or {},
    }


def process_batch(leads: list, max_leads: int = MAX_BATCH) -> dict:
    cap = min(max_leads or MAX_BATCH, MAX_BATCH)
    incoming = [_to_dict(l) for l in (leads or [])]
    truncated = len(incoming) > cap
    to_run = incoming[:cap]

    results = []
    summary = {
        "success": 0, "partial": 0, "error": 0,
        "man_verified": 0, "man_upgraded": 0,
        "man_from_zint": 0, "man_from_zint_unverified": 0,
        "man_from_pomanda": 0,
        "contact_from_zint": 0, "contact_enriched_cognism": 0,
        "contact_enriched_lusha": 0, "contact_partial": 0,
    }
    totals = {"cognism": 0, "lusha": 0}

    for lead in to_run:
        r = process_lead(lead)
        results.append(r)
        summary[r.get("status", "error")] = summary.get(r.get("status", "error"), 0) + 1
        es = r.get("enrichment_status")
        if es in summary:
            summary[es] += 1
        cs = r.get("contact_status")
        if cs in summary:
            summary[cs] += 1
        cu = r.get("credits_used") or {}
        totals["cognism"] += cu.get("cognism", 0) or 0
        totals["lusha"] += cu.get("lusha", 0) or 0

    return {
        "total": len(to_run),
        "truncated": truncated,
        "original_count": len(incoming),
        "results": results,
        "summary": summary,
        "credits_used": totals,
    }


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------

def _try_pomanda_verify(company: dict) -> tuple[Optional[dict], Optional[str], bool]:
    """Run Pomanda + JSP rules. Returns (pomanda_man_or_None, error_or_None, did_run)."""
    number = (company.get("number") or "").strip() or None
    name = company.get("name") or ""

    if not number:
        search = pomanda.find_company_by_name(name)
        if not search.get("ok"):
            return None, search.get("error") or "Pomanda lookup failed", False
        number = (search.get("match") or {}).get("number")
        if not number:
            return None, f"No Pomanda match for '{name}'", True

    sh = pomanda.get_shareholders(number)
    if not sh.get("ok"):
        return None, sh.get("error") or "Pomanda shareholders lookup failed", False
    off = pomanda.get_officers(number)
    if not off.get("ok"):
        return None, off.get("error") or "Pomanda officers lookup failed", False

    pm = _apply_jsp_priority_rules(sh.get("shareholders", []), off.get("officers", []), company)
    return pm, None, True


def _err(company_name: str, message: str, company: Optional[dict] = None) -> dict:
    return {
        "company_name": company_name,
        "company_number": (company or {}).get("number"),
        "domain": (company or {}).get("domain") or (company or {}).get("website"),
        "status": "error",
        "enrichment_status": None,
        "contact_status": None,
        "error": message,
        "man": None,
        "sources": {"man": None, "email": None, "mobile": None},
        "credits_used": {"cognism": 0, "lusha": 0},
        "context": {},
        "original_row": (company or {}).get("original_row") or {},
    }


def _needs_review_result(name: str, company: dict, pomanda_man: dict) -> dict:
    base = _err(name, "Parent-company shareholder lookup required", company)
    base["status"] = "needs_review"
    base["enrichment_status"] = "man_needs_parent_lookup"
    base["error"] = None
    base["man"] = {
        "name": None,
        "role": "needs_parent_lookup",
        "parent_company": pomanda_man.get("parent_company"),
    }
    return base


def _attribute(zint_val, cog_result, lsh_result, field: str, final_val) -> Optional[str]:
    """Pick the source label for a given output field."""
    if not final_val:
        return None
    if zint_val and zint_val == final_val:
        return "zint"
    if cog_result and cog_result.get(field) and cog_result[field] == final_val:
        return "cognism"
    if lsh_result and lsh_result.get(field) and lsh_result[field] == final_val:
        return "lusha"
    return None


def _to_dict(lead) -> dict:
    if isinstance(lead, dict):
        return lead
    if hasattr(lead, "model_dump"):
        return lead.model_dump()
    if hasattr(lead, "dict"):
        return lead.dict()
    return dict(lead)
