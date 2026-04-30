"""Smoke tests for the Companies House integration.

These cover the offline pieces — number normalisation, CSV parsing, PSC nature
summarisation, formatting, and the auth-header construction. Live API
verification (real key, real lookup) is a separate manual step at demo time.

Run: python3 -m pytest backend/test_companies_house.py -v
or:   python3 backend/test_companies_house.py
"""

import base64
import io
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from integrations import companies_house as ch  # noqa: E402


def test_looks_like_number():
    assert ch._looks_like_number("12345678")
    assert ch._looks_like_number("SC123456")
    assert ch._looks_like_number("ni654321")
    assert ch._looks_like_number("01234567")
    assert not ch._looks_like_number("Apple UK Ltd")
    assert not ch._looks_like_number("")
    assert not ch._looks_like_number("12345678 Apple")


def test_normalise_number():
    assert ch._normalise_number("12345678") == "12345678"
    assert ch._normalise_number("sc123456") == "SC123456"
    # Pads short digit-only numbers to 8 chars.
    assert ch._normalise_number("12345") == "00012345"
    # Pads short prefixed numbers so total stays 8.
    assert ch._normalise_number("ni12345") == "NI012345"
    # Leaves random strings alone (canonicalised to upper).
    assert ch._normalise_number("apple") == "APPLE"


def test_summarise_natures_shares_band():
    natures = ["ownership-of-shares-50-to-75-percent-as-trust"]
    assert ch._summarise_natures(natures) == "50-75% shares"


def test_summarise_natures_voting_band():
    natures = ["voting-rights-25-to-50-percent"]
    assert ch._summarise_natures(natures) == "25-50% voting rights"


def test_summarise_natures_prefers_shares():
    # If both share and voting bands present, share-ownership wins.
    natures = [
        "voting-rights-75-to-100-percent",
        "ownership-of-shares-50-to-75-percent",
    ]
    assert ch._summarise_natures(natures) == "50-75% shares"


def test_summarise_natures_empty():
    assert ch._summarise_natures([]) == "unknown"


def test_summarise_natures_falls_through():
    # An unrecognised nature: hyphens flattened to a sentence.
    natures = ["right-to-appoint-and-remove-directors"]
    assert "appoint" in ch._summarise_natures(natures)


def test_auth_header_basic():
    h = ch._auth_header("test-key-abc123")
    assert h["Accept"] == "application/json"
    auth = h["Authorization"]
    assert auth.startswith("Basic ")
    decoded = base64.b64decode(auth.split(" ", 1)[1]).decode("ascii")
    # Companies House: API key is the username, password is empty.
    assert decoded == "test-key-abc123:"


# --- CSV parsing tests --------------------------------------------------------
# Imported lazily because they touch server.py's helper. Avoids loading the
# whole server at module import time when running just the integration tests.

def test_csv_parse_with_company_name_header():
    from server import _ch_parse_csv
    csv_content = "Company Name\nApple UK Ltd\nGoogle UK Limited\nTesco PLC\n"
    assert _ch_parse_csv(csv_content) == ["Apple UK Ltd", "Google UK Limited", "Tesco PLC"]


def test_csv_parse_with_company_number_header():
    from server import _ch_parse_csv
    csv_content = "Company Number\n12345678\nSC123456\n\n00098765\n"
    assert _ch_parse_csv(csv_content) == ["12345678", "SC123456", "00098765"]


def test_csv_parse_prefers_number_column():
    from server import _ch_parse_csv
    # Both columns present — number wins.
    csv_content = "Company Name,Company Number\nApple UK Ltd,12345678\nGoogle UK,87654321\n"
    assert _ch_parse_csv(csv_content) == ["12345678", "87654321"]


def test_csv_parse_falls_back_to_name_when_number_missing():
    from server import _ch_parse_csv
    csv_content = "Company Name,Company Number\nApple UK Ltd,\nTesco PLC,12345678\n"
    # Row 1: number empty → falls back to name. Row 2: number present → uses it.
    assert _ch_parse_csv(csv_content) == ["Apple UK Ltd", "12345678"]


def test_csv_parse_headerless():
    from server import _ch_parse_csv
    csv_content = "Apple UK Ltd\n12345678\nTesco PLC\n"
    assert _ch_parse_csv(csv_content) == ["Apple UK Ltd", "12345678", "Tesco PLC"]


def test_csv_parse_strips_bom():
    from server import _ch_parse_csv
    # FileReader-on-BOM-encoded file occasionally preserves the U+FEFF.
    csv_content = "﻿Company Name\nApple UK Ltd\n"
    assert _ch_parse_csv(csv_content) == ["Apple UK Ltd"]


def test_csv_parse_empty():
    from server import _ch_parse_csv
    assert _ch_parse_csv("") == []
    assert _ch_parse_csv("   \n\n") == []


# --- Formatter tests ----------------------------------------------------------
# The formatter is the bit that produces what Adam sees in chat.

def test_format_company_full():
    from server import _format_ch_company
    res = {
        "company_name": "ACME Widgets Ltd",
        "company_number": "12345678",
        "status": "Active",
        "incorporation_date": "2010-04-15",
        "sic_codes": ["62012", "62020"],
        "officers": [
            {"name": "Jane Smith", "role": "Director"},
            {"name": "John Smith", "role": "Secretary"},
        ],
        "shareholders": [
            {
                "name": "Holdings Co Ltd",
                "type": "company",
                "percentage": "75-100% shares",
                "natures_of_control": ["ownership-of-shares-75-to-100-percent"],
                "nationality": None,
            },
            {
                "name": "Ms J Smith",
                "type": "individual",
                "percentage": "25-50% shares",
                "natures_of_control": ["ownership-of-shares-25-to-50-percent"],
                "nationality": "British",
            },
        ],
        "shareholders_source": "PSC register",
        "error": None,
    }
    out = _format_ch_company(res)
    assert "ACME Widgets Ltd" in out
    assert "12345678" in out
    assert "Active" in out
    assert "Holdings Co Ltd" in out
    assert "75-100% shares" in out
    assert "Jane Smith" in out
    assert "Director" in out
    assert "British" in out


def test_format_company_no_pscs():
    from server import _format_ch_company
    res = {
        "company_name": "Tiny Co Ltd",
        "company_number": "00012345",
        "status": "Active",
        "incorporation_date": "2024-01-01",
        "sic_codes": [],
        "officers": [{"name": "Sole Owner", "role": "Director"}],
        "shareholders": [],
        "shareholders_source": "PSC register",
        "error": None,
    }
    out = _format_ch_company(res)
    assert "No PSCs on file" in out
    assert "Sole Owner" in out


def test_format_company_error_row():
    from server import _format_ch_company
    res = {
        "company_name": "",
        "company_number": "",
        "error": "Company 'ZZZ Bogus' not found",
    }
    out = _format_ch_company(res)
    assert "not found" in out


def test_format_company_truncates_long_officer_list():
    from server import _format_ch_company
    res = {
        "company_name": "Big Board PLC",
        "company_number": "12345678",
        "status": "Active",
        "incorporation_date": "1990-01-01",
        "sic_codes": [],
        "officers": [{"name": f"Officer {i}", "role": "Director"} for i in range(15)],
        "shareholders": [],
        "shareholders_source": "PSC register",
        "error": None,
    }
    out = _format_ch_company(res)
    assert "and 7 more" in out


# --- Integration registry wiring ---------------------------------------------

def test_registered_in_integrations():
    from server import _INTEGRATIONS
    assert "companies_house" in _INTEGRATIONS
    spec = _INTEGRATIONS["companies_house"]
    assert spec["required_fields"] == ["api_key"]
    assert spec["oauth"] is False


def test_registered_in_testers():
    from server import _TESTERS
    assert "companies_house" in _TESTERS


def test_registered_in_read_action_handlers():
    from server import _READ_ACTION_HANDLERS
    assert "companies_house.lookup" in _READ_ACTION_HANDLERS
    assert "companies_house.batch_lookup" in _READ_ACTION_HANDLERS


def test_registered_in_agent_tool_catalogue():
    from server import AGENT_TOOL_CATALOGUE
    assert "companies_house" in AGENT_TOOL_CATALOGUE


# --- needs_setup signalling when no key present ------------------------------
# Verifies the chat layer will pop SetupModal correctly when Adam hasn't
# configured the key yet. We rely on _kc_get returning None for an unset
# field (the keychain lookup just returns None, no exception).

def test_lookup_without_key_returns_needs_setup():
    # Force the keychain lookup to return None by overriding via monkey-patch.
    original = ch._kc_get
    ch._kc_get = lambda tool_id, field: None
    try:
        res = ch.query_companies_house("Apple UK Ltd")
        assert res["error"] is not None
        assert "needs_setup" in res
        assert "companies_house" in res["needs_setup"]["tools"]
    finally:
        ch._kc_get = original


if __name__ == "__main__":
    # Tiny self-runner for environments without pytest installed.
    import inspect
    funcs = [
        (name, fn)
        for name, fn in sorted(globals().items())
        if name.startswith("test_") and inspect.isfunction(fn)
    ]
    failures = []
    for name, fn in funcs:
        try:
            fn()
        except Exception as e:  # noqa: BLE001
            failures.append((name, e))
            print(f"FAIL  {name}: {e}")
        else:
            print(f"PASS  {name}")
    print(f"\n{len(funcs) - len(failures)} / {len(funcs)} passed")
    sys.exit(0 if not failures else 1)
