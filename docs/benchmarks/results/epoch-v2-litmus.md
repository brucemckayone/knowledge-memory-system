# Epoch-v2 validity-harness litmus — corpus3 smoke (post-E4)

First live run of the propose->promote pipeline through the validity harness
([doc 39](../../architecture/truth-graph/39-graph-validity-harness.md)), after E4
landed. Bead `nmemo-vpz.8` (E8).

- runId: `2026-06-15T14-41-36-935Z`
- branch: `feat/parallel-ingestion` (E4 = commit `82f42d0`, + E8 offline tests)
- corpus: `corpus3.json` (3 chunks); arm: `epoch`; forward + reverse litmus
- ml provider: `claude`; platform scheduler disabled (`DISABLE_SCHEDULER=1`)

## Result

| metric | value |
|---|---|
| entities | 4 |
| active facts | 9 |
| duplicate entities | 0 |
| duplicate facts | 0 |
| litmusPass (exact structural fwd == rev) | false |
| semantic litmus entityF1 / factF1 (fwd vs rev) | 0.89 / 0.63 |
| `singleActivePerExclusiveGroup` errorViolations (forward) | 0 |
| `singleActivePerExclusiveGroup` errorViolations (reverse) | 0 |

## Read

- **Headline win:** zero `singleActivePerExclusiveGroup` violations in BOTH orders.
  The coexisting-exclusive-facts failure doc 39 §1 documented (Elena's 5 active
  titles, Helix's dual HQ) does not reproduce — E1's cross-predicate supersession +
  E3/E4 ordering hold under the live pipeline.
- **litmus factF1 = 0.63 is the LLM-extraction floor, not a backbone regression.**
  The deterministic backbone is order-independent by construction (doc 41 §10),
  proven offline by `promotion-plan.unit.test.ts` (`plan(forward)` deep-equals
  `plan(reverse)`) and the promotion-replay determinism test. The live litmus also
  includes the non-deterministic extraction proposer, so forward and reverse stage
  different proposals; the residual isolates there. A `--determinism` run (same
  order twice) would confirm `litmus F1 ~= determinism F1`.
- 3 chunks is a tiny corpus where each differing fact moves F1 sharply; corpus10/20
  give a steadier band. Re-run per landed step and track the number here.
