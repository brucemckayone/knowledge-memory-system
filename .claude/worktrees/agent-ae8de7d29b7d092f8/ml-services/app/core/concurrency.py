"""
Bounded work-queue pools for ML service concurrency control.

Two resource pools gate access to the expensive backends:
  - ollama_pool: embedding calls to the Ollama HTTP API
  - llm_pool:    LLM subprocess calls (Claude CLI, Z.AI, etc.)

Each pool has N long-lived worker tasks pulling from a bounded
asyncio.Queue.  Requests land in the buffer instantly; workers
dispatch them to the thread pool one at a time.  When the buffer
is full (safety valve), QueueFullError → HTTP 503.
"""

import asyncio
import logging
import os

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Configuration (env vars, per uvicorn worker process)
# ---------------------------------------------------------------------------
OLLAMA_WORKERS = int(os.getenv("ML_OLLAMA_WORKERS", "4"))
OLLAMA_BUFFER = int(os.getenv("ML_OLLAMA_BUFFER", "100"))

LLM_WORKERS = int(os.getenv("ML_LLM_WORKERS", "6"))
LLM_BUFFER = int(os.getenv("ML_LLM_BUFFER", "100"))

THREAD_POOL_SIZE = int(os.getenv("ML_THREAD_POOL_SIZE", "20"))


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------
class QueueFullError(Exception):
    """Raised when a ResourcePool's buffer is at capacity."""
    pass


# ---------------------------------------------------------------------------
# ResourcePool
# ---------------------------------------------------------------------------
class ResourcePool:
    """Bounded producer-consumer work queue with a fixed worker count.

    submit(fn, *a, **kw) drops a job into the buffer and returns a Future.
    Workers pull jobs and run them via asyncio.to_thread().
    """

    def __init__(self, name: str, workers: int, buffer_size: int):
        self.name = name
        self._worker_count = workers
        self._buffer_size = buffer_size
        self._queue: asyncio.Queue | None = None  # created lazily
        self._started = False
        self._active = 0

    # -- lifecycle -----------------------------------------------------------

    def _ensure_started(self) -> None:
        """Lazily create queue + worker tasks on first submit (needs a running loop)."""
        if self._started:
            return
        self._queue = asyncio.Queue(maxsize=self._buffer_size)
        for i in range(self._worker_count):
            asyncio.create_task(self._worker(i))
        self._started = True
        logger.info(
            "%s pool started: %d workers, buffer=%d",
            self.name, self._worker_count, self._buffer_size,
        )

    async def _worker(self, worker_id: int) -> None:
        """Long-lived worker task — pulls jobs from the queue forever."""
        while True:
            fn, args, kwargs, future = await self._queue.get()
            self._active += 1
            try:
                result = await asyncio.to_thread(fn, *args, **kwargs)
                if not future.cancelled():
                    future.set_result(result)
            except Exception as exc:
                if not future.cancelled():
                    future.set_exception(exc)
            finally:
                self._active -= 1
                self._queue.task_done()

    # -- public API ----------------------------------------------------------

    async def submit(self, fn, *args, **kwargs):
        """Enqueue a blocking callable and await its result.

        The callable runs in a thread via asyncio.to_thread().
        Raises QueueFullError if the buffer is at capacity.
        """
        self._ensure_started()
        future = asyncio.get_running_loop().create_future()
        try:
            self._queue.put_nowait((fn, args, kwargs, future))
        except asyncio.QueueFull:
            raise QueueFullError(
                f"{self.name}: buffer full ({self._buffer_size})"
            )
        return await future

    @property
    def stats(self) -> dict:
        queued = self._queue.qsize() if self._queue else 0
        return {
            "active": self._active,
            "queued": queued,
            "total_pending": self._active + queued,
            "workers": self._worker_count,
            "buffer_size": self._buffer_size,
        }


# ---------------------------------------------------------------------------
# Singletons (one per uvicorn worker process)
# ---------------------------------------------------------------------------
ollama_pool = ResourcePool("ollama", OLLAMA_WORKERS, OLLAMA_BUFFER)
llm_pool = ResourcePool("llm", LLM_WORKERS, LLM_BUFFER)
