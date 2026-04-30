"""Live integration test for v1.30.1 — async enrichment with progress polling.

Exercises the real Companies House API + the in-memory job registry.
Posts both a 15-row and a 199-row CSV through the real /enrichment/run
endpoint, then polls /enrichment/status/{job_id} every second, mirroring
what the EnrichmentProgressCard does in the UI.

Run:
  /opt/homebrew/bin/python3.12 backend/_run_live_progress.py
"""

from __future__ import annotations

import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi.testclient import TestClient  # noqa: E402

from server import app  # noqa: E402


REPO = Path(__file__).resolve().parent.parent


def _run_one(client: TestClient, csv_path: Path, *, snapshot_after_secs: float = 5.0) -> dict:
    text = csv_path.read_text(encoding="utf-8")
    rows = len(text.splitlines()) - 1
    print()
    print("=" * 64)
    print(f"FILE:  {csv_path.name} ({rows} rows)")
    print("=" * 64)

    t0 = time.monotonic()
    post = client.post("/enrichment/run", json={"csv_content": text, "filename": csv_path.name})
    post_elapsed = time.monotonic() - t0
    if post.status_code != 200:
        print(f"!! POST failed: HTTP {post.status_code} — {post.text[:300]}")
        return {}
    body = post.json()
    job_id = body["job_id"]
    print(f"-> POST /enrichment/run → HTTP 200 in {post_elapsed*1000:.0f}ms")
    print(f"   job_id: {job_id}")
    print(f"   marker: {body['progress_marker']}")
    print(f"   total:  {body['total']}")
    print()

    # Poll every second; print a snapshot at ~5s for the "mid-flight"
    # screenshot equivalent, then keep going until done.
    last_print = time.monotonic()
    snapshot_taken = False
    snapshot_state = None
    final = None
    while True:
        st = client.get(f"/enrichment/status/{job_id}").json()
        elapsed = st.get("elapsed_seconds", 0)
        progress = st.get("progress", 0)
        total = st.get("total", 0)
        eta = st.get("eta_seconds")
        eta_s = "estimating…" if eta is None else f"~{eta}s"
        bar_filled = int((progress / total) * 30) if total else 0
        bar = "█" * bar_filled + "░" * (30 - bar_filled)
        line = (
            f"  [{bar}] {progress:>4}/{total} ({100*progress/total:5.1f}%) "
            f"elapsed={elapsed}s eta={eta_s}  now={st.get('current_company') or '—'}"
        )
        # Overwrite-in-place when the same line, full print every 10s for the log.
        now = time.monotonic()
        if now - last_print >= 1.0 or st["status"] != "processing":
            print(line)
            last_print = now

        if (
            not snapshot_taken
            and st["status"] == "processing"
            and (now - t0) >= snapshot_after_secs
        ):
            snapshot_state = dict(st)
            snapshot_taken = True

        if st["status"] in ("completed", "failed"):
            final = st
            break
        time.sleep(1.0)

    print()
    print("--- FINAL STATE ---")
    print(f"  status:        {final['status']}")
    print(f"  progress:      {final['progress']} / {final['total']}")
    print(f"  enriched:      {final['rows_enriched']}")
    print(f"  unmatched:     {final['rows_unmatched']}")
    print(f"  errored:       {final['rows_errored']}")
    print(f"  elapsed:       {final['elapsed_seconds']}s")
    print(f"  output_url:    {final['output_url']}")
    print(f"  download_name: {final.get('download_filename')}")
    if final.get("credits_used"):
        print(f"  credits:       {final['credits_used']}")
    if snapshot_state:
        print()
        print(f"--- MID-FLIGHT SNAPSHOT (~{snapshot_after_secs}s in) ---")
        print(f"  progress:    {snapshot_state['progress']} / {snapshot_state['total']}")
        print(f"  current:     {snapshot_state['current_company']} · {snapshot_state['current_enricher']}")
        print(f"  enriched:    {snapshot_state['rows_enriched']}")
        print(f"  unmatched:   {snapshot_state['rows_unmatched']}")
        print(f"  errored:     {snapshot_state['rows_errored']}")
        print(f"  elapsed:     {snapshot_state['elapsed_seconds']}s")
        print(f"  eta:         {snapshot_state['eta_seconds']}s")
        # Per-row log tail — what a user would see scrolling in the UI.
        tail = snapshot_state.get("per_row_log") or []
        if tail:
            print(f"  recent rows ({len(tail)} in tail):")
            for entry in tail[-5:]:
                print(f"    row {entry['row_index']}: {entry['company']} → {entry['status']}")

    # Verify the download endpoint also serves the file.
    if final.get("output_url"):
        token = final["output_url"].rsplit("/", 1)[-1]
        dl = client.get(f"/enrichment/download/{token}")
        print()
        print(f"-> GET /enrichment/download/{token} → HTTP {dl.status_code} ({len(dl.content)} bytes)")

    return final


def main() -> int:
    client = TestClient(app)
    print()
    print("v1.30.1 live progress test — using the real Companies House API.")
    print()
    _run_one(client, REPO / "demo-leads-15.csv", snapshot_after_secs=3.0)
    _run_one(client, REPO / "demo-leads-199.csv", snapshot_after_secs=10.0)
    return 0


if __name__ == "__main__":
    sys.exit(main())
