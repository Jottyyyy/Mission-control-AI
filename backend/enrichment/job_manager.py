"""In-memory job registry for async enrichment runs.

Why in-memory: a single Mission Control backend serves a single user.
Persisting across restarts isn't a v1.30.1 requirement (see TODO/spec
out-of-scope). When the user restarts, in-flight jobs disappear; a
chat reload re-renders the progress card as "expired" and the user
re-uploads. That's a fine trade-off vs. a SQLite table + reaper job.

Concurrency model: a single asyncio task per job calls update_progress
many times; the polling endpoint reads via get_job. Operations are
small dict mutations protected by a threading.Lock so a polling read
can't observe a half-written state. We avoid asyncio.Lock here because
get_job is called from sync request handlers too.
"""

from __future__ import annotations

import time
import uuid
from collections import deque
from threading import Lock
from typing import Optional


# How long a finished or stale job stays queryable before _prune drops it.
# 30 minutes is generous — covers a slow demo + a coffee break — without
# leaking memory if Mission Control runs unattended for hours.
JOB_TTL_SECONDS = 30 * 60

# Total wall-time before a still-running job is force-failed. Defends
# against a runaway enricher hanging the registry forever.
JOB_HARD_TIMEOUT_SECONDS = 30 * 60

# Rolling window of per-row durations used for ETA. Last 10 rows is
# responsive enough that ETA recovers quickly when an enricher gets
# faster (e.g. cache hit) without being so noisy it jumps every poll.
ETA_WINDOW_ROWS = 10

# How many recent per-row entries we keep in the live feed. The status
# endpoint returns these so the UI can show a scrolling "what just
# happened" tail. 10 is enough for the user to see meaningful churn,
# small enough that the JSON payload stays under a few KB.
LIVE_LOG_TAIL = 10


_lock = Lock()
_jobs: dict[str, dict] = {}


def _now() -> float:
    return time.monotonic()


def _format_eta(seconds: Optional[float]) -> Optional[int]:
    """Round to whole seconds for the wire — sub-second precision is noise
    once the user is reading "ETA ~3m 24s"."""
    if seconds is None:
        return None
    if seconds < 0:
        return 0
    return int(round(seconds))


def _compute_eta_seconds(
    durations: deque,
    rows_remaining: int,
) -> Optional[float]:
    """Rolling average of recent per-row durations × rows remaining.

    Returns None until we have at least 2 samples — a one-sample average
    is wildly off when the very first row is unusually slow or fast
    (cold cache, network warmup). 2 samples gets us a reasonable estimate
    by the third row, which matches the spec's "ETA appears within ~2-3
    rows" requirement.
    """
    if rows_remaining <= 0:
        return 0.0
    if len(durations) < 2:
        return None
    avg = sum(durations) / len(durations)
    return avg * rows_remaining


def create_job(total: int) -> str:
    """Register a new job and return its ID. The caller is responsible
    for calling complete_job or fail_job when done; otherwise the job
    will eventually be pruned by TTL."""
    if total < 0:
        total = 0
    job_id = str(uuid.uuid4())
    now = _now()
    state: dict = {
        "job_id": job_id,
        "started_at": now,
        "started_at_wall": time.time(),
        "finished_at": None,
        "status": "processing",
        "total": total,
        "progress": 0,
        "current_company": None,
        "current_enricher": None,
        "rows_enriched": 0,
        "rows_unmatched": 0,
        "rows_errored": 0,
        "per_row_log": [],
        "output_url": None,
        "download_filename": None,
        "summary": None,
        "credits_used": {},
        "error": None,
        # Internal — not exposed via get_job.
        "_durations": deque(maxlen=ETA_WINDOW_ROWS),
        "_last_row_started_at": now,
    }
    with _lock:
        _prune_locked()
        _jobs[job_id] = state
    return job_id


def update_current(
    job_id: str,
    *,
    row_index: int,
    company_name: Optional[str],
    enricher_name: Optional[str] = None,
) -> None:
    """Mark which row + enricher is currently being processed.

    Called BEFORE the row is enriched, so the UI can show "Now: Acme Ltd
    · Companies House" while the network round-trip is in flight."""
    with _lock:
        job = _jobs.get(job_id)
        if not job or job["status"] != "processing":
            return
        job["current_company"] = company_name
        job["current_enricher"] = enricher_name
        # `progress` is the number of COMPLETED rows, so it doesn't bump
        # here — only when row_done fires. We do still record the
        # row-start time so the duration sample is accurate.
        job["_last_row_started_at"] = _now()


def row_done(
    job_id: str,
    *,
    row_index: int,
    company_name: Optional[str],
    status_per_enricher: dict,
) -> None:
    """A row finished. Update counters, append to the live log, and
    refresh the ETA from the rolling-average duration window."""
    with _lock:
        job = _jobs.get(job_id)
        if not job or job["status"] != "processing":
            return

        # Per-row classification. A row counts as "enriched" if ANY
        # source filled at least one field. "errored" if any source
        # raised. "unmatched" if all sources were no-match (and nothing
        # was enriched).
        any_enriched = any(s.startswith("enriched") for s in status_per_enricher.values())
        any_error = any(s.startswith("error") for s in status_per_enricher.values())
        any_no_match = any(s == "no match" for s in status_per_enricher.values())

        if any_enriched:
            job["rows_enriched"] += 1
        elif any_error and not any_enriched:
            job["rows_errored"] += 1
        elif any_no_match:
            job["rows_unmatched"] += 1
        # else: all skipped — counts as "no change", reported neither
        # as enriched nor unmatched. The total still advances.

        job["progress"] = row_index + 1

        # Sample duration for ETA.
        now = _now()
        delta = now - job["_last_row_started_at"]
        if delta > 0:
            job["_durations"].append(delta)
        job["_last_row_started_at"] = now

        log_entry = {
            "row_index": row_index,
            "company": company_name,
            "status": dict(status_per_enricher),
        }
        log = job["per_row_log"]
        log.append(log_entry)
        # Trim to LIVE_LOG_TAIL — we keep only the most recent entries
        # for the live feed; the server's per_row_status (returned with
        # the final result) is the authoritative full log.
        if len(log) > LIVE_LOG_TAIL:
            del log[: len(log) - LIVE_LOG_TAIL]


def complete_job(
    job_id: str,
    *,
    output_url: str,
    summary: dict,
    download_filename: Optional[str] = None,
    credits_used: Optional[dict] = None,
) -> None:
    with _lock:
        job = _jobs.get(job_id)
        if not job:
            return
        job["status"] = "completed"
        job["finished_at"] = _now()
        job["output_url"] = output_url
        job["download_filename"] = download_filename
        job["summary"] = summary
        if credits_used is not None:
            job["credits_used"] = credits_used
        # Force progress to total so the UI shows 100% even if the
        # final row's row_done was racy with the complete call.
        job["progress"] = job["total"]
        job["current_company"] = None
        job["current_enricher"] = None


def fail_job(job_id: str, error: str) -> None:
    with _lock:
        job = _jobs.get(job_id)
        if not job:
            return
        job["status"] = "failed"
        job["finished_at"] = _now()
        job["error"] = error
        job["current_company"] = None
        job["current_enricher"] = None


def get_job(job_id: str) -> Optional[dict]:
    """Return a snapshot of public job state. Returns None when the
    job_id is unknown (or has been pruned)."""
    with _lock:
        _prune_locked()
        job = _jobs.get(job_id)
        if not job:
            return None
        return _public_view_locked(job)


def _public_view_locked(job: dict) -> dict:
    """Strip internal-only keys and add derived fields (elapsed, ETA).
    MUST be called while `_lock` is held — caller's responsibility."""
    now = _now()
    started = job["started_at"]
    finished = job.get("finished_at")
    elapsed_end = finished if finished is not None else now
    elapsed = max(0.0, elapsed_end - started)

    rows_remaining = max(0, job["total"] - job["progress"])
    if job["status"] == "processing":
        eta = _compute_eta_seconds(job["_durations"], rows_remaining)
    else:
        eta = 0.0

    return {
        "job_id": job["job_id"],
        "status": job["status"],
        "total": job["total"],
        "progress": job["progress"],
        "current_company": job["current_company"],
        "current_enricher": job["current_enricher"],
        "rows_enriched": job["rows_enriched"],
        "rows_unmatched": job["rows_unmatched"],
        "rows_errored": job["rows_errored"],
        "per_row_log": list(job["per_row_log"]),
        "output_url": job["output_url"],
        "download_filename": job["download_filename"],
        "summary": job["summary"],
        "credits_used": job["credits_used"],
        "error": job["error"],
        "elapsed_seconds": _format_eta(elapsed),
        "eta_seconds": _format_eta(eta),
    }


def _prune_locked() -> None:
    """Drop jobs older than JOB_TTL_SECONDS or stuck past the hard
    timeout. MUST be called while `_lock` is held."""
    now = _now()
    expired: list[str] = []
    for jid, job in _jobs.items():
        # Force-fail anything stuck past the hard timeout.
        if job["status"] == "processing" and now - job["started_at"] > JOB_HARD_TIMEOUT_SECONDS:
            job["status"] = "failed"
            job["finished_at"] = now
            job["error"] = (
                f"Job exceeded hard timeout of {JOB_HARD_TIMEOUT_SECONDS // 60} min."
            )
            job["current_company"] = None
            job["current_enricher"] = None
        # Then prune anything that finished long enough ago.
        finished = job.get("finished_at")
        if finished is not None and now - finished > JOB_TTL_SECONDS:
            expired.append(jid)
    for jid in expired:
        _jobs.pop(jid, None)


def _reset_for_tests() -> None:
    """Test helper: wipe the registry. Production code never calls this."""
    with _lock:
        _jobs.clear()
