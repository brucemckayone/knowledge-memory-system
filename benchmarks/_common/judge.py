"""LLM-as-judge scoring with a single Sonnet call per item.

Locked low-temperature / structured-output prompt so judge variance across
runs stays small (the whole point of using Sonnet over Haiku here). If the
judge prompt ever needs to change, that's a methodology-breaking event —
bump the JUDGE_PROMPT_VERSION constant so prior results aren't compared
against post-change ones silently.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

from anthropic import Anthropic

from _common.config import ANTHROPIC_API_KEY, JUDGE_MODEL

JUDGE_PROMPT_VERSION = "v1"


@dataclass
class JudgeVerdict:
    score: float  # 0.0 = wrong, 1.0 = correct, intermediate = partial
    reasoning: str
    raw_response: str


_SYSTEM = (
    "You are a strict evaluator. Given a question, a candidate answer, and a "
    "reference answer, score the candidate on a 0.0-1.0 scale and explain in "
    "one or two sentences. 1.0 means substantively correct; 0.0 means wrong "
    "or missing; intermediate values are allowed for partial answers. Do not "
    "reward correct-sounding prose that misses the factual content."
)

_TEMPLATE = """Question:
{question}

Reference answer:
{reference}

Candidate answer:
{candidate}

Respond with ONLY a JSON object of the form:
{{"score": <0.0-1.0>, "reasoning": "<one or two sentences>"}}
No prose before or after."""


class JudgeError(RuntimeError):
    pass


class Judge:
    """Sonnet-based scorer. One API call per item."""

    def __init__(self, model: str = JUDGE_MODEL, api_key: str | None = None) -> None:
        key = api_key or ANTHROPIC_API_KEY
        if not key:
            raise JudgeError(
                "ANTHROPIC_API_KEY is not set; required for the LLM-as-judge."
            )
        self._client = Anthropic(api_key=key)
        self._model = model

    @property
    def model(self) -> str:
        return self._model

    def score(self, question: str, candidate: str, reference: str) -> JudgeVerdict:
        prompt = _TEMPLATE.format(question=question, reference=reference, candidate=candidate)
        msg = self._client.messages.create(
            model=self._model,
            max_tokens=400,
            temperature=0.0,
            system=_SYSTEM,
            messages=[{"role": "user", "content": prompt}],
        )
        raw = "".join(block.text for block in msg.content if block.type == "text")
        verdict = _parse_verdict(raw)
        return JudgeVerdict(score=verdict["score"], reasoning=verdict["reasoning"], raw_response=raw)


def _parse_verdict(raw: str) -> dict[str, object]:
    """Tolerant JSON extraction — Sonnet usually emits clean JSON but the
    occasional trailing whitespace / leading comment shouldn't fail a run.
    """
    text = raw.strip()
    # Most common case: clean JSON.
    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        # Fallback: extract the first {...} block.
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if not match:
            raise JudgeError(f"judge produced non-JSON response: {raw[:200]}")
        try:
            obj = json.loads(match.group(0))
        except json.JSONDecodeError as e:
            raise JudgeError(f"judge JSON parse failed: {e}; raw: {raw[:200]}") from e

    if not isinstance(obj, dict) or "score" not in obj or "reasoning" not in obj:
        raise JudgeError(f"judge missing required keys; got: {obj!r}")

    score = float(obj["score"])
    if not (0.0 <= score <= 1.0):
        raise JudgeError(f"judge score out of range [0,1]: {score}")

    return {"score": score, "reasoning": str(obj["reasoning"])}
