"""Capture-mechanism tests — B2 (nmemo-6do.2).

Proves the per-request accumulator threading WITHOUT modifying ResourcePool: the
pool forwards an extra argument to the provider callable untouched (the
decoupling-note passthrough test), each provider appends a UsageRecord to a
supplied accumulator after a successful call, and capture is non-fatal (a capture
bug can never abort a successful generation — design §6).
"""

import asyncio
import json
import subprocess
from types import SimpleNamespace
from unittest.mock import patch

from app.core.concurrency import ResourcePool
from app.core.llm import (
    ClaudeCodeProvider,
    ZAIProvider,
    PiBridgeProvider,
    UsageAccumulator,
    UsageRecord,
    _safe_capture,
)


def _cli(stdout: str) -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(args=["claude"], stdout=stdout, stderr="", returncode=0)


# ---------------------------------------------------------------------------
# ResourcePool is UNCHANGED — it forwards extra args/kwargs verbatim
# ---------------------------------------------------------------------------
def test_submit_forwards_extra_kwarg_untouched():
    """The accumulator rides as a normal argument to the callable; the pool
    stays usage-agnostic (decoupling note on B2). submit(fn, *a, **kw) must
    forward an extra ``accumulator`` kwarg into fn unchanged."""
    pool = ResourcePool("test", workers=2, buffer_size=10)
    captured = {}

    def fn(a, b, accumulator=None):
        captured.update(a=a, b=b, accumulator=accumulator)
        return "ok"

    async def run():
        return await pool.submit(fn, 1, 2, accumulator="ACC")

    result = asyncio.run(run())
    assert result == "ok"
    assert captured == {"a": 1, "b": 2, "accumulator": "ACC"}


# ---------------------------------------------------------------------------
# UsageAccumulator — pure capture
# ---------------------------------------------------------------------------
def test_accumulator_append_skips_none_and_totals():
    acc = UsageAccumulator()
    acc.append(None)                       # a call with no usage block is ignored
    assert acc.records == []
    acc.append(UsageRecord(
        requested_model="haiku", resolved_model="claude-haiku-4-5", provider="anthropic",
        input_tokens=10, output_tokens=5, cache_read_tokens=3,
        cache_write_5m_tokens=2, cache_write_1h_tokens=1,
    ))
    acc.append(UsageRecord(
        requested_model="haiku", resolved_model="claude-haiku-4-5", provider="anthropic",
        input_tokens=20, output_tokens=7,
    ))
    assert acc.totals() == {
        "input": 30, "output": 12, "cache_read": 3,
        "cache_write_5m": 2, "cache_write_1h": 1, "calls": 2,
    }


# ---------------------------------------------------------------------------
# Each provider appends a UsageRecord after a successful call
# ---------------------------------------------------------------------------
@patch("app.core.llm.subprocess.run")
def test_claude_generate_populates_accumulator(mock_run):
    provider = ClaudeCodeProvider.__new__(ClaudeCodeProvider)
    envelope = {"result": "hi", "model": "claude-haiku-4-5",
                "cost": {"input_tokens": 100, "output_tokens": 50, "cache_read_tokens": 20}}
    mock_run.return_value = _cli(json.dumps(envelope))
    acc = UsageAccumulator()
    out = provider.generate("hi", {"model": "haiku"}, accumulator=acc)
    assert out == "hi"
    assert len(acc.records) == 1
    rec = acc.records[0]
    assert rec.provider == "anthropic"
    assert rec.input_tokens == 100 and rec.output_tokens == 50 and rec.cache_read_tokens == 20


@patch("app.core.llm.subprocess.run")
def test_claude_generate_json_populates_accumulator(mock_run):
    provider = ClaudeCodeProvider.__new__(ClaudeCodeProvider)
    envelope = {"result": '{"k": "v"}', "model": "claude-haiku-4-5",
                "cost": {"input_tokens": 8, "output_tokens": 4}}
    mock_run.return_value = _cli(json.dumps(envelope))
    acc = UsageAccumulator()
    provider.generate_json("extract", accumulator=acc)
    assert len(acc.records) == 1 and acc.records[0].input_tokens == 8


def test_zai_generate_populates_accumulator():
    provider = ZAIProvider.__new__(ZAIProvider)
    provider.model = "glm-4.7"
    response = SimpleNamespace(
        id="r1", model="glm-4.7",
        choices=[SimpleNamespace(message=SimpleNamespace(content="answer"))],
        usage=SimpleNamespace(
            prompt_tokens=100, completion_tokens=50,
            prompt_tokens_details=SimpleNamespace(cached_tokens=30),
        ),
    )
    provider.client = SimpleNamespace(
        chat=SimpleNamespace(completions=SimpleNamespace(create=lambda **kw: response)),
    )
    acc = UsageAccumulator()
    out = provider.generate("q", accumulator=acc)
    assert out == "answer"
    assert len(acc.records) == 1
    assert acc.records[0].input_tokens == 70 and acc.records[0].cache_read_tokens == 30


@patch("httpx.post")
def test_pi_generate_populates_accumulator(mock_post):
    provider = PiBridgeProvider.__new__(PiBridgeProvider)
    data = {
        "result": "done", "provider": "zai", "model": "glm-5.1",
        "tool_calls": 4, "turns": 2,
        "cost": {
            "input_tokens": 900, "output_tokens": 120, "cache_read_tokens": 400,
            "cache_creation": {"ephemeral_5m_input_tokens": 64, "ephemeral_1h_input_tokens": 16},
        },
    }
    mock_post.return_value = SimpleNamespace(status_code=200, json=lambda: data, text="")
    acc = UsageAccumulator()
    out = provider.generate("q", accumulator=acc)
    assert out == "done"
    assert len(acc.records) == 1
    rec = acc.records[0]
    assert rec.input_tokens == 900 and rec.cache_write_5m_tokens == 64
    assert rec.cache_write_1h_tokens == 16 and rec.tool_calls == 4


# ---------------------------------------------------------------------------
# Capture is transparent + non-fatal (design §6; B10 enforcement absent)
# ---------------------------------------------------------------------------
@patch("app.core.llm.subprocess.run")
def test_generate_without_accumulator_is_noop(mock_run):
    provider = ClaudeCodeProvider.__new__(ClaudeCodeProvider)
    mock_run.return_value = _cli(json.dumps({"result": "x", "cost": {"input_tokens": 1}}))
    assert provider.generate("hi") == "x"  # default accumulator=None, no error


@patch("app.core.llm.subprocess.run")
def test_capture_failure_never_aborts_generation(mock_run):
    """A capture bug must only ever lose a metric, never fail the call (§6)."""
    provider = ClaudeCodeProvider.__new__(ClaudeCodeProvider)
    mock_run.return_value = _cli(json.dumps({"result": "hi", "cost": {"input_tokens": 1}}))

    class BoomAccumulator(UsageAccumulator):
        def append(self, record):  # noqa: D401
            raise RuntimeError("boom")

    out = provider.generate("hi", accumulator=BoomAccumulator())
    assert out == "hi"  # generation succeeds despite the capture explosion


# ---------------------------------------------------------------------------
# _safe_capture — the single shared non-fatal guard (covers ALL providers)
# ---------------------------------------------------------------------------
def test_safe_capture_appends_on_success():
    acc = UsageAccumulator()
    rec = UsageRecord(requested_model="m", resolved_model="m", provider="p", input_tokens=3)
    _safe_capture(acc, lambda: rec, "test")
    assert acc.records == [rec]


def test_safe_capture_noop_when_accumulator_none_skips_parse():
    called = []

    def parse():
        called.append(1)
        return None

    _safe_capture(None, parse, "test")
    assert called == []  # parse must not even run when there's nothing to capture into


def test_safe_capture_swallows_parse_error():
    acc = UsageAccumulator()

    def boom():
        raise RuntimeError("parse boom")

    _safe_capture(acc, boom, "test")  # must not raise
    assert acc.records == []


def test_safe_capture_swallows_append_error():
    class BoomAcc(UsageAccumulator):
        def append(self, record):
            raise RuntimeError("append boom")

    rec = UsageRecord(requested_model="m", resolved_model="m", provider="p")
    _safe_capture(BoomAcc(), lambda: rec, "test")  # must not raise
