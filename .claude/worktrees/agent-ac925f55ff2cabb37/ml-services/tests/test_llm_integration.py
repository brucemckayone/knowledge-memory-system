"""Integration tests for ClaudeCodeProvider — calls the real Claude CLI.

These tests require:
- `claude` CLI on PATH and authenticated
- Network access to Anthropic API

Skip automatically when CLI is unavailable. Run with:
    pytest tests/test_llm_integration.py -v
"""

import shutil
from typing import List, Optional

import pytest
from pydantic import BaseModel

from app.core.llm import ClaudeCodeProvider, TASK_DEFAULTS

# Skip entire module if claude CLI is not installed
pytestmark = pytest.mark.skipif(
    shutil.which("claude") is None,
    reason="Claude Code CLI not found on PATH",
)

# Shared timeout — keep integration tests fast
FAST_TIMEOUT = 60


@pytest.fixture(scope="module")
def provider():
    return ClaudeCodeProvider()


# ---------------------------------------------------------------------------
# Response models for structured output tests
# ---------------------------------------------------------------------------
class ClassifyOutput(BaseModel):
    intent: str
    confidence: float


class EntityOutput(BaseModel):
    entities: List[str]


class SummaryOutput(BaseModel):
    summary: str
    key_points: List[str]


# ---------------------------------------------------------------------------
# generate() — plain text
# ---------------------------------------------------------------------------
class TestGenerate:
    def test_returns_nonempty_string(self, provider):
        result = provider.generate(
            "Reply with exactly: hello",
            options={"task": "classify", "timeout": FAST_TIMEOUT},
        )
        assert isinstance(result, str)
        assert len(result) > 0

    def test_system_prompt_respected(self, provider):
        result = provider.generate(
            "What is your name?",
            options={
                "task": "chat",
                "system_prompt": "You are TestBot. Always introduce yourself as TestBot.",
                "timeout": FAST_TIMEOUT,
            },
        )
        assert "TestBot" in result

    def test_task_routes_to_correct_model(self, provider):
        """Verify task-based routing by checking the command that would be built."""
        cmd = provider._build_cmd("test", options={"task": "classify"})
        model_idx = cmd.index("--model") + 1
        effort_idx = cmd.index("--effort") + 1
        assert cmd[model_idx] == "haiku"
        assert cmd[effort_idx] == "low"

        cmd = provider._build_cmd("test", options={"task": "check_contradiction"})
        assert cmd[cmd.index("--model") + 1] == "opus"
        assert cmd[cmd.index("--effort") + 1] == "high"


# ---------------------------------------------------------------------------
# generate_json() — unstructured (text → extract_json fallback)
# ---------------------------------------------------------------------------
class TestGenerateJson:
    def test_returns_dict(self, provider):
        result = provider.generate_json(
            'Return a JSON object with key "color" set to "blue".',
            options={"task": "classify", "timeout": FAST_TIMEOUT},
        )
        assert isinstance(result, dict)
        assert "color" in result
        assert result["color"] == "blue"

    def test_returns_list(self, provider):
        result = provider.generate_json(
            "Return a JSON array of three fruits.",
            options={"task": "classify", "timeout": FAST_TIMEOUT},
        )
        assert isinstance(result, list)
        assert len(result) >= 3


# ---------------------------------------------------------------------------
# generate_json() with response_model — structured output via --json-schema
# ---------------------------------------------------------------------------
class TestStructuredOutput:
    def test_returns_pydantic_model(self, provider):
        result = provider.generate_json(
            'Classify the intent of: "remind me to buy milk". '
            'Return intent and confidence.',
            response_model=ClassifyOutput,
            options={"task": "classify", "timeout": FAST_TIMEOUT},
        )
        assert isinstance(result, ClassifyOutput)
        assert isinstance(result.intent, str)
        assert len(result.intent) > 0
        assert 0.0 <= result.confidence <= 1.0

    def test_entity_extraction(self, provider):
        result = provider.generate_json(
            'Extract named entities from: "Alice met Bob at Google HQ". '
            'Return as a list of entity name strings.',
            response_model=EntityOutput,
            options={"task": "extract_entities", "timeout": FAST_TIMEOUT},
        )
        assert isinstance(result, EntityOutput)
        assert len(result.entities) >= 2
        names_lower = [e.lower() for e in result.entities]
        assert any("alice" in n for n in names_lower)
        assert any("bob" in n for n in names_lower)

    def test_summary_extraction(self, provider):
        article = (
            "Scientists at CERN announced the discovery of a new particle "
            "that could explain dark matter. The finding, published in Nature, "
            "was based on data from the Large Hadron Collider. Researchers say "
            "it will take years to fully understand the implications."
        )
        result = provider.generate_json(
            f"Summarize this article:\n\n{article}",
            response_model=SummaryOutput,
            options={"task": "summarize", "timeout": FAST_TIMEOUT},
        )
        assert isinstance(result, SummaryOutput)
        assert len(result.summary) > 20
        assert len(result.key_points) >= 1


# ---------------------------------------------------------------------------
# Task routing — verify every TASK_DEFAULTS entry builds correct CLI flags
# ---------------------------------------------------------------------------
class TestTaskRouting:
    @pytest.mark.parametrize("task_name,expected", list(TASK_DEFAULTS.items()))
    def test_task_defaults_produce_correct_flags(self, provider, task_name, expected):
        cmd = provider._build_cmd("test", options={"task": task_name})
        model_idx = cmd.index("--model") + 1
        effort_idx = cmd.index("--effort") + 1
        assert cmd[model_idx] == expected["model"], (
            f"task={task_name}: expected model={expected['model']}, got {cmd[model_idx]}"
        )
        assert cmd[effort_idx] == expected["effort"], (
            f"task={task_name}: expected effort={expected['effort']}, got {cmd[effort_idx]}"
        )


# ---------------------------------------------------------------------------
# Error handling — real CLI errors
# ---------------------------------------------------------------------------
class TestErrors:
    def test_short_timeout_raises(self, provider):
        """A 1-second timeout should fail on any real LLM call."""
        from fastapi import HTTPException

        with pytest.raises(HTTPException) as exc_info:
            provider.generate(
                "Write a 500-word essay about the history of computing.",
                options={"timeout": 1},
            )
        assert exc_info.value.status_code == 504
