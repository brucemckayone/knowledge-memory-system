#!/usr/bin/env python3
"""
redact-report.py — sanitise agent reasoning reports for consumption by the Data Evolver.

Strips implementation-specific references (file paths, function names, SQL column names)
while preserving semantic difficulty signals (entity names in the fixture, patterns of
confusion, tool call counts).

Usage:
  redact-report.py <report-file-or-stdin>
  echo "..." | redact-report.py -
"""

import json
import re
import sys
from pathlib import Path


# Redaction patterns — replace with [REDACTED:type]
PATTERNS = [
    # File paths — both forward and back slash
    (re.compile(r"(?<![\w/])(?:platform|ml-services|src|\.claude)(?:[/\\][\w\-.]+)+"), "[REDACTED:path]"),
    # TypeScript/Python function signatures
    (re.compile(r"\b(?:function|def|async function|class)\s+\w+", re.IGNORECASE), "[REDACTED:fn]"),
    # Line numbers in stack-trace format
    (re.compile(r":\d+:\d+\b"), ":[REDACTED:line]"),
    (re.compile(r"\bline\s+\d+\b", re.IGNORECASE), "line [REDACTED:line]"),
    # SQL column refs that aren't in the common schema
    # (keep common ones like entities.id, facts.predicate — redact implementation-leaking names)
    # crude: anything with an underscore and looks like snake_case_fn_name
    (re.compile(r"\b(?:recordFactChange|recordEdgeChange|applyConfidenceDecay|cascadeFactExpiry|detectCausalPatterns|analyzeImpact|findCausalGhosts|resolveContradiction|invokeGraphAgent|invokeReasoningAgent)\b"), "[REDACTED:fn]"),
    # Git SHAs
    (re.compile(r"\b[0-9a-f]{7,40}\b"), "[REDACTED:sha]"),
    # Absolute Windows/Unix paths
    (re.compile(r"(?<![\w:])(?:[A-Z]:)?[/\\](?:[\w\-.]+[/\\])+[\w\-.]+"), "[REDACTED:path]"),
]

# Signals to PRESERVE (these patterns, if matched, indicate the redaction should be skipped):
PRESERVE = [
    re.compile(r"entity[- ]?id\s*:\s*[a-f0-9\-]{36}", re.IGNORECASE),  # UUIDs are ok
    re.compile(r"predicate[- ]?category", re.IGNORECASE),
]


def redact(text: str) -> str:
    for pat, repl in PATTERNS:
        text = pat.sub(repl, text)
    return text


def redact_report(report: dict) -> dict:
    """Report is a reasoning_reports row. Redact the text fields, keep IDs and metadata."""
    out = dict(report)
    for k in ("report", "question"):
        if isinstance(out.get(k), str):
            out[k] = redact(out[k])
    if isinstance(out.get("actions_taken"), dict):
        # Recursively redact string values in actions_taken
        def _recurse(v):
            if isinstance(v, dict):
                return {k: _recurse(v) for k, v in v.items()}
            elif isinstance(v, list):
                return [_recurse(x) for x in v]
            elif isinstance(v, str):
                return redact(v)
            else:
                return v
        out["actions_taken"] = _recurse(out["actions_taken"])
    return out


def leak_check(text: str) -> list[str]:
    """Return a list of suspected leaks still present after redaction."""
    leaks = []
    # Any remaining file path
    if re.search(r"[/\\][\w\-]+\.(?:ts|py|sql|md|json)\b", text):
        leaks.append("file path pattern remains")
    # Any remaining function-call looking thing with dot notation
    if re.search(r"\b\w+\.\w+\([^)]*\)", text):
        leaks.append("dotted function call remains")
    return leaks


def main():
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        sys.exit(2)

    source = sys.argv[1]
    if source == "-":
        content = sys.stdin.read()
    else:
        content = Path(source).read_text(encoding="utf-8")

    # Try JSON parse first
    try:
        data = json.loads(content)
        if isinstance(data, list):
            out = [redact_report(r) for r in data]
        else:
            out = redact_report(data)
        output = json.dumps(out, indent=2)
    except json.JSONDecodeError:
        output = redact(content)

    leaks = leak_check(output)
    if leaks:
        print("-- REDACTION WARNING --", file=sys.stderr)
        for leak in leaks:
            print(f"  {leak}", file=sys.stderr)
        print("-- END WARNING --", file=sys.stderr)

    print(output)


if __name__ == "__main__":
    main()
