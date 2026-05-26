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
