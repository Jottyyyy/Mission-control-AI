"""MAN identification workflow.

For each company, picks a MAN (Money/Authority/Need) per JSP's strict 4-level
priority rules, then enriches them via Cognism → Lusha cascade."""

from typing import Optional

from integrations import pomanda, cognism, lusha


MAX_BATCH = 200


# ---------------------------------------------------------------------------
# Priority rules — pure, easy to unit-test
# ---------------------------------------------------------------------------

def _apply_jsp_priority_rules(
    shareholders: list,
    officers: list,
    company: dict,
) -> Optional[dict]:
    """Returns the MAN based on JSP's priority order, or None if nothing matches.

    Priority order (from JSP-CONTEXT.md):
      1. Largest private individual shareholder of the company.
      2. Largest private shareholder of the parent company (>50% corp holder).
         v1 flags needs_review=True and stops — recursive parent lookup is v2.
      3. CEO or Managing Director.
      4. CFO or Finance Director."""

    # Rule 1 — largest private individual shareholder.
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
            "priority_rule": 1,
        }

    # Rule 2 — parent company >50% holder. v1 flags for manual review.
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

    # Rule 3 — CEO / MD.
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

    # Rule 4 — CFO / FD.
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
# Orchestrator
# ---------------------------------------------------------------------------

def process_lead(company: dict) -> dict:
    """Full MAN workflow for a single company.

    company must carry at least {"name": str}. Optional: "number", "website"."""

    name = (company.get("name") or "").strip()
    if not name:
        return {
            "company_name": "",
            "status": "error",
            "error": "Missing company name",
            "man": None,
            "credits_used": {"cognism": 0, "lusha": 0},
        }

    # Step 1 — resolve Companies House number via Pomanda.
    number = (company.get("number") or "").strip() or None
    if not number:
        search = pomanda.find_company_by_name(name)
        if not search.get("ok"):
            return _err(name, search.get("error") or "Pomanda lookup failed")
        number = (search.get("match") or {}).get("number")
        if not number:
            return _err(name, f"No Pomanda match for '{name}'")

    # Step 2 — pull shareholders + officers.
    sh = pomanda.get_shareholders(number)
    if not sh.get("ok"):
        return _err(name, sh.get("error") or "Pomanda shareholders lookup failed")
    off = pomanda.get_officers(number)
    if not off.get("ok"):
        return _err(name, off.get("error") or "Pomanda officers lookup failed")

    # Step 3 — apply JSP priority rules.
    man_candidate = _apply_jsp_priority_rules(
        sh.get("shareholders", []),
        off.get("officers", []),
        company,
    )
    if not man_candidate:
        return {
            "company_name": name,
            "company_number": number,
            "status": "not_found",
            "error": "No MAN identifiable",
            "man": None,
            "credits_used": {"cognism": 0, "lusha": 0},
        }
    if man_candidate.get("needs_review"):
        # Rule 2 hit — skip enrichment until parent-company recursion is built.
        return {
            "company_name": name,
            "company_number": number,
            "status": "needs_review",
            "error": "Parent-company shareholder lookup required",
            "man": man_candidate,
            "credits_used": {"cognism": 0, "lusha": 0},
        }

    # Step 4 — enrich via Cognism.
    cog = cognism.enrich_person(man_candidate["name"], name)
    cog_credits = cog.get("credits_used", 0) or 0
    if cog.get("email") and cog.get("mobile"):
        return _success(name, number, man_candidate, cog, "cognism", cog_credits, 0)

    # Step 5 — fallback to Lusha.
    lsh = lusha.enrich_person(man_candidate["name"], name)
    lsh_credits = lsh.get("credits_used", 0) or 0
    if lsh.get("email") and lsh.get("mobile"):
        return _success(name, number, man_candidate, lsh, "lusha", cog_credits, lsh_credits)

    # Step 6 — neither found the full pair. Return whatever partial contact data we have.
    partial_contact = _merge_contact(cog, lsh)
    return {
        "company_name": name,
        "company_number": number,
        "status": "partial",
        "error": "Name found but no complete contact details (email + mobile)",
        "man": {**man_candidate, **partial_contact, "source": partial_contact.get("source")},
        "credits_used": {"cognism": cog_credits, "lusha": lsh_credits},
    }


def process_batch(leads: list, max_leads: int = MAX_BATCH) -> dict:
    """Run process_lead over a list of companies. No streaming in v1.

    `leads` accepts both dicts and Pydantic-model-like objects (anything with
    a .dict() method)."""
    cap = min(max_leads or MAX_BATCH, MAX_BATCH)
    incoming = [_to_dict(l) for l in (leads or [])]
    truncated = len(incoming) > cap
    to_run = incoming[:cap]

    results = []
    summary = {"success": 0, "partial": 0, "not_found": 0, "needs_review": 0, "error": 0}
    totals = {"cognism": 0, "lusha": 0}

    for lead in to_run:
        r = process_lead(lead)
        results.append(r)
        summary[r.get("status", "error")] = summary.get(r.get("status", "error"), 0) + 1
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
# Helpers
# ---------------------------------------------------------------------------

def _err(company_name: str, message: str) -> dict:
    return {
        "company_name": company_name,
        "status": "error",
        "error": message,
        "man": None,
        "credits_used": {"cognism": 0, "lusha": 0},
    }


def _success(
    name: str, number: str, man_candidate: dict,
    enrich: dict, source: str, cog_credits: int, lsh_credits: int,
) -> dict:
    return {
        "company_name": name,
        "company_number": number,
        "status": "success",
        "error": None,
        "man": {
            **man_candidate,
            "email": enrich.get("email"),
            "mobile": enrich.get("mobile"),
            "linkedin": enrich.get("linkedin"),
            "title": enrich.get("title"),
            "source": source,
        },
        "credits_used": {"cognism": cog_credits, "lusha": lsh_credits},
    }


def _merge_contact(cog: dict, lsh: dict) -> dict:
    """Pick the best available contact fields from both enrichment attempts."""
    def pick(field: str) -> Optional[str]:
        return (cog.get(field) if cog.get(field) else lsh.get(field)) or None

    email = pick("email")
    mobile = pick("mobile")
    # Tag source by whichever actually provided data (Cognism first, Lusha second).
    source = None
    if cog.get("email") or cog.get("mobile"):
        source = "cognism"
    elif lsh.get("email") or lsh.get("mobile"):
        source = "lusha"
    return {
        "email": email,
        "mobile": mobile,
        "linkedin": pick("linkedin"),
        "title": pick("title"),
        "source": source,
    }


def _to_dict(lead) -> dict:
    if isinstance(lead, dict):
        return lead
    # Pydantic v1 / v2 compat.
    if hasattr(lead, "model_dump"):
        return lead.model_dump()
    if hasattr(lead, "dict"):
        return lead.dict()
    return dict(lead)
