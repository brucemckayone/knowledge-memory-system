"""In-memory token-usage accumulator for a benchmark run (nmemo-6do, B9).

Sums the per-call usage echoed by each platform response (response.usage.calls,
design §4.2) into per-(operation, resolved_model) buckets across the WHOLE run.
It is pure in-memory, so it survives /api/reset (which wipes Postgres between
questions) — this is the only correlation path for benchmark-run usage, since
llm_usage.trace_id is platform-internal only (design §4.5 option b).

It records TOKENS, not USD: pricing is single-source-of-truth in TypeScript
(config.ts PRICING), so estimated cost is computed downstream from the recorded
token buckets — never duplicated here. Judge usage (a `claude -p` harness
subprocess, not platform traffic) is folded in via add_judge under the 'judge'
operation, and lives only here + in the RunEnvelope — never an llm_usage row.
"""

from __future__ import annotations

from typing import Any

_BUCKET_KEYS = ("input", "output", "cache_read", "cache_write_5m", "cache_write_1h", "calls", "tool_calls")


class TokenAccumulator:
    def __init__(self) -> None:
        # {operation: {resolved_model: {input, output, cache_read,
        #              cache_write_5m, cache_write_1h, calls, tool_calls}}}
        self.buckets: dict[str, dict[str, dict[str, int]]] = {}

    def _bucket(self, operation: str, model: str) -> dict[str, int]:
        op = self.buckets.setdefault(operation, {})
        return op.setdefault(model, {k: 0 for k in _BUCKET_KEYS})

    def add_response(self, operation: str, response: dict[str, Any] | None) -> None:
        """Accumulate a platform response's usage.calls into per-model buckets.

        Each echoed call carries its own resolved_model (the per-model split the
        aggregate totals can't provide). A response without usage is a no-op.
        """
        usage = (response or {}).get("usage") or {}
        for call in usage.get("calls", []) or []:
            b = self._bucket(operation, call.get("resolved_model") or "unknown")
            b["input"] += int(call.get("input_tokens") or 0)
            b["output"] += int(call.get("output_tokens") or 0)
            b["cache_read"] += int(call.get("cache_read_tokens") or 0)
            b["cache_write_5m"] += int(call.get("cache_write_5m_tokens") or 0)
            b["cache_write_1h"] += int(call.get("cache_write_1h_tokens") or 0)
            b["calls"] += 1
            b["tool_calls"] += int(call.get("tool_calls") or 0)

    def add_judge(self, cost: Any | None) -> None:
        """Accumulate a JudgeCost (operation='judge'). None is a no-op."""
        if cost is None:
            return
        b = self._bucket("judge", getattr(cost, "model", "unknown"))
        b["input"] += int(getattr(cost, "input_tokens", 0) or 0)
        b["output"] += int(getattr(cost, "output_tokens", 0) or 0)
        b["calls"] += 1

    def totals(self) -> dict[str, dict[str, dict[str, int]]]:
        """The nested {operation: {model: {buckets}}} dict for RunEnvelope.token_usage."""
        return self.buckets
