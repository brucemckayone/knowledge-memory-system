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
from typing import Optional, Dict, Any, Protocol, Type, TypeVar, runtime_checkable

from pydantic import BaseModel
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
# Provider Protocol — the adapter contract
# ---------------------------------------------------------------------------
@runtime_checkable
class LLMProvider(Protocol):
    """Interface that all LLM adapters must satisfy.

    Endpoints import `llm_client` and call these methods.
    Each adapter translates `options` into provider-specific flags.
    """

    def generate(
        self, prompt: str, options: Optional[Dict[str, Any]] = None,
    ) -> str: ...

    def generate_json(
        self,
        prompt: str,
        response_model: Optional[Type[T]] = None,
        options: Optional[Dict[str, Any]] = None,
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
        """Execute CLI command and return the parsed JSON envelope."""
        timeout = (options or {}).get("timeout", 300)
        logger.info("Claude CLI cmd: %s", " ".join(str(c) for c in cmd[:10]) + "...")

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
            logger.error(
                "Claude CLI failed (rc=%d): %s", result.returncode, result.stderr[:500],
            )
            raise HTTPException(
                status_code=500,
                detail=f"Claude CLI failed (rc={result.returncode}): {result.stderr[:200]}",
            )

        try:
            data = json.loads(result.stdout)
        except json.JSONDecodeError:
            # Shouldn't happen with --output-format json, but degrade gracefully
            logger.warning("Claude CLI returned non-JSON output, wrapping as raw text")
            return {"result": result.stdout.strip()}

        # Log cost/usage for observability
        cost = data.get("cost", {})
        if cost:
            logger.info(
                "llm call: model=%s task=%s cost=$%.4f in=%d out=%d",
                self._resolve("model", options),
                (options or {}).get("task", "unknown"),
                cost.get("estimated_usd", 0),
                cost.get("input_tokens", 0),
                cost.get("output_tokens", 0),
            )

        return data

    # -- public interface (LLMProvider) -------------------------------------

    def generate(
        self,
        prompt: str,
        options: Optional[Dict[str, Any]] = None,
    ) -> str:
        """Generate a text response."""
        cmd = self._build_cmd(prompt, options)
        data = self._run(cmd, options)
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
            return response.choices[0].message.content or ""
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=f"LLM generation failed: {str(e)}",
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
    ) -> Any:
        text = self.generate(prompt, options)
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

        return data.get("result", "")

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
    ) -> Any:
        """Generate and parse a JSON response via the Pi bridge."""
        text = self.generate(prompt, options)
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
        """Resolve a setting: explicit option > task default > Pi default."""
        if options and options.get(key):
            return str(options[key])
        task = (options or {}).get("task", "")
        task_defaults = TASK_DEFAULTS.get(task, {})
        if key in task_defaults:
            return task_defaults[key]
        # Pi defaults
        pi_defaults = {"model": "glm-5.1", "provider": "zai"}
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
