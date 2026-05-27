"""
Tests for bead nmemo-klv.10 — structured CLI-failure detail passthrough.

When ``ClaudeCodeProvider._run`` raises ``HTTPException(detail=<dict>)`` to
signal a non-zero Claude CLI exit, the four agent endpoints that spawn the
CLI (graph_agent, gardener_agent, reasoning_agent, reconciliation_agent)
must NOT collapse the dict to ``str(e)`` via their ``except Exception``
catch-all. Pre-fix the platform received ``"Graph agent failed: 500: ..."``
where the structured fields (rc, stderr_tail, stdout_tail, cmd_summary)
were destroyed; this rendered the bead's titular ``Claude CLI failed
(rc=1)`` error opaque and unactionable.

These tests pin the passthrough contract end-to-end: they invoke the
FastAPI router with a mocked ``llm_pool.submit`` that re-raises a
structured ``HTTPException`` exactly as ``_run`` would, then assert the
HTTP response body preserves every diagnostic field as JSON.

The graph_agent endpoint is the canonical reproducer (per the bead). We
cover it end-to-end and add lighter direct-handler tests for the three
sister endpoints to prevent the same regression on those surfaces.
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

ML_SERVICES_ROOT = Path(__file__).resolve().parent.parent
if str(ML_SERVICES_ROOT) not in sys.path:
    sys.path.insert(0, str(ML_SERVICES_ROOT))


# Shape of the structured detail dict produced by
# ``ClaudeCodeProvider._run`` on non-zero CLI exit. Reproduced verbatim in
# every test so a future schema change in _run breaks these tests loudly.
_STRUCTURED_DETAIL = {
    "error": "Claude CLI failed (rc=1): ENOENT: auth token missing",
    "rc": 1,
    "stderr_tail": "ENOENT: auth token missing\nat readAuth (/path/cli.js:42)",
    "stdout_tail": "",
    "cmd_summary": "claude -p <prompt> --output-format json --model haiku",
}


async def _fake_submit_raising_http_exception(*_args, **_kwargs):
    """Stand-in for ``llm_pool.submit`` that re-raises exactly what
    ``ClaudeCodeProvider._run`` would on a non-zero CLI exit. The agent
    endpoints' ``except HTTPException: raise`` guard is what we are
    exercising — without it, the structured dict collapses to a string
    via the catch-all ``except Exception as e: ... detail=f"...{e}"``."""
    raise HTTPException(status_code=500, detail=_STRUCTURED_DETAIL)


# ---------------------------------------------------------------------------
# Graph agent — the canonical reproducer from bead nmemo-klv.10
# ---------------------------------------------------------------------------
class TestGraphAgentErrorPassthrough:
    def _build_client(self) -> TestClient:
        from app.graph_agent import router as graph_router  # noqa: E402
        app = FastAPI()
        app.include_router(graph_router)
        return TestClient(app, raise_server_exceptions=False)

    def test_structured_detail_survives_endpoint(self):
        """End-to-end: POST /graph-agent → ``_run`` raises structured
        HTTPException → FastAPI serialises detail as JSON → response body
        carries every diagnostic field. Pre-fix the body was
        ``{"detail": "Graph agent failed: 500: ..."}`` (string, collapsed)."""
        client = self._build_client()
        with patch(
            "app.graph_agent.llm_pool.submit",
            side_effect=_fake_submit_raising_http_exception,
        ):
            response = client.post(
                "/graph-agent",
                json={
                    "source_text": "hello world",
                    "memory_id": "11111111-1111-1111-1111-111111111111",
                    "mcp_config_path": "/tmp/mcp.json",
                },
            )

        assert response.status_code == 500
        body = response.json()
        # FastAPI wraps HTTPException.detail under the ``detail`` key.
        detail = body.get("detail")
        assert isinstance(detail, dict), (
            f"detail must be a dict to preserve diagnostic fields; "
            f"got {type(detail).__name__}: {detail!r}"
        )
        assert detail["rc"] == 1
        assert "auth token missing" in detail["stderr_tail"]
        assert detail["cmd_summary"].startswith("claude -p")
        assert detail["stdout_tail"] == ""

    def test_queue_full_still_returns_503(self):
        """The ``except QueueFullError`` arm sits before the new
        ``except HTTPException: raise`` and must continue to return 503.
        Regression guard against an accidental re-order."""
        from app.core.concurrency import QueueFullError
        client = self._build_client()

        async def _raise_queue_full(*_a, **_k):
            raise QueueFullError("queue full")

        with patch("app.graph_agent.llm_pool.submit", side_effect=_raise_queue_full):
            response = client.post(
                "/graph-agent",
                json={
                    "source_text": "x",
                    "memory_id": "11111111-1111-1111-1111-111111111111",
                    "mcp_config_path": "/tmp/mcp.json",
                },
            )

        assert response.status_code == 503
        assert response.json()["detail"] == "Service busy, retry later"

    def test_generic_exception_still_wrapped_as_string(self):
        """The catch-all ``except Exception as e: ... str(e)`` path must
        still trigger for non-HTTPException raises (programmer errors,
        unexpected provider faults). Only HTTPException is passthrough."""
        client = self._build_client()

        async def _raise_generic(*_a, **_k):
            raise RuntimeError("unexpected boom")

        with patch("app.graph_agent.llm_pool.submit", side_effect=_raise_generic):
            response = client.post(
                "/graph-agent",
                json={
                    "source_text": "x",
                    "memory_id": "11111111-1111-1111-1111-111111111111",
                    "mcp_config_path": "/tmp/mcp.json",
                },
            )

        assert response.status_code == 500
        detail = response.json()["detail"]
        # Generic exception path: detail is a STRING containing the
        # exception text. This is the legacy contract for non-CLI errors
        # and must not regress to the structured dict shape.
        assert isinstance(detail, str)
        assert "Graph agent failed" in detail
        assert "unexpected boom" in detail


# ---------------------------------------------------------------------------
# Sister CLI-spawning endpoints — same passthrough contract
# ---------------------------------------------------------------------------
#
# We don't repeat the full end-to-end client matrix for the other three
# endpoints because (a) their request schemas vary (gardener takes
# ``trigger``, reconciliation takes a candidate batch, reasoning takes a
# query + entity ids) and bootstrapping each adds maintenance cost, and
# (b) the guard itself is identical line-for-line. Instead we assert the
# guard exists in each module via static inspection — a single grep-like
# check is sufficient regression coverage for the structural property.

_AGENT_MODULE_PATHS = [
    "app/gardener_agent.py",
    "app/reasoning_agent.py",
    "app/reconciliation_agent.py",
]


@pytest.mark.parametrize("module_path", _AGENT_MODULE_PATHS)
def test_sister_agents_have_http_exception_passthrough_guard(module_path):
    """Every CLI-spawning agent endpoint must have an ``except
    HTTPException: raise`` arm BEFORE the catch-all ``except Exception``,
    otherwise the structured CLI-failure detail collapses to a string.
    Inspection-based check — cheap regression guard against accidental
    removal during future refactors of the sister endpoints."""
    source = (ML_SERVICES_ROOT / module_path).read_text(encoding="utf-8")
    # Locate the catch-all and the passthrough guard. They must coexist
    # in the same module and the guard must precede the catch-all
    # textually (Python evaluates except clauses in source order).
    guard_idx = source.find("except HTTPException:")
    catchall_idx = source.find("except Exception as e:")
    assert guard_idx != -1, (
        f"{module_path}: missing ``except HTTPException: raise`` guard. "
        f"Without this the structured detail dict from "
        f"ClaudeCodeProvider._run collapses to a string via the "
        f"catch-all ``except Exception``."
    )
    assert catchall_idx != -1, (
        f"{module_path}: expected ``except Exception as e:`` catch-all"
    )
    assert guard_idx < catchall_idx, (
        f"{module_path}: ``except HTTPException`` must precede ``except "
        f"Exception`` in source order — otherwise the catch-all matches "
        f"HTTPException first (it is an Exception subclass) and the "
        f"structured detail still collapses."
    )
