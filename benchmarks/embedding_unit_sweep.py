"""yxj.1 - Micro-benchmark: retrieval recall vs embedding unit size + overlap.

Standalone measurement, NO platform change. Embeds candidate text units at
varying char size + overlap via the ML /embed service, indexes them in a
THROWAWAY Qdrant collection (never the shared `memories` collection), and
measures recall@k of an answer-bearing "needle" unit against its question.
The scratch collection is deleted on exit.

Reproduces the whole-window baseline (a single big chunk - the degree session
scored ~0.47 cosine for its question in the prior Frankenstein probe) and
sweeps small-unit settings to find where the needle lands in the 0.7+ band and
ranks top-k. Also runs a one-off no-prefix vs nomic-prefix
(search_query:/search_document:) side comparison: /embed sends RAW text to
nomic with no task prefix (ml-services/app/embed.py:58,95), so the prefix
variant prepends the prefixes client-side.

A "needle" is one LongMemEval_S question whose answer is buried in a long
session. Needles are selected by a deterministic per-type algorithm (q[0],
the "Business Administration" degree question, is always included) so the
result is not tuned to one answer shape. Distractors are the FULL units of the
source sessions (plus optional extra haystack sessions) - recall is measured
against real corpus noise, not needles-in-isolation.

Usage from /benchmarks/ root:
  uv run python -m embedding_unit_sweep                 # default sweep
  uv run python -m embedding_unit_sweep --smoke         # fast pipeline check
  uv run python -m embedding_unit_sweep --needles 8 --corpus-char-budget 200000
  uv run python -m embedding_unit_sweep --keep-collection   # leave scratch for debug
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

import httpx
import yaml

# Allow `python -m embedding_unit_sweep` and direct invocation.
if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from longmemeval.dataset import Question, Session, load_dataset  # noqa: E402

BENCH_DIR = Path(__file__).resolve().parent
LME_DIR = BENCH_DIR / "longmemeval"
LME_CONFIG = LME_DIR / "config.yaml"
RESULTS_DIR = BENCH_DIR / "results"

# Defaults per the bead DESIGN sweep.
DEFAULT_UNIT_SIZES = [128, 256, 512, 1024]
DEFAULT_OVERLAPS = [0, 64, 128, 256]
DEFAULT_KS = [1, 3, 5]

# Selection order across question_type so the needle set spans answer shapes
# (attribute, temporal, preference, knowledge-update, assistant-sourced,
# multi-session). q[0] is single-session-user and is force-included first.
TYPE_ORDER = [
    "single-session-user",
    "temporal-reasoning",
    "single-session-preference",
    "knowledge-update",
    "single-session-assistant",
    "multi-session",
]

# A unit counts as a "needle" for a question if its char window overlaps the
# answer anchor by at least this many chars (or fully contains a shorter
# literal anchor). Keeps a small unit that merely touches a long answer turn
# from being scored as a hit when the answer text is elsewhere in the turn.
NEEDLE_MIN_OVERLAP = 32


# --------------------------------------------------------------------------
# Text / corpus helpers
# --------------------------------------------------------------------------

def build_session_doc(turns: list) -> tuple[str, list[tuple[int, int, bool]]]:
    """Concatenate a session's turns into one document, recording the char
    span [start, end) of each turn's *content* and whether it answers.

    Built identically wherever a session appears (needle source or distractor)
    so anchor offsets stay valid.
    """
    parts: list[str] = []
    spans: list[tuple[int, int, bool]] = []
    cursor = 0
    sep = "\n\n"
    for t in turns:
        role = getattr(t, "role", "") or ""
        content = getattr(t, "content", "") or ""
        prefix = f"{role}: "
        start = cursor + len(prefix)
        end = start + len(content)
        parts.append(prefix + content)
        spans.append((start, end, bool(getattr(t, "has_answer", False))))
        cursor = end + len(sep)
    return sep.join(parts), spans


@dataclass
class Needle:
    qid: str
    qtype: str
    question: str
    answer: str
    source_session_id: str
    anchor_start: int
    anchor_end: int
    anchor_mode: str  # "literal" | "turn"


def _answer_session(q: Question) -> Session | None:
    """First answer session that carries a has_answer turn."""
    answer_ids = set(q.answer_session_ids)
    for sess in q.sessions:
        if sess.session_id in answer_ids and any(t.has_answer for t in sess.turns):
            return sess
    return None


def make_needle(q: Question) -> Needle | None:
    """Build a needle from a question, or None if it has no locatable answer."""
    sess = _answer_session(q)
    if sess is None:
        return None
    doc, spans = build_session_doc(sess.turns)
    answer_turns = [(s, e) for (s, e, ha) in spans if ha]
    if not answer_turns:
        return None

    # Distinctive literal answer (>=4 chars) -> tighten the anchor to the exact
    # phrase span via a whitespace-tolerant search across ALL answer turns (the
    # literal may live in a later flagged turn, and the turn's internal spacing
    # may differ from q.answer). Otherwise anchor on the first answer turn.
    t_start, t_end = answer_turns[0]
    anchor_start, anchor_end, mode = t_start, t_end, "turn"
    tokens = str(q.answer).strip().split()
    if len("".join(tokens)) >= 4 and tokens:
        pat = re.compile(r"\s+".join(re.escape(tok) for tok in tokens), re.IGNORECASE)
        for s, e in answer_turns:
            m = pat.search(doc[s:e])
            if m is not None:
                anchor_start, anchor_end, mode = s + m.start(), s + m.end(), "literal"
                break
    return Needle(
        qid=q.question_id,
        qtype=q.question_type,
        question=q.question,
        answer=str(q.answer),
        source_session_id=sess.session_id,
        anchor_start=anchor_start,
        anchor_end=anchor_end,
        anchor_mode=mode,
    )


def select_needles(questions: list[Question], target: int) -> list[Needle]:
    """Deterministic type-spread selection. q[0] forced first, then round-robin
    over TYPE_ORDER picking the first dataset-order question per type that
    yields a valid needle, until `target` needles are collected."""
    by_type: dict[str, list[Question]] = {t: [] for t in TYPE_ORDER}
    for q in questions:
        if q.is_abstention:
            continue
        by_type.setdefault(q.question_type, []).append(q)

    chosen: list[Needle] = []
    used_qids: set[str] = set()
    used_sessions: set[str] = set()

    def try_add(q: Question) -> bool:
        if q.question_id in used_qids:
            return False
        n = make_needle(q)
        if n is None or n.source_session_id in used_sessions:
            return False
        chosen.append(n)
        used_qids.add(q.question_id)
        used_sessions.add(n.source_session_id)
        return True

    # Force q[0].
    if questions:
        try_add(questions[0])

    # Round-robin across types. Known types first (TYPE_ORDER), then any
    # dataset types not in the fixed order, so a renamed/added category can't
    # silently starve the needle set.
    order = TYPE_ORDER + [t for t in by_type if t not in TYPE_ORDER]
    cursors = {t: 0 for t in by_type}
    while len(chosen) < target:
        progressed = False
        for t in order:
            if len(chosen) >= target:
                break
            bucket = by_type.get(t, [])
            while cursors[t] < len(bucket):
                q = bucket[cursors[t]]
                cursors[t] += 1
                if try_add(q):
                    progressed = True
                    break
        if not progressed:
            break  # exhausted all types
    return chosen


def build_corpus(
    needles: list[Needle],
    questions: list[Question],
    char_budget: int,
    distractors_per_needle: int,
) -> dict[str, str]:
    """Answer sessions (full) + capped extra haystack sessions as distractors,
    bounded by char_budget. Needle source sessions are always included."""
    q_by_id = {q.question_id: q for q in questions}
    docs: dict[str, str] = {}

    # 1. All needle source sessions (mandatory).
    for n in needles:
        if n.source_session_id in docs:
            continue
        q = q_by_id[n.qid]
        sess = next(s for s in q.sessions if s.session_id == n.source_session_id)
        docs[n.source_session_id], _ = build_session_doc(sess.turns)

    used_chars = sum(len(v) for v in docs.values())

    # 2. Distractor sessions from each needle's haystack, round-robin, capped.
    if distractors_per_needle > 0:
        added_per_needle = {n.qid: 0 for n in needles}
        more = True
        while more and used_chars < char_budget:
            more = False
            for n in needles:
                if added_per_needle[n.qid] >= distractors_per_needle:
                    continue
                q = q_by_id[n.qid]
                for sess in q.sessions:
                    if sess.session_id in docs:
                        continue
                    text, _ = build_session_doc(sess.turns)
                    if used_chars + len(text) > char_budget:
                        continue
                    docs[sess.session_id] = text
                    used_chars += len(text)
                    added_per_needle[n.qid] += 1
                    more = True
                    break
    return docs


# --------------------------------------------------------------------------
# Unit splitting
# --------------------------------------------------------------------------

@dataclass
class Unit:
    idx: int
    session_id: str
    text: str
    start: int
    end: int


def split_units(docs: dict[str, str], size: int, overlap: int) -> list[Unit]:
    """Sliding char windows of `size` with `overlap`. overlap must be < size."""
    if overlap >= size:
        raise ValueError(f"overlap {overlap} must be < size {size}")
    step = size - overlap
    units: list[Unit] = []
    idx = 0
    for sid, text in docs.items():
        if not text:
            continue
        pos = 0
        n = len(text)
        while pos < n:
            chunk = text[pos:pos + size]
            units.append(Unit(idx=idx, session_id=sid, text=chunk, start=pos, end=pos + len(chunk)))
            idx += 1
            if pos + size >= n:
                break
            pos += step
    return units


def baseline_units(docs: dict[str, str], chunk_chars: int) -> list[Unit]:
    """The whole-window baseline: platform-style large chunks (no overlap).

    Not one-unit-per-session - nomic-embed-text caps at ~2048 tokens, so a full
    ~17K-char session 500s the embed step. The platform splits sessions at
    `max_ingest_chars` (~6000 chars / 5895-char window, which scored ~0.47 in
    the prior Frankenstein probe), so the realistic baseline chunks at the same
    ceiling.
    """
    return split_units(docs, chunk_chars, 0)


def needle_units_for(units: list[Unit], n: Needle) -> list[int]:
    """Indices of units that satisfy the needle (right session + anchor overlap)."""
    a0, a1 = n.anchor_start, n.anchor_end
    anchor_len = max(1, a1 - a0)
    need = min(anchor_len, NEEDLE_MIN_OVERLAP) if n.anchor_mode == "turn" else anchor_len
    hits = []
    for u in units:
        if u.session_id != n.source_session_id:
            continue
        inter = max(0, min(u.end, a1) - max(u.start, a0))
        if inter >= need:
            hits.append(u.idx)
    return hits


# --------------------------------------------------------------------------
# Embedding + Qdrant (REST, no extra deps)
# --------------------------------------------------------------------------

def cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


class Embedder:
    def __init__(self, ml_url: str, model: str, batch_size: int, timeout: float) -> None:
        self._http = httpx.Client(base_url=ml_url.rstrip("/"), timeout=timeout)
        self.model = model
        self.batch_size = batch_size

    def embed(self, texts: list[str], prefix: str | None = None) -> list[list[float]]:
        payload_texts = [(prefix + t) if prefix else t for t in texts]
        out: list[list[float]] = []
        for i in range(0, len(payload_texts), self.batch_size):
            batch = payload_texts[i:i + self.batch_size]
            r = self._http.post("/embed/batch", json={"texts": batch, "model": self.model})
            r.raise_for_status()
            out.extend(r.json()["embeddings"])
        if len(out) != len(payload_texts):
            raise RuntimeError(
                f"/embed/batch returned {len(out)} vectors for {len(payload_texts)} texts"
            )
        return out

    def close(self) -> None:
        self._http.close()


class Qdrant:
    def __init__(self, url: str, timeout: float) -> None:
        self._http = httpx.Client(base_url=url.rstrip("/"), timeout=timeout)

    def version(self) -> str:
        try:
            return self._http.get("/").json().get("version", "?")
        except Exception:
            return "?"

    def recreate(self, name: str, dim: int) -> None:
        self._http.delete(f"/collections/{name}")  # 404 if absent - ignore
        r = self._http.put(
            f"/collections/{name}",
            json={"vectors": {"size": dim, "distance": "Cosine"}},
        )
        r.raise_for_status()

    def upsert(self, name: str, units: list[Unit], vectors: list[list[float]]) -> None:
        chunk = 256
        for i in range(0, len(units), chunk):
            pts = [
                {
                    "id": u.idx,
                    "vector": vectors[u.idx],
                    "payload": {"session_id": u.session_id, "start": u.start, "end": u.end},
                }
                for u in units[i:i + chunk]
            ]
            r = self._http.put(f"/collections/{name}/points?wait=true", json={"points": pts})
            r.raise_for_status()

    def search(self, name: str, vector: list[float], limit: int) -> list[tuple[int, float]]:
        r = self._http.post(
            f"/collections/{name}/points/search",
            json={"vector": vector, "limit": limit, "with_payload": False},
        )
        r.raise_for_status()
        return [(p["id"], p["score"]) for p in r.json()["result"]]

    def delete(self, name: str) -> None:
        self._http.delete(f"/collections/{name}")

    def close(self) -> None:
        self._http.close()


# --------------------------------------------------------------------------
# Config run
# --------------------------------------------------------------------------

@dataclass
class NeedleResult:
    qid: str
    qtype: str
    anchor_mode: str
    n_needle_units: int
    best_score: float | None  # exact cosine of best needle unit vs question
    hit_at: dict[int, int]  # k -> 0/1
    best_rank: int | None


@dataclass
class ConfigResult:
    label: str
    unit_size: object
    overlap: object
    n_units: int
    prefix: bool
    per_needle: list[NeedleResult] = field(default_factory=list)
    recall_at: dict[int, float] = field(default_factory=dict)
    mean_needle_score: float | None = None


def run_config(
    *,
    label: str,
    units: list[Unit],
    needles: list[Needle],
    embedder: Embedder,
    qdrant: Qdrant,
    collection: str,
    ks: list[int],
    use_prefix: bool,
    unit_size: object,
    overlap: object,
    question_vecs: dict[str, list[float]],
) -> ConfigResult:
    doc_prefix = "search_document: " if use_prefix else None
    vectors = embedder.embed([u.text for u in units], prefix=doc_prefix)
    dim = len(vectors[0])
    qdrant.recreate(collection, dim)
    qdrant.upsert(collection, units, vectors)

    res = ConfigResult(label=label, unit_size=unit_size, overlap=overlap,
                       n_units=len(units), prefix=use_prefix)
    kmax = max(ks)
    search_limit = max(kmax, 50)
    needle_scores: list[float] = []
    for n in needles:
        nu = set(needle_units_for(units, n))
        qvec = question_vecs[n.qid]
        results = qdrant.search(collection, qvec, search_limit)
        ranked_ids = [pid for pid, _ in results]
        hit_at = {k: int(any(pid in nu for pid in ranked_ids[:k])) for k in ks}
        best_rank = next((i for i, pid in enumerate(ranked_ids) if pid in nu), None)
        best_score = max((cosine(qvec, vectors[i]) for i in nu), default=None)
        if best_score is not None:
            needle_scores.append(best_score)
        res.per_needle.append(NeedleResult(
            qid=n.qid, qtype=n.qtype, anchor_mode=n.anchor_mode,
            n_needle_units=len(nu), best_score=best_score, hit_at=hit_at,
            best_rank=best_rank,
        ))
    for k in ks:
        res.recall_at[k] = sum(nr.hit_at[k] for nr in res.per_needle) / len(needles)
    res.mean_needle_score = (sum(needle_scores) / len(needle_scores)) if needle_scores else None
    return res


# --------------------------------------------------------------------------
# Reporting
# --------------------------------------------------------------------------

def degree_needle_result(cfg: ConfigResult, degree_qid: str) -> NeedleResult | None:
    return next((nr for nr in cfg.per_needle if nr.qid == degree_qid), None)


def recommend(sweep: list[ConfigResult], ks: list[int]) -> ConfigResult | None:
    """Best by mean needle score, tie-break recall@max-k, then smaller unit,
    then smaller overlap.

    Mean needle score (where the answer-bearing unit lands in the 0.47->0.7+
    band) is the primary axis: it is the bead's explicit framing and is a
    smooth, monotone signal across unit size. recall@k is the tie-breaker, not
    the primary - at an ~8-needle set it moves in coarse 0.125 steps and a
    single-config outlier (e.g. 1024/128 hitting recall@5=0.88 while its
    neighbours sit at 0.62/0.38) would otherwise steer the recommendation away
    from the small-unit setting the score band clearly favours.
    """
    if not sweep:
        return None
    kmax = max(ks)
    return sorted(
        sweep,
        key=lambda c: (
            -(c.mean_needle_score or 0.0),
            -c.recall_at.get(kmax, 0.0),
            c.unit_size if isinstance(c.unit_size, int) else 1 << 30,
            c.overlap if isinstance(c.overlap, int) else 1 << 30,
        ),
    )[0]


def write_reports(
    *,
    out_dir: Path,
    sweep: list[ConfigResult],
    baseline: ConfigResult | None,
    prefix_pair: tuple[ConfigResult, ConfigResult] | None,
    needles: list[Needle],
    ks: list[int],
    degree_qid: str,
    meta: dict,
) -> tuple[Path, Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    json_path = out_dir / "yxj1_embedding_unit_sweep.json"
    md_path = out_dir / "yxj1_embedding_unit_sweep.md"

    def cfg_dict(c: ConfigResult) -> dict:
        return {
            "label": c.label, "unit_size": c.unit_size, "overlap": c.overlap,
            "prefix": c.prefix, "n_units": c.n_units,
            "recall_at": c.recall_at, "mean_needle_score": c.mean_needle_score,
            "per_needle": [
                {"qid": nr.qid, "qtype": nr.qtype, "anchor_mode": nr.anchor_mode,
                 "n_needle_units": nr.n_needle_units, "best_score": nr.best_score,
                 "best_rank": nr.best_rank, "hit_at": nr.hit_at}
                for nr in c.per_needle
            ],
        }

    rec = recommend(sweep, ks)
    payload = {
        "meta": meta,
        "needles": [
            {"qid": n.qid, "qtype": n.qtype, "question": n.question, "answer": n.answer,
             "source_session_id": n.source_session_id, "anchor_mode": n.anchor_mode}
            for n in needles
        ],
        "sweep": [cfg_dict(c) for c in sweep],
        "baseline_whole_window": cfg_dict(baseline) if baseline else None,
        "prefix_side_test": (
            {"no_prefix": cfg_dict(prefix_pair[0]), "prefix": cfg_dict(prefix_pair[1])}
            if prefix_pair else None
        ),
        "recommended": cfg_dict(rec) if rec else None,
    }
    json_path.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    kmax = max(ks)
    lines: list[str] = []
    lines.append("# yxj.1 - Embedding unit-size/overlap retrieval sweep")
    lines.append("")
    lines.append(f"- Generated: {meta['timestamp']}")
    lines.append(f"- Needles: {len(needles)} | corpus units (size128/ov0 ref): see per-config")
    lines.append(f"- ML model: {meta['embed_model']} | Qdrant: {meta['qdrant_version']}")
    lines.append(f"- Corpus: {meta['n_docs']} sessions, {meta['corpus_chars']:,} chars")
    lines.append("")
    lines.append("## Needle set (answer-shape spread)")
    lines.append("")
    lines.append("| qid | type | anchor | answer | question |")
    lines.append("|---|---|---|---|---|")
    for n in needles:
        lines.append(f"| {n.qid} | {n.qtype} | {n.anchor_mode} | {n.answer[:30]} | {n.question[:50]} |")
    lines.append("")
    lines.append("## Recall@k vs (unit_size, overlap)")
    lines.append("")
    header_ks = " | ".join(f"recall@{k}" for k in ks)
    lines.append(f"| unit_size | overlap | units | {header_ks} | mean needle score | degree score |")
    lines.append("|" + "---|" * (5 + len(ks)))
    for c in sweep:
        deg = degree_needle_result(c, degree_qid)
        deg_s = f"{deg.best_score:.3f}" if deg and deg.best_score is not None else "-"
        rec_cells = " | ".join(f"{c.recall_at[k]:.2f}" for k in ks)
        mns = f"{c.mean_needle_score:.3f}" if c.mean_needle_score is not None else "-"
        lines.append(f"| {c.unit_size} | {c.overlap} | {c.n_units} | {rec_cells} | {mns} | {deg_s} |")
    lines.append("")
    if baseline:
        deg = degree_needle_result(baseline, degree_qid)
        deg_s = f"{deg.best_score:.3f}" if deg and deg.best_score is not None else "-"
        rec_cells = " | ".join(f"{baseline.recall_at[k]:.2f}" for k in ks)
        lines.append("## Whole-window baseline (platform-style large chunks)")
        lines.append("")
        lines.append(f"- degree-needle score: **{deg_s}** (prior Frankenstein probe ~0.47)")
        b_mns = f"{baseline.mean_needle_score:.3f}" if baseline.mean_needle_score is not None else "-"
        lines.append(f"- recall@k: {rec_cells} | mean needle score: {b_mns}")
        lines.append("")
    if prefix_pair:
        npfx, pfx = prefix_pair
        dn = degree_needle_result(npfx, degree_qid)
        dp = degree_needle_result(pfx, degree_qid)
        lines.append(f"## Prefix side-test (at size={npfx.unit_size}, overlap={npfx.overlap})")
        lines.append("")
        lines.append("| variant | " + " | ".join(f"recall@{k}" for k in ks) +
                     " | mean needle score | degree score |")
        lines.append("|" + "---|" * (3 + len(ks)))
        for tag, c, d in (("no-prefix", npfx, dn), ("nomic-prefix", pfx, dp)):
            rc = " | ".join(f"{c.recall_at[k]:.2f}" for k in ks)
            ds = f"{d.best_score:.3f}" if d and d.best_score is not None else "-"
            ms = f"{c.mean_needle_score:.3f}" if c.mean_needle_score is not None else "-"
            lines.append(f"| {tag} | {rc} | {ms} | {ds} |")
        lines.append("")
    if rec:
        deg = degree_needle_result(rec, degree_qid)
        deg_s = f"{deg.best_score:.3f}" if deg and deg.best_score is not None else "-"
        lines.append("## Recommendation")
        lines.append("")
        lines.append(f"- **unit_size={rec.unit_size}, overlap={rec.overlap}** "
                     f"(recall@{kmax}={rec.recall_at[kmax]:.2f}, "
                     f"mean needle score={rec.mean_needle_score:.3f}, degree score={deg_s})")
        lines.append("- Feeds yxj.2 (unit splitter defaults) and yxj.5 (q[0] retest).")
        lines.append("")
    md_path.write_text("\n".join(lines), encoding="utf-8")
    return json_path, md_path


# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description="yxj.1 embedding unit-size/overlap recall sweep")
    ap.add_argument("--unit-sizes", default=",".join(map(str, DEFAULT_UNIT_SIZES)))
    ap.add_argument("--overlaps", default=",".join(map(str, DEFAULT_OVERLAPS)))
    ap.add_argument("--ks", default=",".join(map(str, DEFAULT_KS)))
    ap.add_argument("--needles", type=int, default=8)
    ap.add_argument("--corpus-char-budget", type=int, default=200000)
    ap.add_argument("--distractors-per-needle", type=int, default=2)
    ap.add_argument("--ml-url", default="http://localhost:8000")
    ap.add_argument("--qdrant-url", default="http://localhost:6335")
    ap.add_argument("--embed-model", default="nomic-embed-text")
    ap.add_argument("--batch-size", type=int, default=32)
    ap.add_argument("--collection", default="yxj1_scratch")
    ap.add_argument("--baseline-chunk-chars", type=int, default=6000,
                    help="whole-window baseline chunk size (platform max_ingest_chars)")
    ap.add_argument("--prefix-size", type=int, default=256, help="unit_size for the prefix side-test")
    ap.add_argument("--prefix-overlap", type=int, default=64)
    ap.add_argument("--keep-collection", action="store_true")
    ap.add_argument("--out-dir", default=str(RESULTS_DIR))
    ap.add_argument("--smoke", action="store_true",
                    help="tiny fast run: 2 needles, one config, small budget")
    args = ap.parse_args()

    if args.smoke:
        unit_sizes = [256]
        overlaps = [0]
        ks = [1, 3, 5]
        n_needles = 2
        char_budget = 40000
        distractors = 0
    else:
        unit_sizes = [int(x) for x in args.unit_sizes.split(",") if x]
        overlaps = [int(x) for x in args.overlaps.split(",") if x]
        ks = [int(x) for x in args.ks.split(",") if x]
        n_needles = args.needles
        char_budget = args.corpus_char_budget
        distractors = args.distractors_per_needle

    cfg = yaml.safe_load(LME_CONFIG.read_text(encoding="utf-8"))
    ds = cfg["dataset"]
    local = LME_DIR / ds["local_path"]
    print(f"[yxj.1] loading dataset {local} ...", flush=True)
    questions = load_dataset(local, ds["url"], ds.get("expected_size"))

    needles = select_needles(questions, n_needles)
    degree_qid = questions[0].question_id
    print(f"[yxj.1] selected {len(needles)} needles:", flush=True)
    for n in needles:
        print(f"    {n.qid} [{n.qtype}/{n.anchor_mode}] ans={n.answer[:30]!r}", flush=True)

    corpus = build_corpus(needles, questions, char_budget, distractors)
    corpus_chars = sum(len(v) for v in corpus.values())
    print(f"[yxj.1] corpus: {len(corpus)} sessions, {corpus_chars:,} chars", flush=True)

    embedder = Embedder(args.ml_url, args.embed_model, args.batch_size, timeout=600.0)
    qdrant = Qdrant(args.qdrant_url, timeout=120.0)
    qver = qdrant.version()
    print(f"[yxj.1] qdrant version {qver}", flush=True)

    # Question vectors (no prefix) - reused across all no-prefix configs.
    qtexts = [n.question for n in needles]
    qvecs_noprefix = dict(zip([n.qid for n in needles], embedder.embed(qtexts)))

    sweep: list[ConfigResult] = []
    baseline: ConfigResult | None = None
    prefix_pair: tuple[ConfigResult, ConfigResult] | None = None
    t0 = time.monotonic()
    try:
        # Sweep.
        for size in unit_sizes:
            for ov in overlaps:
                if ov >= size:
                    print(f"[yxj.1] skip size={size} overlap={ov} (overlap>=size)", flush=True)
                    continue
                units = split_units(corpus, size, ov)
                print(f"[yxj.1] config size={size} overlap={ov}: {len(units)} units", flush=True)
                sweep.append(run_config(
                    label=f"s{size}_o{ov}", units=units, needles=needles,
                    embedder=embedder, qdrant=qdrant, collection=args.collection,
                    ks=ks, use_prefix=False, unit_size=size, overlap=ov,
                    question_vecs=qvecs_noprefix,
                ))

        # Whole-window baseline: platform-style large chunks (nomic-safe).
        units = baseline_units(corpus, args.baseline_chunk_chars)
        print(f"[yxj.1] baseline large-chunk (~{args.baseline_chunk_chars} chars): "
              f"{len(units)} units", flush=True)
        baseline = run_config(
            label="baseline_large_chunk", units=units, needles=needles,
            embedder=embedder, qdrant=qdrant, collection=args.collection,
            ks=ks, use_prefix=False, unit_size=f"~{args.baseline_chunk_chars}", overlap="-",
            question_vecs=qvecs_noprefix,
        )

        # Prefix side-test at a representative small setting.
        if not args.smoke:
            ps, po = args.prefix_size, args.prefix_overlap
            if po < ps:
                units = split_units(corpus, ps, po)
                print(f"[yxj.1] prefix side-test size={ps} overlap={po}: {len(units)} units", flush=True)
                # The no-prefix arm is identical to a sweep config when (ps, po)
                # coincides with one already run - reuse it to skip a full embed
                # pass over the corpus.
                npfx = next((c for c in sweep if c.unit_size == ps and c.overlap == po), None)
                if npfx is None:
                    npfx = run_config(
                        label=f"prefix_off_s{ps}_o{po}", units=units, needles=needles,
                        embedder=embedder, qdrant=qdrant, collection=args.collection,
                        ks=ks, use_prefix=False, unit_size=ps, overlap=po,
                        question_vecs=qvecs_noprefix,
                    )
                qvecs_prefix = dict(zip(
                    [n.qid for n in needles],
                    embedder.embed(qtexts, prefix="search_query: "),
                ))
                pfx = run_config(
                    label=f"prefix_on_s{ps}_o{po}", units=units, needles=needles,
                    embedder=embedder, qdrant=qdrant, collection=args.collection,
                    ks=ks, use_prefix=True, unit_size=ps, overlap=po,
                    question_vecs=qvecs_prefix,
                )
                prefix_pair = (npfx, pfx)
    finally:
        if args.keep_collection:
            print(f"[yxj.1] keeping scratch collection {args.collection!r}", flush=True)
        else:
            qdrant.delete(args.collection)
            print(f"[yxj.1] deleted scratch collection {args.collection!r}", flush=True)
        embedder.close()
        qdrant.close()

    meta = {
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "embed_model": args.embed_model,
        "qdrant_version": qver,
        "n_docs": len(corpus),
        "corpus_chars": corpus_chars,
        "n_needles": len(needles),
        "elapsed_s": round(time.monotonic() - t0, 1),
        "smoke": args.smoke,
    }
    json_path, md_path = write_reports(
        out_dir=Path(args.out_dir), sweep=sweep, baseline=baseline,
        prefix_pair=prefix_pair, needles=needles, ks=ks, degree_qid=degree_qid, meta=meta,
    )
    print(f"\n[yxj.1] wrote {json_path}\n[yxj.1] wrote {md_path}", flush=True)

    rec = recommend(sweep, ks)
    if rec:
        deg = degree_needle_result(rec, degree_qid)
        deg_s = f"{deg.best_score:.3f}" if deg and deg.best_score is not None else "-"
        print(f"[yxj.1] RECOMMENDED unit_size={rec.unit_size} overlap={rec.overlap} "
              f"recall@{max(ks)}={rec.recall_at[max(ks)]:.2f} degree_score={deg_s}", flush=True)
    if baseline:
        bdeg = degree_needle_result(baseline, degree_qid)
        bds = f"{bdeg.best_score:.3f}" if bdeg and bdeg.best_score is not None else "-"
        print(f"[yxj.1] baseline whole-window degree_score={bds}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
