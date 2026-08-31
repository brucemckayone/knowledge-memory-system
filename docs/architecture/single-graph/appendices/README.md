# Survey appendices — 2026-08-31

Verbatim-as-possible records of seven parallel read-only surveys run on 2026-08-31 over
`feat/cross-corpus-audit`. The consolidated conclusions are in `../00-consolidated-keep-list.md`;
these appendices hold the detail that was compressed out of it.

Each survey owned a disjoint slice so they could run concurrently without collision:

| # | file | scope |
|---|---|---|
| 1 | `01-arc-source-inventory.md` | the arc's 86 source files + migrations 051-057; wired vs inert; isolation gaps |
| 2 | `02-beads-corpus.md` | 559 issues + 53 memories; findings that exist only in the tracker |
| 3 | `03-decision-register.md` | arc docs 00-19: D1-D10, A1-A5, Q1-Q15, PC1-PC8 |
| 4 | `04-experiment-ledger.md` | arc docs 20-38: bars, results, adversary verdicts, retractions |
| 5 | `05-artifact-audit.md` | ~155 raw artifacts; reproduction; the doc 32/33 adversary debts |
| 6 | `06-other-doc-trees.md` | truth-graph / token-usage / benchmarks; the tiered query architecture |
| 7 | `07-ios-and-mcp.md` | the (now-stripped) iOS surface + the 50-tool MCP surface |

**Status of claims.** Each survey cited file:line or artifact values. I re-verified the load-bearing
claims by hand before folding them into the keep list; the rest are single-source and tagged as such in
the reports. Where a survey and my verification disagreed, the keep list records my measurement.

**Known limitation.** These were written by agents with fresh context reading a codebase whose docs are
demonstrably stale. Two of them found errors in my own prior work, and one found a false premise in a
frozen pre-registration. Treat any uncorroborated row as a lead, not a fact.
