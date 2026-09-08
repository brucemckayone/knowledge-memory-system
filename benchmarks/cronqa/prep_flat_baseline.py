#!/usr/bin/env python
"""
prep_flat_baseline.py — nmemo-asf.7 (doc 40). Read CronQuestions test.pickle + label
maps and emit the ENTITY-ANSWER question cut as JSON for the TS flat-vector baseline
harness (cronqa-flat-baseline.ts). Read-only over the dataset; deterministic.

Emits, in FILE ORDER (the TS side does the frozen mulberry32 seeded sample), one record
per answer_type=='entity' question:
  { uniq_id, bucket, nl, fallback, answer_qids: [...], answer_names: [...] }

NL is reconstructed by substituting annotation values into `template` (QID slots ->
entity label; {time} -> the year). Falls back to paraphrases[0] if a slot is unresolved
(fallback=true). Run from repo root:
  python benchmarks/cronqa/prep_flat_baseline.py
"""
import json
import os
import pickle
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
KG = os.path.join(HERE, "upstream", "data", "wikidata_big", "kg")
Q = os.path.join(HERE, "upstream", "data", "wikidata_big", "questions", "test.pickle")
OUT = os.path.join(HERE, "flat-baseline-entity-questions.json")

SLOT_RE = re.compile(r"\{(\w+)\}")


def load_labels(path):
    m = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            parts = line.rstrip("\n").split("\t")
            if len(parts) >= 2:
                m[parts[0]] = parts[1]
    return m


def main():
    ent_label = load_labels(os.path.join(KG, "wd_id2entity_text.txt"))
    print(f"entity labels: {len(ent_label)}", file=sys.stderr)
    with open(Q, "rb") as f:
        data = pickle.load(f)
    ent = [q for q in data if q.get("answer_type") == "entity"]
    print(f"entity-answer questions: {len(ent)}", file=sys.stderr)

    def label_of(qid):
        return ent_label.get(qid, qid)

    out = []
    dropped = 0
    for q in ent:
        template = q.get("template") or ""
        ann = q.get("annotation") or {}
        slots = SLOT_RE.findall(template)
        nl = template
        fallback = False
        for s in slots:
            val = ann.get(s)
            if val is None:
                fallback = True
                break
            # A time slot is a year string/int; everything else is a QID -> label.
            rep = str(val) if s == "time" else label_of(str(val))
            nl = nl.replace("{" + s + "}", rep, 1)
        if fallback or "{" in nl:
            paras = q.get("paraphrases") or []
            if paras:
                nl = paras[0]
                fallback = True
            else:
                dropped += 1
                continue
        answers = sorted(a for a in (q.get("answers") or set()) if isinstance(a, str) and a.startswith("Q"))
        if not answers:
            dropped += 1
            continue
        out.append({
            "uniq_id": q.get("uniq_id"),
            "bucket": q.get("type"),
            "nl": nl.strip(),
            "fallback": fallback,
            "answer_qids": answers,
            "answer_names": [label_of(a) for a in answers],
        })

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False)
    print(f"wrote {len(out)} questions -> {OUT} (dropped {dropped})", file=sys.stderr)


if __name__ == "__main__":
    main()
