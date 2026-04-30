"""Enricher protocol — what every data source plugs into the pipeline as.

An Enricher takes a single row (column-name -> value dict) and returns
the subset of fields it can fill. The pipeline is responsible for
write-back rules (missing-only, first-wins) so individual enrichers
stay simple: "given this input, here's what I know."
"""

from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class Enricher(Protocol):
    """One source of enrichment data (Companies House, Cognism, Lusha, ...).

    Attributes
    ----------
    name:
        Stable machine-readable identifier ("companies_house"). Used in
        per-enricher status reports and rate-limit accounting.
    enriches_fields:
        Canonical column names this source can populate. Used by the
        pipeline to decide whether to skip ("all my fields are already
        full"). Names match the canonical headers — `_match_column` on
        the enricher resolves these against whatever case / spacing the
        input row actually uses.
    requires_fields:
        Canonical column names this source needs as INPUT to do anything.
        If none of these are present in the row, the enricher is skipped
        with status "missing required input". At least one variant of
        each name should be present in the row for the call to proceed.
    """

    name: str
    enriches_fields: list[str]
    requires_fields: list[str]

    def enrich(self, row: dict, missing_only: bool = True) -> dict:
        """Return {field_name: value} for fields this source can fill.

        The pipeline always passes `missing_only=True` and post-filters
        out any keys whose cell is already populated. Enrichers MAY
        respect the flag themselves to short-circuit network calls when
        nothing is needed, but they never need to enforce it.
        """
        ...
