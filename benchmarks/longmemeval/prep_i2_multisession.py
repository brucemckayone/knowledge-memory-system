#!/usr/bin/env python3
"""prep_i2_multisession.py — derive the FROZEN I2 "multi-hop" cut for doc 43 (nmemo-asf.14).

Reads LongMemEval_S and emits the multi-session (I2) subset, excluding abstention
(_abs), in the same compact shape the I1 harness reads. Deterministic; no network.

I2 subset = question_type == "multi-session", non-abstention (doc 43 §2). All such
questions have >=2 evidence sessions (answer_session_ids) — the multi-evidence bar.

Run from repo root (host python 3.12):
    python benchmarks/longmemeval/prep_i2_multisession.py
Output (gitignored): benchmarks/longmemeval/i2-multi-cut.json
"""
import json
import os
from collections import Counter

REPO = r"C:\Users\bruce.mckay\dev\nmemo"
SRC = os.path.join(REPO, "benchmarks", "longmemeval", "data", "longmemeval_s_cleaned.json")
OUT = os.path.join(REPO, "benchmarks", "longmemeval", "i2-multi-cut.json")


def main() -> None:
    print(f"loading {SRC} ...", flush=True)
    with open(SRC, "r", encoding="utf-8") as f:
        data = json.load(f)
    print(f"instances: {len(data)}", flush=True)

    cut = []
    total_turns = 0
    uniq_turns = set()
    ev_counts = Counter()
    for inst in data:
        qid = str(inst.get("question_id", ""))
        if inst["question_type"] != "multi-session" or qid.endswith("_abs"):
            continue
        sess_ids = inst["haystack_session_ids"]
        sessions = inst["haystack_sessions"]
        assert len(sess_ids) == len(sessions), f"{qid}: session id/list length mismatch"
        haystack = []
        for sid, turns in zip(sess_ids, sessions):
            tlist = []
            for t in turns:
                content = t.get("content", "")
                tlist.append({"content": content, "has_answer": bool(t.get("has_answer", False))})
                total_turns += 1
                uniq_turns.add(content)
            haystack.append({"session_id": sid, "turns": tlist})
        hs = set(sess_ids)
        for a in inst["answer_session_ids"]:
            assert a in hs, f"{qid}: gold session {a} not in its own haystack"
        assert len(inst["answer_session_ids"]) >= 2, f"{qid}: multi-session with <2 gold"
        ev_counts[len(inst["answer_session_ids"])] += 1
        cut.append({
            "question_id": qid,
            "question_type": inst["question_type"],
            "question": inst["question"],
            "answer_session_ids": inst["answer_session_ids"],
            "haystack": haystack,
        })

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(cut, f)

    print(f"\nwrote {OUT}")
    print(f"  questions: {len(cut)}")
    print(f"  evidence-session-count distribution: {dict(sorted(ev_counts.items()))}")
    print(f"  total gold sessions: {sum(k * v for k, v in ev_counts.items())}  mean {sum(k*v for k,v in ev_counts.items())/max(1,len(cut)):.2f}")
    print(f"  total turns: {total_turns}")
    print(f"  unique turn contents: {len(uniq_turns)}")


if __name__ == "__main__":
    main()
