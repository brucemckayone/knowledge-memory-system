# Pre-registration — does description-aligned entity embedding improve retrieval?

**Status:** FROZEN pre-registration. Written and committed BEFORE any number was computed.
**Date:** 2026-08-31 · **Branch:** `feat/single-graph-retrieval`
**Beads:** follows `nmemo-9b4`, `nmemo-86z`, `nmemo-vga` (all closed this session).

---

## 1. Why this is the one untested lever

`00-consolidated-keep-list.md` §6 item 3 calls this "the one retrieval lever never tested". It was not
untested by choice — it was **silently unavailable**, for two independent reasons found this session:

1. `promotion-plan.ts` hardcoded `summary: null`, so `entities.description` was NULL on **all 3,406
   canonical entities across all 8 corpora** in `cognitive_test` (measured). The proposer agents author
   summaries — 1,430 of 1,558 surviving staged proposals (92%) carried one — and the planner discarded
   them.
2. `promotion.ts` embeds `entityEmbedTextFor(name, summary, mode)`. Both arXiv ingests ran with
   `EMBED_DESCRIPTIONS=true`, so the composite path was active — **with `summary` always null**. Every
   entity vector in the substrate embeds a bare name. The flag was on and had nothing to act on.

So no prior result speaks to this lever in either direction. Both defects are fixed on this branch
(commits `b14cca6`, `50ff95a`, `2a9047e`).

## 2. The question

Does embedding an entity's **authored description alongside its name** make that entity more
retrievable than embedding the **bare name**, on the same graph?

## 3. Design — within-graph, vector-text-only

The obvious design (old graph = control, new graph = treatment) is **rejected**: a re-ingest re-runs
Haiku extraction, so the two graphs would differ in their entity and fact sets. That confounds
"description-aligned vectors" with "a different extraction", and the extraction difference would
plausibly dominate.

Instead: **one** fresh ingest, then two arms over the *same* entity set.

- **Substrate:** re-ingest `corpus-A.json` (147 docs) and `corpus-B.json` (147 docs) — the committed,
  tracked 294-document arXiv corpora, identical inputs to the original run — into **new** corpus ids
  `dal-nlp` and `dal-cv`, via `ingestBatch(mode:'epoch', corpusId)`, with the fixed pipeline so
  `entities.description` is populated.
- **ARM-NAME:** entity vector = `embed(entityEmbedTextFor(name, desc, 'name'))` — the bare name.
- **ARM-DESC:** entity vector = `embed(entityEmbedTextFor(name, desc, 'name_description'))` —
  name, newline, description.

Same entities, same facts, same queries, same graph. **Only the embedded text differs.**

Cosine ranking is computed **in-process over the full entity set** (exact, ~2.5k entities by 768 dims),
not through the HNSW index. This is deliberate: post-filtered HNSW recall is itself a variable on this
branch (migration 058), and an approximate index must not be allowed to move the headline.

## 4. Task and oracle — held-out mention retrieval

Ground truth **by construction**, from the per-document attribution the ingest harness already
snapshots. No LLM judge, no external oracle, and specifically no embedding-correlated oracle (the
failure that compromised docs 28–30 per the keep list §5).

- A **query pair** is (entity `e`, document `d`) where `e` is attributed to `d`.
- **Held-out constraint (non-tautology guard):** `e` must be attributed to **at least 2 documents**,
  and `d` must **not** be the first-attributing document of `e`. An entity's description is authored at
  mint time, i.e. in the epoch of its first attribution. Restricting queries to *later* attributing
  documents means the description was not written from the query text. Without this guard, ARM-DESC
  would be scored on retrieving an entity from the very text its description was authored from, which
  the lever would pass by construction.
- **Query text:** the document's title and abstract, embedded with `embedForQuery`.
- **Candidate set:** all entities in the corpus of `d`.

### Metric — headline, pre-registered as the ONLY promotable number

**Recall@10**: the fraction of query pairs where `e` is in the top 10 entities by cosine similarity.

### Bar — pre-registered

`ARM-DESC Recall@10 − ARM-NAME Recall@10`, paired per query pair, with a **95% bootstrap CI
(10,000 resamples, resampling query pairs)**:

| CI | verdict |
|---|---|
| entirely above 0 | **lever DEMONSTRATED** |
| spans 0 | **TIE — lever not demonstrated.** A tie is a tie; it is not "a slight win" |
| entirely below 0 | **lever HARMS retrieval** |

### Secondary — reported, explicitly NOT promotable to the headline

Recall@1, Recall@5, MRR, and the per-corpus split. These are for understanding, and may not be
substituted for Recall@10 if Recall@10 disappoints. Naming them here is what stops that swap.

## 5. Diagnostics reported unconditionally

Reported whichever way the result goes, because each one changes how a null should be read:

1. **Description coverage** — percentage of minted entities with a non-blank description.
2. **Description informativeness** — mean length, and token-Jaccard overlap between description and
   name. *If descriptions largely restate the name, a null result says the descriptions were
   uninformative, NOT that the lever fails.* This distinction must be drawn before the number is read.
3. **Vector divergence** — percentage of entities whose two arm vectors differ (cosine < 0.999).
4. **Query truncation** — whether title plus abstract exceeds the embedding model's token limit
   (nomic-embed-text truncates silently; a known trap in this repo).
5. **n** — number of query pairs, and the number of multi-attributed entities they come from.

## 6. Kill conditions — void the run rather than report it

- Description coverage **< 50%** → VOID. The lever was not actually available, and reporting it would
  be a re-run of the same silent no-op.
- Vector divergence **< 90%** → VOID. The two arms are not meaningfully different.
- **n < 100** query pairs → report as UNDERPOWERED with no verdict. The CI would be uninformative,
  which is the Leg-7 mistake (a kappa CI of [0.00, 0.47] at n=30 settled nothing).

## 7. Process commitments

- This document is committed before the harness is written, and is not edited once numbers exist
  except to append results in a clearly marked section.
- The harness is audited against this frozen text before the numbers are read.
- A **blind adversary** reviews before anything is banked, tasked in **both** directions — to argue the
  result is overstated AND that it is understated. Across this project 12–13 over-statements were
  caught, and since doc 24 the majority ran **pessimistic**.
- Deterministic set arithmetic throughout; no LLM in the measurement path.
- Watch for silent no-ops specifically: every largest finding in this project was a feature reporting
  success while doing nothing. A `0` or a `PASS` gets verified two ways before it is believed.

---

## APPENDED BEFORE ANY NUMBER WAS COMPUTED — substrate deviations

Recorded here, in the frozen document, **before the harness was run**, so that neither deviation can be
presented as a footnote after the fact. Both reduce coverage; neither can create a false query pair,
because every pair still comes from a true attribution.

**Deviation 1 — corpus B is 110 of 147 documents (74.8%).** The re-ingest stopped on an external
blocker: the Claude API returned `429` with *"You've hit your org's monthly spend limit"*. The harness is
resumable and did not mark the batch done, so the remaining 37 documents can be ingested whenever credit
is available. Documents are processed in corpus-file order (OpenAlex work ids, effectively arbitrary with
respect to topic), so a 74.8% prefix is not systematically biased by subject — but it is a prefix, not a
random sample, and that is the honest characterisation.

**Deviation 2 — 10 of corpus A's 147 documents have no attribution.** Self-inflicted: while the ingest
was running I ran `promotion.test.ts` against the same database, and its cleanup contained three
unscoped `DELETE FROM staging_proposed_*` statements. That removed the in-flight batch's staging rows
before the harness could snapshot paper-level attribution from them, and staging is transient by design
so it could not be reconstructed. Ledger positions 60–69. All three suites carrying that pattern are now
scoped. Details in `03-blocker-closeout-findings.md` §9.5.

**Not repaired, deliberately.** Re-ingesting those 10 documents would extract them a second time, making
10 of 294 documents non-uniform in a substrate whose whole purpose is a controlled comparison. With
n = 300 the power is not the binding constraint, so the loss is left in place rather than traded for
an inhomogeneity.

**State at run time [M]:**

| | corpus A (`dal-nlp`) | corpus B (`dal-cv`) |
|---|---|---|
| documents ingested | 147 / 147 | **110 / 147** |
| documents with attribution | 137 | 110 |
| multi-attributed entities | 87 | 68 |
| query pairs contributed | 177 | 123 |
| entities | 1,133 | 960 |
| description coverage | **98.9%** | **99.4%** |

**n = 300 query pairs**, against the pre-registered kill threshold of 100. Description coverage is far
above the 50% VOID threshold in both corpora. So the run proceeds, and its headline is reported for the
substrate described above rather than for a complete 294-document one.
