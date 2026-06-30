"""B3 (nmemo-6do.3): per-request usage isolation across the worker pool.

The blocking capture gate: fire N parallel /graph-agent requests through the
REAL llm_pool (6 shared workers running providers via asyncio.to_thread) and
assert each response.usage.calls contains ONLY its own call — no cross-request
bleed. This proves the explicit per-request accumulator (B2) survives concurrent
scheduling where the original request-scoped ContextVar premise would have
interleaved usage across the shared workers.

Per-adapter token-normalisation tests (the OpenAI uncached-remainder rule,
input + cache_read == prompt_tokens, the Anthropic cache TTL split) are the
OTHER half of this gate and live in test_usage_parsing.py (B1). Streaming: no
current provider streams (Claude returns a JSON envelope, ZAI is non-streaming
chat.completions, the Pi bridge returns JSON), so the "read usage from the final
SSE chunk, never a header" path is deferred until a streaming provider (LiteLLM)
lands — every adapter today already reads usage from the response body.
"""

import asyncio
import itertools
import time

import httpx
from fastapi import FastAPI

from app import graph_agent
from app.graph_agent import router as graph_router
from app.core.llm import UsageRecord


class _FakeLLM:
    """Each call sleeps briefly (forces overlap across the 6 workers) then appends
    one uniquely-tagged UsageRecord to the per-request accumulator it is handed.

    The id counter is per-instance (not module-global) so each test starts at 0
    and there is no cross-test coupling on import-once semantics."""

    def __init__(self):
        self._counter = itertools.count()

    def generate(self, prompt, options=None, accumulator=None):
        time.sleep(0.05)
        n = next(self._counter)
        if accumulator is not None:
            accumulator.append(UsageRecord(
                requested_model="haiku", resolved_model="claude-haiku-4-5",
                provider="anthropic", input_tokens=n, request_id=f"call-{n}",
            ))
        return f"r{n}"


_REQUEST = {
    "source_text": "Alice knows Bob.",
    "memory_id": "00000000-0000-0000-0000-000000000001",
    "mcp_config_path": "/tmp/mcp.json",
}


async def _fire(app, n):
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test", timeout=30.0) as client:
        return await asyncio.gather(*[client.post("/graph-agent", json=_REQUEST) for _ in range(n)])


def test_concurrent_graph_agent_requests_no_usage_bleed(monkeypatch):
    # Only the provider is faked; the REAL llm_pool (6 workers) schedules the calls.
    monkeypatch.setattr(graph_agent, "llm_client", _FakeLLM())
    app = FastAPI()
    app.include_router(graph_router)

    n = 12
    responses = asyncio.run(_fire(app, n))

    assert all(r.status_code == 200 for r in responses), [r.status_code for r in responses]

    seen_ids = []
    for r in responses:
        usage = r.json()["usage"]
        # the handler calls generate exactly once -> exactly one record per request
        assert usage["totals"]["calls"] == 1, usage
        assert len(usage["calls"]) == 1
        seen_ids.append(usage["calls"][0]["request_id"])

    # No record bled into another request's echo: every id is unique, n total.
    assert len(set(seen_ids)) == n, seen_ids
