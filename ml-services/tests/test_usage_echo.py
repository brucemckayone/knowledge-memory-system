"""B4 (nmemo-6do.4): HTTP echo — every live agent response carries usage{calls,totals}.

Drives the real /graph-agent handler through a minimal FastAPI app. The provider
is a fake that appends a UsageRecord to the injected accumulator (like a real
adapter), and llm_pool is replaced by a direct-call stub so the handler's echo
wiring (FastAPI dependency -> submit -> adapter append -> response.usage) is
tested without the real worker pool. B2 already proved the pool forwards the
accumulator verbatim; the rigorous N-parallel isolation + streaming proof is B3.
"""

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app import graph_agent
from app.graph_agent import router as graph_router
from app.core.llm import UsageRecord


class _FakeLLM:
    """Stands in for llm_client: appends one UsageRecord per call, like an adapter."""

    def generate(self, prompt, options=None, accumulator=None):
        if accumulator is not None:
            accumulator.append(UsageRecord(
                requested_model="haiku", resolved_model="claude-haiku-4-5",
                provider="anthropic", input_tokens=100, output_tokens=50, cache_read_tokens=10,
            ))
        return "fake result"


class _DirectPool:
    """Bypasses the real ResourcePool: runs the callable inline (no queue/threads),
    forwarding *args/**kwargs exactly as the real submit does."""

    async def submit(self, fn, *args, **kwargs):
        return fn(*args, **kwargs)


def _client(monkeypatch) -> TestClient:
    monkeypatch.setattr(graph_agent, "llm_client", _FakeLLM())
    monkeypatch.setattr(graph_agent, "llm_pool", _DirectPool())
    app = FastAPI()
    app.include_router(graph_router)
    return TestClient(app)


_REQUEST = {
    "source_text": "Alice knows Bob.",
    "memory_id": "00000000-0000-0000-0000-000000000001",
    "mcp_config_path": "/tmp/mcp.json",
}


def test_graph_agent_response_carries_usage_echo(monkeypatch):
    client = _client(monkeypatch)
    resp = client.post("/graph-agent", json=_REQUEST)
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["result"] == "fake result"
    assert body.get("usage") is not None

    calls = body["usage"]["calls"]
    totals = body["usage"]["totals"]
    assert len(calls) == 1
    assert calls[0]["input_tokens"] == 100
    assert calls[0]["resolved_model"] == "claude-haiku-4-5"
    assert calls[0]["provider"] == "anthropic"
    assert totals == {
        "input": 100, "output": 50, "cache_read": 10,
        "cache_write_5m": 0, "cache_write_1h": 0, "calls": 1,
    }


def test_each_request_gets_its_own_accumulator(monkeypatch):
    """Three sequential requests each echo exactly one call — the per-request
    accumulator does not accumulate across requests (lightweight isolation; B3
    proves the concurrent case)."""
    client = _client(monkeypatch)
    for _ in range(3):
        body = client.post("/graph-agent", json=_REQUEST).json()
        assert body["usage"]["totals"]["calls"] == 1
        assert body["usage"]["totals"]["input"] == 100


class _SilentLLM:
    """A provider that records no usage (appends nothing to the accumulator)."""

    def generate(self, prompt, options=None, accumulator=None):
        return "no usage recorded"


def test_zero_call_echo_is_empty_not_missing(monkeypatch):
    """A response with no recorded LLM usage still carries usage = {calls:[],
    totals: all-zero} — present and well-formed, never missing — verified through
    the full FastAPI response-model serialization (echo() on empty records)."""
    monkeypatch.setattr(graph_agent, "llm_client", _SilentLLM())
    monkeypatch.setattr(graph_agent, "llm_pool", _DirectPool())
    app = FastAPI()
    app.include_router(graph_router)
    body = TestClient(app).post("/graph-agent", json=_REQUEST).json()
    assert body["usage"] is not None
    assert body["usage"]["calls"] == []
    assert body["usage"]["totals"] == {
        "input": 0, "output": 0, "cache_read": 0,
        "cache_write_5m": 0, "cache_write_1h": 0, "calls": 0,
    }
