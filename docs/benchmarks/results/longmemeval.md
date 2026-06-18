# longmemeval — results

Trend table; latest run first. JSON envelopes live in `/benchmarks/results/longmemeval/runs/`. Schema in [`docs/benchmarks/plan.md`](../plan.md) §1.4.

| Date | Mnemo SHA | Cut | Model | Judge | N | Scores | Notes |
|------|-----------|-----|-------|-------|---|--------|-------|
| 2026-06-15 | b64a476 | LongMemEval_S | claude-haiku-4-5-20251001 | claude-sonnet-4-6 | 1 | overall_accuracy=1.000, by_category=<dict>, abstention_rate=None, sanity_pass=False, n=1, correct=1, errors=0 | resume window 95 (final 24 + query), ml-services restarted; 2026-06-15 |
| 2026-06-12 | b64a476 | LongMemEval_S | claude-haiku-4-5-20251001 | claude-sonnet-4-6 | 1 | overall_accuracy=0.000, by_category=<dict>, abstention_rate=None, sanity_pass=False, n=1, correct=0, errors=1 | 1-question smoke, session-reset after limit hit 2026-06-10, timeout 1200s, pe... |
| 2026-06-10 | b64a476 | LongMemEval_S | claude-haiku-4-5-20251001 | claude-sonnet-4-6 | 1 | overall_accuracy=0.000, by_category=<dict>, abstention_rate=None, sanity_pass=False, n=1, correct=0, errors=1 | 1-question smoke, host stack, migrations 038+039 applied, HTTP timeout 1200s,... |
| 2026-06-09 | b64a476 | LongMemEval_S | claude-haiku-4-5-20251001 | claude-sonnet-4-6 | 1 | overall_accuracy=0.000, by_category=<dict>, abstention_rate=None, sanity_pass=False, n=1, correct=0, errors=1 | 1-question smoke, full host stack, AFTER migrations 038(fact_units)+039(AGE s... |
| 2026-06-02 | 239263d | LongMemEval_S | claude-haiku-4-5-20251001 | claude-sonnet-4-6 | 21 | overall_accuracy=0.524, by_category=<dict>, abstention_rate=0.667, sanity_pass=True, n=21, correct=11 | nmemo-3f9.4 smoke |
| 2026-06-01 | c510009 | LongMemEval_S | claude-haiku-4-5-20251001 | claude-sonnet-4-6 | 1 | overall_accuracy=0.000, by_category=<dict>, abstention_rate=None, sanity_pass=False, n=1, correct=0, errors=0 | resume from chunk 55 after session-limit interruption; graph preserved (284 e... |
