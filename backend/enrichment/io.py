"""I/O for the enrichment pipeline.

Two surfaces:
- read_input: parse a CSV string OR fetch a Google Sheet into rows
- write_output: write enriched rows back in the SAME format (CSV →
  download URL; Sheets → in-place batchUpdate, return same URL)

Output preserves all original columns + values + row order. New
columns (added by enrichers) are appended after the originals.
"""

from __future__ import annotations

import csv
import io
import re
import time
import uuid
from pathlib import Path
from typing import Optional

from integrations import google_sheets


# Sheets URLs look like:
#   https://docs.google.com/spreadsheets/d/<ID>/edit#gid=0
#   https://docs.google.com/spreadsheets/d/<ID>
# The ID is the alphanumeric / dash / underscore segment after /d/.
_SHEETS_URL_RE = re.compile(
    r"https?://docs\.google\.com/spreadsheets/d/([A-Za-z0-9_-]+)",
)

# Cap row count to keep the chat round-trip well under a minute.
# Companies House at 0.5s/row puts 200 rows at ~100s — already too long.
# We document the cap in the response so the chat can tell Adam.
MAX_ROWS = 200

# Where we stash generated enriched-CSV files for download. Per-process
# tmp directory so multiple Mission Control instances on one machine
# don't collide. Files are stamped with a uuid + timestamp so guesses
# can't be enumerated.
_TMP_ROOT = Path("/tmp") / "mission-control-enrichment"


def _tmp_dir() -> Path:
    _TMP_ROOT.mkdir(parents=True, exist_ok=True)
    return _TMP_ROOT


def parse_sheets_url(url: str) -> Optional[str]:
    """Extract the spreadsheet ID from a Google Sheets URL. Returns None
    if the URL doesn't look like a Sheets link."""
    if not url:
        return None
    m = _SHEETS_URL_RE.search(url)
    return m.group(1) if m else None


def read_csv(csv_content: str) -> tuple[list[dict], list[str]]:
    """Parse CSV content into (rows, header_order). Empty cells become
    empty strings — never None — so downstream "is this blank" checks
    are uniform. Strips a UTF-8 BOM the OS sometimes prepends."""
    text = csv_content or ""
    if text.startswith("﻿"):
        text = text.lstrip("﻿")
    if not text.strip():
        return [], []

    reader = csv.DictReader(io.StringIO(text))
    header = list(reader.fieldnames or [])
    rows: list[dict] = []
    for raw_row in reader:
        clean = {(k or "").strip(): (v or "").strip() for k, v in raw_row.items() if k is not None}
        rows.append(clean)
    return rows, header


def read_sheet(spreadsheet_id: str) -> tuple[list[dict], list[str], dict]:
    """Read the first sheet's A:Z into rows + header. Returns
    (rows, header, meta) where meta contains the spreadsheet_id and
    range used. Raises ValueError on read failure so the endpoint can
    translate to an HTTP 4xx with a clear message."""
    res = google_sheets.read_range(spreadsheet_id, range="A1:Z1000")
    if res.get("error") and not res.get("found"):
        raise ValueError(res.get("error") or "Sheet read failed")
    values = res.get("values") or []
    if not values:
        return [], [], {"spreadsheet_id": spreadsheet_id, "range": res.get("range")}
    header = [str(h or "").strip() for h in values[0]]
    rows: list[dict] = []
    for raw_row in values[1:]:
        # Pad short rows so every key in header is present (Google
        # truncates trailing empty cells in a row).
        padded = list(raw_row) + [""] * (len(header) - len(raw_row))
        rows.append({h: str(padded[i] or "").strip() for i, h in enumerate(header) if h})
    meta = {
        "spreadsheet_id": spreadsheet_id,
        "range": res.get("range"),
        "header": header,
    }
    return rows, header, meta


def merge_headers(original: list[str], enriched_rows: list[dict]) -> list[str]:
    """Return original headers first (preserving order), then any new
    keys the enrichers added. Stable: a column added in row 1 keeps the
    same position even if row 5 also adds it."""
    seen = {h for h in original}
    out = list(original)
    for row in enriched_rows:
        for k in row.keys():
            if k not in seen:
                out.append(k)
                seen.add(k)
    return out


def write_csv(rows: list[dict], header_order: list[str]) -> tuple[str, str]:
    """Write enriched rows to /tmp and return (file_path, download_token).

    The token is the URL-safe handle the download endpoint uses to look
    the file up. Files are kept until the process exits or the tmp
    directory is reaped — we don't try to GC them here."""
    token = f"{int(time.time())}-{uuid.uuid4().hex[:12]}"
    out_path = _tmp_dir() / f"enriched-{token}.csv"
    with open(out_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=header_order, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({h: row.get(h, "") for h in header_order})
    return str(out_path), token


def resolve_download_path(token: str) -> Optional[Path]:
    """Look a download token up. Returns None when the file isn't there
    (expired or fabricated). Token is restricted to a safe character set
    by construction — we still re-validate here to refuse path traversal."""
    if not re.match(r"^[A-Za-z0-9_-]+$", token or ""):
        return None
    p = _tmp_dir() / f"enriched-{token}.csv"
    if not p.is_file():
        return None
    return p


# A1 column letter helpers — Google uses A, B, ..., Z, AA, AB, ... so
# we can't just index into the alphabet. (1-indexed.)
def _col_letter(index_1based: int) -> str:
    n = index_1based
    s = ""
    while n > 0:
        n, r = divmod(n - 1, 26)
        s = chr(65 + r) + s
    return s


def diff_for_sheet_update(
    original_rows: list[dict],
    enriched_rows: list[dict],
    header: list[str],
    sheet_name: str = "Sheet1",
) -> list[dict]:
    """Build the values.batchUpdate payload for cells that are NEW or
    CHANGED. Original cells (non-blank in input) are skipped — we only
    fill blanks. New columns enrichers added are appended to the right
    of the existing header.

    Returns a list of {"range": "Sheet1!B5", "values": [["..."]]} entries.
    """
    if not enriched_rows:
        return []

    final_header = merge_headers(header, enriched_rows)
    new_columns = [h for h in final_header if h not in header]

    updates: list[dict] = []

    # Header row: write the appended column names. Sheets is 1-indexed
    # and row 1 is the header by convention here.
    for new_col in new_columns:
        col_idx = final_header.index(new_col) + 1
        updates.append({
            "range": f"{sheet_name}!{_col_letter(col_idx)}1",
            "values": [[new_col]],
        })

    # Data rows: only emit a write for cells that were blank in the
    # original AND non-blank in the enriched copy.
    for row_idx, (original, enriched) in enumerate(zip(original_rows, enriched_rows)):
        for col_name in final_header:
            old_val = (original.get(col_name) or "").strip() if isinstance(original, dict) else ""
            new_val = (enriched.get(col_name) or "").strip() if isinstance(enriched, dict) else ""
            if not new_val:
                continue
            if old_val:  # never overwrite existing data
                continue
            col_idx = final_header.index(col_name) + 1
            sheet_row = row_idx + 2  # +1 for 1-indexing, +1 for header row
            updates.append({
                "range": f"{sheet_name}!{_col_letter(col_idx)}{sheet_row}",
                "values": [[new_val]],
            })

    return updates


def write_sheet(
    spreadsheet_id: str,
    original_rows: list[dict],
    enriched_rows: list[dict],
    header: list[str],
    sheet_name: str = "Sheet1",
) -> dict:
    """Push enriched cells back to the same spreadsheet in place.

    Only fills blanks — never overwrites. Header row gets new column
    names appended. Returns the underlying batchUpdate response so the
    caller can surface success / cell count to the chat."""
    updates = diff_for_sheet_update(original_rows, enriched_rows, header, sheet_name=sheet_name)
    if not updates:
        return {"success": True, "updated_cells": 0, "spreadsheet_id": spreadsheet_id, "error": None}
    return google_sheets.values_batch_update(spreadsheet_id, updates)
