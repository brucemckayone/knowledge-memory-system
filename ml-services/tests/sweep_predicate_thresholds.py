"""
PC6 (nmemo-213.6) — threshold + multi-signal weight optimization sweep.

Calibrates the predicate-canonicalization operating point against the ontology
benchmark corpus. Embeds the corpus ONCE, then sweeps weight tuples x merge
thresholds purely arithmetically over the cached per-signal scores (embedding is
the only cost, and it is one-time).

Three calibration metrics, each cheap and faithful to a live behavior:
  - B7 false-merges    : # adversarial pairs scoring >= merge_t (want 0).
  - B9 NL accuracy     : NL phrase -> correct canonical via argmax (want >= 0.85;
                         depends only on WEIGHTS, threshold-independent).
  - synonym-reuse rate : fraction of known (alias -> canonical) pairs scoring
                         >= merge_t. UPPER-BOUND SENSITIVITY PROBE, not the live
                         minting rate: registered aliases hit the alias-table
                         fast-path in the live resolve path (resolve_predicate.py)
                         and reuse at score=1.0 WITHOUT being embedded or
                         threshold-gated, so this metric only governs UNregistered
                         free-text variants. It is a conservative directional
                         signal for the PC4 over-minting (higher = less minting of
                         novel phrasings); the real minting reduction is measured
                         live in PC8 (distinct-predicate count + predicateSprawl).

The B7 "must-not-merge" set is the curated ADVERSARIAL_PAIRS AUGMENTED with every
same-type-pair distinct-canonical combination (excluding registered inverses,
which the hard guard already blocks). Distinct canonicals are by definition
must-not-merge, and same-type-pair pairs are the genuinely risky band the curated
set under-probes (type_pair_overlap pins high, so cosine alone decides) — so
B7==0 over this augmented set is a far stronger safety gate than the curated 21.

The recommended operating point maximizes synonym reuse (minimizes minting)
subject to B7 == 0 and B9 >= 0.85 — i.e. reuse as aggressively as possible while
never false-merging an adversarial pair. distinct_t is placed just below merge_t
(a narrow ambiguous zone) and at/above the bulk of adversarial scores so they are
confidently distinct, not ambiguous.

Live fact-F1 / predicateSprawl on corpus10/20 are NOT swept per-config (each is a
minutes-long flaky proposer run); they are measured once at the locked point in
PC8. The synonym-reuse proxy here is the cheap stand-in that drives the choice.

Run:  python -m tests.sweep_predicate_thresholds            # requires Ollama
The recommended env values are printed; lock them by editing the defaults in
app/predicate_scoring.py (they are env-overridable for per-deploy tuning).
"""

from __future__ import annotations

import os
import sys

import numpy as np
import ollama

from app.predicate_scoring import (
    cosine_sim,
    type_pair_overlap,
    jaro_winkler,
    conceptnet_relatedness,
    combine,
)
from tests.ontology_test_data import (
    ONTOLOGY,
    PREDICATE_TYPE_PAIRS,
    ADVERSARIAL_PAIRS,
    NATURAL_LANGUAGE_PREDICATES,
    INVERSE_PAIRS,
)

_client = ollama.Client(host=os.getenv("OLLAMA_HOST", "http://localhost:11434"), timeout=120.0)
_MODEL = "nomic-embed-text"

# Candidate weight tuples (cosine, type_pair, jaro, conceptnet), each summing to 1.0.
# Includes the current default first; variants probe more/less embedding-weight and
# more/less type-pair-weight.
WEIGHT_CANDIDATES = [
    (0.50, 0.30, 0.10, 0.10),  # current default
    (0.60, 0.25, 0.10, 0.05),
    (0.60, 0.20, 0.10, 0.10),
    (0.55, 0.30, 0.10, 0.05),
    (0.45, 0.35, 0.10, 0.10),
    (0.40, 0.40, 0.10, 0.10),
    (0.50, 0.25, 0.15, 0.10),
    (0.70, 0.20, 0.05, 0.05),
]

MERGE_GRID = [round(0.78 + 0.01 * i, 2) for i in range(20)]  # 0.78 .. 0.97

# Safety margin between the chosen merge_t and the WORST must-not-merge score.
# A merge is lossy/unrecoverable (the canonical string is written into the graph),
# while over-minting is gardener-recoverable — so we deliberately leave headroom
# above the worst distinct pair rather than picking the rock-bottom B7=0 value.
SAFETY_MARGIN = 0.015


def embed_enriched(label: str, description: str) -> np.ndarray:
    body = description.lower() if description else label.replace("_", " ")
    resp = _client.embeddings(model=_MODEL, prompt=f"clustering: The relationship '{label}' describes {body}")
    return np.array(resp["embedding"], dtype=float)


def get_type_pair(pred: str) -> tuple:
    if pred in PREDICATE_TYPE_PAIRS:
        return PREDICATE_TYPE_PAIRS[pred]
    for canonical, info in ONTOLOGY.items():
        if pred in info.get("aliases", []):
            return PREDICATE_TYPE_PAIRS.get(canonical, ("unknown", "unknown"))
    return ("unknown", "unknown")


def _signals(pred_a, tp_a, emb_a, pred_b, tp_b, emb_b) -> dict:
    return {
        "cosine_sim": cosine_sim(emb_a, emb_b),
        "type_pair_overlap": type_pair_overlap(tp_a, tp_b),
        "jaro_winkler": jaro_winkler(pred_a, pred_b),
        "conceptnet": conceptnet_relatedness(pred_a, pred_b),
    }


def build_cache():
    """Embed the corpus once and precompute per-signal breakdowns for the
    evaluation sets. Returns (adversarial_sigs, synonym_sigs, nl_rows)."""
    canonicals = list(ONTOLOGY.keys())
    canon_emb = {c: embed_enriched(c, ONTOLOGY[c].get("description", "")) for c in canonicals}
    canon_tp = {c: get_type_pair(c) for c in canonicals}

    # B7 "must-not-merge" set: curated adversarial pairs ...
    adversarial_sigs = []
    for pred_a, pred_b, desc_a, desc_b, _reason in ADVERSARIAL_PAIRS:
        ea, eb = embed_enriched(pred_a, desc_a), embed_enriched(pred_b, desc_b)
        adversarial_sigs.append(_signals(pred_a, get_type_pair(pred_a), ea, pred_b, get_type_pair(pred_b), eb))

    # ... AUGMENTED with same-type-pair distinct-canonical combinations (the risky
    # band: type_pair_overlap=1.0, so cosine alone decides). Distinct canonicals are
    # must-not-merge by definition. Exclude registered inverses (the hard guard
    # already blocks them, so they are not a threshold concern).
    inverse_set = {frozenset((a, b)) for a, b in INVERSE_PAIRS}
    for i, ca in enumerate(canonicals):
        for cb in canonicals[i + 1:]:
            if canon_tp[ca] != canon_tp[cb] or canon_tp[ca] == ("unknown", "unknown"):
                continue
            if frozenset((ca, cb)) in inverse_set:
                continue
            adversarial_sigs.append(_signals(ca, canon_tp[ca], canon_emb[ca], cb, canon_tp[cb], canon_emb[cb]))

    # Synonym reuse: each (alias -> its canonical).
    synonym_sigs = []
    for c in canonicals:
        for alias in ONTOLOGY[c].get("aliases", []):
            ea = embed_enriched(alias, "")
            synonym_sigs.append(_signals(alias, get_type_pair(alias), ea, c, canon_tp[c], canon_emb[c]))

    # B9: NL phrase -> each canonical (answer-aware type pair, matching the benchmark).
    nl_rows = []
    for phrase, expected in NATURAL_LANGUAGE_PREDICATES:
        ep = embed_enriched(phrase, phrase)
        tp_phrase = get_type_pair(expected)
        per_canon = {c: _signals(phrase, tp_phrase, ep, c, canon_tp[c], canon_emb[c]) for c in canonicals}
        nl_rows.append((expected, per_canon))

    return adversarial_sigs, synonym_sigs, nl_rows


def nl_accuracy(nl_rows, weights) -> float:
    correct = 0
    for expected, per_canon in nl_rows:
        best = max(per_canon, key=lambda c: combine(per_canon[c], weights))
        if best == expected:
            correct += 1
    return correct / len(nl_rows)


def evaluate(adversarial_sigs, synonym_sigs, nl_rows):
    """Sweep weights x merge_t. Returns (rows, recommendation)."""
    rows = []
    best = None
    for w in WEIGHT_CANDIDATES:
        b9 = nl_accuracy(nl_rows, w)
        adv = [combine(s, w) for s in adversarial_sigs]
        syn = [combine(s, w) for s in synonym_sigs]
        adv_arr = np.array(adv)
        worst_adv = float(adv_arr.max())
        for merge_t in MERGE_GRID:
            false_merges = int(np.sum(adv_arr >= merge_t))
            reuse = float(np.mean([s >= merge_t for s in syn]))
            distinct_t = round(merge_t - 0.05, 3)
            safe = merge_t >= worst_adv + SAFETY_MARGIN  # B7=0 with headroom
            row = {
                "weights": w, "merge_t": merge_t, "distinct_t": distinct_t,
                "b7_false_merges": false_merges, "b9_accuracy": round(b9, 4),
                "synonym_reuse": round(reuse, 4), "worst_adv": round(worst_adv, 4),
                "safe": safe,
            }
            rows.append(row)
            # Operating point: B7=0 WITH safety headroom AND NL gate met, max reuse.
            if safe and b9 >= 0.85:
                key = (reuse, -merge_t)  # max reuse, then prefer lower merge_t
                if best is None or key > best["_key"]:
                    best = {**row, "_key": key, "b9_accuracy": round(b9, 4)}
    return rows, best


def render_table(rows, best) -> str:
    out = ["# PC6 predicate threshold/weight sweep", ""]
    out.append("Metrics: B7 false-merges (want 0), B9 NL accuracy (want >=0.85, weight-only),")
    out.append("synonym-reuse rate (minting proxy: higher = less over-minting).")
    out.append("")
    out.append("| weights (cos/type/jw/cn) | merge_t | distinct_t | B7 | B9 | reuse |")
    out.append("|---|---|---|---|---|---|")
    # Show, per weight tuple, the best safe merge_t (max reuse with B7=0 & B9>=0.85),
    # plus the current default row for reference.
    seen = set()
    for w in WEIGHT_CANDIDATES:
        cand = [r for r in rows if r["weights"] == w and r["safe"] and r["b9_accuracy"] >= 0.85]
        pick = max(cand, key=lambda r: (r["synonym_reuse"], -r["merge_t"])) if cand else None
        if pick:
            wlabel = "/".join(f"{x:.2f}" for x in w)
            out.append(f"| {wlabel} | {pick['merge_t']} | {pick['distinct_t']} | "
                       f"{pick['b7_false_merges']} | {pick['b9_accuracy']} | {pick['synonym_reuse']} |")
            seen.add(w)
    if not seen:
        out.append("| (no config met B7=0 AND B9>=0.85) | | | | | |")
    out.append("")
    if best:
        wlabel = "/".join(f"{x:.2f}" for x in best["weights"])
        out.append("## Recommended operating point")
        out.append(f"- weights (cosine/type/jaro/conceptnet): **{wlabel}**")
        out.append(f"- merge_threshold: **{best['merge_t']}**, distinct_threshold: **{best['distinct_t']}**")
        out.append(f"- B7 false-merges: {best['b7_false_merges']}  B9: {best['b9_accuracy']}  synonym-reuse: {best['synonym_reuse']}")
        out.append(f"- worst must-not-merge score: {best['worst_adv']}  headroom: {round(best['merge_t'] - best['worst_adv'], 4)} (>= {SAFETY_MARGIN} margin)")
        out.append("")
        out.append("Env to lock this point (defaults in app/predicate_scoring.py):")
        out.append("```")
        out.append(f"PREDICATE_W_COSINE={best['weights'][0]}")
        out.append(f"PREDICATE_W_TYPE_PAIR={best['weights'][1]}")
        out.append(f"PREDICATE_W_JARO={best['weights'][2]}")
        out.append(f"PREDICATE_W_CONCEPTNET={best['weights'][3]}")
        out.append(f"PREDICATE_MERGE_THRESHOLD={best['merge_t']}")
        out.append(f"PREDICATE_DISTINCT_THRESHOLD={best['distinct_t']}")
        out.append("```")
    return "\n".join(out)


def main() -> int:
    try:
        _client.embeddings(model=_MODEL, prompt="ping")
    except Exception as e:  # noqa: BLE001
        print(f"SKIP: Ollama unavailable ({e})")
        return 0
    print("Embedding benchmark corpus (one-time)...", file=sys.stderr)
    adversarial_sigs, synonym_sigs, nl_rows = build_cache()
    # Confirm the augmented must-not-merge set is non-trivial and report the safety
    # headroom: the worst (highest-scoring) must-not-merge pair at the recommended
    # weights vs the chosen merge_t. Headroom > 0 is the margin keeping B7=0.
    rec_w = (0.60, 0.25, 0.10, 0.05)
    worst_adv = max(combine(s, rec_w) for s in adversarial_sigs)
    print(f"must-not-merge pairs: {len(adversarial_sigs)} (curated {len(ADVERSARIAL_PAIRS)} + same-type distinct-canonical); "
          f"worst score @ {rec_w} = {worst_adv:.4f}", file=sys.stderr)
    rows, best = evaluate(adversarial_sigs, synonym_sigs, nl_rows)
    table = render_table(rows, best)
    print(table)
    if best is None:
        print("\nNO SAFE OPERATING POINT FOUND (B7=0 & B9>=0.85). Keeping defaults.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
