# 38 — Dedup / canonicalization hardening: design (nmemo-asf.5, Phase 1.4)

Bead `nmemo-asf.5`. This doc grounds the design in the current code + a measurement of the live substrate,
so the write-path change is made deliberately. Related bugs: `nmemo-cki`, `nmemo-x4s`, `nmemo-ecn`.

## 1. How dedup / reconciliation works today

| | Serial arm (`extract`, default mode) | Epoch arm (`promote`, used by the research corpora) |
|---|---|---|
| Reuse key | `createEntity` — `lower(canonical_name)` + `entity_type`, **no corpus** (`entities.ts:253-256`) | `normalizeName(name)` + `entity_type` + corpus (`promotion.ts:402-406`) |
| Name normalize | raw `lower()` | `normalizeName` (lowercase, collapse spaces, strip `Dr/Mr` prefixes + edge punctuation) — `promotion-plan.ts:335` |
| Merge **detection** | `detectMergeCandidates` runs but **corpus-blind** (no arg → `'default'`) — `pipeline.ts:718` | not called |
| Merge **execution** | LLM `reconciliation_agent` via `maybeTriggerReconciliation` → `execute_merge` → `mergeEntities` | only to execute an arbiter identity verdict (`promotion.ts:363`) |

Inconsistencies: the two arms normalize names differently; detection is corpus-blind (serial) / absent (epoch);
the only self-directed merge executor is an **LLM agent** (spend); the gardener's deterministic merge path was
retired (`nmemo-5fa`).

## 2. Measured problem (cognitive_test)

Within every named corpus: **0 exact `(name, type)` duplicates** — the key holds. All fragmentation is the
`entity_type` axis (one real entity split because each extraction emitted a different type string):

- `chatgpt` (arxiv-nlp) = **21 rows** across `AI_System`/`ai_system`/`model`/`tool`/`LLM`/… ; `large language
  models` = 16; `chatgpt` (dal-nlp) = 19.
- Fragmented name-groups per corpus: qbio 103, arxiv-nlp 81, arxiv-cv 76, dal-cv 74, dal-nlp 67 (~5-8% of
  names, concentrated on high-value entities). `nmemo-x4s`: **26-37% of facts touch a fragmented node**.
- `default` shows 247 exact dupes — all test fixtures (`john smith`, `hub entity`, `consistency test entity
  0-4`, `spoke 1/2/3`), ignore.

**Embedding regime split (decisive for the guard):** same-name rows to their representative —

| corpus | groups | avg cos | min cos | members < 0.95 |
|---|---|---|---|---|
| qbio / arxiv-nlp / arxiv-cv | 103 / 81 / 76 | **1.0000** | 1.0000 | 0 |
| dal-cv / dal-nlp | 74 / 67 | 0.83 | 0.63 | 100/105, 128/132 |

qbio/arxiv embedded name-only (identical vectors for a shared name); dal embedded name+description composite
(EMBED_DESCRIPTIONS on → vectors differ). So **an embedding-agreement guard is incoherent across the
substrate** — trivially true on 3 corpora, meaningful on 2. A homonym guard must be **fact-neighbourhood**
based, not embedding based. (Also a standing substrate inconsistency relevant to `nmemo-u8j`.)

## 3. Decision

`entity_type` carries no scientific signal (doc 34 §7) and the current type-in-key gives **zero** homonym
protection — it only fragments. Genuine homonyms (`target` = company/person) appear only in the `default`
test corpus, not the research corpora. So:

**Identity = `(normalizeName(name), corpus)`; `entity_type` becomes a first-seen attribute, not identity.**
Deterministic, no LLM. This is the `nmemo-x4s` "relax reuse" fork, chosen over "restore merge detection"
because it fixes fragmentation at the source on both arms and needs no LLM disposer.

Split into two steps, mirroring the causal-mirror precedent (`nmemo-asf.3` forward-fix + `nmemo-asf.10`
backfill):

- **`.5` now (forward, non-destructive):** change the two reuse keys; unify name normalization; corpus-scope
  the serial path. Stops *new* fragmentation. Does not merge existing rows.
- **New bead (destructive, guarded):** backfill-merge the existing fragments (chatgpt's 21 → 1) via
  `mergeEntities` (repoints facts), guarded by fact-neighbourhood overlap for homonyms. Own measurement +
  gate. `mergeEntities`' old blocker `nmemo-9vk` is now closed.

## 4. Exact edits (`.5` forward — as shipped)

1. **`entities.ts` `createEntity`** — advisory-lock key (`:247`) + existence check (`:253-256`) key on
   `(lower(name), corpusId)`: drop the `entityType` equality, add the corpus predicate (`nmemo-cki`). Kept
   `lower()` (not `normalizeName`) — the SQL keys on both arms already use `lower()`, so they stay
   consistent; prefix-stripping normalization in SQL is low-value and deferred.
2. **`promotion.ts` epoch mint-idempotency** (`:410-414`): drop `eq(entities.entityType, e.type)`; keep
   `lower(name)` + corpus. **Added `ORDER BY entities.createdAt, entities.id` before `LIMIT 1`** — once
   type leaves the key the reuse query can match several same-name rows (the pre-backfill fragments), so a
   deterministic earliest-wins pick preserves promotion re-run idempotency (doc 41 §12 #9). The pure planner
   is NOT restructured: it still clusters staged mentions by `(type, norm)`, and those clusters converge here
   at mint (`mintedEntityIds` is keyed by clusterKey; both keys map to the one id).
3. **`pipeline.ts:718`** — resolve the entities' own corpus (`SELECT DISTINCT corpus_id`) and pass it to
   `detectMergeCandidates`, instead of the `'default'` the arg defaulted to.
4. **`corpus-ingest.ts` NOT retired** — it is still imported by the audit-corpus tooling
   (`ingestCodeElement`/`ingestRuleElement`/`upsertCorpusElementEntity`, used by `audit-*`/`floor-*`/`recall-service`
   probes). Its `createEntity`-corpus-blind workaround is now redundant, but its element-ingest helpers are
   live, so it stays. Retiring it is separate cleanup.

**Caller impact (verified):** only these two keys encode `(name,type)` as identity. Other `entity_type`
uses are filters / display / pattern-matching / fuzzy search (`entities.ts:337,348,383`,
`causal-agent.ts:3276`, `causal-patterns.ts:1054`, `graph-canonical-query.ts:28`, `promotion.ts:198-216`) —
they stay. The `_concepts` corpus is uniformly `type='concept'` (0 fragmentation), so dropping type from the
mint key is a no-op there.

## 5. Gate (done)

`platform/src/test/tools/dedup-identity-probe.ts` — deterministic, no Claude, self-cleaning. Serial arm via
`createEntity`; epoch arm via hand-seeded staging + the real `promote()` (the `promote-probe.ts` pattern).
8/8 assertions PASS: same name under two types → **one** entity on both arms; both epoch facts resolve to the
single collapsed entity; a same-name mint in a *different* corpus stays separate (cki). tsc held at 69.

## 6. Explicitly out of scope for `.5`

Existing-fragment backfill-merge (separate bead, guarded). The LLM `reconciliation_agent` route. Authoring a
per-corpus type/predicate ontology (`nmemo-ecn` — deprioritised by its own notes; predicate constraint was
`nmemo-4g9`, closed). The dal-vs-arxiv embedding-regime inconsistency (`nmemo-u8j`).
