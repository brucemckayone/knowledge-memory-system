#!/usr/bin/env python
"""
prep_temporal_experiment.py — nmemo-asf.8 (doc 41). Emit the simple_entity oracle cut
for the I3 temporal experiment. Reads gold slots from `annotation` + `relations` ONLY
(never NL, never paraphrases). Deterministic. Run from repo root:
  python benchmarks/cronqa/prep_temporal_experiment.py

Emits benchmarks/cronqa/temporal-experiment-simple-entity.json — one record per
simple_entity test question:
  { uniq_id, direction (forward|reverse), anchor_qid, pid, year, answer_qids: [...] }
"""
import json
import os
import pickle
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
Q = os.path.join(HERE, "upstream", "data", "wikidata_big", "questions", "test.pickle")
OUT = os.path.join(HERE, "temporal-experiment-simple-entity.json")


def main():
    with open(Q, "rb") as f:
        data = pickle.load(f)
    se = [q for q in data if q.get("type") == "simple_entity"]
    print(f"simple_entity questions: {len(se)}", file=sys.stderr)

    out = []
    skipped = 0
    for q in se:
        ann = q.get("annotation") or {}
        rels = [r for r in (q.get("relations") or set()) if isinstance(r, str) and r.startswith("P")]
        year = ann.get("time")
        if len(rels) != 1 or year is None:
            skipped += 1
            continue
        if "head" in ann:
            direction, anchor = "forward", ann["head"]
        elif "tail" in ann:
            direction, anchor = "reverse", ann["tail"]
        else:
            skipped += 1
            continue
        answers = sorted(a for a in (q.get("answers") or set()) if isinstance(a, str) and a.startswith("Q"))
        if not answers or not (isinstance(anchor, str) and anchor.startswith("Q")):
            skipped += 1
            continue
        out.append({
            "uniq_id": q.get("uniq_id"),
            "direction": direction,
            "anchor_qid": anchor,
            "pid": rels[0],
            "year": int(year),
            "answer_qids": answers,
        })

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f)
    fwd = sum(1 for r in out if r["direction"] == "forward")
    print(f"wrote {len(out)} (forward={fwd}, reverse={len(out)-fwd}, skipped={skipped}) -> {OUT}", file=sys.stderr)


if __name__ == "__main__":
    main()
