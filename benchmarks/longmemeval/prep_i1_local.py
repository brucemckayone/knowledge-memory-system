#!/usr/bin/env python3
"""prep_i1_local.py — derive the FROZEN I1 "local" cut for doc 42 (nmemo-asf.13).

Reads LongMemEval_S and emits the single-session (I1) subset, excluding
abstention (_abs) questions, in a compact shape the tsx harness
(longmemeval-i1-baseline.ts) reads directly. Deterministic; no network.

I1 subset = single-session-{user,assistant,preference}, non-abstention (doc 42 §2).
Per-question haystack (needle-in-own-history). Gold = answer_session_ids (session
level) + has_answer turns (turn level).

Run from repo root (host python 3.12):
    python benchmarks/longmemeval/prep_i1_local.py
Output (gitignored): benchmarks/longmemeval/i1-local-cut.json
"""
import json
import os

REPO = r"C:\Users\bruce.mckay\dev\nmemo"
SRC = os.path.join(REPO, "benchmarks", "longmemeval", "data", "longmemeval_s_cleaned.json")
OUT = os.path.join(REPO, "benchmarks", "longmemeval", "i1-local-cut.json")

I1_TYPES = {"single-session-user", "single-session-assistant", "single-session-preference"}


def main() -> None:
    print(f"loading {SRC} ...", flush=True)
    with open(SRC, "r", encoding="utf-8") as f:
        data = json.load(f)
    print(f"instances: {len(data)}", flush=True)

    cut = []
    total_turns = 0
    uniq_turns = set()
    per_type: dict[str, int] = {}
    for inst in data:
        qtype = inst["question_type"]
        qid = str(inst.get("question_id", ""))
        if qtype not in I1_TYPES or qid.endswith("_abs"):
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
        # invariant: every gold session id resolves inside this question's own haystack
        hs = set(sess_ids)
        for a in inst["answer_session_ids"]:
            assert a in hs, f"{qid}: gold session {a} not in its own haystack"
        cut.append({
            "question_id": qid,
            "question_type": qtype,
            "question": inst["question"],
            "answer_session_ids": inst["answer_session_ids"],
            "haystack": haystack,
        })
        per_type[qtype] = per_type.get(qtype, 0) + 1

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(cut, f)

    print(f"\nwrote {OUT}")
    print(f"  questions: {len(cut)}")
    for k in sorted(per_type):
        print(f"    {k}: {per_type[k]}")
    print(f"  total turns: {total_turns}")
    print(f"  unique turn contents (embed units): {len(uniq_turns)}")


if __name__ == "__main__":
    main()
