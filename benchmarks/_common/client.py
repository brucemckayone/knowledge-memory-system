"""HTTP client for the Mnemo platform.

Calls the same surface a real user hits — POST /ingest for write,
POST /api/reason/query for read, GET /health for sanity. Endpoints
discovered from platform/src/index.ts; payload shapes pinned from
platform/src/pipeline.ts IngestResult.
"""

from __future__ import annotations

from typing import Any, Literal

import httpx

from _common.config import HTTP_TIMEOUT_SECONDS, PLATFORM_BASE_URL

ContentType = Literal["prose", "code-ts", "code-sql"]


class MnemoClientError(RuntimeError):
    """Non-2xx response from the platform."""


class MnemoClient:
    """Thin Mnemo HTTP client. Stateful only in its base_url + httpx client."""

    def __init__(
        self,
        base_url: str = PLATFORM_BASE_URL,
        timeout: float = HTTP_TIMEOUT_SECONDS,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._http = httpx.Client(base_url=self.base_url, timeout=timeout)

    def __enter__(self) -> "MnemoClient":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        self._http.close()

    def health(self) -> dict[str, Any]:
        """GET /health — returns {status, db, ml, qdrant}."""
        r = self._http.get("/health")
        r.raise_for_status()
        return r.json()

    def ingest(
        self,
        text: str,
        source: str | None = None,
        content_type: ContentType | None = None,
    ) -> dict[str, Any]:
        """POST /ingest — runs the synchronous pipeline (store + extract +
        optional causal agent) and returns the full IngestResult."""
        payload: dict[str, Any] = {"text": text}
        if source is not None:
            payload["source"] = source
        if content_type is not None:
            payload["contentType"] = content_type
        r = self._http.post("/ingest", json=payload)
        if r.status_code != 200:
            raise MnemoClientError(f"ingest failed: {r.status_code} {r.text[:200]}")
        return r.json()

    def query(self, question: str) -> dict[str, Any]:
        """POST /api/reason/query — invokes the reasoning agent.

        Returns {triggered: bool, result: str, durationMs: number}.
        The benchmark uses `result` as Mnemo's answer.
        """
        r = self._http.post("/api/reason/query", json={"question": question})
        if r.status_code == 504:
            # Bead nmemo-2yv.76 — reasoning agent timeout. Surface as a
            # specific exception so benchmarks can distinguish from 5xx.
            raise MnemoClientError(f"reasoning timeout (504): {r.text[:200]}")
        if r.status_code != 200:
            raise MnemoClientError(f"query failed: {r.status_code} {r.text[:200]}")
        return r.json()

    def stats(self) -> dict[str, Any]:
        """GET /api/viz/stats — entity/fact/causal-event/causal-edge counts."""
        r = self._http.get("/api/viz/stats")
        r.raise_for_status()
        return r.json()
