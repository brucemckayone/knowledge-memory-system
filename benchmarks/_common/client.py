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

ContentType = Literal["prose", "code-ts", "code-sql", "conversational"]


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
        stream_id: str | None = None,
    ) -> dict[str, Any]:
        """POST /ingest — stores the memory synchronously and ENQUEUES extraction
        off the request path, returning {"memory_id": ...}.

        Status contract: the success response is **202 Accepted** (the memory is
        stored + idempotent; entity/relationship/fact extraction runs in the
        background and surfaces shortly). 200 is also accepted for back-compat.
        We treat any 2xx as success — a hard `== 200` check would (and did) reject
        the legitimate 202 once /ingest moved extraction async.

        `stream_id` (snake_case in the body, per the platform /ingest handler
        wired in nmemo-3f9.2) scopes speaker identity: speakers are resolved
        and deduped within a stream. Omit it for the implicit single stream
        (back-compat). `content_type='conversational'` makes the graph agent
        apply the first-person conversational addendum (nmemo-3f9.3).
        """
        payload: dict[str, Any] = {"text": text}
        if source is not None:
            payload["source"] = source
        if content_type is not None:
            payload["contentType"] = content_type
        if stream_id is not None:
            payload["stream_id"] = stream_id
        r = self._http.post("/ingest", json=payload)
        if not (200 <= r.status_code < 300):
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

    def reset(self) -> dict[str, Any]:
        """POST /api/reset — clears Postgres + Qdrant.

        Required between LongMemEval questions (each item has its own
        independent haystack; contamination breaks the abstention category).
        """
        r = self._http.post("/api/reset", json={})
        if r.status_code != 200:
            raise MnemoClientError(f"reset failed: {r.status_code} {r.text[:200]}")
        return r.json()
