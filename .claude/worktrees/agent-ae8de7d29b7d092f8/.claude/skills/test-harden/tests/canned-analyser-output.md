## Failure analysis

**Classification:** code-bug
**Confidence:** medium
**Affected:** `platform/src/services/audit.ts:142` in function `recordFactChange`

### Root cause hypothesis
The audit service does not validate actor-string casing before INSERT. Upstream callers passing case-variants like `Reasoning_Agent` slip through the service layer unchanged, hit the DB CHECK constraint `valid_fact_actor`, and fail with a confusing 23514 error rather than a clean validation message at the service boundary.

### Evidence
- Stack trace: `at recordFactChange (platform/src/services/audit.ts:142:18)`
- Assertion: `expected actor to be one of [...] but got 'Reasoning_Agent'`
- Agent pattern: same entity queried 5+ times — suggests prompt ambiguity contributing to non-canonical casing
- Git log: audit.ts last touched 12 commits ago in nmemo-w4j.3 — case-validation never landed

### Suggested fix direction
Add an explicit case-sensitive validator in `recordFactChange` that rejects non-canonical actor values with a typed error before the INSERT. Keep the DB CHECK as a defence-in-depth layer rather than the only gate. This matches Phase 1 acceptance criterion that "Actor required" implies the service layer is the canonical validator.

### Bead issue text
```
Title: [code-bug] audit.ts: case-variant actor reaches DB CHECK
Type: bug
Priority: 2
Description:
The audit service does not validate actor-string casing before INSERT. Upstream
callers passing case-variants such as `Reasoning_Agent` slip through the service
layer unchanged, hit the DB CHECK constraint valid_fact_actor, and fail with a
confusing 23514 error rather than a clean validation message at the service
boundary.

Affected: platform/src/services/audit.ts:142, function recordFactChange.
Discovered by: test-harden skill canned smoke test (klv.8.5 verification),
run on 2026-04-27.

NOTE: This is a CANNED TEST BEAD filed by file-bead-from-analyser.py to verify
the bd create wiring under nmemo-w4j. Close when verified.

## Symptom
INSERT fails with check_violation on valid_fact_actor when actor casing differs
from the canonical lowercase enum members.

## Hypothesis
Service layer is missing an enum validator before INSERT. The DB CHECK is
defence-in-depth, not the primary gate.

## Suggested direction
Add a case-sensitive whitelist check in recordFactChange. Reject non-canonical
values with a typed error at the service boundary so callers get a clean
diagnostic before the DB layer rejects.
```
