"""prereg-26 (nmemo-u8j.4) STAGE 2 — cross-encoder scoring of the fusion pool.

Reads rerank-pool-<substrate>.json (from rerank-dump.ts), scores every (query_text, candidate_text)
pair with an open cross-encoder (BAAI/bge-reranker-v2-m3), writes rerank-scores-<substrate>.json =
{ "meta": {...}, "scores": { "<pairIdx>": { "<entityId>": score, ... } } }.

Local CPU, no external API, no Claude. Run with the isolated rerank venv's python:
  <venv>/Scripts/python.exe rerank_score.py --substrate=arxiv --model=BAAI/bge-reranker-v2-m3
"""
import argparse
import json
import os
import time

ART = r"C:\Users\bruce.mckay\dev\nmemo\docs\architecture\single-graph\prereg-artifacts"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--substrate", default="arxiv")
    ap.add_argument("--model", default="BAAI/bge-reranker-v2-m3")
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--max_length", type=int, default=512)
    args = ap.parse_args()

    pool_path = os.path.join(ART, f"rerank-pool-{args.substrate}.json")
    with open(pool_path, "r", encoding="utf-8") as f:
        data = json.load(f)
    pairs = data["pairs"]

    from sentence_transformers import CrossEncoder
    t_load = time.time()
    model = CrossEncoder(args.model, max_length=args.max_length)
    load_s = time.time() - t_load
    print(f"loaded {args.model} in {load_s:.1f}s")

    # Flatten all (query, candidate) pairs, remember (pairIdx, entityId) provenance.
    flat = []
    prov = []
    for p in pairs:
        q = p["queryText"]
        for cand in p["pool"]:
            flat.append((q, cand["text"]))
            prov.append((str(p["pairIdx"]), cand["entityId"]))
    print(f"scoring {len(flat)} (query,candidate) pairs over {len(pairs)} queries ...")

    t0 = time.time()
    raw = model.predict(flat, batch_size=args.batch, show_progress_bar=True)
    elapsed = time.time() - t0
    scores = {}
    for (pi, eid), s in zip(prov, raw):
        scores.setdefault(pi, {})[eid] = float(s)

    out = {
        "meta": {
            "substrate": args.substrate,
            "model": args.model,
            "max_length": args.max_length,
            "n_pairs": len(pairs),
            "n_scored": len(flat),
            "score_seconds": round(elapsed, 1),
            "ms_per_query": round(1000.0 * elapsed / max(1, len(pairs)), 1),
        },
        "scores": scores,
    }
    out_path = os.path.join(ART, f"rerank-scores-{args.substrate}.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(out, f)
    print(f"scored in {elapsed:.1f}s ({out['meta']['ms_per_query']} ms/query); wrote {out_path}")


if __name__ == "__main__":
    main()
