# /check-contradiction rewrite — 2026-04-24

**Branch:** `feat/reasoning-agent`
**Beads:** `nmemo-0dx.1`
**Scope:** `ml-services/app/check_contradiction.py`

## Problem

Golden-set scores against the 10 `CONTRADICTION_PAIRS` fixtures in
`platform/src/test/quality/golden-scenarios.ts`:

| | Before | After | Threshold |
|---|---|---|---|
| E5 true-positive rate | 16.7% (1/6) | **100% (6/6)** | 80% |
| E6 true-negative rate | 25% (1/4)  | **100% (4/4)** | 90% |

## Root cause

The old pipeline ran an adversarial debate (advocate → defender → judge)
for every non-trivial pair. Three Haiku calls per pair and the judge
consistently sided with the advocate on ambiguous cases, producing both
false positives (`knows Bob` vs `knows Carol` called a contradiction)
and false negatives (`located_in London` vs `located_in Manchester`
called coexistable — the judge accepted "two offices, different
times").

The real signal is simpler: whether the predicate is **functional**
(one value at a time) or **multi-valued** (many values simultaneously).
Heuristics can classify nine of the ten golden pairs before any LLM
call; the LLM is now a fallback, not the primary mechanism.

## Design

Pipeline, in order:

1. **Different subjects → coexist.**
2. **Identical objects → coexist.**
3. **Antonym predicate pair** (e.g. `employed`/`unemployed`) with
   overlapping validity → contradict.
4. **Same predicate + predicate in `MULTI_VALUED_PREDICATES`** → coexist.
   Covers `knows`, `works_on`, `has_role`, `likes`, `owns`, `manages`,
   `uses`, `speaks`, `has_tag`, etc.
5. **Same predicate + predicate in `FUNCTIONAL_PREDICATES` + overlap**
   → contradict. Covers `works_at`, `located_in`, `lives_in`,
   `scheduled_for`, `married_to`, `ceo_of`, `born_on`, `has_price`,
   `has_salary`, etc.
6. **`has_status` slot match:** both objects start with the same
   attribute prefix (`Budget is …`, `Size: …`) but different values →
   contradict.
7. **Fallback: single LLM call** with a concise few-shot prompt. No
   more advocate/defender/judge.

## Coverage of the golden set

All 10 pairs now resolve via pure heuristics (no LLM call):

| Pair | Route |
|---|---|
| Alice works_at Acme/Beta | FUNCTIONAL |
| Project Budget £500k/£350k | has_status slot match |
| Office located_in Baker/King | FUNCTIONAL |
| Team Size 12/15 | has_status slot match |
| Launch scheduled_for Apr 15/May 1 | FUNCTIONAL |
| Company located_in London/Manchester | FUNCTIONAL |
| Alice knows Bob/Carol | MULTI_VALUED |
| Alice works_on Alpha/Beta | MULTI_VALUED |
| Alice has_role engineer/ML Lead | MULTI_VALUED |
| Alice vs Bob works_at Acme | Different subjects |

## Regression check

Full infra tier (`src/test/harness` + `src/test/integration`,
pre-existing 0 failing after test-debt sweep): 31 files passed,
1 flaky causal-pipeline test that passed on internal retry. No new
regressions.

## Tradeoffs

- **Taxonomy-driven, not semantic.** Unknown predicates fall through
  to the LLM. Extend the sets as new predicate shapes show up.
- **No debate log in the response.** The `DebateLog` optional field is
  gone. No callers relied on it.
- **Slot regex is conservative.** `^(attr)(:|is|=|—|-)(value)` — won't
  catch free-form statuses that lack a separator.

## Follow-ups

- Out-of-taxonomy predicates are the largest remaining failure mode;
  as the agentic extractor expands predicate vocabulary, keep the two
  sets in sync.
- If the LLM fallback becomes a hotspot, add a small cache keyed on
  `(subject, predicate, object1, object2)`.
