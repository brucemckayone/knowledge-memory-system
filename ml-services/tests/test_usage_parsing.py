"""Per-adapter usage-normalisation tests — B1 (nmemo-6do.1).

Locks the token-semantics gate (design §4.1, §9.2): ``input_tokens`` is the
UNCACHED remainder for every provider, the buckets sum to the billed total, and
the OpenAI-shaped invariant ``input_tokens + cache_read_tokens == prompt_tokens``
holds. The parse methods are pure (no I/O), so providers are built with
``__new__`` to skip the CLI / openai / health-check dependencies in ``__init__``.
"""

from types import SimpleNamespace

from app.core.llm import (
    ClaudeCodeProvider,
    ZAIProvider,
    PiBridgeProvider,
    UsageRecord,
    _anthropic_cache_buckets,
)


def _claude() -> ClaudeCodeProvider:
    return ClaudeCodeProvider.__new__(ClaudeCodeProvider)


def _zai() -> ZAIProvider:
    p = ZAIProvider.__new__(ZAIProvider)
    p.model = "glm-4.7"
    return p


def _pi() -> PiBridgeProvider:
    return PiBridgeProvider.__new__(PiBridgeProvider)


# ---------------------------------------------------------------------------
# UsageRecord model
# ---------------------------------------------------------------------------
def test_usage_record_validates_with_defaults():
    rec = UsageRecord(requested_model="haiku", resolved_model="haiku", provider="anthropic")
    assert rec.input_tokens == 0
    assert rec.cache_write_1h_tokens == 0
    assert rec.tool_calls is None
    assert rec.gateway_reported_usd is None


# ---------------------------------------------------------------------------
# ClaudeCodeProvider — Anthropic-shaped (maps straight through)
# ---------------------------------------------------------------------------
def test_claude_usage_parsing():
    """Captured-shape Claude CLI envelope with a cache_creation TTL split."""
    data = {
        "result": "ok",
        "model": "claude-haiku-4-5",
        "num_turns": 1,
        "session_id": "sess_abc",
        "cost": {
            "estimated_usd": 0.0021,
            "input_tokens": 1200,
            "output_tokens": 300,
            "cache_read_tokens": 800,
            "cache_creation": {
                "ephemeral_5m_input_tokens": 50,
                "ephemeral_1h_input_tokens": 20,
            },
        },
    }
    rec = _claude()._parse_usage_record(data, options={"model": "haiku"})
    assert isinstance(rec, UsageRecord)
    assert rec.provider == "anthropic"
    assert rec.input_tokens == 1200          # already the uncached remainder
    assert rec.output_tokens == 300
    assert rec.cache_read_tokens == 800
    assert rec.cache_write_5m_tokens == 50
    assert rec.cache_write_1h_tokens == 20
    assert rec.resolved_model == "claude-haiku-4-5"
    assert rec.requested_model == "haiku"
    assert rec.turns == 1
    assert rec.request_id == "sess_abc"
    # ml-services never prices: the CLI's own estimate must not leak into the record.
    assert rec.gateway_reported_usd is None


def test_claude_usage_parsing_flat_cache_spelling():
    """Flat single-bucket cache_creation_input_tokens -> default 5m TTL."""
    data = {
        "model": "claude-sonnet-4-6",
        "cost": {
            "input_tokens": 10,
            "output_tokens": 5,
            "cache_read_input_tokens": 7,
            "cache_creation_input_tokens": 3,
        },
    }
    rec = _claude()._parse_usage_record(data)
    assert rec.cache_read_tokens == 7
    assert rec.cache_write_5m_tokens == 3
    assert rec.cache_write_1h_tokens == 0


def test_claude_usage_parsing_no_cost_returns_none():
    assert _claude()._parse_usage_record({"result": "x"}) is None


def test_claude_usage_parsing_real_cli_envelope():
    """Regression (found by the B11 E2E): the live `claude -p --output-format json`
    envelope has NO top-level 'cost' — usage is under 'usage', the served model
    under 'modelUsage', the dollar total under 'total_cost_usd'. The parser must
    read 'usage', not 'cost'."""
    data = {
        "result": "ok",
        "num_turns": 3,
        "session_id": "sess_z",
        "total_cost_usd": 0.0307,
        "modelUsage": {"claude-haiku-4-5-20251001": {"inputTokens": 9}},
        "usage": {
            "input_tokens": 9,
            "output_tokens": 77,
            "cache_read_input_tokens": 21322,
            "cache_creation": {"ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": 14103},
        },
    }
    rec = _claude()._parse_usage_record(data, options={"model": "haiku"})
    assert rec is not None
    assert rec.provider == "anthropic"
    assert rec.input_tokens == 9            # uncached remainder
    assert rec.output_tokens == 77
    assert rec.cache_read_tokens == 21322
    assert rec.cache_write_1h_tokens == 14103   # ephemeral_1h split
    assert rec.cache_write_5m_tokens == 0
    assert rec.resolved_model == "claude-haiku-4-5-20251001"  # from modelUsage
    assert rec.turns == 3


# ---------------------------------------------------------------------------
# ZAIProvider — OpenAI-shaped (the remainder rule, the blocking gate)
# ---------------------------------------------------------------------------
def test_zai_usage_parsing():
    """Synthetic OpenAI-compatible response: prompt_tokens=100, cached=30."""
    response = {
        "id": "req_1",
        "model": "glm-4.7",
        "usage": {
            "prompt_tokens": 100,
            "completion_tokens": 50,
            "prompt_tokens_details": {"cached_tokens": 30},
        },
    }
    rec = _zai()._parse_openai_usage(response)
    assert isinstance(rec, UsageRecord)
    assert rec.provider == "zai"
    assert rec.input_tokens == 70            # 100 - 30 (uncached remainder)
    assert rec.cache_read_tokens == 30
    assert rec.output_tokens == 50
    # The blocking invariant: buckets sum to the provider's reported prompt total.
    assert rec.input_tokens + rec.cache_read_tokens == response["usage"]["prompt_tokens"]
    assert rec.request_id == "req_1"
    assert rec.resolved_model == "glm-4.7"


def test_zai_usage_parsing_no_cache():
    response = {"model": "glm-4.7", "usage": {"prompt_tokens": 40, "completion_tokens": 9}}
    rec = _zai()._parse_openai_usage(response)
    assert rec.input_tokens == 40
    assert rec.cache_read_tokens == 0
    assert rec.input_tokens + rec.cache_read_tokens == 40


def test_zai_usage_parsing_attribute_response():
    """The adapter must also read SDK objects (attribute access), not only dicts."""
    response = SimpleNamespace(
        id="req_2",
        model="glm-4.7",
        usage=SimpleNamespace(
            prompt_tokens=200,
            completion_tokens=10,
            prompt_tokens_details=SimpleNamespace(cached_tokens=80),
            completion_tokens_details=SimpleNamespace(reasoning_tokens=4),
        ),
    )
    rec = _zai()._parse_openai_usage(response)
    assert rec.input_tokens == 120
    assert rec.cache_read_tokens == 80
    assert rec.reasoning_output_tokens == 4
    assert rec.input_tokens + rec.cache_read_tokens == 200


def test_zai_usage_parsing_no_usage_returns_none():
    assert _zai()._parse_openai_usage({"model": "glm-4.7"}) is None


def test_zai_usage_parsing_clamps_reasoning_over_completion():
    """Review fix: reasoning_output is a SUBSET of completion_tokens, so a
    misreporting gateway with reasoning > output is clamped (symmetric with the
    cached clamp) — cost can never bill more reasoning than output emitted."""
    rec = _zai()._parse_openai_usage({
        "model": "glm-4.7",
        "usage": {
            "prompt_tokens": 10, "completion_tokens": 100,
            "completion_tokens_details": {"reasoning_tokens": 150},
        },
    })
    assert rec.output_tokens == 100
    assert rec.reasoning_output_tokens == 100   # clamped to completion_tokens


# ---------------------------------------------------------------------------
# PiBridgeProvider — Anthropic-shaped via the bridge cost object
# ---------------------------------------------------------------------------
def test_pi_bridge_usage_parsing():
    """Pi bridge response (Anthropic-shaped cost) with a cache TTL split."""
    data = {
        "result": "ok",
        "provider": "zai",
        "model": "glm-5.1",
        "tool_calls": 6,
        "turns": 3,
        "cost": {
            "estimated_usd": 0.004,
            "input_tokens": 900,
            "output_tokens": 120,
            "cache_read_tokens": 400,
            "cache_creation": {
                "ephemeral_5m_input_tokens": 64,
                "ephemeral_1h_input_tokens": 16,
            },
        },
    }
    rec = _pi()._parse_pi_usage(data)
    assert isinstance(rec, UsageRecord)
    assert rec.provider == "zai"
    assert rec.input_tokens == 900
    assert rec.output_tokens == 120
    assert rec.cache_read_tokens == 400
    assert rec.cache_write_5m_tokens == 64    # 5m TTL split
    assert rec.cache_write_1h_tokens == 16    # 1h TTL split
    assert rec.tool_calls == 6
    assert rec.turns == 3
    assert rec.resolved_model == "glm-5.1"


def test_pi_bridge_usage_parsing_no_cost_returns_none():
    assert _pi()._parse_pi_usage({"result": "x"}) is None


# ---------------------------------------------------------------------------
# Shared cache-bucket helper
# ---------------------------------------------------------------------------
def test_anthropic_cache_buckets_helper():
    # Nested API spelling.
    assert _anthropic_cache_buckets({
        "cache_read_tokens": 5,
        "cache_creation": {"ephemeral_5m_input_tokens": 2, "ephemeral_1h_input_tokens": 1},
    }) == (5, 2, 1)
    # Flat spelling -> 5m default, no 1h.
    assert _anthropic_cache_buckets({
        "cache_read_input_tokens": 9,
        "cache_creation_input_tokens": 4,
    }) == (9, 4, 0)
    # Empty.
    assert _anthropic_cache_buckets({}) == (0, 0, 0)


def test_anthropic_cache_buckets_nested_empty_falls_back_to_flat():
    """Review fix: a nested cache_creation present but lacking TTL keys must NOT
    silently drop the flat cache_creation_input_tokens total."""
    assert _anthropic_cache_buckets({
        "cache_read_tokens": 10,
        "cache_creation": {},                  # present but no TTL breakdown
        "cache_creation_input_tokens": 512,    # flat total
    }) == (10, 512, 0)
    # nested with only an unknown key -> still falls back to flat
    assert _anthropic_cache_buckets({
        "cache_creation": {"some_future_key": 9},
        "cache_creation_input_tokens": 64,
    }) == (0, 64, 0)


def test_claude_usage_parsing_empty_nested_cache_keeps_flat_writes():
    rec = _claude()._parse_usage_record({
        "model": "claude-haiku-4-5",
        "cost": {
            "input_tokens": 5, "output_tokens": 2,
            "cache_creation": {}, "cache_creation_input_tokens": 100,
        },
    })
    assert rec.cache_write_5m_tokens == 100   # not silently dropped


def test_zai_usage_parsing_clamps_cached_over_prompt():
    """Review fix: when a gateway misreports cached > prompt_tokens, clamp so the
    bucket-sum invariant input + cache_read == prompt_tokens still holds."""
    rec = _zai()._parse_openai_usage({
        "model": "glm-4.7",
        "usage": {
            "prompt_tokens": 100, "completion_tokens": 5,
            "prompt_tokens_details": {"cached_tokens": 120},
        },
    })
    assert rec.input_tokens == 0
    assert rec.cache_read_tokens == 100       # clamped to the prompt total
    assert rec.input_tokens + rec.cache_read_tokens == 100


def test_pi_usage_parsing_provider_defaults_to_pi_provider_env(monkeypatch):
    """Review fix: when the bridge omits provider and no options are passed, the
    recorded provider matches what generate() actually sent (PI_PROVIDER, default
    'zai') — not the literal 'pi'."""
    monkeypatch.delenv("PI_PROVIDER", raising=False)
    rec = _pi()._parse_pi_usage({
        "model": "glm-5.1",
        "cost": {"input_tokens": 1, "output_tokens": 1},
    })
    assert rec.provider == "zai"
