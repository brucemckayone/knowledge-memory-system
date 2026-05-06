# 28 — Test Data Snapshots

**Type:** Platform testing infrastructure
**Master:** `21-cluster-bridging-master.md` (referenced; this doc is a sibling, not a child)
**Status:** Design draft (2026-04-29) — under review
**Bead:** to be created post-review; **blocks** Phase 1 close per master §10 lock B2

---

## 1. Purpose

The system has a working **SQL-fixture** test-data infrastructure (`18-test-data-hardening-protocol.md`) — small INSERT scripts that target specific scenarios at the unit/integration level. The fixtures live in-repo, are reviewable, and drive the recursive hardening loop. They are excellent for the sub-thousand-row cases.

What's missing is **production-shape representative state** at scale. Phase 1's benchmark targets 100, 1000, and 10000 entities. Phase 4's cross-cluster generator needs realistic multi-cluster graphs. Future scale work needs 50k+. None of this is achievable as INSERT scripts:

- Generation requires running the actual LLM-augmented ingest pipeline (extraction, embedding, reconciliation), which is slow and non-deterministic
- Storage as SQL would be MB–GB of text, too large to commit
- Recreation per test run would dominate test time

**This document defines the snapshot infrastructure**: a system for generating, caching, restoring, and version-tracking full database states (Postgres + Qdrant) so that benchmarks, scale tests, demos, and bug repros all run against deterministic, named, reproducible datasets.

It is complementary to `18`, not a replacement. SQL fixtures cover narrow, hand-crafted scenarios. Snapshots cover broad, generated, representative state.

## 2. Design

### 2.1 Two kinds of snapshot

Both produced by the same tooling, both addressed by name in the manifest, both restorable through the same script:

- **LLM-pipeline snapshots** — produced by running the real ingest pipeline against a source corpus. Slow to generate, deterministic to restore, capture realistic LLM-extracted structure.
- **Synthetic snapshots** — produced by a deterministic generator that emits random-but-shaped entities, facts, and centroids without invoking the LLM. Cheap, fast, scale-tunable, used for performance benchmarks where graph shape matters but content does not.

### 2.2 Standardised dataset roster

The initial roster, extensible via the manifest:

| Name | Kind | Source | Approx scale | Use |
|---|---|---|---|---|
| `empty` | LLM | (none) | 0 entities | schema-only baseline |
| `frankenstein-10chunks` | LLM | Project Gutenberg ch. 1–10 | ~60 entities | small narrative; canonical cluster-bridging case |
| `nist-sp800-63b-technical` | LLM | NIST SP 800-63B (Digital Identity Guidelines) excerpt | ~150 entities | technical, single-culture, public domain (cold-eyes review W8 — replaces MISRA, which is copyrighted) |
| `mixed-narrative-technical-1k` | LLM | combined Frankenstein + NIST SP 800-63B + a public-domain conversation transcript | ~1k entities | medium multi-cluster |
| `synthetic-1k` | Synthetic | generator | 1k entities | benchmark sweet-spot |
| `synthetic-10k` | Synthetic | generator | 10k entities | benchmark scale ceiling for unconditional phases |
| `synthetic-50k` | Synthetic | generator | 50k entities | future scale-test (T2/T3 work) |

**Note (cold-eyes review S10):** The original `mixed-narrative-technical-1k` referenced "work docs" — replaced with a third public-domain conversation transcript. No private corpora in committed snapshots.

Each dataset has a **manifest entry** that fully describes how to (re)generate it. New datasets are added by extending the manifest, not by ad-hoc scripts.

### 2.3 Manifest format

A single JSON file at `platform/src/test/snapshots/manifest.json` (committed). Each entry:

```json
{
  "name": "frankenstein-10chunks",
  "kind": "llm",
  "description": "First 10 chunks of Frankenstein from Project Gutenberg",
  "source_corpus": "test-corpora/frankenstein-ch1-10.txt",
  "ingest_params": {
    "chunk_size": 2000,
    "model": "haiku",
    "extraction_prompt_version": "v1.4",
    "claude_model_version_pin": "claude-haiku-4-5-20251001",
    "claude_temperature": 0.0,
    "embedding_model_pin": "nomic-embed-text:v1.5",
    "embedding_dim": 768
  },
  "pg_dump_flags": ["--format=custom", "--no-sync", "--no-comments"],
  "files": {
    "postgres": "snapshots/frankenstein-10chunks/cognitive.dump",
    "qdrant_memories": "snapshots/frankenstein-10chunks/memories.snapshot"
  },
  "expected_hashes": {
    "cognitive.dump": "sha256:...",
    "memories.snapshot": "sha256:..."
  },
  "schema_version": 13,
  "age_version": "1.5",
  "postgres_version": "16",
  "stats": {
    "total_entities": 58,
    "total_facts": 39,
    "total_memories": 10,
    "ingest_time_ms": 120000
  },
  "regenerated_at": "2026-04-29T10:30:00Z",
  "regeneration_command": "pnpm tsx scripts/generate-snapshot.ts frankenstein-10chunks",
  "deterministic": false,
  "notes": "Re-run when any pin changes (model version, prompt version, embedding model, temperature). Stats may drift ±5% across regenerations within fixed pins; larger drift indicates a pin needs updating. (Cold-eyes review B7 — pinning prevents silent drift on upstream model updates.)"
}
```

For synthetic entries:

```json
{
  "name": "synthetic-10k",
  "kind": "synthetic",
  "description": "10000 random entities, multi-cluster, no LLM, with labelled cross-cluster identity bridges",
  "generator_params": {
    "entity_count": 10000,
    "cluster_count": 5,
    "facts_per_entity_mean": 3.2,
    "centroid_dim": 768,
    "bridge_pairs": 50,
    "seed": 42
  },
  "files": {
    "postgres": "snapshots/synthetic-10k/cognitive.dump",
    "qdrant_memories": "snapshots/synthetic-10k/memories.snapshot",
    "ground_truth": "snapshots/synthetic-10k/ground_truth.json"
  },
  "expected_hashes": { ... },
  "schema_version": 13,
  "stats": {
    "total_entities": 10000,
    "total_facts": 32000,
    "bridge_pairs_count": 50,
    "...": "..."
  },
  "deterministic": true,
  "regeneration_command": "pnpm tsx scripts/generate-synthetic.ts synthetic-10k"
}
```

`bridge_pairs: N` instructs the generator to inject N pre-labelled identity-bridging cases — pairs of entities placed in *different* cluster modes (so their centroids diverge), sharing *no* facts or memories, but tagged as ground-truth co-referent. The cross-cluster generator (Phase 4) is evaluated against this label set: precision = (correctly-flagged pairs / all flagged pairs); recall = (correctly-flagged / N).

### 2.4 Storage strategy

**Snapshots themselves are not committed to git.** They live under `platform/test-snapshots/` (gitignored) on the developer's machine and on CI runners. Three things ARE committed:

1. **The manifest** (`platform/src/test/snapshots/manifest.json`) — single source of truth for what exists, with hashes for integrity
2. **Source corpora** for LLM snapshots (`platform/src/test/corpora/*.txt`) — committed to git per user direction 2026-04-29. Frankenstein ch. 1-10 ≈ 450 KB; MISRA excerpt smaller. If a corpus genuinely cannot be committed (license, size > 10 MB), use a `corpus_url` manifest field with a download script — but this is the exception, not the default
3. **Generator scripts** (`platform/scripts/generate-snapshot.ts`, `generate-synthetic.ts`, `load-snapshot.ts`) — the regeneration recipe

Anyone who needs a snapshot runs `pnpm snapshot:ensure <name>`, which:
- Reads the manifest entry
- If files exist locally + hashes match: done, returns
- If files exist but hashes mismatch: regenerates (warns about drift)
- If files don't exist: regenerates from scratch
- Validates schema_version against current migrations

This keeps the repo small, eliminates "snapshot is missing" friction, and makes drift audible.

### 2.5 Compute placement

All snapshot tooling lives in **`platform/scripts/`** (TypeScript, run via `pnpm tsx`). It uses:

- `pg_dump` / `pg_restore` from the Postgres client (already installed on the dev box)
- Qdrant HTTP API directly (no SDK dependency)
- Drizzle for migrations (existing)
- The same ingest pipeline that production uses, for LLM snapshots

**No Python sidecar work.** This is platform infrastructure, not ML. Scripts can run against any local Postgres+Qdrant pair (the `make up` stack on port 5433/6335).

### 2.6 Cross-platform considerations

The dev box is Windows 11 + Docker Desktop (WSL2). Three concerns:

- **Path separators**: scripts use `path.join` throughout; never raw string concatenation
- **`pg_dump` location**: Postgres client tools may not be on PATH. Scripts probe via Node's `child_process` rather than shell builtins (cold-eyes review S11): `process.platform === 'win32' ? execSync('where pg_dump') : execSync('which pg_dump')` — but `where` is a CMD builtin and unreliable from Git Bash. Preferred order: (1) `process.env.PG_DUMP_PATH` if set; (2) `child_process.spawnSync('pg_dump', ['--version'])` to test if it's resolvable on PATH; (3) common install paths (`C:\Program Files\PostgreSQL\*\bin\pg_dump.exe` on Windows; `/usr/bin/pg_dump`, `/usr/local/bin/pg_dump`, `/opt/homebrew/bin/pg_dump` on Unix); (4) **docker-exec fallback** — if `docker exec ${PG_DUMP_DOCKER_CONTAINER:-nmemo-postgres-1} pg_dump --version` succeeds, run pg_dump/pg_restore inside the container and stream binary I/O over stdout/stdin. The fallback covers the dev-box state where Postgres lives only in Docker and no client tools are installed on the host. Wired in `platform/scripts/lib/pg-tools.ts` (j77.1)
- **Line endings in source corpora**: corpora are checked in with LF (force via `.gitattributes`), regeneration produces deterministic output regardless of checkout style

### 2.7 Out of scope (this doc)

- **Snapshot diffing** — comparing two snapshots' graph state. Useful for regression analysis. Future work.
- **Streaming snapshot upload** — for snapshots too large to fit in memory during transfer. Phase 5+/6+ concern.
- **CI-side snapshot caching** — depends on CI infrastructure choices not yet made.
- **Multi-tenant or sharded snapshots** — not relevant at our scale.
- **Encrypted snapshots** — no PII in test corpora; not needed.

## 3. Implementation

### 3.1 Directory layout

```
platform/
├── src/
│   └── test/
│       ├── corpora/                        ← committed source text (Frankenstein, MISRA excerpt, etc.)
│       │   ├── README.md
│       │   ├── frankenstein-ch1-10.txt
│       │   └── misra-cpp-excerpt.txt
│       └── snapshots/
│           └── manifest.json               ← committed manifest
├── scripts/
│   ├── generate-snapshot.ts                ← LLM-pipeline regeneration
│   ├── generate-synthetic.ts               ← deterministic synthetic generator
│   ├── load-snapshot.ts                    ← restore Postgres + Qdrant from a named snapshot
│   ├── snapshot-ensure.ts                  ← idempotent "make sure this snapshot exists"
│   └── snapshot-verify.ts                  ← hash-check all snapshots in manifest
└── test-snapshots/                         ← GITIGNORED; per-machine cache
    ├── frankenstein-10chunks/
    │   ├── cognitive.dump
    │   └── memories.snapshot
    ├── synthetic-10k/
    │   ├── cognitive.dump
    │   └── memories.snapshot
    └── ...
```

The snapshot-ensure script is what tests call. Direct invocation of `generate-*` is for explicit regeneration only.

### 3.2 `pnpm` scripts

Add to `platform/package.json`:

```json
{
  "scripts": {
    "snapshot:ensure": "tsx scripts/snapshot-ensure.ts",
    "snapshot:generate": "tsx scripts/generate-snapshot.ts",
    "snapshot:synthetic": "tsx scripts/generate-synthetic.ts",
    "snapshot:load": "tsx scripts/load-snapshot.ts",
    "snapshot:verify": "tsx scripts/snapshot-verify.ts"
  }
}
```

### 3.3 Synthetic generator

`scripts/generate-synthetic.ts` is fully deterministic given the manifest's `generator_params.seed`. It exercises the **real** `updateEntityMeta` code path by layering data through the same dependency direction the production pipeline follows: per-memory vectors → memory rows + Qdrant points → memory_entities links → centroid computed by the existing service. This catches bugs that bypass-the-pipeline fakery would miss. (Cold-eyes review B6.)

**Hard guard (cold-eyes review S5):** The script aborts immediately if `process.env.DATABASE_URL` resolves to anything other than the `cognitive_test` or `cognitive_snapshot_*` database. Synthetic generation is destructive; it must not run against `cognitive` (the dev DB).

The layered process:

1. **Pre-flight check** — verify `DATABASE_URL` matches an allowed test/snapshot database; otherwise abort with a clear error
2. Drop + recreate the test database
3. Apply all migrations
4. **Pick cluster modes**: generate `cluster_count` 768-dim Gaussian mode vectors. These are the centres of the semantic neighbourhoods entities will live in
5. **Generate entities**: N random entities with names like `synth-{uuid}` and types drawn from the canonical list. Each entity is assigned to a cluster mode (mostly even distribution; bridge-pair entities pinned to specific modes — see step 7)
6. **Generate per-entity memories** (this is the layered key): for each entity, generate `K` mock memories, each with a vector drawn from the entity's cluster mode plus small Gaussian noise. Each memory has a distinct UUID and mock source text like `"Synthetic memory {entity_id}/{i}"`. *Memories are the source of truth for vectors;* the entity centroid is *derived* from them in step 10, exactly as in production
7. **Bridge-pair injection** (when `bridge_pairs: N > 0`): selects N pairs of cluster modes, generates two entities per pair pinned to *different* modes, gives each an independent set of memories drawn from its respective mode. The two entities share *no* memory IDs, *no* facts, *no* aliases — they look distinct to the existing 3-signal scoring but are labelled co-referent in the ground-truth file. They are NOT linked by any `same_as_links` row
8. **Generate facts**: subject-predicate-object triples respecting the canonical predicate ontology, with target mean facts/entity = `facts_per_entity_mean`. Facts respect cluster topology: most edges stay within a cluster, with a configurable cross-cluster edge probability. Bridge-pair entities receive only within-cluster facts (never to each other, never to the partner's cluster)
9. **Insert memory rows + Qdrant points + memory_entities links**: write memories table rows, upload all memory vectors to the Qdrant collection (one Qdrant point per memory, not per entity), and link each entity to its memories via `memory_entities`
10. **Call the real `updateEntityMeta`** for every entity — this fetches each entity's memory vectors from Qdrant and computes the centroid as their mean. The resulting `entity_meta.centroid` is the *output* of the production code path, not a fabricated value. Verify post-condition: each entity's centroid lies within a small cosine distance of its assigned cluster mode (sanity check the layering)
11. Optionally create `same_as` links between non-bridge cluster mode pairs to vary topology (separate from bridge pairs; these are visible to the system, bridge pairs are not)
12. Dump Postgres + Qdrant snapshot
13. Write `ground_truth.json` listing every bridge pair: `[{"a": uuid, "b": uuid, "reason": "bridge_pair_<n>"}, ...]`

**Determinism:** identical `seed` produces byte-identical snapshots and ground-truth files. Tests can assume reproducibility.

**Why this matters:** the centroid value Phase 1 reads from `entity_meta.centroid` is *computed* by the same `updateEntityMeta` code path tests will use in production, not synthesised. If `updateEntityMeta` has a bug, synthetic snapshots will surface it.

Ground truth is consumed by Phase 4's cross-cluster generator benchmark to compute precision and recall against a known answer set. It is *never* readable by the algorithm under test — the generator does not store ground-truth labels in any table the algorithm queries (verified by §4.2 test "Ground truth is invisible to algorithms").

### 3.4 LLM-pipeline generator

`scripts/generate-snapshot.ts` is *not* deterministic but is reproducible-modulo-LLM-variance. It:

1. **Pre-flight check** — same `DATABASE_URL` guard as §3.3 (cold-eyes review S5)
2. Drops + recreates the test database
3. Applies all migrations
4. Reads the source corpus from `manifest.source_corpus`
5. Chunks per `ingest_params.chunk_size`
6. For each chunk: calls the existing `/ingest/queue` HTTP endpoint with the manifest's pinned `claude_model_version_pin`, `claude_temperature`, and prompt version. Waits for completion via the queue's status endpoint, with a **per-chunk timeout** of 5 minutes (configurable via `ingest_params.chunk_timeout_ms`); on timeout the script emits a partial snapshot with a clear "regeneration partial" warning and exits non-zero. (Cold-eyes review S9.)
7. After all chunks: optionally invokes reconciliation/gardener if `ingest_params.run_gardening: true`
8. Computes `graph_stats` (Phase 1), records into manifest stats
9. Dumps Postgres + Qdrant snapshot using the manifest's `pg_dump_flags` (default: `--format=custom --no-sync --no-comments` for byte-stable hashing — cold-eyes review W5), updates manifest with new hashes + timestamp

The non-determinism is captured in the `deterministic: false` flag and acknowledged in the manifest's `notes`. Stats may drift ±5% across regenerations within fixed model + prompt + embedding pins; larger drift indicates a pin needs updating. Tests that depend on exact counts use synthetic snapshots, not LLM ones.

### 3.5 Restoration

`scripts/load-snapshot.ts <name>`:

1. Reads the manifest entry
2. Verifies all files exist locally + hashes match (else error or regenerate)
3. Verifies `manifest.schema_version` matches current migrations (else error: "snapshot is from migration 12, current is migration 13 — regenerate or roll back")
4. Drops the target Postgres database
5. Restores via `pg_restore --clean --if-exists` using the manifest's `pg_dump_flags`
6. Drops the target Qdrant collection unconditionally — the snapshot's embedded collection definition determines the new collection's dimensionality and config (cold-eyes review W10)
7. Uploads the Qdrant snapshot via the API
8. Verifies row counts match the manifest stats (sanity check)

Restoration time target: < 5 seconds for up to 10k-entity snapshots.

**Format trade-off (cold-eyes review W3):** This doc commits to `pg_dump --format=custom` for byte-stable hashing. Custom format does NOT support `pg_restore --jobs=N` parallel restore (that requires `--format=directory`). At our scales the trade-off favours hash stability over parallel restore — single-threaded custom-format restore comfortably hits the < 5s target on 10k-entity snapshots. If a future synthetic-50k or larger snapshot exceeds the latency budget, we can ship a separate `format: "directory"` manifest entry for that specific dataset; meanwhile, the unconditional roster stays on custom format.

### 3.6 Test integration (serial-only — cold-eyes review B5)

Snapshot-loading tests run **serially**, in a dedicated vitest project, separate from the parallel default suite. The reasons:

- `pg_restore --clean --if-exists` requires no active connections to the target DB. The default vitest setup at `platform/src/test/setup.ts:55` opens a connection pool in `beforeAll`. Running snapshot restoration concurrently with that pool errors with "database is being accessed by other users."
- vitest's default file-parallelism would let two snapshot tests obliterate each other's state.

**Naming convention:** snapshot-loading test files end in `.snapshot.test.ts`. A dedicated `vitest.snapshot.config.ts` runs them with `--no-file-parallelism --pool=forks --poolOptions.forks.singleFork=true`. The default `vitest.config.ts` excludes the snapshot suffix.

**Helper contract:**

```typescript
// In src/test/setup.ts (extension)
export async function ensureSnapshot(name: string): Promise<void> {
  // 1. Close the existing connection pool (so pg_restore can drop the DB)
  await closeTestDbPool();
  // 2. Invoke snapshot-ensure.ts (regenerates if missing or hash mismatch)
  await runSnapshotEnsure(name);
  // 3. Reopen the pool against the freshly-restored DB
  await openTestDbPool();
}

export async function loadGroundTruth(name: string): Promise<BridgePair[]> { ... }
```

**Worked example:**

```typescript
// platform/src/test/harness/graph-stats-bench.snapshot.test.ts
import { ensureSnapshot, loadGroundTruth } from '../setup.js';

describe('Phase 1 graph_stats benchmark', () => {
  beforeAll(async () => {
    await ensureSnapshot('synthetic-10k');  // serial, no pool conflict
  });

  it('computes within 2 seconds', async () => {
    const start = Date.now();
    await computeGraphStats();
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

// platform/src/test/harness/cross-cluster-gen.snapshot.test.ts
describe('Phase 4 cross-cluster generator', () => {
  beforeAll(async () => {
    await ensureSnapshot('synthetic-10k');  // has 50 bridge pairs
  });

  it('flags ground-truth bridge pairs with > 0.6 recall', async () => {
    const groundTruth = await loadGroundTruth('synthetic-10k');
    const flagged = await runCrossClusterGenerator();
    const recall = countMatches(flagged, groundTruth) / groundTruth.length;
    // Note: 0.6 is a placeholder. Phase 4's own design doc (`25`) sets the
    // actual threshold based on the master's milestone. (Cold-eyes review S8.)
    expect(recall).toBeGreaterThan(0.6);
  });
});
```

Both helpers throw clearly if the snapshot is unavailable or malformed.

## 4. Verification

### 4.1 Manual checks

- After fresh clone + `pnpm snapshot:ensure synthetic-1k`: snapshot files appear under `test-snapshots/synthetic-1k/`, hashes match manifest, `pnpm snapshot:verify` passes
- After `pnpm snapshot:load frankenstein-10chunks` against an empty DB: row counts in `entities`, `facts`, `memory_entities` match the manifest stats. AGE graph state restored (cypher queries work)
- After `pnpm snapshot:generate frankenstein-10chunks` (regeneration): manifest's `regenerated_at` updates, hashes update, stats update

### 4.2 Automated tests

Test file `platform/src/test/harness/snapshots.test.ts`:

- **Manifest valid** — JSON parses, every entry has required fields, no duplicate names, file paths follow the convention
- **Synthetic generator deterministic** — same seed → byte-identical Postgres dump and ground-truth file (compared via SHA-256)
- **Synthetic generator stats match expectation** — for `synthetic-1k`, `total_entities = 1000` exactly, `total_facts ≈ facts_per_entity_mean × entity_count` within ±2%
- **Bridge-pair labelling** — for a synthetic snapshot with `bridge_pairs: 10`, exactly 10 entries appear in `ground_truth.json`; each entry's two entity IDs exist in the entities table; each pair has no shared facts, no shared memories, and centroids in different cluster modes. The pair entities are NOT linked by any `same_as_links` row in the snapshot
- **Ground truth is invisible to algorithms** — verify no production-readable table contains the bridge_pair labels (i.e. ground truth lives only in the side file, never in `entities.merged_from`, `same_as_links`, or any other queryable surface)
- **Restoration roundtrip** — generate → dump → drop → restore → verify row counts match
- **Schema version mismatch detected** — manually rewrite manifest entry's `schema_version` to a wrong value, restoration fails with a clear error
- **Hash mismatch detected** — corrupt a snapshot file, `verify` reports the mismatch and `ensure` regenerates
- **Empty snapshot loads** — `empty` snapshot restores to a clean schema-only state, no errors
- **Cross-platform path handling** — generator uses `path.join`, scripts run on Windows-style `\` paths and Unix-style `/` paths

### 4.3 Acceptance criteria for `bd close`

- `pnpm snapshot:ensure` works for every entry in the manifest on a fresh clone
- `pnpm snapshot:verify` passes
- All §4.2 tests green
- `synthetic-10k` is the largest required snapshot for unconditional phases; `synthetic-50k` design specified but generation is optional pre-T2 work
- Phase 1 benchmark report (`22-graph-stats-foundation.md` §5.2) is generated using snapshots restored via this infrastructure

## 5. Benchmark

### 5.1 Acceptance thresholds

| Operation | Snapshot size | Target | Hard cap |
|---|---|---|---|
| `snapshot:ensure` (cache hit) | any | < 100 ms | 500 ms |
| `snapshot:load` (cold restore) | 1k entities | < 1 s | 3 s |
| `snapshot:load` (cold restore) | 10k entities | < 5 s | 15 s |
| `snapshot:generate` (synthetic) | 10k entities | < 30 s | 90 s |
| `snapshot:generate` (LLM) | Frankenstein-10chunks | < 5 min | 15 min |
| Disk size | 10k synthetic | < 50 MB | 200 MB |

### 5.2 Baseline report

Committed to `platform/src/test/data/snapshots/benchmark-reports/`:

```
benchmark-reports/
├── ensure-cache-hit.json
├── load-1k.json
├── load-10k.json
├── generate-synthetic-10k.json
└── generate-frankenstein-10chunks.json
```

Each JSON: `{operation, snapshot_name, duration_ms, disk_size_bytes, machine, timestamp}`.

### 5.3 Drift over time

The LLM snapshot regeneration is non-deterministic by nature. We track:

- **Stats drift** — `total_entities`, `total_facts` across regenerations of the same name. A drift > 10% signals prompt or model change.
- **Generation time drift** — wall clock of `snapshot:generate` for LLM snapshots. Sudden increase signals API latency or model change.

These appear in the manifest's `notes` field and as commit messages on regeneration.

## 6. Edge cases

| Case | Expected behaviour |
|---|---|
| Snapshot file missing on disk | `ensure` regenerates from manifest. Clear message about regeneration. |
| Hash mismatch detected | `ensure` regenerates. `verify` reports without regenerating. |
| Schema version mismatch | `load` errors with explicit instruction to regenerate or migrate. |
| Manifest entry references missing source corpus | `generate` errors immediately with the missing path. |
| Postgres database in use by another process | `load` fails with a clear "drop blocked" message; user instructed to disconnect or use a different DB. |
| Qdrant collection has wrong dimensionality | `load` recreates the collection with correct dim from manifest. |
| Out of disk space during generation | Partial files cleaned up on error. Clear "out of disk" message. |
| Concurrent `ensure` calls | File-lock per snapshot directory; second call waits for first. |
| `pg_dump` not on PATH | Scripts probe via env var `PG_DUMP_PATH`; clear error if neither set nor on PATH. |
| Empty source corpus | `generate` produces an `empty`-equivalent snapshot. Recorded in stats. |
| Unicode in entity names (Frankenstein has accents) | Postgres handles UTF-8 natively; manifest stored as UTF-8; pg_dump custom format preserves. |
| Manifest JSON corruption | `ensure` and `verify` both error with line/column from JSON parser. |
| Synthetic seed change in manifest | Hash mismatch detected; regeneration produces new bytes; user notified. |
| Snapshot file referenced in manifest is on a teammate's machine but not on yours | `ensure` regenerates locally from manifest (default path — works for synthetic and any LLM snapshot whose source corpus is in repo). For LLM snapshots whose source corpus is gated behind a `corpus_url`, the script downloads first. Snapshot sharing via S3 / shared storage is future work, out of scope for the initial ship. (Cold-eyes review coverage gap 2.) |
| `bridge_pairs > cluster_count * (cluster_count - 1)` | Generator errors clearly: "cannot place N bridge pairs across only M cluster-mode pairs". |
| `bridge_pairs > 0` but `cluster_count < 2` | Generator errors: bridge pairs require at least two cluster modes. |
| `ground_truth.json` missing post-restoration | `loadGroundTruth` errors with a clear message instructing regeneration via `pnpm snapshot:ensure --force <name>`. |

## 7. Iteration cycle

### 7.1 Initial roster (this ship)

The 7 datasets in §2.2. Each has a manifest entry; `empty`, `synthetic-1k`, `synthetic-10k`, `frankenstein-10chunks` are required for cluster-bridging Phase 1 close. `nist-sp800-63b-technical` and `mixed-narrative-technical-1k` ship alongside; `synthetic-50k` is design-only until consumers exist.

### 7.2 Growth signals

The `test-harden` skill's Test-Data Evolver subagent watches for:

- **A real-world ingest reveals an interesting graph shape** that no existing snapshot covers — propose a new dataset
- **A new phase introduces a benchmark requirement** at a new scale point — extend the synthetic ladder
- **An LLM prompt change shifts ingest output meaningfully** — regenerate the affected LLM snapshots, record drift

### 7.3 Deprecation

- Snapshots from removed migrations are flagged but retained for historical regression
- Snapshots whose source corpus is removed are flagged in the manifest with `deprecated: true` and excluded from CI/`ensure`

### 7.4 "Done enough"

Snapshot infrastructure is "done enough" when:

- All 8 §4.2 tests pass
- Every dataset in §2.2 has a manifest entry, generation works, restoration roundtrip works
- Phase 1's `22-graph-stats-foundation.md` benchmark §5.2 runs against snapshots from this infrastructure (the gating dependency per master §10 lock B2)
- Cross-platform verification: at least one CI / clean-machine run produces working snapshots from a fresh clone

### 7.5 Forward evolution

When Phase 5/6 (KGE, deep-ER) ship, they may need:

- `synthetic-50k`, `synthetic-100k` for scale benchmarks
- Pre-trained KGE embeddings stored as a sibling artefact alongside Postgres+Qdrant snapshots — consider extending the manifest schema with a `kge_embeddings` file slot
- Multi-collection Qdrant snapshots (if a separate collection holds entity embeddings)

These are forward-compatible extensions — the manifest schema is intentionally generous in its file-slot layout.

## 8. References

### Existing docs

- `18-test-data-hardening-protocol.md` — sibling doc covering SQL fixtures + recursive hardening loop
- `20-test-harden-skill-design.md` — the test-harden skill that consumes both fixture types
- `21-cluster-bridging-master.md` — first major consumer; Phase 1 close depends on this infra
- `22-graph-stats-foundation.md` — first benchmark consumer (§5.2 references `synthetic-10k`)

### Existing infrastructure

- `platform/src/test/data/phase{N}-{name}/` — established phase-data layout
- `platform/src/test/setup.ts` — `loadFixture()` helper to be extended with `ensureSnapshot()`
- `platform/src/test/generators/` — existing `randomEmbedding` helper, sibling to the synthetic generator

### External

- Postgres `pg_dump` / `pg_restore` — https://www.postgresql.org/docs/current/app-pgdump.html
- Qdrant snapshots API — https://qdrant.tech/documentation/concepts/snapshots/
- Apache AGE serialisation — https://age.apache.org/age-manual/master/

---

*This is the snapshot infrastructure design contract. The bead created from this doc carries a hard `blocks` relation against cluster-bridging Phase 1 close per master §10 lock B2.*
