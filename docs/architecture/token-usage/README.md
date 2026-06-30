# Token Usage & Cost Tracking

Design for end-to-end LLM token-usage and cost tracking across the Mnemo platform,
ml-services, and benchmarks — model- and provider-aware, with a versioned pricing
map and blended multipliers, built to survive the move to a multi-model LiteLLM
routing architecture.

## Reading order

1. [`00-token-usage-and-cost-tracking.md`](./00-token-usage-and-cost-tracking.md)
   — the design (status: design, no code). Normalised per-call usage record,
   HTTP echo, the `llm_usage` table (migration `040`), versioned pricing map,
   benchmark rollup, reporting and projection.
2. [`01-hardening-review.md`](./01-hardening-review.md)
   — companion hardening review (multi-agent fleet, 2026-06-16). Corrections,
   SOTA-backed strengthenings, new risks, and a revised open-questions list. Kept
   as the standing record of the review; the design doc (00) has since been
   revised to fold in all of its corrections and risks.
3. [`02-usage-record-spec.md`](./02-usage-record-spec.md)
   — the `UsageRecord` normalisation contract (implemented in B1 / `nmemo-6do.1`):
   the 16 fields, the per-provider adapter rules, and the OpenAI uncached-remainder
   rule with a worked example. Expands 00 §4.1 / §9.2.

## Status

Design + review complete; review folded into the design (2026-06-16). No
implementation yet. The two blocking items (capture mechanism, token-normalisation
contract) are resolved in 00's design and restated as gating open questions (00 §9)
to confirm before code begins.

A follow-up **decoupling / maintainability pass** (2026-06-16) hardened three
boundaries — pricing single-source-of-truth in TS (00 §4.4), `ResourcePool` left
generic (00 §4.1), and cost enforcement separated from capture (00 §6) — plus a
schema-drift guard (00 §4.3) and a single `operation` enum (00 §4.7). Beads
`nmemo-6do.2/.5/.6/.10` carry matching addenda.
