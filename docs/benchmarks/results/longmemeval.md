# longmemeval — results

Trend table; latest run first. JSON envelopes live in `/benchmarks/results/longmemeval/runs/`. Schema in [`docs/benchmarks/plan.md`](../plan.md) §1.4.

> **NO ACCURACY HAS BEEN MEASURED ON THIS BENCHMARK BY ANY RUN MARKED `DRY-RUN` BELOW.** A dry run is a plumbing test of the dataset/score/envelope/markdown pipeline. It calls neither Mnemo nor the judge: it builds synthetic questions and scores them with an alternating stub, `score = 1.0 if idx % 2 == 0 else 0.0` (`benchmarks/longmemeval/run.py`). Every figure such a row reports is an artifact of that loop — the `overall_accuracy=0.524` on the 2026-06-02 row is just the fraction of even indices in 21 items (11/21 = 0.5238), and its `sanity_pass=True` / `abstention_rate=0.667` are 2/3 of three synthetic abstention stubs. Treat these rows as evidence the harness runs, and as nothing else.

| Date | Mnemo SHA | Cut | Model | Judge | N | Scores | Notes |
|------|-----------|-----|-------|-------|---|--------|-------|
| 2026-06-15 | b64a476 | LongMemEval_S | claude-haiku-4-5-20251001 | claude-sonnet-4-6 | 1 | overall_accuracy=1.000, by_category=<dict>, abstention_rate=None, sanity_pass=False, n=1, correct=1, errors=0 | resume window 95 (final 24 + query), ml-services restarted; 2026-06-15 |
| 2026-06-12 | b64a476 | LongMemEval_S | claude-haiku-4-5-20251001 | claude-sonnet-4-6 | 1 | overall_accuracy=0.000, by_category=<dict>, abstention_rate=None, sanity_pass=False, n=1, correct=0, errors=1 | 1-question smoke, session-reset after limit hit 2026-06-10, timeout 1200s, pe... |
| 2026-06-10 | b64a476 | LongMemEval_S | claude-haiku-4-5-20251001 | claude-sonnet-4-6 | 1 | overall_accuracy=0.000, by_category=<dict>, abstention_rate=None, sanity_pass=False, n=1, correct=0, errors=1 | 1-question smoke, host stack, migrations 038+039 applied, HTTP timeout 1200s,... |
| 2026-06-09 | b64a476 | LongMemEval_S | claude-haiku-4-5-20251001 | claude-sonnet-4-6 | 1 | overall_accuracy=0.000, by_category=<dict>, abstention_rate=None, sanity_pass=False, n=1, correct=0, errors=1 | 1-question smoke, full host stack, AFTER migrations 038(fact_units)+039(AGE s... |
| 2026-06-02 | 239263d | LongMemEval_S | claude-haiku-4-5-20251001 | claude-sonnet-4-6 | 21 | **DRY-RUN — STUB SCORER, NOT A MEASUREMENT:** overall_accuracy=0.524, by_category=<dict>, abstention_rate=0.667, sanity_pass=True, n=21, correct=11 | **DRY RUN (`idx % 2` stub judge)** — nmemo-3f9.4 smoke |
| 2026-06-01 | c510009 | LongMemEval_S | claude-haiku-4-5-20251001 | claude-sonnet-4-6 | 1 | overall_accuracy=0.000, by_category=<dict>, abstention_rate=None, sanity_pass=False, n=1, correct=0, errors=0 | resume from chunk 55 after session-limit interruption; graph preserved (284 e... |
