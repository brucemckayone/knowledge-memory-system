"""B9 (nmemo-6do.9): benchmark token-usage integration.

Run from /benchmarks: `uv run pytest test_token_usage_b9.py -q`. Pure unit tests
(no platform, no claude subprocess) — the judge subprocess is mocked.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import asdict
from unittest.mock import patch

import _common.results as results_mod
from _common.judge import Judge, JudgeCost, _parse_envelope, _parse_verdict
from _common.results import RunEnvelope, write_run
from _common.token_accumulator import TokenAccumulator


def _minimal_envelope(**over):
    base = dict(
        benchmark="t", cut="c", mnemo_git_sha="abc1234", harness_commit="h",
        config_path="p", model_under_test="m", judge_model="j",
        timestamp="2026-06-30T00:00:00Z", dataset_size=1, scores={"overall": 1.0},
    )
    base.update(over)
    return RunEnvelope(**base)


# ---------------------------------------------------------------------------
# RunEnvelope — the 3 new fields, defaults, ordering, backward-compat
# ---------------------------------------------------------------------------
def test_runenvelope_new_fields_default():
    env = _minimal_envelope()
    assert env.token_usage == {}
    assert env.estimated_cost_usd == 0.0
    assert env.pricing_version == ""


def test_runenvelope_backward_compat_old_json_deserializes():
    # An old run JSON written before the epic (no token-usage fields).
    old = {
        "benchmark": "longmemeval", "cut": "LongMemEval_S", "mnemo_git_sha": "deadbee",
        "harness_commit": "abc", "config_path": "p", "model_under_test": "m",
        "judge_model": "j", "timestamp": "2026-01-01T00:00:00Z", "dataset_size": 500,
        "scores": {"overall_accuracy": 0.5}, "notes": "old", "judge_prompt_version": "v1",
    }
    env = RunEnvelope(**old)        # must not raise
    assert env.token_usage == {}    # defaults fill the missing fields
    assert env.estimated_cost_usd == 0.0
    assert env.pricing_version == ""


def test_runenvelope_field_order_matches_pinned_schema():
    # asdict preserves field order; the 3 token fields sit before notes (plan.md §1.4).
    keys = list(asdict(_minimal_envelope()).keys())
    assert keys.index("token_usage") < keys.index("notes")
    assert keys.index("estimated_cost_usd") < keys.index("notes")
    assert keys.index("pricing_version") < keys.index("notes")


def test_write_run_stamps_token_usage_and_defaults_cost(tmp_path, monkeypatch):
    # Write into a throwaway tmp dir, not the real results tree (no shared on-disk
    # state, auto-cleaned by pytest even if an assert fails mid-test).
    monkeypatch.setattr(results_mod, "RESULTS_DIR", tmp_path)
    tu = {"graph_agent": {"claude-haiku-4-5": {"input": 10, "output": 5, "cache_read": 0,
          "cache_write_5m": 0, "cache_write_1h": 0, "calls": 1, "tool_calls": 0}}}
    path = write_run(
        benchmark="b9test", cut="c", config_path="p", model_under_test="m",
        judge_model="j", dataset_size=1, scores={"overall": 1.0}, token_usage=tu,
    )
    written = json.loads(path.read_text(encoding="utf-8"))
    assert written["token_usage"] == tu
    assert written["estimated_cost_usd"] == 0.0   # cost computed downstream, not here
    assert written["pricing_version"] == ""


# ---------------------------------------------------------------------------
# TokenAccumulator
# ---------------------------------------------------------------------------
def _resp(model, **toks):
    call = {"resolved_model": model, **{f"{k}_tokens" if k != "tool_calls" else k: v for k, v in toks.items()}}
    return {"usage": {"calls": [call], "totals": {}}}


def test_accumulator_sums_per_operation_per_model_and_survives_reset():
    acc = TokenAccumulator()
    # two ingests of the same model (e.g. across an /api/reset between questions)
    acc.add_response("graph_agent", _resp("claude-haiku-4-5", input=100, output=50))
    acc.add_response("graph_agent", _resp("claude-haiku-4-5", input=20, output=10, tool_calls=3))
    acc.add_response("reasoning_agent", _resp("claude-sonnet-4-6", input=200, output=80))
    t = acc.totals()
    assert t["graph_agent"]["claude-haiku-4-5"]["input"] == 120
    assert t["graph_agent"]["claude-haiku-4-5"]["output"] == 60
    assert t["graph_agent"]["claude-haiku-4-5"]["calls"] == 2
    assert t["graph_agent"]["claude-haiku-4-5"]["tool_calls"] == 3
    assert t["reasoning_agent"]["claude-sonnet-4-6"]["input"] == 200


def test_accumulator_add_judge_and_noop_paths():
    acc = TokenAccumulator()
    acc.add_response("graph_agent", None)        # no-op
    acc.add_response("graph_agent", {"result": "x"})  # no usage -> no-op
    acc.add_judge(None)                          # no-op
    acc.add_judge(JudgeCost(model="claude-sonnet-4-6", input_tokens=200, output_tokens=30, estimated_usd=0.001))
    t = acc.totals()
    assert "graph_agent" not in t                # nothing accumulated
    assert t["judge"]["claude-sonnet-4-6"]["input"] == 200
    assert t["judge"]["claude-sonnet-4-6"]["calls"] == 1


# ---------------------------------------------------------------------------
# judge.py — envelope split + cost capture
# ---------------------------------------------------------------------------
def test_parse_envelope_splits_result_and_cost():
    raw = json.dumps({"result": '{"score": 0.8, "reasoning": "ok"}',
                      "cost": {"input_tokens": 200, "output_tokens": 30, "estimated_usd": 0.0012}})
    result_text, cost = _parse_envelope(raw, "claude-sonnet-4-6")
    assert cost is not None
    assert cost.model == "claude-sonnet-4-6"
    assert cost.input_tokens == 200 and cost.estimated_usd == 0.0012
    # the verdict JSON lives inside the result text
    assert _parse_verdict(result_text) == {"score": 0.8, "reasoning": "ok"}


def test_parse_envelope_real_cli_shape():
    """Regression (found by the B11 E2E): the live CLI envelope carries usage under
    'usage' and the dollar total under 'total_cost_usd' — no 'cost' key."""
    raw = json.dumps({
        "result": '{"score": 0.9, "reasoning": "ok"}',
        "total_cost_usd": 0.0123,
        "usage": {"input_tokens": 1500, "output_tokens": 40},
    })
    result_text, cost = _parse_envelope(raw, "claude-sonnet-4-6")
    assert cost is not None
    assert cost.input_tokens == 1500
    assert cost.output_tokens == 40
    assert cost.estimated_usd == 0.0123  # from total_cost_usd
    assert _parse_verdict(result_text)["score"] == 0.9


def test_parse_envelope_tolerates_non_envelope_stdout():
    # Older CLI / plain output: treat the whole string as the result, no cost.
    result_text, cost = _parse_envelope('{"score": 1.0, "reasoning": "x"}', "m")
    assert cost is None
    assert _parse_verdict(result_text)["score"] == 1.0


def test_judge_score_captures_cost():
    envelope = json.dumps({
        "result": '{"score": 0.8, "reasoning": "correct"}',
        "cost": {"input_tokens": 200, "output_tokens": 30, "estimated_usd": 0.0012},
    })
    completed = subprocess.CompletedProcess(args=["claude"], returncode=0, stdout=envelope, stderr="")
    with patch("_common.judge.shutil.which", return_value="/usr/bin/claude"), \
         patch("_common.judge.subprocess.run", return_value=completed):
        verdict = Judge(model="claude-sonnet-4-6").score("q", "cand", "ref")
    assert verdict.score == 0.8
    assert verdict.reasoning == "correct"
    assert verdict.cost is not None
    assert verdict.cost.input_tokens == 200
    assert verdict.cost.estimated_usd == 0.0012
