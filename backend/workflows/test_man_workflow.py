"""Unit tests for the MAN workflow.

Covers:
  - _apply_jsp_priority_rules (pure function, no I/O) — 6 cases
  - _compare_man_candidates                           — 4 cases
  - process_lead (mocked pomanda/cognism/lusha)       — 6 scenarios from v1.14

Runnable from the backend/ directory with:
    python -m unittest workflows.test_man_workflow
"""

import unittest
from unittest.mock import patch

from workflows.man_workflow import (
    _apply_jsp_priority_rules,
    _compare_man_candidates,
    _names_match,
    process_lead,
)


# ---------------------------------------------------------------------------
# Priority rules — retained from v1.12/v1.13 (must not regress)
# ---------------------------------------------------------------------------

class TestPriorityRules(unittest.TestCase):

    def test_a_picks_largest_individual_ignores_corp(self):
        shareholders = [
            {"name": "Alice Smith", "type": "individual", "pct": 35.0},
            {"name": "Bob Jones", "type": "individual", "pct": 25.0},
            {"name": "Big Corp Ltd", "type": "company", "pct": 40.0},
        ]
        officers = [{"name": "CEO Person", "role_raw": "CEO", "role_normalized": "CEO"}]
        result = _apply_jsp_priority_rules(shareholders, officers, {})
        self.assertEqual(result["priority_rule"], 1)
        self.assertEqual(result["name"], "Alice Smith")
        self.assertIn("35", result["role"])

    def test_b_parent_company_flags_needs_review(self):
        shareholders = [{"name": "Foo Holdings", "type": "company", "pct": 80.0}]
        officers = [{"name": "Some Director", "role_raw": "Director", "role_normalized": "Director"}]
        result = _apply_jsp_priority_rules(shareholders, officers, {})
        self.assertEqual(result["priority_rule"], 2)
        self.assertTrue(result["needs_review"])
        self.assertEqual(result["parent_company"], "Foo Holdings")

    def test_c_officers_pick_ceo_before_cfo(self):
        officers = [
            {"name": "Carol CFO", "role_raw": "Chief Financial Officer", "role_normalized": "CFO"},
            {"name": "Dave CEO", "role_raw": "Chief Executive Officer", "role_normalized": "CEO"},
        ]
        result = _apply_jsp_priority_rules([], officers, {})
        self.assertEqual(result["priority_rule"], 3)
        self.assertEqual(result["name"], "Dave CEO")

    def test_d_cfo_only(self):
        officers = [
            {"name": "Fiona FD", "role_raw": "Finance Director", "role_normalized": "FD"},
            {"name": "Random Director", "role_raw": "Director", "role_normalized": "Director"},
        ]
        result = _apply_jsp_priority_rules([], officers, {})
        self.assertEqual(result["priority_rule"], 4)
        self.assertEqual(result["name"], "Fiona FD")

    def test_e_returns_none_when_nothing_matches(self):
        officers = [{"name": "Ops Director", "role_raw": "Operations Director", "role_normalized": "Director"}]
        self.assertIsNone(_apply_jsp_priority_rules([], officers, {}))

    def test_f_minority_corp_does_not_trigger_rule_2(self):
        shareholders = [{"name": "Small Stake Corp", "type": "company", "pct": 40.0}]
        officers = [{"name": "Gareth CEO", "role_raw": "CEO", "role_normalized": "CEO"}]
        result = _apply_jsp_priority_rules(shareholders, officers, {})
        self.assertEqual(result["priority_rule"], 3)
        self.assertEqual(result["name"], "Gareth CEO")


# ---------------------------------------------------------------------------
# MAN comparison logic (new in v1.14)
# ---------------------------------------------------------------------------

class TestCompareManCandidates(unittest.TestCase):

    def test_upgrade_when_pomanda_finds_bigger_shareholder(self):
        zint = {"first_name": "Neil", "last_name": "Salmon", "job_title": "CEO"}
        pomanda_man = {"name": "Sarah Owner", "priority_rule": 1, "shareholder_pct": 75.0}
        self.assertEqual(_compare_man_candidates(zint, pomanda_man), "upgrade")

    def test_verify_when_names_match(self):
        zint = {"first_name": "Neil", "last_name": "Salmon", "job_title": "CEO"}
        pomanda_man = {"name": "Neil Salmon", "priority_rule": 1, "shareholder_pct": 55.0}
        self.assertEqual(_compare_man_candidates(zint, pomanda_man), "verify")

    def test_keep_zint_when_pomanda_returns_only_officer_fallback(self):
        # Pomanda's "CEO fallback" doesn't outrank Zint's named CEO candidate.
        zint = {"first_name": "Neil", "last_name": "Salmon", "job_title": "CEO"}
        pomanda_man = {"name": "Different CEO", "priority_rule": 3}
        self.assertEqual(_compare_man_candidates(zint, pomanda_man), "keep_zint")

    def test_keep_zint_when_pomanda_returns_nothing(self):
        zint = {"first_name": "Neil", "last_name": "Salmon", "job_title": "CEO"}
        self.assertEqual(_compare_man_candidates(zint, None), "keep_zint")

    def test_keep_zint_when_needs_review(self):
        zint = {"first_name": "Neil", "last_name": "Salmon"}
        pomanda_man = {"name": None, "priority_rule": 2, "needs_review": True, "parent_company": "X Ltd"}
        self.assertEqual(_compare_man_candidates(zint, pomanda_man), "keep_zint")


class TestNameMatching(unittest.TestCase):

    def test_exact_match(self):
        self.assertTrue(_names_match("Neil Salmon", "Neil Salmon"))

    def test_case_and_whitespace_insensitive(self):
        self.assertTrue(_names_match("  neil salmon  ", "Neil  Salmon"))

    def test_reversed_with_comma_matches_on_last_and_first(self):
        # "SALMON, Neil" vs "Neil Salmon" — last name Salmon + Neil in both sets.
        self.assertTrue(_names_match("SALMON, Neil", "Neil Salmon"))

    def test_different_people_do_not_match(self):
        self.assertFalse(_names_match("Neil Salmon", "Sarah Jones"))

    def test_first_names_only_do_not_match(self):
        # Pure last-name match with no other overlap must not return True.
        self.assertFalse(_names_match("John Smith", "Jane Smith"))


# ---------------------------------------------------------------------------
# process_lead — full path with mocked integrations (v1.14 scenarios)
# ---------------------------------------------------------------------------

def _zint_lead(**over):
    base = {
        "name": "GRAIL BIO UK LIMITED",
        "number": "12345678",
        "domain": "grail.com",
        "first_name": "Neil",
        "last_name": "Salmon",
        "job_title": "CEO",
        "linkedin": "https://linkedin.com/in/neilsalmon",
        "email": "neil.salmon@ansell.com",
        "mobile": "32 478 96 99 90",
        "original_row": {},
    }
    base.update(over)
    return base


def _mock_pomanda_ok(shareholders=None, officers=None):
    return {
        "find_company_by_name": lambda name: {"ok": True, "match": {"number": "12345678", "name": name}},
        "get_shareholders": lambda num: {"ok": True, "shareholders": shareholders or []},
        "get_officers": lambda num: {"ok": True, "officers": officers or []},
    }


def _mock_pomanda_unconfigured():
    err = {"ok": False, "error": "Pomanda not configured"}
    return {
        "find_company_by_name": lambda name: err,
        "get_shareholders": lambda num: err,
        "get_officers": lambda num: err,
    }


class TestProcessLead(unittest.TestCase):

    # Scenario 1: Zint has complete contact + Pomanda unconfigured → no enrichment calls.
    def test_zint_complete_contact_no_pomanda(self):
        with patch("workflows.man_workflow.pomanda.find_company_by_name",
                   return_value={"ok": False, "error": "Pomanda not configured"}), \
             patch("workflows.man_workflow.pomanda.get_shareholders",
                   return_value={"ok": False, "error": "Pomanda not configured"}), \
             patch("workflows.man_workflow.pomanda.get_officers",
                   return_value={"ok": False, "error": "Pomanda not configured"}), \
             patch("workflows.man_workflow.cognism.enrich_person") as cog, \
             patch("workflows.man_workflow.lusha.enrich_person") as lsh:
            r = process_lead(_zint_lead())
            cog.assert_not_called()
            lsh.assert_not_called()
        self.assertEqual(r["status"], "success")
        self.assertEqual(r["enrichment_status"], "man_from_zint_unverified")
        self.assertEqual(r["contact_status"], "contact_from_zint")
        self.assertEqual(r["sources"]["email"], "zint")
        self.assertEqual(r["sources"]["mobile"], "zint")

    # Scenario 2: Zint missing mobile, Cognism provides it.
    def test_zint_missing_mobile_cognism_fills_in(self):
        lead = _zint_lead(mobile=None)
        with patch("workflows.man_workflow.pomanda.find_company_by_name",
                   return_value={"ok": False, "error": "Pomanda not configured"}), \
             patch("workflows.man_workflow.pomanda.get_shareholders",
                   return_value={"ok": False, "error": "Pomanda not configured"}), \
             patch("workflows.man_workflow.pomanda.get_officers",
                   return_value={"ok": False, "error": "Pomanda not configured"}), \
             patch("workflows.man_workflow.cognism.enrich_person",
                   return_value={"found": True, "email": None, "mobile": "+44 7700 999000", "credits_used": 1, "error": None}) as cog, \
             patch("workflows.man_workflow.lusha.enrich_person") as lsh:
            r = process_lead(lead)
            cog.assert_called_once()
            lsh.assert_not_called()
        self.assertEqual(r["status"], "success")
        self.assertEqual(r["contact_status"], "contact_enriched_cognism")
        self.assertEqual(r["man"]["mobile"], "+44 7700 999000")
        self.assertEqual(r["sources"]["mobile"], "cognism")
        self.assertEqual(r["sources"]["email"], "zint")
        self.assertEqual(r["credits_used"]["cognism"], 1)

    # Scenario 3: Cognism misses, Lusha fills it in.
    def test_cognism_miss_lusha_fallback(self):
        lead = _zint_lead(email=None, mobile=None)
        with patch("workflows.man_workflow.pomanda.find_company_by_name",
                   return_value={"ok": False, "error": "Pomanda not configured"}), \
             patch("workflows.man_workflow.pomanda.get_shareholders",
                   return_value={"ok": False, "error": "Pomanda not configured"}), \
             patch("workflows.man_workflow.pomanda.get_officers",
                   return_value={"ok": False, "error": "Pomanda not configured"}), \
             patch("workflows.man_workflow.cognism.enrich_person",
                   return_value={"found": False, "email": None, "mobile": None, "credits_used": 1, "error": None}), \
             patch("workflows.man_workflow.lusha.enrich_person",
                   return_value={"found": True, "email": "neil@ansell.com", "mobile": "+32 478 96 99 90", "credits_used": 1, "error": None}):
            r = process_lead(lead)
        self.assertEqual(r["status"], "success")
        self.assertEqual(r["contact_status"], "contact_enriched_lusha")
        self.assertEqual(r["sources"]["email"], "lusha")
        self.assertEqual(r["sources"]["mobile"], "lusha")
        self.assertEqual(r["credits_used"]["cognism"], 1)
        self.assertEqual(r["credits_used"]["lusha"], 1)

    # Scenario 4: Pomanda finds a larger shareholder → MAN upgraded.
    def test_pomanda_upgrades_man(self):
        lead = _zint_lead()  # Zint says Neil Salmon is CEO
        # Pomanda says Sarah Owner owns 80% — outranks Zint's named CEO.
        shareholders = [
            {"name": "Sarah Owner", "type": "individual", "pct": 80.0},
            {"name": "Neil Salmon", "type": "individual", "pct": 5.0},
        ]
        with patch("workflows.man_workflow.pomanda.find_company_by_name",
                   return_value={"ok": True, "match": {"number": "12345678", "name": lead["name"]}}), \
             patch("workflows.man_workflow.pomanda.get_shareholders",
                   return_value={"ok": True, "shareholders": shareholders}), \
             patch("workflows.man_workflow.pomanda.get_officers",
                   return_value={"ok": True, "officers": []}), \
             patch("workflows.man_workflow.cognism.enrich_person",
                   return_value={"found": True, "email": "sarah@grail.com", "mobile": "+44 7700 111222", "credits_used": 1, "error": None}), \
             patch("workflows.man_workflow.lusha.enrich_person") as lsh:
            r = process_lead(lead)
            lsh.assert_not_called()
        self.assertEqual(r["enrichment_status"], "man_upgraded")
        self.assertEqual(r["man"]["name"], "Sarah Owner")
        self.assertEqual(r["sources"]["man"], "upgraded")
        # Upgraded MAN means Zint's email/mobile (for Neil) are dropped — Cognism provides new ones.
        self.assertEqual(r["sources"]["email"], "cognism")

    # Scenario 5: Pomanda verifies Zint's candidate (same name).
    def test_pomanda_verifies_zint(self):
        lead = _zint_lead()
        shareholders = [
            {"name": "Neil Salmon", "type": "individual", "pct": 55.0},
        ]
        with patch("workflows.man_workflow.pomanda.find_company_by_name",
                   return_value={"ok": True, "match": {"number": "12345678", "name": lead["name"]}}), \
             patch("workflows.man_workflow.pomanda.get_shareholders",
                   return_value={"ok": True, "shareholders": shareholders}), \
             patch("workflows.man_workflow.pomanda.get_officers",
                   return_value={"ok": True, "officers": []}), \
             patch("workflows.man_workflow.cognism.enrich_person") as cog, \
             patch("workflows.man_workflow.lusha.enrich_person") as lsh:
            r = process_lead(lead)
            cog.assert_not_called()
            lsh.assert_not_called()
        self.assertEqual(r["enrichment_status"], "man_verified")
        self.assertEqual(r["contact_status"], "contact_from_zint")
        self.assertEqual(r["sources"]["man"], "pomanda")
        self.assertEqual(r["man"]["name"], "Neil Salmon")
        self.assertEqual(r["man"]["shareholder_pct"], 55.0)

    # Scenario 6: Pomanda not configured → fall through to enrichment using Zint's MAN.
    def test_pomanda_unconfigured_enrich_zint_man(self):
        lead = _zint_lead(mobile=None)
        with patch("workflows.man_workflow.pomanda.find_company_by_name",
                   return_value={"ok": False, "error": "Pomanda not configured"}), \
             patch("workflows.man_workflow.pomanda.get_shareholders",
                   return_value={"ok": False, "error": "Pomanda not configured"}), \
             patch("workflows.man_workflow.pomanda.get_officers",
                   return_value={"ok": False, "error": "Pomanda not configured"}), \
             patch("workflows.man_workflow.cognism.enrich_person",
                   return_value={"found": True, "email": None, "mobile": "+44 7700 900000", "credits_used": 1, "error": None}), \
             patch("workflows.man_workflow.lusha.enrich_person") as lsh:
            r = process_lead(lead)
            lsh.assert_not_called()
        self.assertEqual(r["enrichment_status"], "man_from_zint_unverified")
        self.assertEqual(r["contact_status"], "contact_enriched_cognism")
        self.assertEqual(r["man"]["name"], "Neil Salmon")  # Zint's name kept.
        self.assertEqual(r["sources"]["mobile"], "cognism")
        self.assertEqual(r["sources"]["email"], "zint")

    # Scenario 7: All three services unconfigured + Zint missing contact → partial.
    def test_all_unconfigured_partial(self):
        lead = _zint_lead(email=None, mobile=None)
        with patch("workflows.man_workflow.pomanda.find_company_by_name",
                   return_value={"ok": False, "error": "Pomanda not configured"}), \
             patch("workflows.man_workflow.pomanda.get_shareholders",
                   return_value={"ok": False, "error": "Pomanda not configured"}), \
             patch("workflows.man_workflow.pomanda.get_officers",
                   return_value={"ok": False, "error": "Pomanda not configured"}), \
             patch("workflows.man_workflow.cognism.enrich_person",
                   return_value={"found": False, "email": None, "mobile": None, "credits_used": 0, "error": "Cognism not configured"}), \
             patch("workflows.man_workflow.lusha.enrich_person",
                   return_value={"found": False, "email": None, "mobile": None, "credits_used": 0, "error": "Lusha not configured"}):
            r = process_lead(lead)
        self.assertEqual(r["status"], "partial")
        self.assertEqual(r["contact_status"], "contact_partial")
        self.assertEqual(r["man"]["name"], "Neil Salmon")


if __name__ == "__main__":
    unittest.main()
