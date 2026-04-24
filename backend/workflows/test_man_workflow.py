"""Unit tests for _apply_jsp_priority_rules.

Runnable from the backend/ directory with:
    python -m unittest workflows.test_man_workflow
"""

import unittest

from workflows.man_workflow import _apply_jsp_priority_rules


class TestPriorityRules(unittest.TestCase):

    def test_a_picks_largest_individual_ignores_corp(self):
        """Rule 1: two individuals + one larger corp → picks 35% individual."""
        shareholders = [
            {"name": "Alice Smith", "type": "individual", "pct": 35.0},
            {"name": "Bob Jones", "type": "individual", "pct": 25.0},
            {"name": "Big Corp Ltd", "type": "company", "pct": 40.0},
        ]
        officers = [{"name": "CEO Person", "role_raw": "CEO", "role_normalized": "CEO"}]
        result = _apply_jsp_priority_rules(shareholders, officers, {})
        self.assertIsNotNone(result)
        self.assertEqual(result["priority_rule"], 1)
        self.assertEqual(result["name"], "Alice Smith")
        self.assertIn("35", result["role"])

    def test_b_parent_company_flags_needs_review(self):
        """Rule 2: no individuals, one 80% corp parent → flags needs_review."""
        shareholders = [
            {"name": "Foo Holdings", "type": "company", "pct": 80.0},
        ]
        officers = [{"name": "Some Director", "role_raw": "Director", "role_normalized": "Director"}]
        result = _apply_jsp_priority_rules(shareholders, officers, {})
        self.assertIsNotNone(result)
        self.assertEqual(result["priority_rule"], 2)
        self.assertTrue(result["needs_review"])
        self.assertEqual(result["parent_company"], "Foo Holdings")
        self.assertIsNone(result["name"])

    def test_c_officers_pick_ceo_before_cfo(self):
        """Rule 3 beats rule 4 — CEO wins when both present."""
        shareholders = []
        officers = [
            {"name": "Carol CFO", "role_raw": "Chief Financial Officer", "role_normalized": "CFO"},
            {"name": "Dave CEO", "role_raw": "Chief Executive Officer", "role_normalized": "CEO"},
        ]
        result = _apply_jsp_priority_rules(shareholders, officers, {})
        self.assertIsNotNone(result)
        self.assertEqual(result["priority_rule"], 3)
        self.assertEqual(result["name"], "Dave CEO")

    def test_d_cfo_only(self):
        """Rule 4: only a Finance Director present → picks CFO."""
        shareholders = []
        officers = [
            {"name": "Fiona FD", "role_raw": "Finance Director", "role_normalized": "FD"},
            {"name": "Random Director", "role_raw": "Director", "role_normalized": "Director"},
        ]
        result = _apply_jsp_priority_rules(shareholders, officers, {})
        self.assertIsNotNone(result)
        self.assertEqual(result["priority_rule"], 4)
        self.assertEqual(result["name"], "Fiona FD")

    def test_e_returns_none_when_nothing_matches(self):
        """No shareholders and no CEO/CFO → returns None."""
        shareholders = []
        officers = [
            {"name": "Some Other Director", "role_raw": "Operations Director", "role_normalized": "Director"},
        ]
        result = _apply_jsp_priority_rules(shareholders, officers, {})
        self.assertIsNone(result)

    def test_f_minority_corp_does_not_trigger_rule_2(self):
        """Parent rule only fires on >50%. 40% corp should fall through to officers."""
        shareholders = [
            {"name": "Small Stake Corp", "type": "company", "pct": 40.0},
        ]
        officers = [{"name": "Gareth CEO", "role_raw": "CEO", "role_normalized": "CEO"}]
        result = _apply_jsp_priority_rules(shareholders, officers, {})
        self.assertIsNotNone(result)
        self.assertEqual(result["priority_rule"], 3)
        self.assertEqual(result["name"], "Gareth CEO")


if __name__ == "__main__":
    unittest.main()
