"""LongMemEval dataset loader.

Downloads the cleaned-S JSON from HuggingFace on first use; caches under
benchmarks/longmemeval/data/. Parses to a list of `Question` records that
the run.py driver iterates over.

Schema reference (from upstream README):
- question_id, question_type, question, answer, question_date
- haystack_session_ids, haystack_dates, haystack_sessions
- answer_session_ids
Questions whose question_id ends with `_abs` are abstention items.
"""

from __future__ import annotations

import json
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


# question_type → high-level category. The five LongMemEval categories from
# the paper map onto question_type as follows; abstention is special (id
# suffix, not question_type). Source: upstream README §LongMemEval Overview.
CATEGORY_FROM_TYPE: dict[str, str] = {
    "single-session-user": "information_extraction",
    "single-session-assistant": "information_extraction",
    "single-session-preference": "information_extraction",
    "multi-session": "multi_session_reasoning",
    "temporal-reasoning": "temporal_reasoning",
    "knowledge-update": "knowledge_updates",
}

CATEGORIES = (
    "information_extraction",
    "multi_session_reasoning",
    "temporal_reasoning",
    "knowledge_updates",
    "abstention",
)


@dataclass
class Turn:
    role: str
    content: str
    has_answer: bool = False


@dataclass
class Session:
    session_id: str
    date: str
    turns: list[Turn]


@dataclass
class Question:
    question_id: str
    question_type: str
    question: str
    answer: str
    question_date: str
    sessions: list[Session]
    answer_session_ids: list[str]

    @property
    def is_abstention(self) -> bool:
        return self.question_id.endswith("_abs")

    @property
    def category(self) -> str:
        if self.is_abstention:
            return "abstention"
        return CATEGORY_FROM_TYPE.get(self.question_type, "information_extraction")


def download_if_missing(url: str, local: Path) -> Path:
    """Fetch the dataset JSON if it's not already cached locally.

    No progress bar (urllib.request is simple); for large files (~hundreds
    of MB on _S), expect a one-time delay on first run.
    """
    local.parent.mkdir(parents=True, exist_ok=True)
    if local.exists() and local.stat().st_size > 0:
        return local
    print(f"[longmemeval] downloading {url} -> {local}", flush=True)
    with urllib.request.urlopen(url) as resp, open(local, "wb") as fp:
        # 1 MiB chunks; iterating keeps memory bounded even on _M-scale files.
        while chunk := resp.read(1024 * 1024):
            fp.write(chunk)
    print(f"[longmemeval] downloaded {local.stat().st_size:,} bytes", flush=True)
    return local


def parse_question(raw: dict[str, Any]) -> Question:
    session_ids = raw.get("haystack_session_ids", []) or []
    session_dates = raw.get("haystack_dates", []) or []
    session_payloads = raw.get("haystack_sessions", []) or []

    sessions: list[Session] = []
    for idx, payload in enumerate(session_payloads):
        sid = session_ids[idx] if idx < len(session_ids) else f"session_{idx}"
        date = session_dates[idx] if idx < len(session_dates) else ""
        turns = [
            Turn(
                role=str(turn.get("role", "")),
                content=str(turn.get("content", "")),
                has_answer=bool(turn.get("has_answer", False)),
            )
            for turn in payload
        ]
        sessions.append(Session(session_id=sid, date=date, turns=turns))

    return Question(
        question_id=str(raw["question_id"]),
        question_type=str(raw["question_type"]),
        question=str(raw["question"]),
        answer=str(raw["answer"]),
        question_date=str(raw.get("question_date", "")),
        sessions=sessions,
        answer_session_ids=list(raw.get("answer_session_ids", []) or []),
    )


def load_dataset(local_path: Path, url: str, expected_size: int | None = None) -> list[Question]:
    """Materialise the dataset as a list of Question records.

    Downloads on demand. Validates the expected count if provided — guards
    against the file being half-downloaded or upstream silently re-cutting.
    """
    download_if_missing(url, local_path)
    with open(local_path, encoding="utf-8") as fp:
        raw = json.load(fp)
    if not isinstance(raw, list):
        raise ValueError(
            f"expected a JSON list at {local_path}, got {type(raw).__name__}"
        )
    questions = [parse_question(item) for item in raw]
    if expected_size is not None and len(questions) != expected_size:
        raise ValueError(
            f"dataset size mismatch: got {len(questions)} questions, expected {expected_size}; "
            f"upstream may have re-cut the data — pin a known commit and re-download"
        )
    return questions
