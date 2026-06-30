# Validity Harness Runbook (epoch-v2 regression gate)

The graph validity & quality harness ([doc 39](../architecture/truth-graph/39-graph-validity-harness.md))
is the regression gate for epoch-v2 ([doc 41](../architecture/truth-graph/41-epoch-v2-design.md),
epic `nmemo-vpz`). It drives the LIVE platform through each ingestion arm, captures
the canonical + rich graph, and scores forward-vs-reverse litmus, deterministic
invariants (`singleActivePerExclusiveGroup`), correctness vs gold, and per-step
instrumentation, persisting a snapshot per run.

Driver: `platform/scripts/compare-ingestion.ts`.

## One-command invocation

From `platform/`, against a running platform:

```
npx tsx scripts/compare-ingestion.ts --chunks <corpus.json> --url http://127.0.0.1:3001 --modes epoch
```

- `--chunks` a JSON array of chunk strings (e.g. `corpus3.json` / `corpus10.json` / `corpus20.json`).
- `--url` MUST be the platform port. The script default is `:3000`; the dev platform runs on `:3001`.
- `--modes serial,epoch,optimistic` (default all three). Litmus (forward + reverse) is ON unless `--no-litmus`.
- `--determinism` adds a second forward run (the LLM noise floor); `--repeats N` adds variance bands;
  `--review` adds a strong LLM judge (default `anthropic/claude-opus-4-8`).
- Output: `platform/benchmark-results/runs/<runId>/` (manifest + canonical/rich JSON + `metrics.json` +
  `report.md`) and one appended `history.jsonl` trend line.

## LIVE-SERVICES COORDINATION CAVEAT (read before running)

This is a LIVE run. It needs the full stack and it WIPES the graph (`/api/reset` before each arm).
**Coordinate before each run — services may be driven from another session.**

- Required up: platform `:3001`, ml-services `:8000`, Postgres `:5433`, Qdrant `:6335`, Ollama `:11434`.
- The platform + ml-services MUST run the **branch under test** (`feat/parallel-ingestion`). Epoch-v2 only
  works if the running code has the propose/promote pipeline (E2/E3), the proposer prompt (E4), and the
  runtime DB has the staging tables — run `npm run db:migrate` to apply migrations 040/041/042.
- Run the platform with `DISABLE_SCHEDULER=1` so its background patrols don't write to the DB mid-measurement.
- ml-services provider: use `claude` (the proposer runs via the Claude Code CLI -> the graph MCP server where
  the `propose_*` tools live). The Pi bridge (`:3099`) is Z.AI-only and cannot reach Anthropic; the doc-39
  judge default model has no transport there. The Z.AI GLM plan has a 5h usage limit (429s manifest as silent
  hangs). Haiku-first for the pipeline; a strong judge only for `--review`.

## Reading the result

- **SCORECARD**: per-arm wall-clock, entity/fact counts, dup counts, `litmusPass`.
- **SEMANTIC SCORECARD**: determinism F1 vs litmus(fwd|rev) F1. `litmus F1 ~= determinism F1` => order-independent
  up to extraction noise; `litmus F1 << determinism F1` => a real order / parallelism effect.
- `invariants.<arm>.<order>.summary.errorViolations == 0` => no coexisting exclusive-group facts
  (`singleActivePerExclusiveGroup`) — the headline epoch-v2 win.
- The deterministic backbone (E1 + E3 + E4) makes `promote(forward) == promote(reverse)` by construction
  (doc 41 §10); residual litmus variance isolates to the LLM extraction layer.

## Offline checks (no live services)

- The litmus-by-construction proof and promotion-replay determinism:
  `vitest run src/test/services/promotion-plan.unit.test.ts src/test/services/promotion.test.ts` (testDb).
- The three named bug scenarios `nmemo-bsb` / `nmemo-wyb` / `nmemo-3bp` are encoded as explicit cases in
  `promotion.test.ts` ("epoch-v2 bug-fix scenarios — named harness cases").
