"""Tests for v1.30.1 — async enrichment runs with live progress.

Covers the in-memory job registry, ETA math, the async POST endpoint
that hands back a job_id immediately, and the GET status endpoint that
the frontend polls.

Run:
  /opt/homebrew/bin/python3.12 backend/test_enrichment_progress.py
or:
  /opt/homebrew/bin/python3.12 -m pytest backend/test_enrichment_progress.py -v
"""

from __future__ import annotations

import asyncio
import sys
import time
import uuid
from collections import deque
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from enrichment import job_manager  # noqa: E402
from enrichment import EnrichmentPipeline  # noqa: E402
from enrichment.companies_house_enricher import CompaniesHouseEnricher  # noqa: E402
from integrations import companies_house  # noqa: E402

# Stub Companies House so the suite runs without an API key — same trick
# as test_enrichment_pipeline.py. Each test that exercises the pipeline
# installs and uninstalls the stub explicitly to avoid order coupling.

_STUB_RESPONSE = {
    "company_name": "Acme",
    "company_number": "12345678",
    "status": "Active",
    "incorporation_date": "2010-01-01",
    "sic_codes": ["12345"],
    "officers": [{"name": "Jane Doe", "role": "Director"}],
    "shareholders": [{"name": "Acme Holdings", "type": "company", "percentage": "75-100% shares", "natures_of_control": []}],
    "shareholders_source": "PSC register",
    "error": None,
}


def _stub_query(target):
    return dict(_STUB_RESPONSE)


def _install_stub():
    original = companies_house.query_companies_house
    companies_house.query_companies_house = _stub_query  # type: ignore[assignment]
    return original


def _uninstall_stub(original):
    companies_house.query_companies_house = original  # type: ignore[assignment]


# ---------- Tests --------------------------------------------------------

def test_1_create_job_returns_uuid_and_sets_total():
    job_manager._reset_for_tests()
    job_id = job_manager.create_job(199)
    # Valid UUID string — uuid.UUID() raises if not.
    uuid.UUID(job_id)
    state = job_manager.get_job(job_id)
    assert state is not None
    assert state["total"] == 199
    assert state["progress"] == 0
    assert state["status"] == "processing"


def test_2_update_progress_increments_and_recomputes_eta():
    job_manager._reset_for_tests()
    job_id = job_manager.create_job(10)

    # Two synthetic row completions, ~0.05s apart, so ETA can be computed.
    job_manager.update_current(job_id, row_index=0, company_name="A", enricher_name="companies_house")
    time.sleep(0.05)
    job_manager.row_done(job_id, row_index=0, company_name="A", status_per_enricher={"companies_house": "enriched 1 fields"})

    job_manager.update_current(job_id, row_index=1, company_name="B", enricher_name="companies_house")
    time.sleep(0.05)
    job_manager.row_done(job_id, row_index=1, company_name="B", status_per_enricher={"companies_house": "enriched 1 fields"})

    state = job_manager.get_job(job_id)
    assert state["progress"] == 2
    assert state["rows_enriched"] == 2
    # 2 samples averaging ~0.05s × 8 remaining = ~0.4s. Allow a wide band
    # for CI noise; we're checking the formula, not millisecond accuracy.
    assert state["eta_seconds"] is not None
    assert state["eta_seconds"] >= 0


def test_3_eta_calc_rolling_average():
    """10 rows in 5s → 100 total → ETA on remaining 90 rows ≈ 45s."""
    durations = deque([0.5] * 10, maxlen=10)  # 0.5s/row average
    rows_remaining = 90
    eta = job_manager._compute_eta_seconds(durations, rows_remaining)
    assert eta is not None
    assert 44 <= eta <= 46  # 0.5 × 90 = 45


def test_4_complete_job_sets_output_url():
    job_manager._reset_for_tests()
    job_id = job_manager.create_job(5)
    job_manager.complete_job(
        job_id,
        output_url="http://127.0.0.1:18789/enrichment/download/abc",
        summary={"rows_processed": 5, "rows_enriched": 4},
        download_filename="leads.csv",
        credits_used={"companies_house": 0},
    )
    state = job_manager.get_job(job_id)
    assert state["status"] == "completed"
    assert state["output_url"].endswith("/abc")
    assert state["progress"] == state["total"] == 5
    assert state["credits_used"] == {"companies_house": 0}


def test_5_fail_job_sets_error():
    job_manager._reset_for_tests()
    job_id = job_manager.create_job(5)
    job_manager.fail_job(job_id, "API down")
    state = job_manager.get_job(job_id)
    assert state["status"] == "failed"
    assert state["error"] == "API down"


def test_6_get_job_returns_none_for_unknown():
    job_manager._reset_for_tests()
    assert job_manager.get_job("does-not-exist") is None
    assert job_manager.get_job("") is None


def test_7_concurrent_updates_to_different_jobs_dont_interfere():
    job_manager._reset_for_tests()
    j1 = job_manager.create_job(3)
    j2 = job_manager.create_job(3)
    job_manager.row_done(j1, row_index=0, company_name="A", status_per_enricher={"x": "enriched 1 fields"})
    job_manager.row_done(j2, row_index=0, company_name="Z", status_per_enricher={"x": "no match"})
    s1 = job_manager.get_job(j1)
    s2 = job_manager.get_job(j2)
    assert s1["rows_enriched"] == 1 and s1["rows_unmatched"] == 0
    assert s2["rows_enriched"] == 0 and s2["rows_unmatched"] == 1
    assert s1["job_id"] != s2["job_id"]


def test_8_job_ttl_prunes_old_jobs():
    job_manager._reset_for_tests()
    j1 = job_manager.create_job(1)
    job_manager.complete_job(j1, output_url="http://x", summary={})
    # Force-finished long ago → next get_job should prune it.
    with job_manager._lock:
        job_manager._jobs[j1]["finished_at"] = job_manager._now() - (job_manager.JOB_TTL_SECONDS + 60)
    assert job_manager.get_job(j1) is None


def test_9_post_run_returns_job_id_immediately():
    """POST /enrichment/run must return processing + job_id BEFORE the
    CSV finishes — the whole point of v1.30.1."""
    from fastapi.testclient import TestClient
    from server import app

    job_manager._reset_for_tests()
    original = _install_stub()
    try:
        # 6-row CSV with the pipeline's per-row sleep at 0.5s. If the
        # endpoint were synchronous this would take ~3s; async means it
        # returns essentially immediately.
        csv = "Company Name\n" + "\n".join(f"Row{i}" for i in range(6))
        client = TestClient(app)
        t0 = time.monotonic()
        r = client.post("/enrichment/run", json={"csv_content": csv, "filename": "x.csv"})
        elapsed = time.monotonic() - t0
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "processing"
        assert "job_id" in body
        assert body["progress_marker"].startswith("[[enrichment-progress:")
        assert body["progress_marker"].endswith("]]")
        # If we accidentally went synchronous, this would be >2s.
        assert elapsed < 1.5, f"Endpoint blocked for {elapsed:.2f}s — should be async."
    finally:
        _uninstall_stub(original)


def test_10_get_status_returns_live_state():
    from fastapi.testclient import TestClient
    from server import app

    job_manager._reset_for_tests()
    original = _install_stub()
    try:
        csv = "Company Name\nAcme\nBeta\nGamma\n"
        client = TestClient(app)
        post = client.post("/enrichment/run", json={"csv_content": csv, "filename": "x.csv"})
        job_id = post.json()["job_id"]

        # Poll until done — each Companies House call is sub-100ms in
        # stub mode plus 0.5s sleep between rows. 10s ceiling is safe.
        deadline = time.monotonic() + 10
        final = None
        while time.monotonic() < deadline:
            r = client.get(f"/enrichment/status/{job_id}")
            assert r.status_code == 200
            body = r.json()
            assert body["job_id"] == job_id
            assert body["total"] == 3
            if body["status"] == "completed":
                final = body
                break
            time.sleep(0.2)
        assert final is not None, "Job did not complete within deadline."
        assert final["progress"] == 3
        assert final["output_url"].startswith("http://127.0.0.1:")
    finally:
        _uninstall_stub(original)


def test_11_status_404_for_unknown_job():
    from fastapi.testclient import TestClient
    from server import app

    client = TestClient(app)
    r = client.get("/enrichment/status/00000000-0000-0000-0000-000000000000")
    assert r.status_code == 404


def test_12_end_to_end_with_pipeline_progress():
    """End-to-end without HTTP: pipeline.enrich_batch with a job_id
    populates the registry such that the final state mirrors the result."""
    job_manager._reset_for_tests()
    original = _install_stub()
    try:
        pipeline = EnrichmentPipeline([CompaniesHouseEnricher()], inter_row_sleep_seconds=0)
        rows = [{"Company Name": "Acme"}, {"Company Name": "Beta"}, {"Company Name": "Gamma"}]
        job_id = job_manager.create_job(len(rows))

        results = asyncio.run(pipeline.enrich_batch(rows, job_id=job_id))
        # Mark the job complete so the final view reads cleanly.
        summary = pipeline.summarise(results)
        job_manager.complete_job(
            job_id,
            output_url="http://x/abc",
            summary={"rows_processed": summary["rows_processed"]},
            credits_used=summary["credits_used"],
        )

        state = job_manager.get_job(job_id)
        assert state["status"] == "completed"
        assert state["progress"] == 3
        assert state["rows_enriched"] == 3
        assert state["per_row_log"][-1]["company"] == "Gamma"
        assert state["per_row_log"][-1]["status"]["companies_house"].startswith("enriched")
    finally:
        _uninstall_stub(original)


# ---------- v1.30.2 — preview/sample row tests ---------------------------

def test_13_complete_job_records_field_fill_counts():
    job_manager._reset_for_tests()
    job_id = job_manager.create_job(3)
    job_manager.complete_job(
        job_id,
        output_url="http://x/abc",
        summary={"rows_processed": 3},
        field_fill_counts={"Status": 3, "Directors": 2, "Shareholders": 1},
        sample_rows=[],
        download_token="tok-abc",
    )
    state = job_manager.get_job(job_id)
    assert state["field_fill_counts"] == {"Status": 3, "Directors": 2, "Shareholders": 1}
    assert state["download_token"] == "tok-abc"


def test_14_complete_job_stores_sample_rows():
    job_manager._reset_for_tests()
    job_id = job_manager.create_job(3)
    rows = [
        {"Company Name": "Acme", "Status": "Active", "Directors_summary": "2 directors"},
        {"Company Name": "Beta", "Status": "Active", "Shareholders_summary": "1 PSC"},
    ]
    job_manager.complete_job(
        job_id, output_url="http://x", summary={}, sample_rows=rows,
    )
    state = job_manager.get_job(job_id)
    assert state["sample_rows"] == rows
    # Mutating the returned list must not affect the registry — caller
    # gets a copy. (Otherwise the polling endpoint would silently leak
    # the registry's internal list.)
    state["sample_rows"].append({"Company Name": "Gamma"})
    state2 = job_manager.get_job(job_id)
    assert len(state2["sample_rows"]) == 2


def test_15_status_response_includes_preview_fields_when_completed():
    from fastapi.testclient import TestClient
    from server import app

    job_manager._reset_for_tests()
    original = _install_stub()
    try:
        # 2-row CSV — small enough to complete fast in the stub harness.
        csv = "Company Name\nAcme\nBeta\n"
        client = TestClient(app)
        post = client.post("/enrichment/run", json={"csv_content": csv, "filename": "x.csv"})
        job_id = post.json()["job_id"]
        deadline = time.monotonic() + 10
        final = None
        while time.monotonic() < deadline:
            r = client.get(f"/enrichment/status/{job_id}")
            body = r.json()
            if body["status"] == "completed":
                final = body
                break
            time.sleep(0.2)
        assert final is not None
        assert "field_fill_counts" in final
        assert isinstance(final["field_fill_counts"], dict)
        assert "sample_rows" in final
        # Sample rows are bounded to 3 even if rows_processed > 3.
        assert len(final["sample_rows"]) <= 3
        # Each sample row at minimum carries the company name.
        for sr in final["sample_rows"]:
            assert "Company Name" in sr
    finally:
        _uninstall_stub(original)


def test_16_status_response_excludes_preview_fields_when_processing():
    """Mid-flight polls must not include field_fill_counts / sample_rows
    — they're computed at completion. Spec calls them out as
    completion-only fields so the UI render code can branch on presence."""
    job_manager._reset_for_tests()
    job_id = job_manager.create_job(50)
    state = job_manager.get_job(job_id)
    assert state["status"] == "processing"
    assert "field_fill_counts" not in state
    assert "sample_rows" not in state
    assert "download_token" not in state


def test_17_preview_endpoint_returns_paginated_rows():
    from fastapi.testclient import TestClient
    from server import app

    job_manager._reset_for_tests()
    original = _install_stub()
    try:
        # Build a 7-row CSV so we can exercise pagination cleanly.
        names = ["Acme", "Beta", "Gamma", "Delta", "Eps", "Zeta", "Eta"]
        csv = "Company Name\n" + "\n".join(names) + "\n"
        client = TestClient(app)
        post = client.post("/enrichment/run", json={"csv_content": csv, "filename": "x.csv"})
        job_id = post.json()["job_id"]
        # Wait for completion.
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if client.get(f"/enrichment/status/{job_id}").json()["status"] == "completed":
                break
            time.sleep(0.2)

        # Default page (offset=0, limit=50) — returns all 7.
        r = client.get(f"/enrichment/preview/{job_id}")
        assert r.status_code == 200
        body = r.json()
        assert body["total"] == 7
        assert body["offset"] == 0
        assert len(body["rows"]) == 7
        assert "Company Name" in body["header"]
        assert body["rows"][0]["Company Name"] == "Acme"

        # Custom slice.
        r = client.get(f"/enrichment/preview/{job_id}?offset=3&limit=2")
        body = r.json()
        assert body["offset"] == 3
        assert body["limit"] == 2
        assert len(body["rows"]) == 2
        assert body["rows"][0]["Company Name"] == "Delta"
        assert body["rows"][1]["Company Name"] == "Eps"
    finally:
        _uninstall_stub(original)


def test_18_preview_404_for_unknown_job():
    from fastapi.testclient import TestClient
    from server import app
    client = TestClient(app)
    r = client.get("/enrichment/preview/not-a-real-job-id")
    assert r.status_code == 404


def test_19_preview_respects_offset_limit_bounds():
    """offset past end → empty rows; limit clamped server-side via
    pydantic Query bounds (>200 should 422)."""
    from fastapi.testclient import TestClient
    from server import app

    job_manager._reset_for_tests()
    original = _install_stub()
    try:
        csv = "Company Name\nAcme\nBeta\n"
        client = TestClient(app)
        post = client.post("/enrichment/run", json={"csv_content": csv, "filename": "x.csv"})
        job_id = post.json()["job_id"]
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if client.get(f"/enrichment/status/{job_id}").json()["status"] == "completed":
                break
            time.sleep(0.2)

        # offset past end → empty rows but valid 200.
        r = client.get(f"/enrichment/preview/{job_id}?offset=999&limit=50")
        assert r.status_code == 200
        assert r.json()["rows"] == []
        assert r.json()["total"] == 2

        # limit > 200 → 422 (FastAPI Query validation).
        r = client.get(f"/enrichment/preview/{job_id}?limit=999")
        assert r.status_code == 422
    finally:
        _uninstall_stub(original)


# ---------- Standalone runner --------------------------------------------

if __name__ == "__main__":
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
                import traceback
                print(f"ERROR {name}: {exc}")
                traceback.print_exc()
                sys.exit(2)
    print(f"\n{fn_count} tests passed.")
