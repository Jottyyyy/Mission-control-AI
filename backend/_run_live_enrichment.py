"""Manual live test for the v1.30 enrichment pipeline.

Posts demo-leads-15.csv through the /enrichment/run endpoint via the
FastAPI TestClient (so we don't need to spawn the gateway). Hits the
real Companies House API. Prints a summary + the path to the enriched
CSV that the download endpoint would serve.

Run:
  /opt/homebrew/bin/python3.12 backend/_run_live_enrichment.py
"""

from __future__ import annotations

import csv
import io
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fastapi.testclient import TestClient  # noqa: E402

from server import app  # noqa: E402
from enrichment import io as eio  # noqa: E402


CSV_PATH = Path(__file__).resolve().parent.parent / "demo-leads-15.csv"


def main() -> int:
    if not CSV_PATH.exists():
        print(f"!! demo CSV not found at {CSV_PATH}")
        return 2

    text = CSV_PATH.read_text(encoding="utf-8")

    client = TestClient(app)
    print(f"-> POST /enrichment/run with {CSV_PATH.name} ({len(text.splitlines()) - 1} rows)")
    resp = client.post(
        "/enrichment/run",
        json={"csv_content": text, "filename": CSV_PATH.name},
    )
    print(f"<- HTTP {resp.status_code}")
    if resp.status_code != 200:
        print(resp.text[:1000])
        return 1

    body = resp.json()
    print()
    print("STATUS:        ", body.get("status"))
    print("INPUT TYPE:    ", body.get("input_type"))
    print("ROWS PROCESSED:", body.get("rows_processed"))
    print("ROWS ENRICHED: ", body.get("rows_enriched"))
    print("ROWS UNMATCHED:", body.get("rows_unmatched"))
    print("CREDITS USED:  ", body.get("credits_used"))
    print("OUTPUT URL:    ", body.get("output_url"))
    print()
    print("--- per-row status ---")
    for entry in body.get("per_row_status") or []:
        print(f"  row {entry['row_index']}: {entry['status']}")

    # Pull the file off the download endpoint to verify the round-trip.
    token = body["output_url"].rsplit("/", 1)[-1]
    dl = client.get(f"/enrichment/download/{token}")
    print()
    print(f"-> GET  /enrichment/download/{token}")
    print(f"<- HTTP {dl.status_code}, {len(dl.content)} bytes")
    if dl.status_code != 200:
        print(dl.text[:500])
        return 1

    saved_to = Path("/tmp") / f"enriched-roundtrip-{token}.csv"
    saved_to.write_bytes(dl.content)
    print(f"   saved to: {saved_to}")

    # Print a tidy preview.
    rows = list(csv.DictReader(io.StringIO(dl.content.decode("utf-8"))))
    if rows:
        cols = list(rows[0].keys())
        print()
        print(f"--- columns ({len(cols)}) ---")
        print("  " + ", ".join(cols))
        print()
        print(f"--- first 3 rows ---")
        for r in rows[:3]:
            for k, v in r.items():
                if v:
                    print(f"  {k}: {v}")
            print("  ---")

    print()
    print("DONE.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
