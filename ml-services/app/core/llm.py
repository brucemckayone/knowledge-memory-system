"""
Core LLM Service
Provides LLM backends: Claude Code CLI (default) and Z.AI GLM-4.7 (legacy).
Switch via LLM_PROVIDER env var: "claude" (default) or "zai".
"""

import json
import logging
import os
import re
import shutil
import subprocess
from typing import Optional, Dict, Any, List, Callable, Protocol, Type, TypeVar, Tuple, runtime_checkable

from pydantic import BaseModel, ConfigDict
from fastapi import HTTPException

T = TypeVar("T", bound=BaseModel)
logger = logging.getLogger(__name__)


def _find_json_structure(text: str) -> Optional[str]:
    """Find the first balanced JSON object or array in text."""
    for i, ch in enumerate(text):
        if ch in ('{', '['):
            close = '}' if ch == '{' else ']'
            depth = 0
            in_string = False
            escape = False
            for j in range(i, len(text)):
                c = text[j]
                if escape:
                    escape = False
                    continue
                if c == '\\' and in_string:
                    escape = True
                    continue
                if c == '"':
                    in_string = not in_string
                    continue
                if in_string:
                    continue
                if c == ch:
                    depth += 1
                elif c == close:
                    depth -= 1
                    if depth == 0:
                        return text[i:j + 1]
    return None

# ---------------------------------------------------------------------------
# Task defaults for Claude Code provider
# Callers can pass options={"task": "classify"} to use these, or override
# any value directly via options={"model": "opus", "effort": "high"}.
# ---------------------------------------------------------------------------
TASK_DEFAULTS: Dict[str, Dict[str, str]] = {
    "classify":              {"model": "haiku",  "effort": "low"},
    "extract_task":          {"model": "haiku",  "effort": "low"},
    "extract_entities":      {"model": "haiku",  "effort": "low"},
    "extract_task_enhanced": {"model": "haiku",  "effort": "low"},
    "summarize":             {"model": "haiku",  "effort": "low"},
    "extract_relationships": {"model": "haiku",  "effort": "low"},
    "reader":                {"model": "haiku",  "effort": "low"},
    "parse_transcript":      {"model": "haiku",  "effort": "low"},
    "resolve_entity":        {"model": "haiku",  "effort": "low"},
    "ontology":              {"model": "haiku",  "effort": "low"},
    "chat":                  {"model": "haiku",  "effort": "low"},
    "check_contradiction":   {"model": "haiku",  "effort": "low"},
    "judge":                 {"model": "haiku",  "effort": "low"},
    "extract_agentic":       {"model": "haiku",  "effort": "low"},
    "graph_agent":           {"model": "haiku",  "effort": "low"},
    "reconciliation_agent":  {"model": "haiku",  "effort": "low"},
    "arbiter_agent":         {"model": "haiku",  "effort": "low"},
    "causal_agent":          {"model": "haiku",  "effort": "low"},
    "gardener_agent":        {"model": "haiku",  "effort": "low"},
    "reasoning_agent":       {"model": "haiku",  "effort": "low"},
    "pattern_naming":        {"model": "haiku",  "effort": "low"},
}
DEFAULT_MODEL = "haiku"
DEFAULT_EFFORT = "low"

# Fallback always escalates to the most capable model.
FALLBACK_MAP: Dict[str, str] = {
    "haiku":  "sonnet",
    "sonnet": "opus",
}


# ---------------------------------------------------------------------------
# Normalised usage record — the provider-agnostic capture contract
# ---------------------------------------------------------------------------
# This is the single shape every LLM call produces, defined by the token-usage
# design doc (docs/architecture/token-usage/00-token-usage-and-cost-tracking.md
# §4.1) and the companion spec (02-usage-record-spec.md). It is the contract that
# survives the future multi-model / LiteLLM routing migration.
#
# THE NORMALISATION CONTRACT (design §4.1, §9.2 — the blocking token-semantics
# gate). The token buckets must SUM TO THE BILLED TOTAL, so `input_tokens` is
# always the UNCACHED REMAINDER, never the full prompt:
#   - Anthropic-shaped (Claude CLI, Pi bridge): the provider already reports
#     `input_tokens` as the uncached remainder and `cache_read` / `cache_creation`
#     separately. Map straight through; split `cache_creation` into the 5m/1h
#     TTL buckets. See _anthropic_cache_buckets.
#   - OpenAI-shaped (ZAI today; LiteLLM/OpenRouter tomorrow): the provider's
#     `prompt_tokens` is the TOTAL prompt and `prompt_tokens_details.cached_tokens`
#     is a SUBSET of it (not an addend). The adapter MUST compute
#     `input_tokens = prompt_tokens - cached_tokens` and
#     `cache_read_tokens = cached_tokens`. A naive adapter that maps both and sums
#     all four double-counts cache — corrupting exactly the cheap-model tier the
#     routing analysis exists to prove. See _parse_openai_usage; the invariant
#     `input_tokens + cache_read_tokens == prompt_tokens` is asserted by a test.
#
# This module DOES NOT PRICE anything. Pricing is single-source-of-truth in
# TypeScript (config.ts PRICING); ml-services emits token counts only. The only
# USD value we ever carry is `gateway_reported_usd`, populated solely when a
# gateway (LiteLLM) returns an authoritative cost — never the Claude CLI's own
# estimate.
class UsageRecord(BaseModel):
    """Normalised, provider-agnostic token-usage for one LLM call (design §4.1)."""

    # `model_group` collides with pydantic's protected `model_` namespace; the
    # field name is fixed by the design contract, so opt out of the guard.
    model_config = ConfigDict(protected_namespaces=())

    requested_model: str                            # model id we asked for (alias/group ok)
    resolved_model: str                             # model that actually served (== requested for non-gateway)
    model_group: Optional[str] = None               # routing alias, when a gateway resolves one
    provider: str                                   # anthropic | zai | ollama | litellm | ...
    input_tokens: int = 0                           # UNCACHED remainder (see contract above)
    output_tokens: int = 0
    reasoning_output_tokens: Optional[int] = None   # subset of output; reasoning models only
    cache_read_tokens: int = 0
    cache_write_5m_tokens: int = 0                  # Anthropic 5-min-TTL cache writes
    cache_write_1h_tokens: int = 0                  # Anthropic 1-hour-TTL cache writes
    tool_calls: Optional[int] = None                # agent loop length; agents only
    turns: Optional[int] = None
    latency_ms: Optional[int] = None
    request_id: Optional[str] = None                # upstream provider request id if exposed
    gateway_request_id: Optional[str] = None        # LiteLLM call id, for SpendLogs reconciliation
    gateway_reported_usd: Optional[float] = None    # authoritative cost when a gateway returns one


class UsageEcho(BaseModel):
    """The ``usage`` field attached to every live ml-services response (design §4.2).

    ``calls`` is the per-call list; ``totals`` is the summed convenience view.
    Benchmarks accumulate ``totals`` in-memory (it survives /api/reset); the
    platform reads ``calls`` to price + persist one row per call.
    """

    calls: List[UsageRecord] = []
    totals: Dict[str, int] = {}


class UsageAccumulator:
    """Per-request, mutable container of UsageRecords (design §4.1, §4.2, §6).

    PURE CAPTURE: it appends records and exposes running totals; it never raises
    on capture and never enforces anything. The per-trace cost ceiling (B10) is a
    separate optional guard that merely *reads* the running totals — so a capture
    bug can only ever lose a metric, never abort a production agent loop.

    One accumulator is created per HTTP request and passed as a normal argument to
    the provider callable through ``ResourcePool.submit`` (the pool itself stays
    usage-agnostic). Because each request owns its own accumulator, the shared
    worker pool never interleaves usage across concurrent requests.
    """

    def __init__(self) -> None:
        self.records: List[UsageRecord] = []

    def append(self, record: Optional[UsageRecord]) -> None:
        """Append a record. ``None`` (e.g. a call with no usage block) is ignored."""
        if record is not None:
            self.records.append(record)

    def totals(self) -> Dict[str, int]:
        """Summed buckets in the HTTP-echo shape (design §4.2)."""
        totals = {
            "input": 0, "output": 0, "cache_read": 0,
            "cache_write_5m": 0, "cache_write_1h": 0, "calls": 0,
        }
        for record in self.records:
            totals["input"] += record.input_tokens
            totals["output"] += record.output_tokens
            totals["cache_read"] += record.cache_read_tokens
            totals["cache_write_5m"] += record.cache_write_5m_tokens
            totals["cache_write_1h"] += record.cache_write_1h_tokens
            totals["calls"] += 1
        return totals

    def echo(self) -> UsageEcho:
        """Build the response-body usage echo (design §4.2)."""
        return UsageEcho(calls=list(self.records), totals=self.totals())


def usage_accumulator() -> UsageAccumulator:
    """FastAPI dependency: a fresh per-request UsageAccumulator (design §4.2).

    One accumulator per request, so the shared worker pool never bleeds usage
    across concurrent requests. Handlers inject this, pass it into
    ``llm_pool.submit(..., accumulator=…)``, and echo ``accumulator.echo()`` on
    the response body.
    """
    return UsageAccumulator()


def _anthropic_cache_buckets(cost: Dict[str, Any]) -> Tuple[int, int, int]:
    """Split an Anthropic-shaped cost dict into (cache_read, write_5m, write_1h).

    Tolerates both spellings seen in the wild: the nested API form
    ``cache_creation.ephemeral_5m_input_tokens`` / ``ephemeral_1h_input_tokens``
    and a flat single-bucket form (``cache_creation_input_tokens``), which is
    attributed to the default 5-minute TTL. ``or 0`` guards against null fields.
    """
    cache_read = int(
        cost.get("cache_read_tokens")
        or cost.get("cache_read_input_tokens")
        or 0
    )
    creation = cost.get("cache_creation")
    if isinstance(creation, dict):
        write_5m = int(creation.get("ephemeral_5m_input_tokens") or 0)
        write_1h = int(creation.get("ephemeral_1h_input_tokens") or 0)
        if write_5m == 0 and write_1h == 0:
            # Nested object present but without a TTL breakdown — fall back to the
            # flat total (default 5m TTL) so cache-write tokens are never dropped.
            write_5m = int(cost.get("cache_creation_input_tokens") or 0)
    else:
        write_5m = int(
            cost.get("cache_write_5m_tokens")
            or cost.get("cache_creation_input_tokens")
            or 0
        )
        write_1h = int(cost.get("cache_write_1h_tokens") or 0)
    return cache_read, write_5m, write_1h


def _attr(obj: Any, name: str, default: Any = None) -> Any:
    """Read ``name`` from either a mapping or an SDK object (attribute access)."""
    if obj is None:
        return default
    if isinstance(obj, dict):
        return obj.get(name, default)
    return getattr(obj, name, default)


def _safe_capture(
    accumulator: Optional["UsageAccumulator"],
    parse: Callable[[], Optional["UsageRecord"]],
    label: str,
) -> None:
    """Append a parsed UsageRecord to the accumulator, non-fatally (design §6).

    The single capture guard shared by every provider: it no-ops when there is no
    accumulator, and swallows any parse/append error with a warning. Capture must
    never break a successful generation — a capture bug can only ever lose a
    metric, never abort a production agent loop.
    """
    if accumulator is None:
        return
    try:
        accumulator.append(parse())
    except Exception:  # noqa: BLE001 — capture is best-effort, never fatal
        logger.warning("%s usage capture failed (non-fatal)", label, exc_info=True)


# ---------------------------------------------------------------------------
# Provider Protocol — the adapter contract
# ---------------------------------------------------------------------------
@runtime_checkable
class LLMProvider(Protocol):
    """Interface that all LLM adapters must satisfy.

    Endpoints import `llm_client` and call these methods.
    Each adapter translates `options` into provider-specific flags.
    """

    def generate(
        self,
        prompt: str,
        options: Optional[Dict[str, Any]] = None,
        accumulator: Optional["UsageAccumulator"] = None,
    ) -> str: ...

    def generate_json(
        self,
        prompt: str,
        response_model: Optional[Type[T]] = None,
        options: Optional[Dict[str, Any]] = None,
        accumulator: Optional["UsageAccumulator"] = None,
    ) -> Any: ...

    def extract_json(self, text: str) -> Dict[str, Any]: ...


# ---------------------------------------------------------------------------
# Claude Code CLI Provider
# ---------------------------------------------------------------------------
class ClaudeCodeProvider:
    """LLM provider that shells out to Claude Code CLI.

    Supports per-call configuration via the options dict:
        model          - "haiku", "sonnet", "opus", or a full model ID
        effort         - "low", "medium", "high", "max" (opus only)
        task           - key into TASK_DEFAULTS for automatic model/effort
        tools          - "" to disable, "default" for all, or "Bash,Read,..."
        max_turns      - int, how many agentic turns (default 1)
        system_prompt  - replaces the default system prompt entirely
        fallback_model - override automatic upward fallback
        mcp_config     - path to MCP config JSON (--mcp-config)
        timeout        - subprocess timeout in seconds (default 300)
    """

    def __init__(self) -> None:
        if not shutil.which("claude"):
            raise RuntimeError(
                "Claude Code CLI not found on PATH. "
                "Install from https://claude.ai/code or ensure 'claude' is accessible."
            )

    # -- internal helpers --------------------------------------------------

    def _resolve(self, key: str, options: Optional[Dict] = None) -> str:
        """Resolve a setting: explicit option > task default > global default."""
        if options and options.get(key):
            return str(options[key])
        task = (options or {}).get("task", "")
        task_defaults = TASK_DEFAULTS.get(task, {})
        if key in task_defaults:
            return task_defaults[key]
        if key == "model":
            return DEFAULT_MODEL
        if key == "effort":
            return DEFAULT_EFFORT
        return ""

    def _build_cmd(
        self,
        prompt: str,
        options: Optional[Dict] = None,
        json_schema: Optional[Dict] = None,
    ) -> list:
        """Build the claude CLI command list."""
        opts = options or {}
        model = self._resolve("model", opts)
        effort = self._resolve("effort", opts)

        cmd = [
            "claude", "-p", prompt,
            "--output-format", "json",
            "--model", model,
            "--effort", effort,
            "--no-session-persistence",
        ]

        # Fallback: explicit override or automatic upward escalation
        fallback = opts.get("fallback_model") or FALLBACK_MAP.get(model)
        if fallback:
            cmd.extend(["--fallback-model", fallback])

        # System prompt (replaces default Claude Code prompt entirely)
        # Use --system-prompt-file for long prompts to avoid CLI length limits
        system_prompt = opts.get("system_prompt")
        if system_prompt:
            import tempfile
            prompt_file = tempfile.NamedTemporaryFile(
                mode='w', suffix='.txt', delete=False, encoding='utf-8',
            )
            prompt_file.write(system_prompt)
            prompt_file.close()
            cmd.extend(["--system-prompt-file", prompt_file.name])

        # Tools: None → disabled (""), "mcp" → omit (MCP tools come via --mcp-config),
        # explicit value passed through
        tools = opts.get("tools")
        if tools == "mcp":
            pass  # MCP tools provided by --mcp-config, don't pass --tools
        elif tools is None:
            cmd.extend(["--tools", ""])
        elif isinstance(tools, list):
            cmd.extend(["--tools", ",".join(tools)])
        else:
            cmd.extend(["--tools", str(tools)])

        # MCP config (connects Claude Code to MCP tool servers)
        mcp_config = opts.get("mcp_config")
        if mcp_config:
            cmd.extend([
                "--mcp-config", str(mcp_config),
                "--strict-mcp-config",
            ])
            # MCP tools must be explicitly allowed in -p mode (no interactive prompt)
            mcp_server = opts.get("mcp_server_name", "mnemo-graph")
            cmd.extend(["--allowedTools", f"mcp__{mcp_server}__*"])

        # Structured output via JSON schema
        if json_schema:
            cmd.extend(["--json-schema", json.dumps(json_schema)])

        # Max turns: default 1 (pure LLM), but --json-schema uses a tool
        # call internally which consumes an extra turn, so minimum 2.
        default_turns = 2 if json_schema else 1
        max_turns = str(opts.get("max_turns", default_turns))
        cmd.extend(["--max-turns", max_turns])

        return cmd

    def _run(self, cmd: list, options: Optional[Dict] = None) -> Dict[str, Any]:
        """Execute CLI command and return the parsed JSON envelope.

        Bead nmemo-klv.10: when the CLI exits non-zero, surface a structured
        detail dict containing rc, stderr_tail, stdout_tail, and cmd_summary
        so callers (and the platform's ``agentFetch`` wrapper) get an
        actionable failure body instead of a 200-char stderr fragment. The
        ``error`` field carries a stable single-line summary for callers that
        only render strings.
        """
        timeout = (options or {}).get("timeout", 300)
        # Summarise the cmd up-front (first 10 tokens) so it can appear in
        # both the log line and the failure detail without recomputing.
        cmd_summary = " ".join(str(c) for c in cmd[:10])
        if len(cmd) > 10:
            cmd_summary += " ..."
        logger.info("Claude CLI cmd: %s", cmd_summary)

        try:
            result = subprocess.run(
                cmd, capture_output=True, text=True, timeout=timeout,
                encoding="utf-8", errors="replace",
            )
        except subprocess.TimeoutExpired:
            raise HTTPException(
                status_code=504,
                detail=f"Claude CLI timed out after {timeout}s",
            )

        logger.info("Claude CLI rc=%d stdout=%d stderr=%d",
                    result.returncode, len(result.stdout or ''), len(result.stderr or ''))
        if result.stderr:
            logger.info("Claude CLI stderr: %s", result.stderr[:500])

        if result.returncode != 0:
            # Capture diagnostic tails. stderr is the primary signal; stdout
            # is included because Claude CLI sometimes emits partial JSON
            # envelopes on stdout before exiting non-zero (auth prompts, MCP
            # config errors). Tails are bounded so very large bodies don't
            # explode the HTTP response.
            stderr_tail = (result.stderr or "")[-2000:]
            stdout_tail = (result.stdout or "")[-500:]
            summary = (
                f"Claude CLI failed (rc={result.returncode}): "
                f"{stderr_tail.strip() or '<empty stderr>'}"
            )
            logger.error(
                "Claude CLI failed (rc=%d) cmd=%s stderr=%s stdout=%s",
                result.returncode, cmd_summary,
                stderr_tail[:500], stdout_tail[:200],
            )
            raise HTTPException(
                status_code=500,
                detail={
                    "error": summary,
                    "rc": result.returncode,
                    "stderr_tail": stderr_tail,
                    "stdout_tail": stdout_tail,
                    "cmd_summary": cmd_summary,
                },
            )

        try:
            data = json.loads(result.stdout)
        except json.JSONDecodeError:
            # Shouldn't happen with --output-format json, but degrade gracefully
            logger.warning("Claude CLI returned non-JSON output, wrapping as raw text")
            return {"result": result.stdout.strip()}

        # Log cost/usage for observability. The CLI envelope carries usage under
        # "usage" + the dollar total under "total_cost_usd" (no "cost" key); fall
        # back to a flat "cost" dict for synthetic/older envelopes.
        usage_obj = data.get("usage") or data.get("cost") or {}
        if usage_obj:
            logger.info(
                "llm call: model=%s task=%s cost=$%.4f in=%d out=%d",
                self._resolve("model", options),
                (options or {}).get("task", "unknown"),
                data.get("total_cost_usd") or usage_obj.get("estimated_usd", 0) or 0,
                usage_obj.get("input_tokens", 0),
                usage_obj.get("output_tokens", 0),
            )

        return data

    # -- usage capture (design §4.1) ----------------------------------------

    def _parse_usage_record(
        self,
        data: Dict[str, Any],
        options: Optional[Dict[str, Any]] = None,
        latency_ms: Optional[int] = None,
    ) -> Optional[UsageRecord]:
        """Normalise the Claude CLI ``cost`` envelope into a UsageRecord.

        Anthropic-shaped: ``input_tokens`` is already the uncached remainder, so
        it maps straight through; ``cache_creation`` is split into 5m/1h TTL
        buckets. The CLI's own ``estimated_usd`` is deliberately NOT carried —
        pricing is single-source-of-truth in TypeScript (design §4.4). Returns
        None when the envelope has no cost block (e.g. a degraded raw-text wrap).
        """
        # The Claude CLI `--output-format json` envelope carries token usage under
        # "usage" (Anthropic-shaped: input_tokens, output_tokens,
        # cache_read_input_tokens, cache_creation.ephemeral_5m/1h_input_tokens),
        # with the dollar total under "total_cost_usd" and the served model under
        # "modelUsage". Synthetic/older envelopes use a flat "cost" dict — prefer
        # "usage", fall back to "cost". (Verified against the live CLI in the B11
        # E2E: there is no top-level "cost" key.)
        usage = data.get("usage") or data.get("cost") or {}
        if not usage:
            return None
        cache_read, write_5m, write_1h = _anthropic_cache_buckets(usage)
        requested = self._resolve("model", options) or DEFAULT_MODEL
        model_usage = data.get("modelUsage") or {}
        resolved = str(next(iter(model_usage), None) or data.get("model") or requested)
        turns = data.get("num_turns", data.get("turns"))
        session_id = data.get("session_id")
        return UsageRecord(
            requested_model=requested,
            resolved_model=resolved,
            provider="anthropic",
            input_tokens=int(usage.get("input_tokens") or 0),
            output_tokens=int(usage.get("output_tokens") or 0),
            cache_read_tokens=cache_read,
            cache_write_5m_tokens=write_5m,
            cache_write_1h_tokens=write_1h,
            turns=int(turns) if turns is not None else None,
            request_id=str(session_id) if session_id else None,
            latency_ms=latency_ms,
        )

    # -- public interface (LLMProvider) -------------------------------------

    def generate(
        self,
        prompt: str,
        options: Optional[Dict[str, Any]] = None,
        accumulator: Optional["UsageAccumulator"] = None,
    ) -> str:
        """Generate a text response."""
        cmd = self._build_cmd(prompt, options)
        data = self._run(cmd, options)
        _safe_capture(accumulator, lambda: self._parse_usage_record(data, options), "claude")
        return data.get("result", "")

    def extract_json(self, text: str) -> Dict[str, Any]:
        """Extract and parse JSON from text.

        Handles markdown code fences and trailing LLM commentary.
        Uses bracket-matching to find the first complete JSON structure.
        """
        stripped = re.sub(r'^```(?:json)?\s*\n?', '', text.strip())
        stripped = re.sub(r'\n?```\s*$', '', stripped).strip()

        # Fast path: entire string is valid JSON
        try:
            return json.loads(stripped)
        except json.JSONDecodeError:
            pass

        # Find first balanced JSON structure (handles trailing text)
        json_str = _find_json_structure(stripped)
        if json_str:
            return json.loads(json_str)

        raise ValueError(f"Could not parse JSON from response: {text[:200]}...")

    def generate_json(
        self,
        prompt: str,
        response_model: Optional[Type[T]] = None,
        options: Optional[Dict[str, Any]] = None,
        accumulator: Optional["UsageAccumulator"] = None,
    ) -> Any:
        """Generate and parse a JSON response.

        If response_model is provided, its JSON schema is sent to Claude via
        --json-schema for server-side validation. The validated object comes
        back in the 'structured_output' field. Otherwise, the text result is
        parsed with extract_json().
        """
        json_schema = None
        if response_model:
            json_schema = response_model.model_json_schema()

        cmd = self._build_cmd(prompt, options, json_schema=json_schema)
        data = self._run(cmd, options)
        _safe_capture(accumulator, lambda: self._parse_usage_record(data, options), "claude")

        # When --json-schema was used, prefer structured_output
        if json_schema and "structured_output" in data:
            parsed = data["structured_output"]
            if response_model:
                return response_model.model_validate(parsed)
            return parsed

        # Fallback: parse the text result
        text = data.get("result", "")
        try:
            parsed = self.extract_json(text)
        except ValueError as e:
            raise ValueError(f"JSON parsing failed: {e}")

        if response_model:
            try:
                return response_model.model_validate(parsed)
            except Exception as e:
                raise ValueError(f"Schema validation failed: {e}")

        return parsed


# ---------------------------------------------------------------------------
# Z.AI GLM-4.7 Provider (legacy)
# ---------------------------------------------------------------------------
class ZAIProvider:
    """LLM provider using Z.AI GLM-4.7 via OpenAI-compatible API."""

    def __init__(self, model: str = "glm-4.7") -> None:
        self.model = model
        api_key = os.getenv("ZAI_API_KEY")
        if not api_key:
            raise ValueError("ZAI_API_KEY environment variable is required")

        from openai import OpenAI
        self.client = OpenAI(
            api_key=api_key,
            base_url="https://api.z.ai/api/coding/paas/v4",
            timeout=120.0,
        )

    def generate(
        self,
        prompt: str,
        options: Optional[Dict[str, Any]] = None,
        accumulator: Optional["UsageAccumulator"] = None,
    ) -> str:
        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {
                        "role": "system",
                        "content": (
                            "You are a helpful AI assistant. When asked to return JSON, "
                            "return ONLY the raw JSON object or array. Never wrap it in "
                            "markdown code fences or any other formatting."
                        ),
                    },
                    {"role": "user", "content": prompt},
                ],
                temperature=options.get("temperature", 0.1) if options else 0.1,
                max_tokens=options.get("num_predict", 16384) if options else 16384,
            )
            content = response.choices[0].message.content or ""
            # Capture usage that ZAI previously discarded. Routed through the
            # shared non-fatal helper so a parse/append bug can never fail a
            # successful generation (design §6). The OpenAI-shaped remainder rule
            # lives in _parse_openai_usage; see 02-usage-record-spec.md (§4.1).
            _safe_capture(accumulator, lambda: self._parse_openai_usage(response), "zai")
            return content
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=f"LLM generation failed: {str(e)}",
            )

    def _parse_openai_usage(
        self,
        response: Any,
        latency_ms: Optional[int] = None,
    ) -> Optional[UsageRecord]:
        """Normalise an OpenAI-shaped ``response.usage`` into a UsageRecord.

        Applies the remainder rule (design §4.1, §9.2): the provider reports
        ``prompt_tokens`` as the TOTAL prompt and ``cached_tokens`` as a SUBSET,
        so ``input_tokens = prompt_tokens - cached_tokens`` and
        ``cache_read_tokens = cached_tokens``. This keeps the buckets summing to
        the billed total and preserves the invariant
        ``input_tokens + cache_read_tokens == prompt_tokens``. Returns None when
        the response carries no usage object.
        """
        usage = _attr(response, "usage")
        if usage is None:
            return None
        prompt_tokens = int(_attr(usage, "prompt_tokens", 0) or 0)
        completion_tokens = int(_attr(usage, "completion_tokens", 0) or 0)
        # cached is a SUBSET of prompt_tokens; clamp it so the buckets always sum
        # to the billed total (input + cache_read == prompt_tokens) even if a
        # gateway misreports cached > prompt.
        cached = min(
            int(_attr(_attr(usage, "prompt_tokens_details"), "cached_tokens", 0) or 0),
            prompt_tokens,
        )
        # reasoning_output is a SUBSET of completion_tokens; clamp it (symmetric
        # with the cached clamp above) so a misreporting gateway with
        # reasoning > output can never bill more reasoning than output emitted.
        reasoning = _attr(_attr(usage, "completion_tokens_details"), "reasoning_tokens")
        reasoning = min(int(reasoning), completion_tokens) if reasoning is not None else None
        resolved = str(_attr(response, "model", self.model) or self.model)
        request_id = _attr(response, "id")
        return UsageRecord(
            requested_model=self.model,
            resolved_model=resolved,
            provider="zai",
            input_tokens=prompt_tokens - cached,
            output_tokens=completion_tokens,
            reasoning_output_tokens=reasoning,
            cache_read_tokens=cached,
            request_id=str(request_id) if request_id else None,
            latency_ms=latency_ms,
        )

    def extract_json(self, text: str) -> Dict[str, Any]:
        stripped = re.sub(r'^```(?:json)?\s*\n?', '', text.strip())
        stripped = re.sub(r'\n?```\s*$', '', stripped).strip()

        try:
            return json.loads(stripped)
        except json.JSONDecodeError:
            pass

        json_str = _find_json_structure(stripped)
        if json_str:
            return json.loads(json_str)

        raise ValueError(f"Could not parse JSON from response: {text[:200]}...")

    def generate_json(
        self,
        prompt: str,
        response_model: Optional[Type[T]] = None,
        options: Optional[Dict[str, Any]] = None,
        accumulator: Optional["UsageAccumulator"] = None,
    ) -> Any:
        text = self.generate(prompt, options, accumulator=accumulator)
        try:
            data = self.extract_json(text)
            if response_model:
                try:
                    return response_model.model_validate(data)
                except Exception as e:
                    raise ValueError(f"Schema validation failed: {str(e)}")
            return data
        except ValueError as e:
            raise ValueError(f"JSON parsing failed: {str(e)}")


# ---------------------------------------------------------------------------
# Pi SDK Bridge Provider
# ---------------------------------------------------------------------------
class PiBridgeProvider:
    """LLM provider that delegates to the Pi Agent Bridge service.

    The bridge is a Node.js service (pi-agent-bridge.ts) that uses the Pi
    SDK to run agentic tool-use loops in-process. It registers the graph
    tools via defineTool() and runs createAgentSession() per request.

    This replaces the Claude Code subprocess + MCP server pattern:
    - No subprocess per invocation
    - No MCP config files on disk
    - No MCP server subprocess (tools are in-process)
    - Direct function calls to handleToolCall() instead of JSON-RPC

    Switch to this provider via: LLM_PROVIDER=pi
    """

    BRIDGE_URL = os.getenv("PI_BRIDGE_URL", "http://localhost:3099")

    def __init__(self) -> None:
        # Eagerly check bridge is reachable (health check)
        try:
            import httpx
            resp = httpx.get(f"{self.BRIDGE_URL}/health", timeout=5.0)
            if resp.status_code != 200:
                raise RuntimeError(f"Pi bridge health check failed: {resp.status_code}")
            info = resp.json()
            logger.info(
                "Pi Agent Bridge connected: service=%s tools=%s",
                info.get("service"), info.get("tools"),
            )
        except Exception as e:
            raise RuntimeError(
                f"Pi Agent Bridge not reachable at {self.BRIDGE_URL}: {e}. "
                "Start it with: npx tsx src/services/pi-agent-bridge.ts"
            )

    # -- public interface (LLMProvider) -------------------------------------

    def generate(
        self,
        prompt: str,
        options: Optional[Dict[str, Any]] = None,
        accumulator: Optional["UsageAccumulator"] = None,
    ) -> str:
        """Generate a response via the Pi Agent Bridge."""
        import httpx

        opts = options or {}
        timeout = opts.get("timeout", 300)

        payload = {
            "prompt": prompt,
            "system_prompt": opts.get("system_prompt", ""),
            "provider": opts.get("provider", os.getenv("PI_PROVIDER", "zai")),
            "model": self._resolve("model", opts),
            "thinking": self._map_effort(opts),
            "actor": opts.get("mcp_actor", opts.get("actor", "graph_agent")),
            "timeout": timeout,
        }

        try:
            resp = httpx.post(
                f"{self.BRIDGE_URL}/run",
                json=payload,
                timeout=timeout + 30,  # client timeout > agent timeout
            )
        except httpx.TimeoutException:
            raise HTTPException(
                status_code=504,
                detail=f"Pi bridge timed out after {timeout}s",
            )
        except httpx.ConnectError as e:
            raise HTTPException(
                status_code=503,
                detail=f"Pi bridge unreachable: {e}",
            )

        if resp.status_code != 200:
            detail = resp.text[:500]
            raise HTTPException(
                status_code=resp.status_code,
                detail=f"Pi bridge error: {detail}",
            )

        data = resp.json()

        # Log cost for observability
        cost = data.get("cost", {})
        if cost:
            logger.info(
                "pi bridge: provider=%s model=%s task=%s cost=$%.4f in=%d out=%d tools=%d turns=%d",
                payload["provider"],
                payload["model"],
                opts.get("task", "unknown"),
                cost.get("estimated_usd", 0),
                cost.get("input_tokens", 0),
                cost.get("output_tokens", 0),
                data.get("tool_calls", 0),
                data.get("turns", 0),
            )

        error = data.get("error")
        if error:
            logger.error("Pi bridge agent error: %s", error[:200])

        _safe_capture(accumulator, lambda: self._parse_pi_usage(data, options), "pi")

        return data.get("result", "")

    # -- usage capture (design §4.1) ----------------------------------------

    def _parse_pi_usage(
        self,
        data: Dict[str, Any],
        options: Optional[Dict[str, Any]] = None,
        latency_ms: Optional[int] = None,
    ) -> Optional[UsageRecord]:
        """Normalise the Pi bridge ``cost`` object into a UsageRecord.

        The bridge response is Anthropic-shaped (``input_tokens`` is already the
        uncached remainder), so ``cache_creation`` is split into 5m/1h TTL
        buckets via the shared helper. The bridge also reports ``tool_calls`` and
        ``turns`` for the agentic loop. ``provider`` reflects the underlying
        backend the bridge ran (zai / anthropic) when echoed, else "pi".
        """
        # The Pi bridge builds its own envelope with a "cost" object; tolerate a
        # "usage" shape too (defensive — the bridge's exact shape is unverified
        # since claude, not pi, is the active provider).
        cost = data.get("cost") or data.get("usage") or {}
        if not cost:
            return None
        cache_read, write_5m, write_1h = _anthropic_cache_buckets(cost)
        requested = self._resolve("model", options)
        resolved = str(data.get("model") or requested)
        # Match generate()'s provider resolution so the recorded provider dimension
        # reflects what was actually requested (PI_PROVIDER, default "zai"), not "pi".
        provider = str(
            data.get("provider")
            or (options or {}).get("provider")
            or os.getenv("PI_PROVIDER", "zai")
        )
        tool_calls = data.get("tool_calls")
        turns = data.get("turns")
        return UsageRecord(
            requested_model=requested,
            resolved_model=resolved,
            provider=provider,
            input_tokens=int(cost.get("input_tokens") or 0),
            output_tokens=int(cost.get("output_tokens") or 0),
            cache_read_tokens=cache_read,
            cache_write_5m_tokens=write_5m,
            cache_write_1h_tokens=write_1h,
            tool_calls=int(tool_calls) if tool_calls is not None else None,
            turns=int(turns) if turns is not None else None,
            latency_ms=latency_ms,
        )

    def extract_json(self, text: str) -> Dict[str, Any]:
        """Extract and parse JSON from text (shared with ClaudeCodeProvider)."""
        stripped = re.sub(r'^```(?:json)?\s*\n?', '', text.strip())
        stripped = re.sub(r'\n?```\s*$', '', stripped).strip()

        try:
            return json.loads(stripped)
        except json.JSONDecodeError:
            pass

        json_str = _find_json_structure(stripped)
        if json_str:
            return json.loads(json_str)

        raise ValueError(f"Could not parse JSON from response: {text[:200]}...")

    def generate_json(
        self,
        prompt: str,
        response_model: Optional[Type[T]] = None,
        options: Optional[Dict[str, Any]] = None,
        accumulator: Optional["UsageAccumulator"] = None,
    ) -> Any:
        """Generate and parse a JSON response via the Pi bridge."""
        text = self.generate(prompt, options, accumulator=accumulator)
        try:
            parsed = self.extract_json(text)
        except ValueError as e:
            raise ValueError(f"JSON parsing failed: {e}")

        if response_model:
            try:
                return response_model.model_validate(parsed)
            except Exception as e:
                raise ValueError(f"Schema validation failed: {e}")

        return parsed

    # -- internal helpers ---------------------------------------------------

    def _resolve(self, key: str, options: Optional[Dict] = None) -> str:
        """Resolve a setting: explicit option > task default > Pi default.

        IMPORTANT: TASK_DEFAULTS hold Claude Code model names
        (haiku/sonnet/opus). The Pi/zai (GLM) backend has no models by those
        names, so for the ``model`` key we DELIBERATELY skip the task default
        and fall back to the Pi default (``PI_MODEL`` env, else ``glm-5.1``)
        unless the caller passes an explicit, Pi-compatible ``options["model"]``.
        Previously the task default leaked through and the bridge asked zai for
        a model literally named ``haiku`` → "Model not found: provider=zai
        id=haiku", which broke every task with a TASK_DEFAULTS entry (graph_agent,
        classify, extract_entities, ...) on the pi harness.

        The ``effort`` task default is still honoured — it maps to a Pi thinking
        level via ``_map_effort`` and is provider-independent.
        """
        if options and options.get(key):
            return str(options[key])
        # Claude-specific model names in TASK_DEFAULTS are meaningless to the
        # zai/GLM backend — only consult task defaults for non-model keys.
        if key != "model":
            task = (options or {}).get("task", "")
            task_defaults = TASK_DEFAULTS.get(task, {})
            if key in task_defaults:
                return task_defaults[key]
        # Pi defaults (model is env-overridable to swap GLM versions w/o code change).
        pi_defaults = {"model": os.getenv("PI_MODEL", "glm-5.1"), "provider": "zai"}
        return pi_defaults.get(key, "")

    def _map_effort(self, options: Optional[Dict] = None) -> str:
        """Map Claude-style effort to Pi thinking level."""
        effort = self._resolve("effort", options)
        mapping = {
            "low": "off",
            "medium": "low",
            "high": "medium",
            "max": "high",
        }
        return mapping.get(effort, "off")


# ---------------------------------------------------------------------------
# Factory & singleton
# ---------------------------------------------------------------------------
LLM_PROVIDER = os.getenv("LLM_PROVIDER", "claude")


def create_llm_client() -> LLMProvider:
    """Create the LLM client based on LLM_PROVIDER env var."""
    if LLM_PROVIDER == "zai":
        logger.info("Using ZAI GLM-4.7 LLM provider")
        return ZAIProvider()
    if LLM_PROVIDER == "pi":
        logger.info("Using Pi Agent Bridge LLM provider")
        return PiBridgeProvider()
    logger.info("Using Claude Code CLI LLM provider")
    return ClaudeCodeProvider()


llm_client: LLMProvider = create_llm_client()
