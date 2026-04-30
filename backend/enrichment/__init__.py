"""Pluggable lead-enrichment pipeline.

Today: one enricher (Companies House). Tomorrow: Cognism, Lusha, Pomanda
slot in alongside it without redesign. The pipeline runs enrichers in
priority order, fills only MISSING cells, and never overwrites an
existing value.

Public surface:
    from enrichment import ENRICHERS, EnrichmentPipeline
    pipeline = EnrichmentPipeline(ENRICHERS)
    enriched_row, status = pipeline.enrich_row(row)
"""

from .base import Enricher
from .companies_house_enricher import CompaniesHouseEnricher, companies_house_enricher
from .pipeline import EnrichmentPipeline


# Order matters: cheapest / most-authoritative first. A later enricher
# can never overwrite a value the earlier one filled (pipeline enforces
# missing-only writes).
ENRICHERS: list[Enricher] = [
    companies_house_enricher,
    # Future: cognism_enricher, lusha_enricher, pomanda_enricher
]


__all__ = [
    "ENRICHERS",
    "Enricher",
    "EnrichmentPipeline",
    "CompaniesHouseEnricher",
    "companies_house_enricher",
]
