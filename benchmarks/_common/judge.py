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
class JudgeCost:
    """Judge token usage (nmemo-6do, B9). Captured from the `claude -p
    --output-format json` envelope. Stays in the RunEnvelope / TokenAccumulator
    ONLY — never an llm_usage row: the judge is a harness subprocess, not platform
    traffic, and /api/reset would wipe a row (design §4.5, §4.7 decision).

    `estimated_usd` is the CLI's OWN figure and is INFORMATIONAL only — it is not
    authoritative and is not summed downstream. Consistent with the platform path
    (which drops the CLI estimate as untrustworthy, llm.py), benchmark cost is
    computed downstream from the token counts via config.ts PRICING (the single
    source of truth). The accumulator records only tokens (add_judge ignores USD)."""

    model: str
    input_tokens: int
    output_tokens: int
    estimated_usd: float  # CLI's own figure; informational, not authoritative — see docstring


@dataclass
class JudgeVerdict:
    score: float  # 0.0 = wrong, 1.0 = correct, intermediate = partial
    reasoning: str
    raw_response: str
    cost: JudgeCost | None = None


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
                    # --output-format json wraps the model output in a cost
                    # envelope (B9) so we can capture judge token usage; same
                    # shape ClaudeCodeProvider parses (llm.py).
                    "--output-format",
                    "json",
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
        # Envelope-parse (result text + cost) then verdict-parse the
        # {score, reasoning} JSON the model emitted inside envelope.result.
        result_text, cost = _parse_envelope(raw, self._model)
        verdict = _parse_verdict(result_text)
        return JudgeVerdict(
            score=verdict["score"],
            reasoning=verdict["reasoning"],
            raw_response=raw,
            cost=cost,
        )


def _parse_envelope(raw: str, model: str) -> tuple[str, JudgeCost | None]:
    """Split the `claude -p --output-format json` envelope into (result_text, cost).

    Mirrors ClaudeCodeProvider's envelope read (ml-services/app/core/llm.py): the
    model's {score, reasoning} JSON lives inside envelope["result"], token usage in
    envelope["cost"]. Tolerant — if stdout is NOT a JSON envelope (older CLI / plain
    output), the whole string is treated as the result text with no cost, so the
    judge keeps working through the verdict-parse fallback.
    """
    try:
        env = json.loads(raw)
    except json.JSONDecodeError:
        return raw, None
    if not isinstance(env, dict) or "result" not in env:
        return raw, None
    # The CLI envelope carries usage under "usage" and the dollar total under
    # "total_cost_usd" (verified against the live CLI in the B11 E2E — there is no
    # "cost" key). Fall back to a flat "cost" dict for synthetic/older envelopes.
    usage = env.get("usage") or env.get("cost") or {}
    cost = (
        JudgeCost(
            model=model,
            input_tokens=int(usage.get("input_tokens") or 0),
            output_tokens=int(usage.get("output_tokens") or 0),
            estimated_usd=float(env.get("total_cost_usd") or usage.get("estimated_usd") or 0.0),
        )
        if usage
        else None
    )
    return str(env.get("result", "")), cost


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
