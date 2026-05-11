"""Tests for markdown parsing endpoint (W37)."""

from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)

MD_WITH_FRONTMATTER = """---
title: Test Note
tags: [project, meeting]
date: 2026-03-19
---

# Meeting Notes

We discussed the [[Release Plan]] and agreed on a timeline.

## Action Items

- Ship by Friday #deadline
- Fix the [API tests](https://ci.example.com/tests)
- Update the [[Documentation]]

## Links

See [docs](https://docs.example.com) for details.
"""

MD_WITHOUT_FRONTMATTER = """# Simple Note

Just a plain markdown note with some content.

## Section Two

More content here with a #tag and [[wikilink]].
"""


def test_parse_markdown_with_frontmatter():
    resp = client.post("/parse-markdown", json={"content": MD_WITH_FRONTMATTER})
    assert resp.status_code == 200
    data = resp.json()
    assert data["title"] == "Test Note"
    assert "project" in data["tags"] or "meeting" in data["tags"]
    assert data["frontmatter"]["date"] == "2026-03-19"
    assert len(data["sections"]) >= 2
    assert any("Release Plan" in w for w in data["wikilinks"])
    assert any("docs.example.com" in l for l in data["links"])
    assert data["word_count"] > 0


def test_parse_markdown_without_frontmatter():
    resp = client.post("/parse-markdown", json={"content": MD_WITHOUT_FRONTMATTER})
    assert resp.status_code == 200
    data = resp.json()
    assert data["title"] == "Simple Note"
    assert data["frontmatter"] == {}
    assert len(data["sections"]) >= 2


def test_extract_wikilinks():
    content = "Link to [[Page One]] and [[Page Two|display]]"
    resp = client.post("/parse-markdown", json={"content": content})
    assert resp.status_code == 200
    data = resp.json()
    assert "Page One" in data["wikilinks"]
    assert "Page Two" in data["wikilinks"]


def test_extract_tags():
    content = "Some text #alpha and #beta-gamma here"
    resp = client.post("/parse-markdown", json={"content": content})
    assert resp.status_code == 200
    data = resp.json()
    assert "alpha" in data["tags"]


def test_empty_markdown():
    resp = client.post("/parse-markdown", json={"content": ""})
    assert resp.status_code == 200
    data = resp.json()
    assert data["word_count"] == 0


def test_filename_as_title_fallback():
    resp = client.post("/parse-markdown", json={"content": "No heading here.", "filename": "my-note.md"})
    assert resp.status_code == 200
    data = resp.json()
    assert "my note" in data["title"].lower() or "my-note" in data["title"].lower()
