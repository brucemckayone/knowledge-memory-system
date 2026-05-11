# Graph Quality Issues

Identified 2026-04-16 after running the graph gardener and analyzing graph utility with an LLM.

Each issue is documented independently for implementation on a separate branch.

## Issues

| # | Issue | Priority | Complexity | Branch |
|---|-------|----------|------------|--------|
| 1 | [Self-Referential Facts](01-self-referential-facts.md) | High | Low | `fix/self-referential-facts` |
| 2 | [Mention Context Population](02-mention-context-population.md) | High | Low | `fix/mention-context-population` |
| 3 | [Gardener Fact Expiry](03-gardener-fact-expiry.md) | Medium | Medium | `feat/gardener-expire-facts` |
| 4 | [Predicate Explosion](04-predicate-explosion.md) | Medium | Medium | `feat/predicate-staging` |
| 5 | [Merge vs Same-As Quality](05-merge-same-as-quality.md) | Low | Low | `feat/gardener-merge-quality` |
| 6 | [Reasoning Agent](06-reasoning-agent.md) | High | High | `feat/reasoning-agent` |

## Tackling Order

1 and 2 are quick wins — clear bugs with straightforward fixes.
3 is superseded by 6 (reasoning agent subsumes fact expiry).
4 requires design decisions (strict vs staging for predicates).
5 is mostly resolved already — needs regression tests and minor cleanup.
6 is the big one — dedicated reasoning agent with patrol and query modes.
