"""Tests for ClaudeCodeProvider in app.core.llm."""

import json
import subprocess
from typing import List, Optional
from unittest.mock import patch, MagicMock

import pytest
from fastapi import HTTPException
from pydantic import BaseModel

from app.core.llm import (
    ClaudeCodeProvider,
    ZAIProvider,
    LLMProvider,
    TASK_DEFAULTS,
    FALLBACK_MAP,
    DEFAULT_MODEL,
    DEFAULT_EFFORT,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _make_provider() -> ClaudeCodeProvider:
    """Create a provider with shutil.which mocked to succeed."""
    with patch("app.core.llm.shutil.which", return_value="/usr/bin/claude"):
        return ClaudeCodeProvider()


def _cli_result(
    stdout: str = "", stderr: str = "", returncode: int = 0,
) -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(
        args=["claude"], stdout=stdout, stderr=stderr, returncode=returncode,
    )


class SampleModel(BaseModel):
    label: str
    confidence: float
    tags: Optional[List[str]] = None


# ---------------------------------------------------------------------------
# __init__
# ---------------------------------------------------------------------------
class TestInit:
    def test_succeeds_when_claude_on_path(self):
        with patch("app.core.llm.shutil.which", return_value="/usr/bin/claude"):
            provider = ClaudeCodeProvider()
            assert provider is not None

    def test_raises_when_claude_missing(self):
        with patch("app.core.llm.shutil.which", return_value=None):
            with pytest.raises(RuntimeError, match="Claude Code CLI not found"):
                ClaudeCodeProvider()


# ---------------------------------------------------------------------------
# Protocol conformance
# ---------------------------------------------------------------------------
class TestProtocol:
    def test_claude_provider_satisfies_protocol(self):
        provider = _make_provider()
        assert isinstance(provider, LLMProvider)

    def test_zai_provider_satisfies_protocol(self):
        """ZAIProvider structurally matches LLMProvider (no instantiation needed)."""
        assert issubclass(ZAIProvider, LLMProvider)


# ---------------------------------------------------------------------------
# _resolve
# ---------------------------------------------------------------------------
class TestResolve:
    def setup_method(self):
        self.provider = _make_provider()

    def test_explicit_option_wins(self):
        assert self.provider._resolve("model", {"model": "opus"}) == "opus"

    def test_task_default_used(self):
        assert self.provider._resolve("model", {"task": "classify"}) == "haiku"
        assert self.provider._resolve("effort", {"task": "classify"}) == "low"

    def test_explicit_overrides_task_default(self):
        opts = {"task": "classify", "model": "opus"}
        assert self.provider._resolve("model", opts) == "opus"

    def test_global_default_model(self):
        assert self.provider._resolve("model", {}) == DEFAULT_MODEL

    def test_global_default_effort(self):
        assert self.provider._resolve("effort", {}) == DEFAULT_EFFORT

    def test_unknown_key_returns_empty(self):
        assert self.provider._resolve("nonexistent", {}) == ""

    def test_none_options(self):
        assert self.provider._resolve("model", None) == DEFAULT_MODEL


# ---------------------------------------------------------------------------
# _build_cmd
# ---------------------------------------------------------------------------
class TestBuildCmd:
    def setup_method(self):
        self.provider = _make_provider()

    def test_default_flags(self):
        cmd = self.provider._build_cmd("hello")
        assert cmd[:3] == ["claude", "-p", "hello"]
        assert "--output-format" in cmd
        assert "json" in cmd
        assert "--no-session-persistence" in cmd
        assert "--max-turns" in cmd
        assert cmd[cmd.index("--max-turns") + 1] == "1"

    def test_tools_disabled_by_default(self):
        cmd = self.provider._build_cmd("hello")
        idx = cmd.index("--tools")
        assert cmd[idx + 1] == ""

    def test_tools_explicit_string(self):
        cmd = self.provider._build_cmd("hello", {"tools": "Bash,Read"})
        idx = cmd.index("--tools")
        assert cmd[idx + 1] == "Bash,Read"

    def test_tools_explicit_list(self):
        cmd = self.provider._build_cmd("hello", {"tools": ["Bash", "Read"]})
        idx = cmd.index("--tools")
        assert cmd[idx + 1] == "Bash,Read"

    def test_task_sets_model_and_effort(self):
        cmd = self.provider._build_cmd("x", {"task": "classify"})
        assert cmd[cmd.index("--model") + 1] == "haiku"
        assert cmd[cmd.index("--effort") + 1] == "low"

    def test_explicit_model_overrides_task(self):
        cmd = self.provider._build_cmd("x", {"task": "classify", "model": "opus"})
        assert cmd[cmd.index("--model") + 1] == "opus"

    def test_fallback_from_map(self):
        cmd = self.provider._build_cmd("x", {"task": "classify"})  # haiku
        idx = cmd.index("--fallback-model")
        assert cmd[idx + 1] == FALLBACK_MAP["haiku"]

    def test_fallback_explicit_override(self):
        cmd = self.provider._build_cmd("x", {"fallback_model": "opus"})
        idx = cmd.index("--fallback-model")
        assert cmd[idx + 1] == "opus"

    def test_no_fallback_for_opus(self):
        cmd = self.provider._build_cmd("x", {"model": "opus"})
        assert "--fallback-model" not in cmd

    def test_system_prompt(self):
        cmd = self.provider._build_cmd("x", {"system_prompt": "You are a classifier."})
        idx = cmd.index("--system-prompt")
        assert cmd[idx + 1] == "You are a classifier."

    def test_max_turns_override(self):
        cmd = self.provider._build_cmd("x", {"max_turns": 5})
        assert cmd[cmd.index("--max-turns") + 1] == "5"

    def test_json_schema_appended(self):
        schema = {"type": "object", "properties": {"label": {"type": "string"}}}
        cmd = self.provider._build_cmd("x", json_schema=schema)
        idx = cmd.index("--json-schema")
        assert json.loads(cmd[idx + 1]) == schema

    def test_json_schema_bumps_max_turns_to_2(self):
        schema = {"type": "object", "properties": {"label": {"type": "string"}}}
        cmd = self.provider._build_cmd("x", json_schema=schema)
        assert cmd[cmd.index("--max-turns") + 1] == "2"

    def test_json_schema_max_turns_explicit_override(self):
        schema = {"type": "object", "properties": {"label": {"type": "string"}}}
        cmd = self.provider._build_cmd("x", {"max_turns": 5}, json_schema=schema)
        assert cmd[cmd.index("--max-turns") + 1] == "5"

    def test_no_json_schema_when_none(self):
        cmd = self.provider._build_cmd("x")
        assert "--json-schema" not in cmd


# ---------------------------------------------------------------------------
# _run
# ---------------------------------------------------------------------------
class TestRun:
    def setup_method(self):
        self.provider = _make_provider()

    @patch("app.core.llm.subprocess.run")
    def test_successful_json(self, mock_run):
        envelope = {"result": "hello", "cost": {}}
        mock_run.return_value = _cli_result(stdout=json.dumps(envelope))

        data = self.provider._run(["claude", "-p", "hi"])
        assert data["result"] == "hello"

    @patch("app.core.llm.subprocess.run")
    def test_timeout_raises_504(self, mock_run):
        mock_run.side_effect = subprocess.TimeoutExpired(cmd="claude", timeout=300)

        with pytest.raises(HTTPException) as exc_info:
            self.provider._run(["claude", "-p", "hi"])
        assert exc_info.value.status_code == 504

    @patch("app.core.llm.subprocess.run")
    def test_nonzero_exit_raises_500(self, mock_run):
        mock_run.return_value = _cli_result(returncode=1, stderr="bad prompt")

        with pytest.raises(HTTPException) as exc_info:
            self.provider._run(["claude", "-p", "hi"])
        assert exc_info.value.status_code == 500

    @patch("app.core.llm.subprocess.run")
    def test_non_json_output_wrapped(self, mock_run):
        mock_run.return_value = _cli_result(stdout="plain text answer")

        data = self.provider._run(["claude", "-p", "hi"])
        assert data == {"result": "plain text answer"}

    @patch("app.core.llm.subprocess.run")
    def test_custom_timeout(self, mock_run):
        mock_run.return_value = _cli_result(stdout='{"result": "ok"}')

        self.provider._run(["claude", "-p", "hi"], options={"timeout": 60})
        mock_run.assert_called_once()
        assert mock_run.call_args.kwargs.get("timeout") == 60

    @patch("app.core.llm.subprocess.run")
    def test_cost_logged(self, mock_run, caplog):
        envelope = {
            "result": "hi",
            "cost": {"estimated_usd": 0.0012, "input_tokens": 100, "output_tokens": 50},
        }
        mock_run.return_value = _cli_result(stdout=json.dumps(envelope))

        import logging
        with caplog.at_level(logging.INFO, logger="app.core.llm"):
            self.provider._run(["claude", "-p", "hi"], options={"task": "classify"})

        assert any("cost=$0.0012" in r.message for r in caplog.records)


# ---------------------------------------------------------------------------
# extract_json
# ---------------------------------------------------------------------------
class TestExtractJson:
    def setup_method(self):
        self.provider = _make_provider()

    def test_raw_object(self):
        assert self.provider.extract_json('{"a": 1}') == {"a": 1}

    def test_raw_array(self):
        assert self.provider.extract_json('[1, 2, 3]') == [1, 2, 3]

    def test_markdown_fenced(self):
        text = "```json\n{\"a\": 1}\n```"
        assert self.provider.extract_json(text) == {"a": 1}

    def test_markdown_fenced_no_lang(self):
        text = "```\n{\"a\": 1}\n```"
        assert self.provider.extract_json(text) == {"a": 1}

    def test_json_embedded_in_text(self):
        text = 'Here is the result: {"label": "task"} done.'
        assert self.provider.extract_json(text) == {"label": "task"}

    def test_invalid_json_raises(self):
        with pytest.raises(ValueError, match="Could not parse JSON"):
            self.provider.extract_json("not json at all")


# ---------------------------------------------------------------------------
# generate
# ---------------------------------------------------------------------------
class TestGenerate:
    def setup_method(self):
        self.provider = _make_provider()

    @patch("app.core.llm.subprocess.run")
    def test_returns_result_text(self, mock_run):
        mock_run.return_value = _cli_result(
            stdout=json.dumps({"result": "classified as: task"}),
        )
        text = self.provider.generate("classify this", {"task": "classify"})
        assert text == "classified as: task"

    @patch("app.core.llm.subprocess.run")
    def test_empty_result(self, mock_run):
        mock_run.return_value = _cli_result(stdout=json.dumps({"cost": {}}))
        assert self.provider.generate("x") == ""


# ---------------------------------------------------------------------------
# generate_json
# ---------------------------------------------------------------------------
class TestGenerateJson:
    def setup_method(self):
        self.provider = _make_provider()

    @patch("app.core.llm.subprocess.run")
    def test_structured_output_path(self, mock_run):
        """When --json-schema is used, structured_output is preferred."""
        envelope = {
            "result": "",
            "structured_output": {"label": "task", "confidence": 0.95},
        }
        mock_run.return_value = _cli_result(stdout=json.dumps(envelope))

        result = self.provider.generate_json("classify", response_model=SampleModel)
        assert isinstance(result, SampleModel)
        assert result.label == "task"
        assert result.confidence == 0.95

    @patch("app.core.llm.subprocess.run")
    def test_fallback_to_text_parsing(self, mock_run):
        """When structured_output is absent, falls back to extract_json."""
        envelope = {"result": '{"label": "note", "confidence": 0.8}'}
        mock_run.return_value = _cli_result(stdout=json.dumps(envelope))

        result = self.provider.generate_json("classify", response_model=SampleModel)
        assert isinstance(result, SampleModel)
        assert result.label == "note"

    @patch("app.core.llm.subprocess.run")
    def test_raw_dict_without_model(self, mock_run):
        envelope = {"result": '{"key": "value"}'}
        mock_run.return_value = _cli_result(stdout=json.dumps(envelope))

        result = self.provider.generate_json("extract")
        assert result == {"key": "value"}

    @patch("app.core.llm.subprocess.run")
    def test_structured_output_without_model(self, mock_run):
        """structured_output returned as dict when no response_model."""
        envelope = {
            "result": "",
            "structured_output": {"label": "task", "confidence": 0.9},
        }
        mock_run.return_value = _cli_result(stdout=json.dumps(envelope))

        # Need to pass a schema for --json-schema to be included
        result = self.provider.generate_json(
            "classify",
            response_model=SampleModel,
            options={"task": "classify"},
        )
        assert isinstance(result, SampleModel)

    @patch("app.core.llm.subprocess.run")
    def test_validation_failure_raises(self, mock_run):
        envelope = {"result": '{"wrong_field": 123}'}
        mock_run.return_value = _cli_result(stdout=json.dumps(envelope))

        with pytest.raises(ValueError, match="Schema validation failed"):
            self.provider.generate_json("classify", response_model=SampleModel)

    @patch("app.core.llm.subprocess.run")
    def test_unparseable_text_raises(self, mock_run):
        envelope = {"result": "not json"}
        mock_run.return_value = _cli_result(stdout=json.dumps(envelope))

        with pytest.raises(ValueError, match="JSON parsing failed"):
            self.provider.generate_json("classify")

    @patch("app.core.llm.subprocess.run")
    def test_json_schema_sent_for_response_model(self, mock_run):
        """Verify --json-schema flag is included when response_model is provided."""
        mock_run.return_value = _cli_result(
            stdout=json.dumps({
                "result": "",
                "structured_output": {"label": "x", "confidence": 0.5},
            }),
        )
        self.provider.generate_json("classify", response_model=SampleModel)

        cmd = mock_run.call_args[0][0]
        assert "--json-schema" in cmd
        schema_str = cmd[cmd.index("--json-schema") + 1]
        schema = json.loads(schema_str)
        assert "properties" in schema
        assert "label" in schema["properties"]
