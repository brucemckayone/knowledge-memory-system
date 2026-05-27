"""LLM-as-judge scoring via `claude -p` subprocess.

Reuses the local Claude Code authentication (same auth path the Mnemo
reasoning agent uses), so no API key is needed in the benchmark process
itself. Trade-off: subprocess startup cost per call (~1-2s) means a
500-question run pays ~15 minutes of overhead on judging alone — but
this is the canonical "no key management" surface for this machine.

JUDGE_PROMPT_VERSION bumps anytime the prompt template or extraction
logic changes. Prior-run scores are not comparable across versions; the
field is stamped into the JSON envelope so a future reader can detect
the boundary.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from dataclasses import dataclass

from _common.config import JUDGE_MODEL

JUDGE_PROMPT_VERSION = "v1"
CLAUDE_BINARY = "claude"
SUBPROCESS_TIMEOUT_SECONDS = 120


@dataclass
class JudgeVerdict:
    score: float  # 0.0 = wrong, 1.0 = correct, intermediate = partial
    reasoning: str
    raw_response: str


_PROMPT_TEMPLATE = """You are a strict evaluator. Score the candidate on a 0.0-1.0 scale.
1.0 = substantively correct. 0.0 = wrong or missing. Intermediate = partial.
Do not reward correct-sounding prose that misses the factual content.

Question:
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
    """`claude -p` subprocess scorer. One invocation per item."""

    def __init__(self, model: str = JUDGE_MODEL) -> None:
        if shutil.which(CLAUDE_BINARY) is None:
            raise JudgeError(
                f"'{CLAUDE_BINARY}' not found on PATH; required for the LLM-as-judge."
            )
        self._model = model

    @property
    def model(self) -> str:
        return self._model

    def score(self, question: str, candidate: str, reference: str) -> JudgeVerdict:
        prompt = _PROMPT_TEMPLATE.format(
            question=question, reference=reference, candidate=candidate
        )
        # Pattern lifted from ml-services/app/core/llm.py:
        # - --no-session-persistence so judge calls don't accumulate in the
        #   shell's session history (each call is fully independent).
        # - --effort low because judging is a simple structured-output task;
        #   no thinking budget needed.
        # - Default mode (no --bare) because --bare exits 1 on this machine.
        try:
            result = subprocess.run(
                [
                    CLAUDE_BINARY,
                    "-p",
                    "--model",
                    self._model,
                    "--effort",
                    "low",
                    "--no-session-persistence",
                ],
                input=prompt,
                capture_output=True,
                text=True,
                timeout=SUBPROCESS_TIMEOUT_SECONDS,
                encoding="utf-8",
                errors="replace",
            )
        except subprocess.TimeoutExpired as e:
            raise JudgeError(
                f"claude -p timed out after {SUBPROCESS_TIMEOUT_SECONDS}s"
            ) from e
        if result.returncode != 0:
            raise JudgeError(
                f"claude -p failed (code {result.returncode}): "
                f"{(result.stderr or '')[:300]}"
            )

        raw = result.stdout.strip()
        verdict = _parse_verdict(raw)
        return JudgeVerdict(
            score=verdict["score"],
            reasoning=verdict["reasoning"],
            raw_response=raw,
        )


def _parse_verdict(raw: str) -> dict[str, object]:
    """Tolerant JSON extraction — model usually emits clean JSON but the
    occasional trailing prose or leading explanation shouldn't fail a run.
    """
    text = raw.strip()
    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
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
