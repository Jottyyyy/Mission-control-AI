"""Pre-deploy smoke test for v1.30.3.

Exercises the full enrichment chain through the real Companies House
API and asserts every piece of the chat surface backend the UI relies
on. UI checks (no Pomanda modal, progress-card render, success-card
sections) still need a human-at-keyboard pass — but everything below
the UI is verified automatically here.

Gate: if this script reports any FAIL, the build does not deploy today.

Run:
  /opt/homebrew/bin/python3.12 backend/_smoke_v1_30_3.py
"""

from __future__ import annotations

import csv
import io
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi.testclient import TestClient  # noqa: E402

from server import app  # noqa: E402


REPO = Path(__file__).resolve().parent.parent
CSV_PATH = REPO / "demo-leads-15.csv"


def _fail(msg: str) -> None:
    print(f"  ✗ FAIL — {msg}")
    raise SystemExit(1)


def _pass(msg: str) -> None:
    print(f"  ✓ {msg}")


def main() -> int:
    print("=" * 72)
    print("v1.30.3 pre-deploy smoke")
    print("=" * 72)

    if not CSV_PATH.exists():
        _fail(f"demo-leads-15.csv not found at {CSV_PATH}")

    csv_text = CSV_PATH.read_text(encoding="utf-8")
    expected_rows = len(csv_text.splitlines()) - 1
    print(f"Input: {CSV_PATH.name} ({expected_rows} rows)")

    client = TestClient(app)

    # ----- 1. POST /enrichment/run returns job_id immediately ------------
    print()
    print("[1/7] POST /enrichment/run returns job_id")
    t0 = time.monotonic()
    post = client.post(
        "/enrichment/run",
        json={"csv_content": csv_text, "filename": CSV_PATH.name},
    )
    elapsed_ms = (time.monotonic() - t0) * 1000
    if post.status_code != 200:
        _fail(f"POST returned HTTP {post.status_code}: {post.text[:300]}")
    body = post.json()
    if body.get("status") != "processing":
        _fail(f"expected status=processing, got {body.get('status')}")
    if not body.get("job_id"):
        _fail("response missing job_id")
    if not body.get("progress_marker", "").startswith("[[enrichment-progress:"):
        _fail("response missing progress_marker")
    job_id = body["job_id"]
    _pass(f"job_id={job_id} (POST returned in {elapsed_ms:.0f}ms)")

    # ----- 2. Poll /enrichment/status until completed --------------------
    print()
    print("[2/7] Poll /enrichment/status until completed")
    deadline = time.monotonic() + 90  # 15 rows × ~3.5s + slack
    final = None
    while time.monotonic() < deadline:
        r = client.get(f"/enrichment/status/{job_id}")
        if r.status_code != 200:
            _fail(f"status returned HTTP {r.status_code}: {r.text[:200]}")
        body = r.json()
        if body["status"] == "completed":
            final = body
            break
        if body["status"] == "failed":
            _fail(f"job failed: {body.get('error')}")
        time.sleep(2)
    if final is None:
        _fail(f"job did not complete within 90s (last progress {body.get('progress')}/{body.get('total')})")
    _pass(f"completed in {final['elapsed_seconds']}s — {final['rows_enriched']}/{final['total']} enriched")

    # ----- 3. Status payload has v1.30.2 preview fields ------------------
    print()
    print("[3/7] Status payload has v1.30.2 preview fields")
    if "field_fill_counts" not in final:
        _fail("missing field_fill_counts in completed status")
    if "sample_rows" not in final:
        _fail("missing sample_rows in completed status")
    if not isinstance(final["field_fill_counts"], dict) or not final["field_fill_counts"]:
        _fail(f"field_fill_counts empty/invalid: {final['field_fill_counts']!r}")
    if not isinstance(final["sample_rows"], list) or not final["sample_rows"]:
        _fail(f"sample_rows empty/invalid: {final['sample_rows']!r}")
    if len(final["sample_rows"]) > 3:
        _fail(f"sample_rows should be ≤3, got {len(final['sample_rows'])}")
    _pass(f"field_fill_counts: {len(final['field_fill_counts'])} fields, "
          f"sample_rows: {len(final['sample_rows'])} rows")

    # ----- 4. /enrichment/preview returns paginated rows -----------------
    print()
    print("[4/7] /enrichment/preview returns full enriched CSV")
    r = client.get(f"/enrichment/preview/{job_id}?offset=0&limit=200")
    if r.status_code != 200:
        _fail(f"preview returned HTTP {r.status_code}: {r.text[:200]}")
    pv = r.json()
    if pv["total"] != expected_rows:
        _fail(f"preview total={pv['total']}, expected {expected_rows}")
    if len(pv["rows"]) != expected_rows:
        _fail(f"preview returned {len(pv['rows'])} rows, expected {expected_rows}")
    _pass(f"preview returned {pv['total']} rows, header: {len(pv['header'])} columns")

    # ----- 5. v1.30.3 — Companies House URL column position --------------
    print()
    print("[5/7] v1.30.3 — 'Companies House URL' pinned right after 'Company Number'")
    header = pv["header"]
    if "Company Number" not in header:
        _fail(f"header missing 'Company Number': {header}")
    if "Companies House URL" not in header:
        _fail(f"header missing 'Companies House URL': {header}")
    num_idx = header.index("Company Number")
    url_idx = header.index("Companies House URL")
    if url_idx != num_idx + 1:
        _fail(f"URL not adjacent to Number: header positions {num_idx} → {url_idx}")
    _pass(f"header positions: Company Number={num_idx}, Companies House URL={url_idx}")

    # ----- 6. Download CSV and verify column position end-to-end ---------
    print()
    print("[6/7] GET /enrichment/download/<token> — column order in downloaded CSV")
    output_url = final.get("output_url", "")
    if not output_url:
        _fail("no output_url on completed job")
    token = output_url.rsplit("/", 1)[-1]
    dl = client.get(f"/enrichment/download/{token}")
    if dl.status_code != 200:
        _fail(f"download returned HTTP {dl.status_code}")
    text = dl.content.decode("utf-8")
    reader = csv.reader(io.StringIO(text))
    csv_header = next(reader)
    if csv_header != header:
        # Soft warn — preview rebuilds via merge_headers, downloaded CSV
        # comes from write_csv. They should match but it's worth noting.
        print(f"  ! note: preview header differs from CSV header")
        print(f"    preview: {header}")
        print(f"    csv:     {csv_header}")
    if "Companies House URL" not in csv_header:
        _fail(f"downloaded CSV missing URL column: {csv_header}")
    csv_url_idx = csv_header.index("Companies House URL")
    csv_num_idx = csv_header.index("Company Number")
    if csv_url_idx != csv_num_idx + 1:
        _fail(f"downloaded CSV URL not adjacent to Number: {csv_num_idx} → {csv_url_idx}")
    _pass(f"downloaded CSV ({len(dl.content)} bytes) has URL at col {csv_url_idx} after Number at col {csv_num_idx}")

    # ----- 7. HEAD-check one CH URL — proves real-world clickability -----
    print()
    print("[7/7] One sampled URL HEAD-checks 200 against Companies House")
    rows = list(csv.DictReader(io.StringIO(text)))
    sampled_url = None
    sampled_company = None
    for r in rows:
        u = (r.get("Companies House URL") or "").strip()
        if u.startswith("https://find-and-update.company-information.service.gov.uk/company/"):
            sampled_url = u
            sampled_company = r.get("Company Name")
            break
    if not sampled_url:
        _fail("no enriched row had a Companies House URL to sample")
    print(f"  sampling: {sampled_company} → {sampled_url}")
    try:
        # Use GET (not HEAD) — CH's site sometimes returns 405 on HEAD
        # for the public record pages.
        req = urllib.request.Request(sampled_url, method="GET", headers={"User-Agent": "MissionControl-Smoke/1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            url_status = resp.status
    except Exception as exc:  # noqa: BLE001
        _fail(f"could not fetch sampled URL: {exc}")
    if url_status != 200:
        _fail(f"sampled URL returned HTTP {url_status}")
    _pass(f"sampled URL returned HTTP 200")

    print()
    print("=" * 72)
    print("ALL 7 BACKEND CHECKS PASS — UI smoke test still required")
    print("=" * 72)
    print()
    print(f"Sample URL to click for visual verification:")
    print(f"  {sampled_url}")
    print()
    print(f"Output download URL (browser-clickable):")
    print(f"  {output_url}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
