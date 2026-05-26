/**
 * Enum-vocabulary single source of truth (bead nmemo-2yv.130 — Review #14 C1).
 *
 * Cross-layer enum vocabularies (DB CHECK constraints, tool input schemas,
 * agent prompt strings, viz strings, HTTP API values) historically duplicated
 * across schema + code + prompts with no single declaration. Cross-layer
 * messages then silently failed when the layers disagreed (canary case: bead
 * nmemo-2yv.60 — `resolve_candidate` tool emitted `'same_as'` but the
 * `merge_candidates.resolution` CHECK admitted only `'alias'`).
 *
 * This module owns the canonical TS-side declaration. Each enum exports a
 * `readonly` tuple plus a type alias derived from it. Consumers IMPORT the
 * tuple (and pass it into tool schemas, type guards, etc.) rather than
 * hardcoding string literals.
 *
 * **Hand-synced layers:**
 * - SQL migrations: CHECK constraints are hand-edited to match. Each migration
 *   that ALTERs a CHECK against one of these vocabularies MUST carry a
 *   `-- keep in sync with src/services/enums.ts:<NAME>` comment so future
 *   readers find the canonical declaration. The .130 design rejected codegen
 *   (option b) — TS is the source of truth; migrations follow.
 *
 * **Scope discipline (.130):**
 * - Only `RESOLUTION_VALUES` lives here today — the canary. Other T7 instances
 *   (.27, .28, .39, .69) migrate to this module independently as their beads
 *   land. Don't pre-populate enums for future beads; add them when the
 *   corresponding bead is implemented.
 */

/**
 * Values admitted by `merge_candidates.resolution` (DB CHECK) and accepted by
 * the `resolve_candidate` tool's `resolution` field (Claude tool schema).
 *
 * Authoritative locations to keep in sync:
 * - `src/services/causal-agent.ts` — `resolve_candidate` tool's input schema.
 * - `src/db/migrations/018_resolution_enum_align.sql` — `valid_resolution`
 *   CHECK constraint (and any later migration that re-ALTERs it).
 *
 * Semantic notes:
 * - `merge`     — the candidate pair was merged into one entity.
 * - `same_as`   — entities co-refer but were kept distinct (alias link).
 * - `link`      — entities are related but NOT same; a typed link was added.
 * - `distinct`  — the pair was confirmed to be different entities; close.
 */
export const RESOLUTION_VALUES = ['merge', 'same_as', 'link', 'distinct'] as const;
export type ResolutionValue = typeof RESOLUTION_VALUES[number];

/**
 * Values admitted by `merge_candidates.candidate_source` (DB CHECK) and used
 * by the two upstream writers as an ENUMERATOR-ORIGIN TAG. Bead nmemo-2yv.93.
 *
 * Authoritative locations to keep in sync:
 * - `src/services/merge-scorer.ts` — `UpsertCtx.candidateSource` type.
 * - `src/services/cross-cluster-generator.ts` — upsert call sites.
 * - `src/services/graph-meta.ts` — within-component upsert call site.
 * - `src/db/migrations/030_candidate_source_check.sql` —
 *   `valid_candidate_source` CHECK constraint (and any later migration
 *   that re-ALTERs it to admit a new source value).
 *
 * Semantic notes:
 * - `three_signal_scoring`    — from `detectMergeCandidates`' within-
 *   component sweep (3 direct-similarity signals: centroid, memory
 *   overlap, structural). See doc 25 §2.3.
 * - `cross_cluster_generator` — from `cross-cluster-generator.ts`'s
 *   component-pair / drift-driven sweep (signals depend on cluster
 *   structure rather than shared memories). See doc 25 §2.3 / §3.3.
 *
 * Onboarding a new source value (e.g. doc 26 structural-embeddings):
 * extend this tuple AND ship a paired migration that drops + recreates
 * the `valid_candidate_source` CHECK with the new value included. The
 * paired-landing rule exists because the reconciliation_agent's
 * prompt-builder branches on exact string equality; an unknown source
 * silently falls back to the generic block. See doc 26 §3.4.
 */
export const CANDIDATE_SOURCE_VALUES = ['three_signal_scoring', 'cross_cluster_generator'] as const;
export type CandidateSourceValue = typeof CANDIDATE_SOURCE_VALUES[number];

/**
 * Values admitted by `gardening_reports.trigger_type` (DB CHECK) and used by
 * the gardener-run writer to tag the source surface of each persisted run.
 * Bead nmemo-2yv.69.
 *
 * Authoritative locations to keep in sync:
 * - `src/services/gardening.ts` — `RecordGardeningRunOpts.trigger` type.
 * - `src/db/schema.ts` — `gardeningReports.triggerType` column (drizzle).
 * - `src/db/migrations/031_trigger_type_check.sql` — `valid_trigger_type`
 *   CHECK constraint (and any later migration that re-ALTERs it to admit
 *   a new trigger value).
 *
 * Semantic notes:
 * - `manual` — `POST /api/garden` user-initiated invocation (see
 *   `index.ts` /api/garden handler).
 * - `auto`   — pipeline counter threshold trip via the gardener
 *   auto-trigger (`pipeline.ts` — bead nmemo-2yv.67 added the
 *   persistence path).
 *
 * Onboarding a new trigger value (no concrete next-source today; doc
 * 36 lists only manual + auto): extend this tuple AND ship a paired
 * migration that drops + recreates the `valid_trigger_type` CHECK with
 * the new value included. The paired-landing rule exists because any
 * downstream analytics over trigger_type branches on exact string
 * equality; an unknown trigger silently miscounts. See doc 36 §8.1 for
 * the schema-layer enforcement reference.
 */
export const TRIGGER_TYPE_VALUES = ['manual', 'auto'] as const;
export type TriggerTypeValue = typeof TRIGGER_TYPE_VALUES[number];
