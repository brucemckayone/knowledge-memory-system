"""Unit tests for the test-harden subagent-output parsers.

Run with:
    python -m unittest .claude.skills.test-harden.tests.test_parsers
or:
    python .claude/skills/test-harden/tests/test_parsers.py

These tests exercise the markdown parsers in apply-evolver-output.py and
file-bead-from-analyser.py against canned subagent output, asserting that
every required field is extracted correctly and that malformed input is
rejected with a clear error.
"""

import importlib.util
import json
import sys
import unittest
from pathlib import Path

SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"


def _load(module_name: str, file_name: str):
    """Load a hyphen-named .py file as an importable module."""
    spec = importlib.util.spec_from_file_location(
        module_name, SCRIPTS_DIR / file_name,
    )
    mod = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = mod
    spec.loader.exec_module(mod)
    return mod


apply_evolver = _load("apply_evolver", "apply-evolver-output.py")
file_bead = _load("file_bead", "file-bead-from-analyser.py")


# ---------- Evolver-output parser ----------

GOOD_EVOLVER_MD = """\
## Mutation proposal

**Fixture version:** v1.1 -> v1.2
**Axis:** concurrency
**Criterion targeted:** "Concurrent mutations don't lose audit rows"
**Complexity delta:** +20 (from 14 to 34)

### Rationale
Push concurrency stressor by introducing 50 parallel writers writing to the same fact.

### Fixture diff
```sql
-- simple-mutations.sql (v1.2)
BEGIN;
INSERT INTO public.entities (id, canonical_name, entity_type, embedding, confidence)
VALUES ('00000000-0000-0000-0000-000000000001', 'Alice', 'person',
        ARRAY(SELECT 0.0 FROM generate_series(1, 768))::vector, 1.0)
ON CONFLICT (id) DO NOTHING;
-- STRESSOR: concurrency=50
COMMIT;
```

### Expected JSON diff
```json
{
  "scenario": "simple-mutations",
  "version": "1.2",
  "assertions": [
    {"type": "row_count", "table": "fact_history", "expected": 50}
  ]
}
```

### Regression-test promise
This mutation MUST pass on iteration N+1.
"""

UNICODE_ARROW_EVOLVER_MD = GOOD_EVOLVER_MD.replace("v1.1 -> v1.2", "v1.1 → v1.2")


class TestEvolverParser(unittest.TestCase):
    def test_parses_all_required_fields(self):
        parsed = apply_evolver.parse_evolver_markdown(GOOD_EVOLVER_MD)
        self.assertEqual(parsed["fixture_version"], "v1.1 -> v1.2")
        self.assertEqual(parsed["axis"], "concurrency")
        self.assertIn("Concurrent mutations", parsed["criterion"])
        self.assertEqual(parsed["complexity_delta"], "+20 (from 14 to 34)")
        self.assertIn("STRESSOR: concurrency=50", parsed["fixture_sql"])
        self.assertIn('"version": "1.2"', parsed["expected_json_text"])
        self.assertIn("50 parallel writers", parsed["rationale"])

    def test_normalise_version_ascii_arrow(self):
        old, new = apply_evolver.normalise_version("v1.1 -> v1.2")
        self.assertEqual((old, new), ("v1.1", "v1.2"))

    def test_normalise_version_unicode_arrow(self):
        old, new = apply_evolver.normalise_version("v2 → v3")
        self.assertEqual((old, new), ("v2", "v3"))

    def test_normalise_version_rejects_malformed(self):
        with self.assertRaises(ValueError):
            apply_evolver.normalise_version("v1.1")
        with self.assertRaises(ValueError):
            apply_evolver.normalise_version("rolling -> stable")

    def test_complexity_delta_parser(self):
        d, c, n = apply_evolver.parse_complexity_delta("+20 (from 14 to 34)")
        self.assertEqual((d, c, n), (20, 14, 34))
        d, _, _ = apply_evolver.parse_complexity_delta("-5")
        self.assertEqual(d, -5)

    def test_expected_json_strips_slash_comments(self):
        text = "// optional hint\n{\n  \"a\": 1\n}\n"
        obj = apply_evolver.validate_expected_json(text)
        self.assertEqual(obj, {"a": 1})

    def test_expected_json_rejects_invalid(self):
        with self.assertRaises(json.JSONDecodeError):
            apply_evolver.validate_expected_json("{ not: json }")

    def test_unicode_arrow_in_version_field(self):
        parsed = apply_evolver.parse_evolver_markdown(UNICODE_ARROW_EVOLVER_MD)
        old, new = apply_evolver.normalise_version(parsed["fixture_version"])
        self.assertEqual((old, new), ("v1.1", "v1.2"))

    def test_missing_fixture_block(self):
        bad = GOOD_EVOLVER_MD.replace("### Fixture diff", "### Other")
        with self.assertRaisesRegex(ValueError, "Fixture diff"):
            apply_evolver.parse_evolver_markdown(bad)

    def test_missing_expected_json_block(self):
        bad = GOOD_EVOLVER_MD.replace("### Expected JSON diff", "### Other JSON")
        with self.assertRaisesRegex(ValueError, "Expected JSON diff"):
            apply_evolver.parse_evolver_markdown(bad)

    def test_missing_required_field(self):
        bad = GOOD_EVOLVER_MD.replace("**Axis:** concurrency", "Axis: concurrency")
        with self.assertRaisesRegex(ValueError, "axis"):
            apply_evolver.parse_evolver_markdown(bad)

    def test_strip_outer_transaction(self):
        sql = "BEGIN;\nINSERT INTO x VALUES (1);\nCOMMIT;\n"
        out = apply_evolver.strip_outer_transaction(sql)
        self.assertNotIn("BEGIN", out)
        self.assertNotIn("COMMIT", out)
        self.assertIn("INSERT INTO x", out)

    def test_strip_outer_transaction_idempotent_when_absent(self):
        sql = "INSERT INTO x VALUES (1);\n"
        out = apply_evolver.strip_outer_transaction(sql)
        self.assertEqual(out.strip(), sql.strip())


# ---------- Analyser-output parser ----------

GOOD_ANALYSER_MD = """\
## Failure analysis

**Classification:** code-bug
**Confidence:** high
**Affected:** `platform/src/services/audit.ts:142` in function `recordFactChange`

### Root cause hypothesis
The actor parameter is silently coerced to lowercase before insertion, but the
DB CHECK constraint is case-sensitive on the actor enum, so an upstream caller
passing `Reasoning_Agent` slips through validation and fails at insert time.

### Evidence
- Stack trace: `at recordFactChange (platform/src/services/audit.ts:142:18)`
- Assertion: `expected actor to be one of [...] but got 'reasoning_agent'`
- Agent pattern: same entity queried 5+ times — prompt ambiguity

### Suggested fix direction
Add an explicit case-sensitive validation step in the service layer that rejects
non-canonical actor values before they reach the DB. This keeps the CHECK
constraint as the second line of defence rather than the only one.

### Bead issue text
```
Title: [code-bug] audit.ts: case-variant actor reaches DB CHECK
Type: bug
Priority: 1
Description:
The audit service does not validate actor casing before insert. Upstream agents
that pass non-canonical actor values (e.g. `Reasoning_Agent`) only fail at the
DB layer, producing confusing 23514 errors.

Affected: platform/src/services/audit.ts:142, function recordFactChange.
Discovered by: test-harden skill, scenario simple-mutations, run 2026-04-27.

## Symptom
Insert fails with check_violation on valid_fact_actor.

## Hypothesis
Service layer is missing an enum validator before INSERT.

## Suggested direction
Add a case-sensitive whitelist check in recordFactChange. Keep the DB CHECK as
backup; the service layer should be the canonical gate.
```
"""


class TestAnalyserParser(unittest.TestCase):
    def test_parses_all_required_fields(self):
        parsed = file_bead.parse_analyser_markdown(GOOD_ANALYSER_MD)
        self.assertEqual(parsed["classification"], "code-bug")
        self.assertEqual(parsed["confidence"], "high")
        self.assertIn("audit.ts:142", parsed["affected"])
        self.assertIn("case-sensitive", parsed["root_cause"])
        self.assertIn("same entity queried", parsed["evidence"])
        self.assertIn("case-sensitive validation", parsed["suggested_fix"])
        self.assertEqual(parsed["title"], "[code-bug] audit.ts: case-variant actor reaches DB CHECK")
        self.assertEqual(parsed["type"], "bug")
        self.assertEqual(parsed["priority"], "1")
        self.assertIn("Affected: platform/src/services/audit.ts:142", parsed["description"])

    def test_validate_passes_on_good_input(self):
        parsed = file_bead.parse_analyser_markdown(GOOD_ANALYSER_MD)
        self.assertEqual(file_bead.validate(parsed), [])

    def test_validate_rejects_bad_classification(self):
        bad = GOOD_ANALYSER_MD.replace(
            "**Classification:** code-bug",
            "**Classification:** mystery",
        )
        parsed = file_bead.parse_analyser_markdown(bad)
        errs = file_bead.validate(parsed)
        self.assertTrue(any("classification" in e for e in errs))

    def test_validate_rejects_bad_priority(self):
        bad = GOOD_ANALYSER_MD.replace("Priority: 1", "Priority: 99")
        parsed = file_bead.parse_analyser_markdown(bad)
        errs = file_bead.validate(parsed)
        self.assertTrue(any("priority" in e for e in errs))

    def test_validate_rejects_short_description(self):
        bad = GOOD_ANALYSER_MD.split("Description:", 1)[0] + "Description:\nshort\n```\n"
        parsed = file_bead.parse_analyser_markdown(bad)
        errs = file_bead.validate(parsed)
        self.assertTrue(any("description" in e for e in errs))

    def test_missing_classification(self):
        bad = GOOD_ANALYSER_MD.replace("**Classification:**", "Classification:")
        with self.assertRaisesRegex(ValueError, "Classification"):
            file_bead.parse_analyser_markdown(bad)

    def test_missing_bead_block(self):
        bad = GOOD_ANALYSER_MD.replace("### Bead issue text", "### Other")
        with self.assertRaisesRegex(ValueError, "Bead issue text"):
            file_bead.parse_analyser_markdown(bad)

    def test_missing_title_in_bead_block(self):
        bad = GOOD_ANALYSER_MD.replace(
            "Title: [code-bug] audit.ts: case-variant actor reaches DB CHECK\n",
            "",
        )
        with self.assertRaisesRegex(ValueError, "Title"):
            file_bead.parse_analyser_markdown(bad)


if __name__ == "__main__":
    unittest.main(verbosity=2)
