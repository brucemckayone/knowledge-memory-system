/**
 * What the semantic vectors on the Graph S instance rows actually embed — the
 * cross-corpus recall lever (bead nmemo-uhp.14).
 *
 * Recall in this system is graph-mediated: the fuzzy vector is one leg, and it
 * is only useful cross-corpus if the vectors of two corpora land near each other
 * by construction. Historically the entity vector was built from the NAME only
 * (`entities.ts` createEntity, `promotion.ts` applyPromotion), so an authored
 * description written in a target standard's vocabulary — the whole point of the
 * cross-corpus use case (docs/architecture/cross-corpus-audit, substrate = full
 * per-corpus entity/fact graph) — never reached the embedder. These pure helpers
 * are the single place that convention lives, so the two ingest paths (serial
 * `createFact` and epoch `applyPromotion`) can never drift again.
 *
 * DEFAULT IS UNCHANGED: `mode='name'` reproduces exactly the pre-.14 behaviour,
 * and an absent/blank description always falls back to the name regardless of
 * mode. The composite modes are opt-in via config.EMBED_DESCRIPTIONS at the call
 * sites, so single-corpus ingestion is byte-for-byte identical unless enabled.
 */

/**
 * How to compose an entity's embedding text.
 *   - 'name'             → name only (pre-.14 behaviour; the default)
 *   - 'name_description' → `${name}\n${description}` when a description exists
 *   - 'description'      → the authored description alone when it exists
 * Any mode falls back to the bare name when no authored description is present.
 */
export type EntityEmbedMode = 'name' | 'name_description' | 'description';

/** Resolve the embed mode from the master flag. Off ⇒ name-only (unchanged). */
export function entityEmbedModeFromFlag(embedDescriptions: boolean): EntityEmbedMode {
  return embedDescriptions ? 'name_description' : 'name';
}

/**
 * Compose the text an entity's semantic vector should embed. PURE — no DB, no
 * config, no side effects, so it is trivially unit-testable and order-independent.
 */
export function entityEmbedTextFor(
  name: string,
  description: string | null | undefined,
  mode: EntityEmbedMode,
): string {
  const desc = description?.trim();
  if (!desc) return name; // no authored text ⇒ name-only regardless of mode
  switch (mode) {
    case 'description':
      return desc;
    case 'name_description':
      return `${name}\n${desc}`;
    case 'name':
    default:
      return name;
  }
}

/**
 * Compose the text a fact edge's `fact_embedding` should embed. This is the ONE
 * convention shared by both ingest paths: the serial `createFact` path
 * (`facts.ts`) and the epoch `applyPromotion` path (`promotion.ts`). Historically
 * only the former populated `fact_embedding`; the latter left it NULL, so fact
 * edges minted through epoch ingestion were invisible to vector recall (the
 * nmemo-uhp.14 inconsistency). Mirrors the historical `createFact` convention:
 * the authored source text when present, else `predicate object`.
 */
export function factEmbedTextFor(
  sourceText: string | null | undefined,
  predicate: string,
  objectValue: string | null | undefined,
): string {
  const src = sourceText?.trim();
  if (src) return src;
  return `${predicate} ${objectValue ?? ''}`.trim();
}
