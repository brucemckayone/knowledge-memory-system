## Failure analysis

**Classification:** code-bug
**Confidence:** high
**Affected:** `platform/src/services/audit.ts:142` in function `recordFactChange`

### Root cause hypothesis
`recordFactChange` performs no service-layer validation of the `actor` parameter before passing it through to the raw `INSERT INTO public.fact_history` statement. As a result, a case-variant value such as `"Reasoning_Agent"` (compared against the canonical lowercase set the DB CHECK constraint `valid_fact_actor` enforces) is rejected by Postgres with a 23514 check-constraint violation rather than by a friendly `Error('actor must be one of …')` thrown from the service. The test was asserting the documented invariant — "actor must be one of the known values" — and instead surfaced the raw DB-level error message, which indicates the validation layer between the TypeScript-typed `Actor` union and the database CHECK is missing or has been bypassed at runtime (TypeScript types alone don't gate string values that arrive from MCP/JSON callers). This is consistent with the phase-1 acceptance criterion "actor is a required parameter on all mutation functions (TypeScript enforces)" — the intent was clearly that the service layer would normalise/validate, not rely solely on the DB constraint as the user-facing error.

### Evidence
- Stack trace: `recordFactChange (platform/src/services/audit.ts:142:18)` then test at `audit-trail.test.ts:482:5`
- Assertion: `expected error to match /actor must be one of/ but got 'new row for relation "fact_history" violates check constraint "valid_fact_actor"'` (Postgres SQLSTATE 23514)
- Source excerpt (lines 102-129) shows the function gates only `reasoning` (non-empty check) before executing the raw SQL `INSERT`; there is no branch that inspects `params.actor` against an allowed-values list and throws a service-level Error before the round-trip to the DB
- Git history note: `c3601d8 p1-w4j.3: audit.ts — recordFactChange, recordEdgeChange, getFactHistory, getEdgeHistory` is the introducing commit; the more recent `5fc8f9c p1-w4j.10` touched jsonb stringification and did not add validation, so this is an original-implementation gap rather than a regression
- Agent pattern: not applicable — agent reasoning reports were not attached to this run (`<reports collection skipped>`)

### Suggested fix direction
Add an explicit allow-list validation step at the top of `recordFactChange` (and the symmetrical `recordEdgeChange` at line ~152, which almost certainly has the same gap) that compares `params.actor` against the canonical lowercase `Actor` values the DB CHECK accepts and, on mismatch, throws a service-layer `Error` whose message contains the phrase `"actor must be one of"` plus the allowed values. The check should be case-sensitive to mirror the DB constraint exactly so the two layers cannot disagree, and the same allowed-values constant should ideally be shared between the migration's CHECK definition and the service module to prevent future drift. No behaviour change is needed at the DB level — the CHECK is the correct last line of defence; the service layer just needs to fail-fast with a stable, user-facing message before reaching it.

### Bead issue text
```
Title: [code-bug] audit.ts: case-variant actor reaches DB CHECK instead of service-layer rejection
Type: bug
Priority: 2
Description:
`recordFactChange` (and presumably `recordEdgeChange`) in platform/src/services/audit.ts does not validate the `actor` parameter against the allowed canonical values before issuing the raw INSERT into `public.fact_history`. A case-variant value (e.g. "Reasoning_Agent") therefore surfaces as a Postgres SQLSTATE 23514 check-constraint violation on `valid_fact_actor` rather than a friendly service-layer `Error('actor must be one of …')`. TypeScript's `Actor` union type does not protect against runtime strings arriving from MCP/JSON callers, so an explicit case-sensitive allow-list check is needed at the top of each mutation function.

Affected: platform/src/services/audit.ts:142, function recordFactChange (and likely recordEdgeChange around line 152)
Discovered by: test-harden skill, scenario phase1/simple-mutations, run 2026-04-27

## Symptom
Assertion failure in audit-trail.test.ts:482 — "expected service-layer rejection, got 23514 from DB". Expected error matching /actor must be one of/ but received: `new row for relation "fact_history" violates check constraint "valid_fact_actor"`.

## Hypothesis
The function jumps straight from the existing `reasoning` non-empty check to the raw `INSERT` SQL without comparing `params.actor` to the canonical lowercase actor values the DB CHECK enforces. The DB constraint is doing the validation work the service layer was supposed to do, producing an opaque user-facing error and breaking the phase-1 acceptance criterion that mutation functions enforce actor validity.

## Suggested direction
Add a case-sensitive allow-list check at the top of `recordFactChange` (and `recordEdgeChange`) that throws a service-level Error with a message including "actor must be one of" plus the allowed values when `params.actor` is not in the canonical set. Share the allowed-values list between the migration's CHECK definition and the service module so the two layers cannot drift. No DB-level changes required — the CHECK should remain as the last line of defence.

## Agent feedback (if applicable)
N/A — agent reasoning reports were not attached to this run.

NOTE: filed by test-harden skill smoke test for klv.8.5 verification (2026-04-27); close after verification.
```
