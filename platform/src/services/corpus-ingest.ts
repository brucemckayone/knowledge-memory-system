/**
 * Cross-corpus element ingest (bead nmemo-uhp.17.3, doc 13). The entry point that
 * turns a code element or a rule into a corpus-partitioned entity whose DESCRIPTION
 * is the authored faceted text — the doc-12 dominant recall lever — and whose vector
 * embeds that description so cross-corpus recall (recallCrossCorpusCandidates over
 * entities.embedding) can align the two corpora.
 *
 * WHY a bespoke upsert instead of createEntity(): createEntity dedups on
 * (lower(canonical_name), entity_type) GLOBALLY — it ignores corpus_id — so the same
 * symbol name in two corpora would collapse onto one entity, exactly the cross-corpus
 * fusion the corpus_id partition (nmemo-uhp.7) exists to prevent. This path dedups
 * corpus-SCOPED (corpus_id, name, type), and always embeds name\ndescription
 * (entityEmbedTextFor 'name_description') regardless of the global EMBED_DESCRIPTIONS
 * flag — cross-corpus recall is meaningless without the description in the vector.
 *
 * Idempotent: re-ingesting the same (corpus, name, type) refreshes the description +
 * embedding in place (author descriptions can be re-run), never a duplicate row.
 */

import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { rawQuery } from '../db/raw.js';
import { entityEmbedTextFor } from './embed-text.js';
import { embedForWrite as embed } from './embed.js';
import {
  authorElementDescription,
  authorRuleDescription,
  type FacetGenerator,
} from './element-authoring.js';

export interface UpsertCorpusEntityParams {
  corpusId: string;
  name: string;
  type: string;
  /** The authored description — stored on the row AND embedded (name\ndescription). */
  description: string;
  /**
   * Stable element identity for dedup, INDEPENDENT of the display name. Distinct code
   * elements can share a symbol name (overloads, file-static functions, a magic
   * constant used in many places) — keying dedup on the name would FUSE them, which
   * is exactly the defect nmemo-uhp.17.4's adversary caught. Defaults to
   * `lower(name)` (correct for rules, whose id is unique per corpus); code ingest
   * passes a content-derived key so same-named-but-different elements stay distinct.
   * Stored on properties.element_key so the dedup can match it.
   */
  dedupeKey?: string;
}

export interface UpsertCorpusEntityResult {
  entityId: string;
  existed: boolean;
}

/** The content-derived identity key for a code element (scheme-tagged sha256, mirrors
 * element-catalogs.ts's `ast` scheme). Same code ⇒ same key ⇒ idempotent re-ingest;
 * different code ⇒ different key even under an identical symbol name. */
export function codeElementKey(code: string): string {
  return `ast:${createHash('sha256').update(code, 'utf8').digest('hex')}`;
}

/**
 * Corpus-SCOPED upsert of an element entity + its description-bearing embedding.
 * Advisory-locked on (corpus, element-key, type) so concurrent ingest of the same
 * element can't double-insert, mirroring createEntity's lock discipline but keyed with
 * the corpus + a name-independent identity so two corpora never contend or collapse and
 * distinct same-named elements never fuse.
 */
export async function upsertCorpusElementEntity(
  params: UpsertCorpusEntityParams,
): Promise<UpsertCorpusEntityResult> {
  const { corpusId, name, type, description } = params;
  const elementKey = params.dedupeKey ?? name.toLowerCase();
  const embedText = entityEmbedTextFor(name, description, 'name_description');
  const vector = await embed(embedText);
  const vectorLiteral = sql.raw(`'[${vector.join(',')}]'::vector`);

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`corpus_element||${corpusId}||${elementKey}||${type}`}))`,
    );

    const existing = (await tx.execute(sql`
      SELECT id::text AS id FROM public.entities
      WHERE corpus_id = ${corpusId}
        AND entity_type = ${type}
        AND properties->>'element_key' = ${elementKey}
      LIMIT 1
    `)) as unknown as Array<{ id: string }>;

    if (existing[0]) {
      await tx.execute(sql`
        UPDATE public.entities
        SET description = ${description},
            embedding = ${vectorLiteral},
            last_seen_at = NOW(),
            updated_at = NOW()
        WHERE id = ${existing[0].id}::uuid
      `);
      return { entityId: existing[0].id, existed: true };
    }

    // jsonb_build_object with a bound TEXT param — NOT `${json}::jsonb`, which the
    // driver double-encodes into a quoted JSON string (so ->>'element_key' returns null).
    const inserted = (await tx.execute(sql`
      INSERT INTO public.entities (canonical_name, entity_type, corpus_id, description, embedding, confidence, properties)
      VALUES (${name}, ${type}, ${corpusId}, ${description}, ${vectorLiteral}, 1.0,
              jsonb_build_object('element_key', ${elementKey}::text))
      RETURNING id::text AS id
    `)) as unknown as Array<{ id: string }>;
    return { entityId: inserted[0]!.id, existed: false };
  });
}

// ============================================
// Ingest entry points
// ============================================

export interface IngestCodeElementParams {
  corpusId: string;
  /** Symbol/name of the element (becomes the entity's canonical_name). */
  name: string;
  /** Source text of the element — the only substantive input the author sees. */
  code: string;
  /** Entity type for code elements. Default 'code_element' (cosmetic; recall is corpus-scoped). */
  type?: string;
  /** Injectable facet generator (default = Haiku ml.generateJson). Tests supply a fake. */
  generate?: FacetGenerator;
}

export interface IngestElementResult extends UpsertCorpusEntityResult {
  description: string;
  /** Rule ids leaked into the description (blindness violation) — should be empty. */
  leakedReferences: string[];
}

/**
 * Ingest a code element: author a faceted description BLIND to the rule set, store it
 * on a corpus-partitioned entity, embed name\ndescription. Returns the entity id +
 * the authored description + any leaked references (surfaced, never scrubbed).
 */
export async function ingestCodeElement(params: IngestCodeElementParams): Promise<IngestElementResult> {
  const authored = await authorElementDescription(
    { name: params.name, code: params.code },
    { generate: params.generate },
  );
  const upserted = await upsertCorpusElementEntity({
    corpusId: params.corpusId,
    name: params.name,
    type: params.type ?? 'code_element',
    description: authored.description,
    // Identity is the CODE CONTENT, not the symbol name — two distinct elements that
    // share a name (overloads, file-static fns, a constant used in many places) must
    // not fuse (nmemo-uhp.17.4 adversary).
    dedupeKey: codeElementKey(params.code),
  });
  return { ...upserted, description: authored.description, leakedReferences: authored.leakedReferences };
}

export interface IngestRuleElementParams {
  corpusId: string;
  ruleId: string;
  ruleText: string;
  /** Entity type for rule elements. Default 'rule'. */
  type?: string;
  generate?: FacetGenerator;
}

/**
 * Ingest a rule element: author a richer description BLIND to the code corpus, store
 * it on a corpus-partitioned entity, embed name\ndescription.
 */
export async function ingestRuleElement(params: IngestRuleElementParams): Promise<IngestElementResult> {
  const authored = await authorRuleDescription(
    { ruleId: params.ruleId, ruleText: params.ruleText },
    { generate: params.generate },
  );
  const upserted = await upsertCorpusElementEntity({
    corpusId: params.corpusId,
    name: params.ruleId,
    type: params.type ?? 'rule',
    description: authored.description,
  });
  // Rule descriptions legitimately reference rule concepts; blindness (blind-to-code)
  // is enforced by the rule prompt, so no leak check applies on this side.
  return { ...upserted, description: authored.description, leakedReferences: [] };
}

// ============================================
// Re-embed pass
// ============================================

export interface ReembedResult {
  /** Entities whose embedding was recomputed. */
  reembedded: number;
  /** Entities skipped because they carry no description (name-only; nothing to re-embed). */
  skipped: number;
}

/**
 * Recompute every entity embedding in a corpus from its CURRENT description
 * (name\ndescription mode). Use after re-authoring descriptions or flipping the
 * embed convention on a corpus that was stored name-only. Entities with no
 * description are skipped (re-embedding name-only would just reproduce the existing
 * name vector). Idempotent.
 */
export async function reembedCorpusDescriptions(corpusId: string): Promise<ReembedResult> {
  const rows = await rawQuery<{ id: string; canonical_name: string; description: string | null }>(sql`
    SELECT id::text AS id, canonical_name, description
    FROM public.entities
    WHERE corpus_id = ${corpusId}
    ORDER BY id
  `);

  let reembedded = 0;
  let skipped = 0;
  for (const row of rows) {
    const description = row.description?.trim();
    if (!description) {
      skipped += 1;
      continue;
    }
    const vector = await embed(entityEmbedTextFor(row.canonical_name, description, 'name_description'));
    const vectorLiteral = sql.raw(`'[${vector.join(',')}]'::vector`);
    await db.execute(sql`
      UPDATE public.entities SET embedding = ${vectorLiteral}, updated_at = NOW()
      WHERE id = ${row.id}::uuid
    `);
    reembedded += 1;
  }
  return { reembedded, skipped };
}
