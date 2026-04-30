"""Enrichment pipeline orchestration.

Runs each enricher in priority order against a row, fills only MISSING
cells, and never overwrites an existing value. First enricher to fill
a field wins — so order in `ENRICHERS` matters (cheapest / most
authoritative first).
"""

from __future__ import annotations

import asyncio
from typing import Optional

from .base import Enricher
from .companies_house_enricher import (
    _FIELD_ALIASES,
    _COMPANY_NAME_ALIASES,
    _NUMBER_INPUT_ALIASES,
    _match_column,
    _value_for,
)
from . import job_manager


# Companies House: 600 requests / 5 minutes per key. Each lookup costs
# 3 requests (profile + officers + PSCs). 0.5s between rows keeps a
# 50-row batch comfortably inside the bucket. Override per-test with
# the ctor's `inter_row_sleep_seconds` arg.
_DEFAULT_INTER_ROW_SLEEP = 0.5


def _is_blank(value) -> bool:
    if value is None:
        return True
    return str(value).strip() == ""


def _resolve_aliases(canonical: str, enricher: Enricher) -> tuple[str, ...]:
    """Get the alias list for a canonical field name.

    Falls back to (canonical,) for fields the enricher's mapping module
    doesn't know about (e.g. a future enricher with bespoke columns)."""
    return _FIELD_ALIASES.get(canonical, (canonical,))


def _row_has_required(row: dict, enricher: Enricher) -> bool:
    """Skip-check: does the row carry the input the enricher needs?

    `requires_any` (a list of alias-tuples) wins when present — at least
    one alias from EACH tuple needs a non-blank value. That model is
    "either company name OR company number" rather than the strict AND
    that `requires_fields` would imply.
    """
    requires_any = getattr(enricher, "requires_any", None)
    if requires_any:
        for alias_group in requires_any:
            if _value_for(row, alias_group):
                return True
        return False

    for field in enricher.requires_fields:
        aliases = _resolve_aliases(field, enricher)
        if not _value_for(row, aliases):
            return False
    return True


def _all_outputs_filled(row: dict, enricher: Enricher) -> bool:
    """Skip-check: are all the fields this enricher CAN fill already populated?

    If yes, calling enrich() would just waste a network round-trip."""
    for field in enricher.enriches_fields:
        aliases = _resolve_aliases(field, enricher)
        if not _value_for(row, aliases):
            return False
    return True


class EnrichmentPipeline:
    def __init__(
        self,
        enrichers: list[Enricher],
        *,
        inter_row_sleep_seconds: float = _DEFAULT_INTER_ROW_SLEEP,
    ) -> None:
        self.enrichers = enrichers
        self.inter_row_sleep_seconds = inter_row_sleep_seconds

    async def enrich_row(self, row: dict) -> tuple[dict, dict]:
        """Run each enricher against the row in order. Returns
        (enriched_row, status_per_enricher).

        - `enriched_row` is a copy of the input with newly-filled cells
          merged in. Original cells are NEVER overwritten.
        - `status_per_enricher` maps name → status string for the chat
          summary. Possible values:
              "enriched <n> fields"
              "skipped (no missing fields)"
              "skipped (missing required input)"
              "no match"
              "error: <message>"
        """
        enriched = dict(row)
        status: dict[str, str] = {}

        for enricher in self.enrichers:
            if _all_outputs_filled(enriched, enricher):
                status[enricher.name] = "skipped (no missing fields)"
                continue

            if not _row_has_required(enriched, enricher):
                status[enricher.name] = "skipped (missing required input)"
                continue

            try:
                # `enrich` is sync today (Companies House client is sync).
                # When async enrichers land we'll detect-and-await here.
                result = enricher.enrich(enriched, missing_only=True)
            except Exception as exc:  # noqa: BLE001
                status[enricher.name] = f"error: {str(exc)[:100]}"
                continue

            if not result:
                status[enricher.name] = "no match"
                continue

            filled = 0
            for canonical, value in result.items():
                if _is_blank(value):
                    continue
                aliases = _resolve_aliases(canonical, enricher)
                existing_key = _match_column(enriched, aliases)
                if existing_key:
                    if not _is_blank(enriched.get(existing_key)):
                        # Honour the missing-only contract — first wins.
                        continue
                    enriched[existing_key] = value
                    filled += 1
                else:
                    # Add a new column under the canonical name.
                    enriched[canonical] = value
                    filled += 1

            if filled == 0:
                status[enricher.name] = "no new fields filled"
            else:
                status[enricher.name] = f"enriched {filled} fields"

        return enriched, status

    async def enrich_batch(
        self,
        rows: list[dict],
        *,
        job_id: Optional[str] = None,
    ) -> list[tuple[dict, dict]]:
        """Process N rows sequentially, sleeping between rows so we stay
        well inside the per-source rate budget. Sequential (not parallel)
        is intentional: the worst-case batch is still <30s, and the
        Companies House client itself already does its own internal
        parallelism. Adding a second layer of concurrency would risk a
        429 burst with no clear win.

        When `job_id` is provided, every row reports its progress to
        the in-memory job registry so the polling endpoint can surface
        live state to the chat UI. The first enricher is named as the
        "current_enricher" — for v1.30.1 we have a single enricher per
        row, so this is a faithful pre-row hint."""
        results: list[tuple[dict, dict]] = []
        first_enricher_name = self.enrichers[0].name if self.enrichers else None

        for i, row in enumerate(rows):
            if job_id:
                # Surface a friendly company label BEFORE the network
                # round-trip starts — without this, the UI would only
                # update after each row completes, leaving "Now: …"
                # stale during the slow part of the loop.
                company = (
                    _value_for(row, _COMPANY_NAME_ALIASES)
                    or _value_for(row, _NUMBER_INPUT_ALIASES)
                    or "(no name)"
                )
                job_manager.update_current(
                    job_id,
                    row_index=i,
                    company_name=company,
                    enricher_name=first_enricher_name,
                )

            result = await self.enrich_row(row)
            results.append(result)

            if job_id:
                _enriched_row, status_per_enricher = result
                company = (
                    _value_for(row, _COMPANY_NAME_ALIASES)
                    or _value_for(row, _NUMBER_INPUT_ALIASES)
                    or "(no name)"
                )
                job_manager.row_done(
                    job_id,
                    row_index=i,
                    company_name=company,
                    status_per_enricher=status_per_enricher,
                )

            # Sleep BETWEEN rows, not before the first or after the last.
            if i < len(rows) - 1 and self.inter_row_sleep_seconds > 0:
                await asyncio.sleep(self.inter_row_sleep_seconds)
        return results

    def summarise(
        self,
        results: list[tuple[dict, dict]],
    ) -> dict:
        """Aggregate per-row results into a chat-friendly summary."""
        rows_enriched = 0
        rows_unmatched = 0
        per_row_status: list[dict] = []

        for original_idx, (enriched, status) in enumerate(results):
            any_filled = any(s.startswith("enriched") for s in status.values())
            if any_filled:
                rows_enriched += 1
            else:
                # "Unmatched" = no enricher filled anything.  Skipped-because-
                # everything-already-full does NOT count as unmatched.
                if any(s == "no match" for s in status.values()):
                    rows_unmatched += 1
            per_row_status.append({
                "row_index": original_idx,
                "status": status,
            })

        return {
            "rows_processed": len(results),
            "rows_enriched": rows_enriched,
            "rows_unmatched": rows_unmatched,
            "per_row_status": per_row_status,
            "credits_used": {"companies_house": 0},  # Companies House is free
        }
