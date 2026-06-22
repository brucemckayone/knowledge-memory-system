"""
/resolve-predicate — deterministic, model-free predicate canonicalization
(truth-graph doc 42 §4/§6, PC3).

Resolves a raw predicate to one of the candidate canonicals, to "mint new", or
to "ambiguous", with NO LLM on the hot path. The pipeline:
  lemmatize -> tense-normalize -> enriched-embed (query) -> mean-center over the
  candidate snapshot -> multi-signal score each candidate -> inverse-predicate
  hard guard -> two-threshold decision.

STATELESS by design: the caller (the platform's promote-time fold, PC4) loads the
candidate canonicals from fact_predicates (with their stored enriched embeddings
from PC2) and passes them in. ml-services only embeds the QUERY and scores —
no DB coupling, matching the embed/compare-predicates endpoints. The candidate
embeddings must have been produced by the SAME enriched recipe (label +
description) used here, so the cosine comparison is meaningful.
"""

from __future__ import annotations

import logging
from typing import List, Optional

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .core.concurrency import ollama_pool, QueueFullError
from .embed import ollama_client, EMBED_MODEL
from .predicate_normalization import normalize_tense
from .predicate_scoring import (
    multi_signal_score,
    is_inverse,
    MERGE_THRESHOLD,
    DISTINCT_THRESHOLD,
)

logger = logging.getLogger("ml-services.resolve_predicate")

router = APIRouter()


def enriched_text(label: str, description: str = "") -> str:
    """The enriched embedding text — MUST match predicate-embeddings.ts
    enrichedPredicateText so query and candidate vectors are comparable."""
    desc = (description or "").strip()
    body = desc.lower() if desc else label.replace("_", " ")
    return f"clustering: The relationship '{label}' describes {body}"


class CandidatePredicate(BaseModel):
    predicate: str
    description: str = ""
    embedding: List[float]
    subject_type: Optional[str] = None
    object_type: Optional[str] = None
    inverse_predicate: Optional[str] = None
    aliases: List[str] = []


class ResolveRequest(BaseModel):
    predicate: str
    subject_type: Optional[str] = None
    object_type: Optional[str] = None
    candidates: List[CandidatePredicate]
    merge_threshold: float = MERGE_THRESHOLD
    distinct_threshold: float = DISTINCT_THRESHOLD


class ScoredCandidate(BaseModel):
    predicate: str
    combined: float
    cosine_sim: float
    type_pair_overlap: float
    jaro_winkler: float
    conceptnet: float
    inverse_blocked: bool = False


class ResolveResponse(BaseModel):
    decision: str  # "merge" | "distinct" | "ambiguous"
    canonical: Optional[str]  # the matched canonical when merge/ambiguous; None when minting
    base: str
    temporal_hint: Optional[str]
    score: float
    signals: dict
    top: List[ScoredCandidate]


def _type_pair(subject_type: Optional[str], object_type: Optional[str]) -> tuple:
    return (subject_type or "unknown", object_type or "unknown")


@router.post("/resolve-predicate", response_model=ResolveResponse)
async def resolve_predicate(request: ResolveRequest):
    """Resolve a raw predicate to canonical / mint / ambiguous (see module doc)."""
    try:
        canonical_set = {c.predicate for c in request.candidates}
        alias_to_canonical: dict[str, str] = {}
        for c in request.candidates:
            for a in c.aliases:
                alias_to_canonical[a.lower()] = c.predicate
        inverse_by_canonical = {c.predicate: c.inverse_predicate for c in request.candidates}

        # Layer 1: tense-normalize (folds worked_at -> works_at and emits the
        # temporal hint). We deliberately do NOT verb-lemmatize the scored string:
        # the inverse registry and the ConceptNet map key on SURFACE forms
        # (employs, supervises), and the enriched embedding already absorbs
        # inflection — the validated benchmark (b18/b19) scores surface forms
        # directly. Lemmatizing here would defeat the inverse guard (employs ->
        # employ no longer matches the registry) and miss ConceptNet entries.
        # lemmatize_predicate stays ported + unit-tested in predicate_normalization
        # as an NL-preprocessing primitive (doc 42 §4/§6).
        base, temporal_hint = normalize_tense(request.predicate, alias_to_canonical, canonical_set)

        # Fast path: the raw predicate resolved straight to a canonical (exact or
        # via the alias/tense table) — reuse it without embedding.
        if base in canonical_set:
            return ResolveResponse(
                decision="merge",
                canonical=base,
                base=base,
                temporal_hint=temporal_hint,
                score=1.0,
                # Definitional reuse (exact or alias/tense match) — not a computed
                # multi-signal score, so report it as such rather than synthesizing
                # per-signal 1.0s that no real scoring would produce.
                signals={"combined": 1.0, "exact_match": True},
                top=[],
            )

        scorable = [c for c in request.candidates if c.embedding]
        if not scorable:
            # Nothing to compare against → genuinely novel.
            return ResolveResponse(
                decision="distinct", canonical=None, base=base, temporal_hint=temporal_hint,
                score=0.0, signals={}, top=[],
            )

        # Embed the query enriched (candidate vectors came in pre-embedded by the
        # same recipe). Score on UNCENTERED enriched cosine — that is the path the
        # benchmark validated (b18/b19) and that the two thresholds were calibrated
        # against (B3); mean-centering is only used in B1's separation analysis,
        # not the merge decision (doc 42 §5).
        query_vec = await ollama_pool.submit(
            ollama_client.embeddings, model=EMBED_MODEL, prompt=enriched_text(base),
        )
        query_emb = np.array(query_vec["embedding"], dtype=float)

        query_tp = _type_pair(request.subject_type, request.object_type)
        query_inverse = inverse_by_canonical.get(base)  # set only if base is itself canonical

        scored: List[ScoredCandidate] = []
        for c in scorable:
            cand_emb = np.array(c.embedding, dtype=float)
            blocked = is_inverse(base, c.predicate, c.inverse_predicate, query_inverse)
            sig = multi_signal_score(
                base, query_tp, query_emb,
                c.predicate, _type_pair(c.subject_type, c.object_type), cand_emb,
            )
            scored.append(ScoredCandidate(
                predicate=c.predicate,
                combined=0.0 if blocked else sig["combined"],
                cosine_sim=sig["cosine_sim"],
                type_pair_overlap=sig["type_pair_overlap"],
                jaro_winkler=sig["jaro_winkler"],
                conceptnet=sig["conceptnet"],
                inverse_blocked=blocked,
            ))

        scored.sort(key=lambda s: s.combined, reverse=True)
        best = scored[0]
        # decide() with request-provided thresholds (PC6 tuning hook).
        if best.combined >= request.merge_threshold:
            decision = "merge"
        elif best.combined < request.distinct_threshold:
            decision = "distinct"
        else:
            decision = "ambiguous"

        canonical = None if decision == "distinct" else best.predicate
        signals = {
            "cosine_sim": best.cosine_sim,
            "type_pair_overlap": best.type_pair_overlap,
            "jaro_winkler": best.jaro_winkler,
            "conceptnet": best.conceptnet,
            "combined": best.combined,
        }
        logger.info(f"resolve-predicate '{request.predicate}' -> base '{base}' -> {decision} ({canonical}, {best.combined:.3f})")
        return ResolveResponse(
            decision=decision, canonical=canonical, base=base, temporal_hint=temporal_hint,
            score=best.combined, signals=signals, top=scored[:5],
        )

    except QueueFullError:
        raise HTTPException(status_code=503, detail="Service busy, retry later")
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        logger.error(f"resolve-predicate failed: {e}")
        raise HTTPException(status_code=502, detail=f"resolve-predicate failed: {e}")
