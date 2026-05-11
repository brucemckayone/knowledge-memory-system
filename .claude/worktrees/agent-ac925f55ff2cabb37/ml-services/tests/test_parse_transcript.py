"""Tests for transcript parsing endpoint (W37)."""

from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

VTT_SAMPLE = """WEBVTT

00:00:01.000 --> 00:00:04.000
<v Alice>Hello everyone, let's start the meeting.

00:00:04.500 --> 00:00:08.000
<v Bob>Sure. First topic is the release schedule.

00:00:08.500 --> 00:00:15.000
<v Alice>We need to ship by Friday. Any blockers?
"""

DIARIZED_SAMPLE = """Alice: Hello everyone, let's start the meeting.
Bob: Sure. First topic is the release schedule.
Alice: We need to ship by Friday. Any blockers?
Bob: The API tests are still failing on staging.
"""

PLAIN_SAMPLE = """This is a plain text transcript of the meeting.

We discussed the release schedule and agreed to ship by Friday.

Bob mentioned that API tests are failing on staging.
"""


def test_parse_vtt_transcript():
    resp = client.post("/parse-transcript", json={"content": VTT_SAMPLE, "format_hint": "vtt"})
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["segments"]) >= 2
    assert "Alice" in data["speakers"] or any("Alice" in s["speaker"] for s in data["segments"])
    assert data["word_count"] > 0


def test_parse_diarized_transcript():
    resp = client.post("/parse-transcript", json={"content": DIARIZED_SAMPLE, "format_hint": "diarized"})
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["segments"]) >= 2
    assert "Alice" in data["speakers"]
    assert "Bob" in data["speakers"]


def test_parse_plain_transcript():
    resp = client.post("/parse-transcript", json={"content": PLAIN_SAMPLE})
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["segments"]) >= 1
    assert data["word_count"] > 0


def test_auto_detect_format():
    # VTT detection
    resp = client.post("/parse-transcript", json={"content": VTT_SAMPLE})
    assert resp.status_code == 200

    # Diarized detection
    resp = client.post("/parse-transcript", json={"content": DIARIZED_SAMPLE})
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["segments"]) >= 2


def test_empty_transcript():
    resp = client.post("/parse-transcript", json={"content": ""})
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["segments"]) >= 1
