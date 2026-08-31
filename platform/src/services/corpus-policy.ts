/**
 * Corpus policy — the per-corpus stance knobs (cross-corpus Phase A; bead
 * nmemo-uhp.8, migration 055_corpus_policies.sql).
 *
 * 04-hardened-spec.md §2 (register row D5): the honest home for the word-prefix /
 * contradiction-stance knobs, instead of `if (corpus === ...)` branches scattered
 * through the pure planner. A corpus is either:
 *   'assimilating' — the current fuse-everything behaviour (blend in). The
 *                    word-prefix rule-3 single-match bind stays (D5).
 *   'comparative'  — kept separate for cross-corpus analysis. The word-prefix
 *                    single-match branch escalates to the arbiter instead of
 *                    binding (D5) — never an embedding gate, never touching rule-4.
 *
 * The mode is READ here (a DB touch) and then passed as plain data INTO the pure
 * planner (promotion.ts → planPromotion), so the planner stays DB-free and the
 * order-independence litmus holds (D5). The default corpus resolves to
 * 'assimilating', so existing single-corpus behaviour is unchanged.
 */

import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { corpusPolicies } from '../db/schema.js';

export type CorpusMode = 'assimilating' | 'comparative';

/**
 * The policy mode for a corpus. Reads `corpus_policies`; a corpus with no row (or
 * any non-'comparative' value) defaults to 'assimilating' so a corpus that has
 * never opted into comparative behaves exactly as before.
 */
export async function getCorpusPolicy(corpusId: string): Promise<CorpusMode> {
  try {
    const [row] = await db
      .select({ mode: corpusPolicies.mode })
      .from(corpusPolicies)
      .where(eq(corpusPolicies.corpusId, corpusId))
      .limit(1);
    return row?.mode === 'comparative' ? 'comparative' : 'assimilating';
  } catch (err) {
    // 42P01 = undefined_table: migration 055 has not been applied. Bead
    // nmemo-31k: promotion.ts calls this inside a Promise.all with no try/catch,
    // so on a DB that lags migrations — the documented normal state, and the
    // state the live cognitive DB was in — the WHOLE epoch arm died with 42P01
    // rather than degrading. The guard belongs here, not at that one call site,
    // because a missing TABLE is indistinguishable to every caller from the
    // missing ROW this function already documents as meaning 'assimilating'.
    //
    // Narrow on purpose: only undefined_table is absorbed. A connection failure
    // or a permission error still throws, because silently defaulting on those
    // would hide a real fault — the failure mode this whole pass is about.
    if ((err as { code?: string })?.code === '42P01') {
      console.warn(
        `[corpus-policy] corpus_policies is absent (migration 055 not applied); ` +
        `defaulting corpus '${corpusId}' to 'assimilating'. Run migrations to silence this.`,
      );
      return 'assimilating';
    }
    throw err;
  }
}

/** Set (upsert) a corpus's policy mode, stamping updated_at on an existing row. */
export async function setCorpusPolicy(corpusId: string, mode: CorpusMode): Promise<void> {
  await db
    .insert(corpusPolicies)
    .values({ corpusId, mode })
    .onConflictDoUpdate({
      target: corpusPolicies.corpusId,
      set: { mode, updatedAt: new Date() },
    });
}
