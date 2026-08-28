"""
doc 40 — offline replay of the promote-time predicate fold over the real 294-document run.

WHY THIS SHAPE. The fold's decision function (`/resolve-predicate`) is deterministic and
model-free, so it can be replayed exactly without an LLM. It is NOT called over HTTP here:
the endpoint is stateless and takes the entire candidate list in the request body, so at a
vocabulary of ~2,500 predicates each call would ship ~46 MB of JSON (768 floats x N). This
script instead imports the SAME modules the endpoint imports -- `predicate_normalization`
and `predicate_scoring` -- and mirrors the endpoint's ~60 lines of orchestration plus the
TypeScript fold's loop. `--equiv-check N` verifies that mirror against the live endpoint.

Faithfulness contract (doc 40 §2), each item traceable to a source line:
  * key = (predicate, subject_type, object_type), resolved once, cached
      -> predicate-resolve.ts:135-140
  * candidates start as the 27 `is_canonical = true` rows, enriched-embedded
      -> predicate-embeddings.ts:63-70 (the backfill embeds only canonicals)
  * merge only on `decision == 'merge' and canonical`; distinct AND ambiguous both mint
      -> predicate-resolve.ts:143-155
  * minted candidates are pushed into the LIVE candidate list (mint-and-grow)
      -> predicate-resolve.ts:151
  * mint passes NO description, so its enriched text falls back to the de-underscored label
      -> predicate-resolve.ts:60-62 (doc 40 §5.7)

ZERO WRITES. Input is read from frozen NDJSON artifacts, not the DB. Nothing is written to
`fact_predicates` or `facts` (doc 40 §2, "Non-destructive").

Usage (from ml-services/, with the venv python):
  ./.venv/Scripts/python.exe tools/predicate_fold_replay.py --out ../docs/architecture/cross-corpus-audit/predicate-fold-artifacts
  ./.venv/Scripts/python.exe tools/predicate_fold_replay.py --equiv-check 30
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Optional

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.embed import ollama_client, EMBED_MODEL  # noqa: E402
from app.predicate_normalization import normalize_tense  # noqa: E402
from app.predicate_scoring import (  # noqa: E402
    multi_signal_score,
    is_inverse,
    MERGE_THRESHOLD,
    DISTINCT_THRESHOLD,
    W_COSINE,
    W_TYPE_PAIR,
    W_JARO,
    W_CONCEPTNET,
)

HERE = Path(__file__).resolve().parent
DEFAULT_ART = HERE.parents[1] / "docs/architecture/cross-corpus-audit/predicate-fold-artifacts"


def enriched_text(label: str, description: str = "") -> str:
    """Mirrors resolve_predicate.enriched_text AND predicate-embeddings.ts
    enrichedPredicateText -- query and candidate vectors must share the recipe."""
    desc = (description or "").strip()
    body = desc.lower() if desc else label.replace("_", " ")
    return f"clustering: The relationship '{label}' describes {body}"


def type_pair(subject_type: Optional[str], object_type: Optional[str]) -> tuple:
    """Mirrors resolve_predicate._type_pair."""
    return (subject_type or "unknown", object_type or "unknown")


def read_ndjson(path: Path) -> list[dict]:
    with path.open(encoding="utf-8") as fh:
        return [json.loads(line) for line in fh if line.strip()]


# --------------------------------------------------------------------------------------
# Embedding
# --------------------------------------------------------------------------------------

def embed_many(texts: list[str], cache_path: Optional[Path] = None,
               workers: int = 6) -> dict[str, np.ndarray]:
    """Embed a de-duplicated list of enriched texts through Ollama. Threaded because each
    call is a blocking HTTP round-trip; Ollama serialises internally.

    Disk-cached so the equivalence check, the four replay arms and any adversary re-run
    share one embedding pass. The cache is keyed by the exact enriched text and holds
    float64 (the dtype `multi_signal_score` sees), so a cache hit is bit-identical to a
    fresh embed -- it cannot shift a score or a decision.
    """
    uniq = list(dict.fromkeys(texts))
    out: dict[str, np.ndarray] = {}

    if cache_path and cache_path.exists():
        with np.load(cache_path, allow_pickle=False) as z:
            keys = list(z["keys"])
            vecs = z["vecs"]
        out = {k: vecs[i] for i, k in enumerate(keys)}
        print(f"  cache: {len(out)} embeddings loaded from {cache_path.name}", flush=True)

    missing = [t for t in uniq if t not in out]
    if missing:
        done = 0
        t0 = time.time()

        def one(t: str):
            return t, ollama_client.embeddings(model=EMBED_MODEL, prompt=t)["embedding"]

        with ThreadPoolExecutor(max_workers=workers) as pool:
            for t, vec in pool.map(one, missing):
                out[t] = np.asarray(vec, dtype=float)
                done += 1
                if done % 250 == 0:
                    print(f"  embedded {done}/{len(missing)} ({time.time() - t0:.0f}s)", flush=True)

        if cache_path:
            cache_path.parent.mkdir(parents=True, exist_ok=True)
            keys = list(out.keys())
            np.savez(cache_path, keys=np.array(keys, dtype=object).astype(str),
                     vecs=np.stack([out[k] for k in keys]))
            print(f"  cache: wrote {len(keys)} embeddings to {cache_path.name}", flush=True)

    return {t: out[t] for t in uniq}


# --------------------------------------------------------------------------------------
# The mirrored resolver
# --------------------------------------------------------------------------------------

class Candidate:
    __slots__ = ("predicate", "description", "emb", "subject_type", "object_type",
                 "inverse_predicate", "aliases", "minted")

    def __init__(self, predicate, description, emb, subject_type, object_type,
                 inverse_predicate, aliases, minted):
        self.predicate = predicate
        self.description = description
        self.emb = emb
        self.subject_type = subject_type
        self.object_type = object_type
        self.inverse_predicate = inverse_predicate
        self.aliases = aliases
        self.minted = minted


def resolve(
    predicate: str,
    subject_type: Optional[str],
    object_type: Optional[str],
    candidates: list[Candidate],
    canonical_set: set[str],
    alias_to_canonical: dict[str, str],
    inverse_by_canonical: dict[str, Optional[str]],
    emb_by_base: dict[str, np.ndarray],
    merge_threshold: float,
    distinct_threshold: float,
) -> dict:
    """Mirror of resolve_predicate.resolve_predicate (ml-services/app/resolve_predicate.py:94-190).
    Returns the same fields the endpoint returns, plus `route` for doc 40 §5.1 attribution."""
    base, temporal_hint = normalize_tense(predicate, alias_to_canonical, canonical_set)

    # Fast path (:116-129): exact / alias / tense match -> definitional reuse, no embedding.
    if base in canonical_set:
        return {
            "decision": "merge", "canonical": base, "base": base,
            "temporal_hint": temporal_hint, "score": 1.0,
            "signals": {"combined": 1.0, "exact_match": True},
            "route": "fast_path", "top": [],
        }

    if not candidates:
        return {"decision": "distinct", "canonical": None, "base": base,
                "temporal_hint": temporal_hint, "score": 0.0, "signals": {},
                "route": "no_candidates", "top": []}

    query_emb = emb_by_base[enriched_text(base)]
    query_tp = type_pair(subject_type, object_type)
    query_inverse = inverse_by_canonical.get(base)

    best = None
    best_pred = None
    for c in candidates:
        blocked = is_inverse(base, c.predicate, c.inverse_predicate, query_inverse)
        sig = multi_signal_score(
            base, query_tp, query_emb,
            c.predicate, type_pair(c.subject_type, c.object_type), c.emb,
        )
        combined = 0.0 if blocked else sig["combined"]
        if best is None or combined > best["combined"]:
            best = dict(sig)
            best["combined"] = combined
            best["inverse_blocked"] = blocked
            best_pred = c.predicate

    if best["combined"] >= merge_threshold:
        decision = "merge"
    elif best["combined"] < distinct_threshold:
        decision = "distinct"
    else:
        decision = "ambiguous"

    canonical = None if decision == "distinct" else best_pred
    return {
        "decision": decision, "canonical": canonical, "base": base,
        "temporal_hint": temporal_hint, "score": best["combined"],
        "signals": best,
        "route": "score_merge" if decision == "merge" else "score_" + decision,
        "top": [{"predicate": best_pred, **{k: best[k] for k in
                 ("cosine_sim", "type_pair_overlap", "jaro_winkler", "conceptnet", "combined")}}],
    }


# --------------------------------------------------------------------------------------
# The fold (mirror of canonicalizeStagedPredicates)
# --------------------------------------------------------------------------------------

def run_fold(facts: list[dict], seeds: list[dict], emb_by_base: dict[str, np.ndarray],
             merge_threshold: float, distinct_threshold: float, sample_seed: int = 40) -> dict:
    """Mirror of predicate-resolve.ts canonicalizeStagedPredicates:113-165."""
    candidates: list[Candidate] = [
        Candidate(s["predicate"], s["description"],
                  emb_by_base[enriched_text(s["predicate"], s["description"])],
                  s["subject_type"], s["object_type"], s["inverse_predicate"],
                  list(s["aliases"] or []), minted=False)
        for s in seeds
    ]
    seed_names = {c.predicate for c in candidates}

    canonical_set = {c.predicate for c in candidates}
    alias_to_canonical: dict[str, str] = {}
    inverse_by_canonical: dict[str, Optional[str]] = {}
    for c in candidates:
        for a in c.aliases:
            alias_to_canonical[a.lower()] = c.predicate
        inverse_by_canonical[c.predicate] = c.inverse_predicate

    # doc 40 §5.1 requires the split over KEYS and over FACTS. `stats` counts keys (one
    # resolution each, matching the production log line); `fact_stats` counts the facts that
    # rode each key, which is the number that actually matters for the graph.
    stats = {"reused": 0, "minted": 0, "deferred": 0}
    fact_stats = {"reused": 0, "minted": 0, "deferred": 0}
    outcome_by_key: dict[str, str] = {}
    routes: dict[str, int] = {}
    merges: list[dict] = []
    tov_positive = 0
    tov_scored = 0
    cache: dict[str, str] = {}
    resolved_per_fact: list[str] = []

    t0 = time.time()
    for i, f in enumerate(facts):
        st, ot = f["subject_type"], f["object_type"]
        key = f"{f['predicate']} {st or ''} {ot or ''}"

        if key not in cache:
            res = resolve(f["predicate"], st, ot, candidates, canonical_set,
                          alias_to_canonical, inverse_by_canonical, emb_by_base,
                          merge_threshold, distinct_threshold)
            routes[res["route"]] = routes.get(res["route"], 0) + 1
            if "type_pair_overlap" in res["signals"]:
                tov_scored += 1
                if res["signals"]["type_pair_overlap"] > 0:
                    tov_positive += 1

            if res["decision"] == "merge" and res["canonical"]:
                stats["reused"] += 1
                outcome_by_key[key] = "reused"
                cache[key] = res["canonical"]
                merges.append({
                    "raw_predicate": f["predicate"], "base": res["base"],
                    "merged_onto": res["canonical"],
                    "onto_is_seed": res["canonical"] in seed_names,
                    "route": res["route"], "score": res["score"],
                    "query_type_pair": [st, ot],
                    "signals": {k: v for k, v in res["signals"].items() if k != "inverse_blocked"},
                })
            else:
                # distinct OR ambiguous -> mint res.base and push it live (:147-152)
                base = res["base"]
                if base not in canonical_set:
                    minted = Candidate(base, "", emb_by_base[enriched_text(base)],
                                       st, ot, None, [], minted=True)
                    candidates.append(minted)
                    canonical_set.add(base)
                    inverse_by_canonical[base] = None
                stats["minted"] += 1
                outcome_by_key[key] = "minted"
                cache[key] = base

        fact_stats[outcome_by_key[key]] += 1
        resolved_per_fact.append(cache[key])
        if (i + 1) % 500 == 0:
            print(f"  folded {i + 1}/{len(facts)} facts, {len(candidates)} candidates "
                  f"({time.time() - t0:.0f}s)", flush=True)

    rng = random.Random(sample_seed)
    sample = rng.sample(merges, min(50, len(merges))) if merges else []

    return {
        "stats": stats, "fact_stats": fact_stats, "routes": routes,
        "merges": merges, "merge_sample": sample,
        "resolved_per_fact": resolved_per_fact,
        "tov_scored": tov_scored, "tov_positive": tov_positive,
        "final_candidates": len(candidates),
        "seed_names": sorted(seed_names),
        # doc 40 §7.5. There is deliberately NO try/except in this loop: offline there is no
        # HTTP call to fail, so `deferred` is structurally 0 and any genuine error (a missing
        # embedding, say) crashes loudly instead of being miscounted as `distinct`. The
        # production down-mode path is therefore NOT exercised here, and that is reported
        # rather than presented as a zero-deferral result.
        "deferred_note": "structurally 0 offline; production ml-down path not exercised",
        # doc 40 §5.7, verified structurally: every mint below passes description="".
        "mint_description_policy": "label-only (description=''), matching predicate-resolve.ts:60-62",
    }


# --------------------------------------------------------------------------------------
# Metrics
# --------------------------------------------------------------------------------------

def counts(values: list[str]) -> dict[str, int]:
    c: dict[str, int] = {}
    for v in values:
        c[v] = c.get(v, 0) + 1
    return c


def metrics(before: list[str], after: list[str]) -> dict:
    """doc 40 §4 primary + §5.3. Mapped over ALL facts, not over keys (§7.4)."""
    assert len(before) == len(after), "fact count changed -- the fold must not drop facts"
    cb, ca = counts(before), counts(after)
    n = len(after)

    def hapax(c):
        h = sum(1 for v in c.values() if v == 1)
        return {"hapax_predicates": h, "distinct": len(c),
                "hapax_rate": h / len(c) if c else 0.0,
                "facts_on_hapax_rate": h / n if n else 0.0}

    def top_k_cover(c, k):
        top = sorted(c.values(), reverse=True)[:k]
        return sum(top) / n if n else 0.0

    return {
        "facts": n,
        "before": {**hapax(cb), "top100_edge_coverage": top_k_cover(cb, 100)},
        "after": {**hapax(ca), "top100_edge_coverage": top_k_cover(ca, 100)},
        "reduction_pct": (1 - len(ca) / len(cb)) * 100 if cb else 0.0,
    }


def grade(distinct_after: int, hapax_rate: float) -> dict:
    """doc 40 §4. Bars frozen at commit 4d0ed13. Boundary straddle window = 25 (§4)."""
    if distinct_after <= 900 and hapax_rate <= 0.45:
        verdict = "PASS"
    elif distinct_after <= 1600:
        verdict = "PARTIAL"
    else:
        verdict = "FAIL"
    straddles = [b for b in (900, 1600) if abs(distinct_after - b) <= 25]
    return {
        "verdict": verdict,
        "distinct_after": distinct_after,
        "hapax_rate_after": hapax_rate,
        "pass_needs": {"distinct_after<=": 900, "hapax_rate<=": 0.45},
        "boundary_straddle": straddles,
        "note": ("reduction achieved, precision unadjudicated" if verdict == "PASS"
                 else "graded on reduction only; merge precision not measured (doc 40 §6)"),
    }


# --------------------------------------------------------------------------------------
# Equivalence check against the live endpoint
# --------------------------------------------------------------------------------------

def equiv_check(n: int, facts: list[dict], seeds: list[dict],
                emb_by_base: dict[str, np.ndarray], url: str) -> dict:
    """Verify the mirrored resolver against the live HTTP endpoint on N real keys, with
    the 27 seeds as the candidate set (small enough to ship over HTTP). Any disagreement
    invalidates the replay."""
    import urllib.request

    candidates = [
        Candidate(s["predicate"], s["description"],
                  emb_by_base[enriched_text(s["predicate"], s["description"])],
                  s["subject_type"], s["object_type"], s["inverse_predicate"],
                  list(s["aliases"] or []), minted=False)
        for s in seeds
    ]
    canonical_set = {c.predicate for c in candidates}
    alias_to_canonical = {a.lower(): c.predicate for c in candidates for a in c.aliases}
    inverse_by_canonical = {c.predicate: c.inverse_predicate for c in candidates}

    keys = list(dict.fromkeys(
        (f["predicate"], f["subject_type"], f["object_type"]) for f in facts))
    rng = random.Random(40)
    picked = rng.sample(keys, min(n, len(keys)))

    wire_candidates = [{
        "predicate": c.predicate, "description": c.description,
        "embedding": c.emb.tolist(), "subject_type": c.subject_type,
        "object_type": c.object_type, "inverse_predicate": c.inverse_predicate,
        "aliases": c.aliases,
    } for c in candidates]

    mismatches = []
    for pred, st, ot in picked:
        mine = resolve(pred, st, ot, candidates, canonical_set, alias_to_canonical,
                       inverse_by_canonical, emb_by_base, MERGE_THRESHOLD, DISTINCT_THRESHOLD)
        body = json.dumps({
            "predicate": pred,
            **({"subject_type": st} if st is not None else {}),
            **({"object_type": ot} if ot is not None else {}),
            "candidates": wire_candidates,
        }).encode()
        req = urllib.request.Request(f"{url}/resolve-predicate", data=body,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=120) as r:
            live = json.loads(r.read())
        same = (mine["decision"] == live["decision"]
                and mine["canonical"] == live["canonical"]
                and mine["base"] == live["base"]
                and abs(mine["score"] - live["score"]) < 1e-6)
        if not same:
            mismatches.append({"key": [pred, st, ot], "mirror": {
                k: mine[k] for k in ("decision", "canonical", "base", "score")},
                "live": {k: live[k] for k in ("decision", "canonical", "base", "score")}})

    return {"checked": len(picked), "mismatches": mismatches,
            "equivalent": len(mismatches) == 0}


# --------------------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(DEFAULT_ART))
    ap.add_argument("--equiv-check", type=int, default=0)
    ap.add_argument("--url", default=os.environ.get("ML_SERVICES_URL", "http://localhost:8000"))
    ap.add_argument("--shuffle-seed", type=int, default=40)
    ap.add_argument("--embed-cache", default="")
    args = ap.parse_args()

    art = Path(args.out)
    facts = read_ndjson(art / "input-facts.ndjson")
    seeds = read_ndjson(art / "input-seeds.ndjson")
    print(f"input: {len(facts)} facts, {len(seeds)} seeds", flush=True)

    # Every enriched text the replay can possibly need: each seed's (label+description),
    # and each distinct normalized predicate's label-only text (mint + query share it).
    normalized = sorted({f["predicate"].lower().strip().replace(" ", "_") for f in facts})
    texts = [enriched_text(s["predicate"], s["description"]) for s in seeds] + \
            [enriched_text(b) for b in normalized]
    print(f"embedding {len(set(texts))} distinct enriched texts...", flush=True)
    cache = Path(args.embed_cache) if args.embed_cache else None
    emb = embed_many(texts, cache_path=cache)

    before = [f["predicate"] for f in facts]
    config = {
        "weights": {"cosine": W_COSINE, "type_pair": W_TYPE_PAIR,
                    "jaro": W_JARO, "conceptnet": W_CONCEPTNET},
        "merge_threshold": MERGE_THRESHOLD, "distinct_threshold": DISTINCT_THRESHOLD,
        "embed_model": EMBED_MODEL,
    }
    print(f"config: {json.dumps(config)}", flush=True)

    if args.equiv_check:
        print(f"equivalence check vs {args.url} on {args.equiv_check} keys...", flush=True)
        eq = equiv_check(args.equiv_check, facts, seeds, emb, args.url)
        (art / "equivalence-check.json").write_text(json.dumps(eq, indent=2), encoding="utf-8")
        print(f"  equivalent={eq['equivalent']} checked={eq['checked']} "
              f"mismatches={len(eq['mismatches'])}", flush=True)
        if not eq["equivalent"]:
            print("MIRROR DISAGREES WITH THE LIVE ENDPOINT -- replay invalid", flush=True)
            return 1
        return 0

    out: dict = {"config": config, "input": {
        "facts": len(facts), "seeds": len(seeds),
        "distinct_predicates_before": len(set(before)),
        "distinct_keys": len({(f["predicate"], f["subject_type"], f["object_type"])
                              for f in facts})}}

    # --- primary arm: frozen order, default thresholds (doc 40 §4) ---
    print("arm: primary (frozen order, default thresholds)", flush=True)
    r = run_fold(facts, seeds, emb, MERGE_THRESHOLD, DISTINCT_THRESHOLD)
    m = metrics(before, r["resolved_per_fact"])
    seed_merges = sum(1 for x in r["merges"] if x["onto_is_seed"])
    out["primary"] = {
        "metrics": m,
        "grade": grade(m["after"]["distinct"], m["after"]["hapax_rate"]),
        "stats_by_key": r["stats"], "stats_by_fact": r["fact_stats"],
        "routes": r["routes"],
        "deferred_note": r["deferred_note"],
        "mint_description_policy": r["mint_description_policy"],
        "final_candidate_count": r["final_candidates"],
        "seed_reuse_vs_mint_and_grow": {
            "merges_total": len(r["merges"]),
            "onto_seed": seed_merges,
            "onto_minted": len(r["merges"]) - seed_merges,
            "onto_seed_by_route": counts([x["route"] for x in r["merges"] if x["onto_is_seed"]]),
            "onto_minted_by_route": counts([x["route"] for x in r["merges"] if not x["onto_is_seed"]]),
        },
        "type_pair_overlap_utility": {
            "scored_resolutions": r["tov_scored"], "with_tov_gt_0": r["tov_positive"],
            "share": (r["tov_positive"] / r["tov_scored"]) if r["tov_scored"] else None,
        },
    }
    (art / "merge-sample.json").write_text(
        json.dumps({"sample_seed": 40, "n": len(r["merge_sample"]),
                    "merges_total": len(r["merges"]), "sample": r["merge_sample"]}, indent=2),
        encoding="utf-8")
    (art / "all-merges.json").write_text(json.dumps(r["merges"], indent=2), encoding="utf-8")
    (art / "resolved-map.json").write_text(
        json.dumps(dict(zip([f["id"] for f in facts], r["resolved_per_fact"]))), encoding="utf-8")

    # --- §5.4 order sensitivity ---
    print(f"arm: shuffled order (seed={args.shuffle_seed})", flush=True)
    shuffled = list(facts)
    random.Random(args.shuffle_seed).shuffle(shuffled)
    rs = run_fold(shuffled, seeds, emb, MERGE_THRESHOLD, DISTINCT_THRESHOLD)
    ms = metrics([f["predicate"] for f in shuffled], rs["resolved_per_fact"])
    out["order_sensitivity"] = {
        "shuffle_seed": args.shuffle_seed, "algorithm": "random.Random(seed).shuffle",
        "distinct_after": ms["after"]["distinct"], "hapax_rate_after": ms["after"]["hapax_rate"],
        "stats_by_key": rs["stats"], "stats_by_fact": rs["fact_stats"], "routes": rs["routes"],
        "delta_vs_primary": ms["after"]["distinct"] - m["after"]["distinct"],
    }

    # --- §5.5 threshold sensitivity ---
    out["threshold_sensitivity"] = []
    for delta in (-0.05, +0.05):
        mt = round(MERGE_THRESHOLD + delta, 4)
        print(f"arm: merge_threshold={mt}", flush=True)
        rt = run_fold(facts, seeds, emb, mt, DISTINCT_THRESHOLD)
        mtm = metrics(before, rt["resolved_per_fact"])
        out["threshold_sensitivity"].append({
            "merge_threshold": mt, "distinct_after": mtm["after"]["distinct"],
            "hapax_rate_after": mtm["after"]["hapax_rate"], "stats_by_key": rt["stats"], "stats_by_fact": rt["fact_stats"],
            "routes": rt["routes"],
            "graded": False,
        })

    (art / "replay-results.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
    print(json.dumps({"grade": out["primary"]["grade"],
                      "stats_by_key": out["primary"]["stats_by_key"], "stats_by_fact": out["primary"]["stats_by_fact"],
                      "routes": out["primary"]["routes"],
                      "seed_split": out["primary"]["seed_reuse_vs_mint_and_grow"],
                      "tov": out["primary"]["type_pair_overlap_utility"],
                      "order": out["order_sensitivity"],
                      "thresholds": out["threshold_sensitivity"]}, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
