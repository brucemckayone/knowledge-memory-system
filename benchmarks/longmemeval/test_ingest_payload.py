"""Harness ingest-payload contract tests (nmemo-3f9.4).

Asserts that the LongMemEval runner ingests each question's sessions with the
speaker-aware shape the platform expects after beads 3f9.1/3f9.2/3f9.3:

  - content_type='conversational'  -> graph_agent applies the first-person
    conversational addendum (Decision 3).
  - a distinct stream_id per question -> scopes speaker identity per
    LongMemEval question/session (Decision 1).
  - in-text USER:/ASSISTANT: role labels reach the agent (carried in the chunk
    text; the prompt maps them).

These are PAYLOAD contract tests: MnemoClient.ingest is replaced with a spy so
NO real platform call / benchmark run happens. The client-level test asserts the
HTTP body MnemoClient builds.

Run from benchmarks/ root:
  uv run pytest longmemeval/test_ingest_payload.py
"""

from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

# Allow direct invocation + `python -m` style without installing the package.
BENCH_ROOT = Path(__file__).resolve().parent.parent
if str(BENCH_ROOT) not in sys.path:
    sys.path.insert(0, str(BENCH_ROOT))

from longmemeval import run as run_mod  # noqa: E402
from longmemeval.dataset import Question, Session, Turn  # noqa: E402
from longmemeval.run import RunConfig, chunk_session, run_real  # noqa: E402


def _question(qid: str = "q-degree-1") -> Question:
    return Question(
        question_id=qid,
        question_type="single-session-user",
        question="What degree did I graduate with?",
        answer="Business Administration",
        question_date="2026-01-01",
        sessions=[
            Session(
                session_id=f"{qid}-s0",
                date="2026-01-01",
                turns=[
                    Turn(role="user", content="I graduated with a degree in Business Administration."),
                    Turn(role="assistant", content="Congratulations on your degree!"),
                ],
            ),
        ],
        answer_session_ids=[f"{qid}-s0"],
    )


def _config() -> RunConfig:
    return RunConfig(
        benchmark="longmemeval",
        cut="s",
        dataset_url="http://example.invalid/ds.json",
        dataset_local=Path("unused.json"),
        expected_size=None,
        sample_size=None,
        reset_between_questions=True,
        max_ingest_chars=6000,
    )


def _drive_run_real(questions: list[Question]):
    """Run run_real with all external collaborators mocked, returning the
    MnemoClient spy so the test can inspect ingest call args."""
    client = MagicMock()
    client.health.return_value = {"status": "ok"}
    client.query.return_value = {"result": "Business Administration"}

    judge = MagicMock()
    judge.score.return_value = MagicMock(score=1.0, reasoning="ok")

    with patch.object(run_mod, "load_dataset", return_value=questions), \
        patch.object(run_mod, "MnemoClient", return_value=client) as client_ctor, \
        patch.object(run_mod, "Judge", return_value=judge), \
        patch.object(run_mod, "write_run", return_value=Path("x.json")), \
        patch.object(run_mod, "regenerate_markdown", return_value=Path("x.md")), \
        patch.object(run_mod, "regenerate_dashboard", return_value=Path("x.html")), \
        patch.object(run_mod, "submodule_sha", return_value="deadbeef"):
        # MnemoClient is used as a context manager (`with MnemoClient() as c`).
        client_ctor.return_value.__enter__.return_value = client
        client_ctor.return_value.__exit__.return_value = False
        run_real(_config(), notes="payload-contract test")

    return client


def test_each_question_ingests_conversational_with_per_question_stream() -> None:
    """ACCEPTANCE: every session ingest carries content_type=conversational and
    a stream_id derived from the question id; distinct questions -> distinct
    stream_ids."""
    q1 = _question("q-aaa")
    q2 = _question("q-bbb")
    client = _drive_run_real([q1, q2])

    assert client.ingest.call_count == 2, "one ingest per single-session question"

    streams: set[str] = set()
    for call in client.ingest.call_args_list:
        kwargs = call.kwargs
        assert kwargs.get("content_type") == "conversational", (
            f"ingest must declare content_type=conversational, got {kwargs.get('content_type')!r}"
        )
        stream_id = kwargs.get("stream_id")
        assert stream_id, "ingest must pass a non-empty stream_id"
        streams.add(stream_id)

    assert streams == {"q-aaa", "q-bbb"}, (
        f"stream_id must be the per-question id; got {streams}"
    )


def test_stream_id_is_stable_across_a_questions_chunks() -> None:
    """A multi-chunk question ingests every chunk under the SAME stream_id (the
    stream scopes speaker identity for the whole question)."""
    # Force a small char budget so the one session splits into multiple chunks.
    big = _question("q-multi")
    big.sessions[0].turns = [
        Turn(role="user", content="A" * 5000),
        Turn(role="assistant", content="B" * 5000),
    ]
    cfg = _config()
    cfg.max_ingest_chars = 3000
    # Sanity: the session genuinely splits.
    assert len(chunk_session(big.sessions[0], cfg.max_ingest_chars)) > 1

    client = MagicMock()
    client.health.return_value = {"status": "ok"}
    client.query.return_value = {"result": "x"}
    judge = MagicMock()
    judge.score.return_value = MagicMock(score=0.0, reasoning="x")

    with patch.object(run_mod, "load_dataset", return_value=[big]), \
        patch.object(run_mod, "MnemoClient", return_value=client) as ctor, \
        patch.object(run_mod, "Judge", return_value=judge), \
        patch.object(run_mod, "write_run", return_value=Path("x.json")), \
        patch.object(run_mod, "regenerate_markdown", return_value=Path("x.md")), \
        patch.object(run_mod, "regenerate_dashboard", return_value=Path("x.html")), \
        patch.object(run_mod, "submodule_sha", return_value="deadbeef"):
        ctor.return_value.__enter__.return_value = client
        ctor.return_value.__exit__.return_value = False
        run_real(cfg, notes="multi-chunk")

    assert client.ingest.call_count > 1, "this question must split into >1 chunk"
    streams = {c.kwargs.get("stream_id") for c in client.ingest.call_args_list}
    assert streams == {"q-multi"}, f"all chunks share one stream_id; got {streams}"


def test_in_text_role_labels_reach_ingest() -> None:
    """The USER:/ASSISTANT: labels ride in the chunk text (the carrier the
    prompt maps), so the ingested text must contain them."""
    client = _drive_run_real([_question("q-labels")])
    text = client.ingest.call_args_list[0].args[0]
    assert "USER:" in text, "user role label must reach the agent in-text"
    assert "ASSISTANT:" in text, "assistant role label must reach the agent in-text"


def test_client_ingest_builds_stream_id_and_content_type_in_body() -> None:
    """Client-level contract: MnemoClient.ingest forwards content_type as the
    POST body's `contentType` and stream_id as `stream_id` (snake_case, per the
    platform /ingest handler wired in 3f9.2)."""
    from _common.client import MnemoClient

    captured: dict[str, object] = {}

    class _Resp:
        status_code = 200

        def json(self) -> dict[str, object]:
            return {"ok": True}

    def fake_post(path: str, json: dict[str, object]):  # noqa: A002 - mirror httpx kw
        captured["path"] = path
        captured["json"] = json
        return _Resp()

    client = MnemoClient.__new__(MnemoClient)
    client._http = MagicMock()
    client._http.post.side_effect = fake_post

    client.ingest(
        "USER: hi\n\nASSISTANT: hello",
        source="longmemeval/q-xyz/q-xyz-s0",
        content_type="conversational",
        stream_id="q-xyz",
    )

    assert captured["path"] == "/ingest"
    body = captured["json"]
    assert body["text"] == "USER: hi\n\nASSISTANT: hello"
    assert body["source"] == "longmemeval/q-xyz/q-xyz-s0"
    assert body["contentType"] == "conversational"
    assert body["stream_id"] == "q-xyz"


def test_chunk_session_windows_and_defers_unit_split_to_store() -> None:
    """nmemo-yxj.4 convergence: chunk_session windows at the shared agent-window
    size and feeds WHOLE windows to store() — it does NOT carve small embed
    units. A window well above the embed-unit width (EMBED_UNIT_CHARS=128) must
    still pass through as ONE window (store() owns the 128/64 satellite split),
    and oversized sessions split at the WINDOW size, not the unit size."""
    # A single ~3000-char turn: far above the 128-char embed-unit width but well
    # under the 6000-char window — must stay ONE window (no embed-unit carving).
    one = Session(
        session_id="s-one",
        date="2026-01-01",
        turns=[Turn(role="user", content="W" * 3000)],
    )
    blobs = chunk_session(one, max_chars=6000)
    assert len(blobs) == 1, "a sub-window session must ingest as one window, not embed units"
    assert len(blobs[0]) > 128, "the window is whole, not split to the embed-unit width"

    # An oversized session splits at the WINDOW boundary (6000), not 128.
    big = Session(
        session_id="s-big",
        date="2026-01-01",
        turns=[Turn(role="user", content="A" * 5000), Turn(role="assistant", content="B" * 5000)],
    )
    win = chunk_session(big, max_chars=6000)
    assert len(win) > 1, "an oversized session must split into multiple windows"
    # Each window respects the window cap; none is chopped down to the unit size.
    for b in win:
        assert len(b) <= 6000 + 100, "windows respect the shared window cap (+header slack)"
        assert len(b) > 128, "windows are not carved to the embed-unit width"


def test_window_default_matches_shared_policy() -> None:
    """The harness window default agrees with the ONE shared policy value
    (config.yaml max_ingest_chars). yxj.5 tunes the number; both sites must
    read the SAME number — no private per-site cap."""
    import yaml

    cfg_path = Path(__file__).resolve().parent / "config.yaml"
    cfg = yaml.safe_load(cfg_path.read_text(encoding="utf-8"))
    yaml_window = int(cfg["max_ingest_chars"])

    # The run.py default fallback must match the config.yaml value.
    rc = RunConfig(
        benchmark="b", cut="c", dataset_url="u", dataset_local=Path("x"),
        expected_size=None, sample_size=None, reset_between_questions=True,
        max_ingest_chars=yaml_window,
    )
    assert rc.max_ingest_chars == yaml_window == 6000


def test_client_ingest_omits_unset_optionals() -> None:
    """Back-compat: when stream_id/content_type are not supplied, the body omits
    them (prose path / existing callers unaffected)."""
    from _common.client import MnemoClient

    captured: dict[str, object] = {}

    class _Resp:
        status_code = 200

        def json(self) -> dict[str, object]:
            return {}

    def fake_post(path: str, json: dict[str, object]):  # noqa: A002
        captured["json"] = json
        return _Resp()

    client = MnemoClient.__new__(MnemoClient)
    client._http = MagicMock()
    client._http.post.side_effect = fake_post

    client.ingest("plain prose", source="doc/1")

    body = captured["json"]
    assert "stream_id" not in body
    assert "contentType" not in body
    assert body == {"text": "plain prose", "source": "doc/1"}
