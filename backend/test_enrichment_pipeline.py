"""Tests for the v1.30 enrichment pipeline.

Covers the offline pieces — pipeline orchestration, missing-only rules,
first-wins precedence, CSV/Sheets I/O. Companies House network calls
are stubbed so the suite runs without an API key.

Run:
  /opt/homebrew/bin/python3.12 -m pytest backend/test_enrichment_pipeline.py -v
or:
  /opt/homebrew/bin/python3.12 backend/test_enrichment_pipeline.py
"""

from __future__ import annotations

import asyncio
import csv
import io
import sys
import time
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent))

from enrichment import EnrichmentPipeline, ENRICHERS  # noqa: E402
from enrichment.companies_house_enricher import (  # noqa: E402
    CompaniesHouseEnricher,
    _match_column,
    _norm_key,
)
from enrichment import io as eio  # noqa: E402
from integrations import companies_house  # noqa: E402


# ---------- Stubs --------------------------------------------------------

# A canned Companies House response for "Pret A Manger Limited".
_PRET_RESPONSE = {
    "company_name": "Pret A Manger Limited",
    "company_number": "03836930",
    "status": "Active",
    "incorporation_date": "1999-09-29",
    "sic_codes": ["56102"],
    "officers": [
        {"name": "Pano Christou", "role": "Director"},
        {"name": "Ohad Hagai", "role": "Director"},
        {"name": "Jonathan Dixon", "role": "Secretary"},
    ],
    "shareholders": [
        {
            "name": "Pret A Manger (Holdings) Limited",
            "type": "company",
            "percentage": "75-100% shares",
            "natures_of_control": ["ownership-of-shares-75-to-100-percent"],
        },
    ],
    "shareholders_source": "PSC register",
    "error": None,
}


def _stub_query(target: str) -> dict:
    """Stand-in for companies_house.query_companies_house — returns the
    canned response if the input clearly references Pret, otherwise
    a "no match" envelope mirroring the real shape."""
    needle = (target or "").strip().lower()
    if "pret" in needle or needle in ("03836930", "3836930"):
        return dict(_PRET_RESPONSE)
    return {
        "company_name": "",
        "company_number": "",
        "status": "",
        "incorporation_date": "",
        "sic_codes": [],
        "officers": [],
        "shareholders": [],
        "shareholders_source": "PSC register",
        "error": "Company not found",
    }


def _install_stub(monkeypatch=None) -> None:
    """Replace the module-level Companies House client. We don't import
    pytest's monkeypatch here so the module also runs as a script — call
    `_uninstall_stub()` in finally blocks when running standalone."""
    companies_house.query_companies_house = _stub_query  # type: ignore[assignment]


def _uninstall_stub(original) -> None:
    companies_house.query_companies_house = original  # type: ignore[assignment]


# ---------- Tests --------------------------------------------------------

def test_1_empty_pipeline_passthrough():
    pipeline = EnrichmentPipeline([], inter_row_sleep_seconds=0)
    row = {"Company Name": "Acme", "Status": "Active"}
    enriched, status = asyncio.run(pipeline.enrich_row(row))
    assert enriched == row
    assert status == {}


def test_2_companies_house_enriches_from_name_only():
    original = companies_house.query_companies_house
    _install_stub()
    try:
        pipeline = EnrichmentPipeline([CompaniesHouseEnricher()], inter_row_sleep_seconds=0)
        row = {"Company Name": "Pret A Manger Limited"}
        enriched, status = asyncio.run(pipeline.enrich_row(row))
        # Input column preserved.
        assert enriched["Company Name"] == "Pret A Manger Limited"
        # Output columns filled.
        assert enriched["Company Number"] == "03836930"
        assert enriched["Status"] == "Active"
        assert "Pano Christou" in enriched["Directors"]
        assert "Pret A Manger (Holdings)" in enriched["Shareholders"]
        assert enriched["Officer Count"] == "3"
        assert status["companies_house"].startswith("enriched")
    finally:
        _uninstall_stub(original)


def test_3_skipped_when_all_outputs_present():
    original = companies_house.query_companies_house
    _install_stub()
    try:
        pipeline = EnrichmentPipeline([CompaniesHouseEnricher()], inter_row_sleep_seconds=0)
        row = {
            "Company Name": "Pret A Manger Limited",
            "Company Number": "03836930",
            "Status": "Active",
            "Incorporation Date": "1999-09-29",
            "SIC Code": "56102",
            "Registered Address": "1 Hudson's Place, London",
            "Directors": "X",
            "Shareholders": "Y",
            "Officer Count": "3",
        }
        enriched, status = asyncio.run(pipeline.enrich_row(row))
        assert status["companies_house"] == "skipped (no missing fields)"
        assert enriched == row
    finally:
        _uninstall_stub(original)


def test_4_existing_value_never_overwritten():
    original = companies_house.query_companies_house
    _install_stub()
    try:
        pipeline = EnrichmentPipeline([CompaniesHouseEnricher()], inter_row_sleep_seconds=0)
        # Status already set — Companies House response would say "Active",
        # but we keep "Dormant" because it was filled in input.
        row = {
            "Company Name": "Pret A Manger Limited",
            "Status": "Dormant",
        }
        enriched, _ = asyncio.run(pipeline.enrich_row(row))
        assert enriched["Status"] == "Dormant"
        assert enriched["Company Number"] == "03836930"
    finally:
        _uninstall_stub(original)


def test_5_skipped_when_required_input_missing():
    original = companies_house.query_companies_house
    _install_stub()
    try:
        pipeline = EnrichmentPipeline([CompaniesHouseEnricher()], inter_row_sleep_seconds=0)
        # Neither name NOR number present → enricher should skip.
        row = {"Industry": "Foodservice", "Email": "x@y.com"}
        enriched, status = asyncio.run(pipeline.enrich_row(row))
        assert status["companies_house"] == "skipped (missing required input)"
        assert enriched == row
    finally:
        _uninstall_stub(original)


def test_6_csv_writeback_preserves_count_and_order():
    rows = [
        {"Company Name": "Acme", "Notes": "old"},
        {"Company Name": "Beta", "Notes": "older"},
        {"Company Name": "Gamma", "Notes": "oldest"},
    ]
    header = ["Company Name", "Notes"]
    out_path, _token = eio.write_csv(rows, header)
    try:
        text = Path(out_path).read_text(encoding="utf-8")
        out_rows = list(csv.DictReader(io.StringIO(text)))
        assert [r["Company Name"] for r in out_rows] == ["Acme", "Beta", "Gamma"]
        assert [r["Notes"] for r in out_rows] == ["old", "older", "oldest"]
        assert list(out_rows[0].keys()) == header
    finally:
        Path(out_path).unlink(missing_ok=True)


def test_7_csv_writeback_appends_new_columns():
    original = companies_house.query_companies_house
    _install_stub()
    try:
        pipeline = EnrichmentPipeline([CompaniesHouseEnricher()], inter_row_sleep_seconds=0)
        rows = [{"Company Name": "Pret A Manger Limited", "Notes": "keep me"}]
        results = asyncio.run(pipeline.enrich_batch(rows))
        enriched_rows = [r for r, _ in results]
        merged_header = eio.merge_headers(["Company Name", "Notes"], enriched_rows)

        # Originals stay in their original positions.
        assert merged_header[:2] == ["Company Name", "Notes"]
        # New columns appended after.
        assert "Company Number" in merged_header[2:]
        assert "Directors" in merged_header[2:]

        out_path, _token = eio.write_csv(enriched_rows, merged_header)
        try:
            text = Path(out_path).read_text(encoding="utf-8")
            out_rows = list(csv.DictReader(io.StringIO(text)))
            assert out_rows[0]["Notes"] == "keep me"
            assert out_rows[0]["Company Number"] == "03836930"
        finally:
            Path(out_path).unlink(missing_ok=True)
    finally:
        _uninstall_stub(original)


def test_8_sheet_diff_only_blank_cells_updated():
    """Verify the batchUpdate payload only touches cells that were
    blank in the input AND filled by the pipeline. Existing cells are
    never overwritten; new columns get a header write + cell writes."""
    header = ["Company Name", "Status"]
    original_rows = [
        {"Company Name": "Pret", "Status": "Dormant"},   # Status pre-filled
        {"Company Name": "Acme", "Status": ""},          # Status blank
    ]
    enriched_rows = [
        {"Company Name": "Pret", "Status": "Dormant", "Company Number": "03836930", "Directors": "Pano"},
        {"Company Name": "Acme", "Status": "Active", "Company Number": "11112222", "Directors": "X"},
    ]

    updates = eio.diff_for_sheet_update(original_rows, enriched_rows, header)

    # Build a quick lookup: range -> value
    by_range = {u["range"]: u["values"][0][0] for u in updates}

    # Header writes: appended columns are written into row 1.
    assert "Sheet1!C1" in by_range and by_range["Sheet1!C1"] == "Company Number"
    assert "Sheet1!D1" in by_range and by_range["Sheet1!D1"] == "Directors"

    # Row 1 (sheet row 2): Status was "Dormant" → not overwritten.
    assert "Sheet1!B2" not in by_range
    # Row 1 new cells written.
    assert by_range["Sheet1!C2"] == "03836930"
    assert by_range["Sheet1!D2"] == "Pano"

    # Row 2 (sheet row 3): Status was blank → filled with "Active".
    assert by_range["Sheet1!B3"] == "Active"
    assert by_range["Sheet1!C3"] == "11112222"
    assert by_range["Sheet1!D3"] == "X"


def test_9_batch_respects_rate_limit_sleep():
    """15-row batch with a 0.05s sleep should take >= 14 * 0.05s
    (only sleeps BETWEEN rows, not before/after)."""
    original = companies_house.query_companies_house
    _install_stub()
    try:
        pipeline = EnrichmentPipeline(
            [CompaniesHouseEnricher()],
            inter_row_sleep_seconds=0.05,
        )
        rows = [{"Company Name": "Pret A Manger Limited"} for _ in range(15)]
        t0 = time.monotonic()
        results = asyncio.run(pipeline.enrich_batch(rows))
        elapsed = time.monotonic() - t0
        assert len(results) == 15
        # 14 inter-row sleeps × 0.05s = 0.7s minimum (with some tolerance).
        assert elapsed >= 14 * 0.05 * 0.8
    finally:
        _uninstall_stub(original)


def test_10_first_enricher_wins_on_overlapping_field():
    """Two enrichers both claim 'Status'; the first to fill wins. The
    second sees the cell as already populated and leaves it alone."""

    class _StaticEnricher:
        """Returns a fixed dict regardless of input — simulates a second
        source that claims to know the same fields as Companies House."""
        def __init__(self, name, fields, value_map):
            self.name = name
            self.enriches_fields = list(fields)
            self.requires_fields = ["Company Name"]
            self._value_map = dict(value_map)

        def enrich(self, row, missing_only=True):
            return dict(self._value_map)

    first = _StaticEnricher("ent_a", ["Status", "Color"], {"Status": "from_a", "Color": "blue"})
    second = _StaticEnricher("ent_b", ["Status", "Shape"], {"Status": "from_b", "Shape": "square"})

    pipeline = EnrichmentPipeline([first, second], inter_row_sleep_seconds=0)
    row = {"Company Name": "Acme"}
    enriched, status = asyncio.run(pipeline.enrich_row(row))
    # First wins for Status.
    assert enriched["Status"] == "from_a"
    # Each filled the field unique to itself.
    assert enriched["Color"] == "blue"
    assert enriched["Shape"] == "square"
    # Second's Status write was skipped (only its unique field counts).
    assert status["ent_a"] == "enriched 2 fields"
    assert status["ent_b"] == "enriched 1 fields"


# ---------- Bonus offline checks (don't count toward the 10) -------------

def test_norm_key_collapses_punctuation_and_case():
    # Same characters modulo case/punctuation collapse to the same key.
    assert _norm_key("Company Number") == _norm_key("company-number")
    assert _norm_key("Company Number") == _norm_key("company_number")
    assert _norm_key("Companies House #") == _norm_key("companies house")
    # But genuinely different identifiers stay distinct.
    assert _norm_key("Company Number") != _norm_key("Companies House Number")


def test_match_column_finds_alias():
    row = {"Companies House Number": "12345678", "Other": "x"}
    assert _match_column(row, ("Company Number", "Companies House Number")) == "Companies House Number"


def test_parse_sheets_url():
    sid = eio.parse_sheets_url("https://docs.google.com/spreadsheets/d/1aB-cD/edit#gid=0")
    assert sid == "1aB-cD"
    assert eio.parse_sheets_url("https://example.com/foo") is None


def test_read_csv_strips_bom_and_whitespace():
    text = "﻿Company Name,Status\nPret  ,  Active  \n"
    rows, header = eio.read_csv(text)
    assert header == ["Company Name", "Status"]
    assert rows[0]["Company Name"] == "Pret"
    assert rows[0]["Status"] == "Active"


# ---------- Standalone runner --------------------------------------------

if __name__ == "__main__":
    import inspect
    fn_count = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn_count += 1
            try:
                fn()
                print(f"PASS  {name}")
            except AssertionError as exc:
                print(f"FAIL  {name}: {exc}")
                sys.exit(1)
            except Exception as exc:  # noqa: BLE001
                print(f"ERROR {name}: {exc}")
                sys.exit(2)
    print(f"\n{fn_count} tests passed.")
