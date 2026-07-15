/**
 * Durable ledger for cross-corpus audit runs + coverage (bead nmemo-uhp.12.1,
 * Phase B). The run-level twin of ingest-ledger.ts.
 *
 * An audit run compares a SOURCE corpus (e.g. a C codebase) against a TARGET
 * corpus (e.g. a coding standard), producing explained/sourced bridge_edges. The
 * ledger tracks two things:
 *   public.audit_runs     — one row per (named) run; resume-by-name.
 *   public.audit_coverage — one row per (element × rule) unit checked: the 4-bin
 *                           coverage matrix that answers "what did we look at, and
 *                           what came of it" and powers the completeness anti-joins
 *                           ("violated somewhere", "satisfied nowhere").
 *
 * SELF-ENSURED (to_regclass-guarded CREATE), NOT a graph migration — same
 * reasoning as ingest-ledger.ts: this is operational run-tracking state, and the
 * live cognitive DB does not run migrations on boot (it can lag the migration set,
 * see CLAUDE.md "Migrate drift"). Self-ensuring keeps the audit path self-contained.
 * Every object is `public.`-qualified (session search_path puts ag_catalog first).
 *
 * Coverage-verdict vocabulary: the hardened spec (04 §D6) supersedes the earlier
 * 03 sketch's `violation | no_violation` labels. A COVERED cell's verdict equals
 * its bridge's `relation` CHECK value — 'violates' | 'satisfies' | 'not_applicable'
 * — with edge_id linking the two; plus 'pending' (seeded, not yet adjudicated) and
 * 'checker_unavailable' (dormant until a Phase C deterministic checker exists). The
 * D6 fork lands here: an LLM-reasoned satisfies/violates stamps the cell AND sets
 * edge_id; a sweep-level "nothing worth keeping" stamps 'not_applicable' with a
 * NULL edge_id (coverage-only). Coverage has no aggregate counter, so replaying a
 * stamp is idempotent by the UNIQUE(run_id, element_ref, rule_id) UPSERT alone
 * (the mig-034 nullable-invocation_id model, minus the corroboration counter).
 */

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

export type AuditRunStatus = 'running' | 'paused' | 'completed' | 'failed';

/** The four live coverage bins (+ the dormant Phase-C bin). See file header. */
export type CoverageVerdict =
  | 'pending'
  | 'violates'
  | 'satisfies'
  | 'not_applicable'
  | 'checker_unavailable';

export interface AuditRun {
  id: string;
  name: string;
  sourceCorpusId: string;
  targetCorpusId: string;
  ruleSetHash: string;
  modelVersion: string | null;
  status: AuditRunStatus;
}

/** One (element × rule) unit to check. element_ref is an entity id in the v1 */
/** full-graph substrate; rule_id is the target-corpus rule identifier. */
export interface AuditUnit {
  elementRef: string;
  ruleId: string;
}

function rows(result: unknown): Array<Record<string, unknown>> {
  return result as unknown as Array<Record<string, unknown>>;
}

async function relExists(qualifiedName: string): Promise<boolean> {
  const r = rows(await db.execute(sql`SELECT to_regclass(${qualifiedName}) AS oid`));
  return r[0]?.oid != null;
}

/**
 * Idempotently create the audit ledger tables. Safe to call on every run;
 * to_regclass-guarded so a resume run does not spam "already exists" NOTICEs.
 */
export async function ensureAuditLedger(): Promise<void> {
  if (!(await relExists('public.audit_runs'))) {
    await db.execute(sql`
      CREATE TABLE public.audit_runs (
        id               UUID PRIMARY KEY,
        name             TEXT NOT NULL,
        source_corpus_id TEXT NOT NULL,
        target_corpus_id TEXT NOT NULL,
        rule_set_hash    TEXT NOT NULL,
        model_version    TEXT,
        status           TEXT NOT NULL DEFAULT 'running',
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (name)
      )
    `);
  }
  if (!(await relExists('public.audit_coverage'))) {
    await db.execute(sql`
      CREATE TABLE public.audit_coverage (
        id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        run_id        UUID NOT NULL REFERENCES public.audit_runs(id) ON DELETE CASCADE,
        element_ref   TEXT NOT NULL,
        rule_id       TEXT NOT NULL,
        verdict       TEXT NOT NULL DEFAULT 'pending'
                        CHECK (verdict IN ('pending','violates','satisfies','not_applicable','checker_unavailable')),
        edge_id       UUID REFERENCES public.bridge_edges(id),
        invocation_id UUID,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (run_id, element_ref, rule_id)
      )
    `);
    // nextPendingAuditUnit hot path — index only the still-pending cells.
    await db.execute(sql`
      CREATE INDEX idx_audit_coverage_pending
        ON public.audit_coverage(run_id) WHERE verdict = 'pending'
    `);
  }
}

function toRun(r: Record<string, unknown>): AuditRun {
  return {
    id: r.id as string,
    name: r.name as string,
    sourceCorpusId: r.source_corpus_id as string,
    targetCorpusId: r.target_corpus_id as string,
    ruleSetHash: r.rule_set_hash as string,
    modelVersion: (r.model_version as string | null) ?? null,
    status: r.status as AuditRunStatus,
  };
}

/**
 * Find the run named `name`, or create it. Re-running with an existing name
 * RESUMES that run — but only if the source/target corpora AND the rule-set hash
 * still match. A rule_set_hash mismatch THROWS rather than silently resuming
 * against a changed standard (the corpus_hash-mismatch discipline of
 * ingest-ledger.createOrLoadJob, applied to the rule set).
 */
export async function createOrLoadAuditRun(opts: {
  name: string;
  sourceCorpusId: string;
  targetCorpusId: string;
  ruleSetHash: string;
  modelVersion?: string | null;
}): Promise<{ run: AuditRun; created: boolean }> {
  await ensureAuditLedger();

  const existing = rows(
    await db.execute(sql`
      SELECT id, name, source_corpus_id, target_corpus_id, rule_set_hash, model_version, status
      FROM public.audit_runs WHERE name = ${opts.name}
    `),
  );
  if (existing.length > 0) {
    const run = toRun(existing[0]!);
    if (run.sourceCorpusId !== opts.sourceCorpusId || run.targetCorpusId !== opts.targetCorpusId) {
      throw new Error(
        `audit run "${opts.name}" already exists over ${run.sourceCorpusId}→${run.targetCorpusId}, ` +
          `not ${opts.sourceCorpusId}→${opts.targetCorpusId}. Use a new run name.`,
      );
    }
    if (run.ruleSetHash !== opts.ruleSetHash) {
      throw new Error(
        `audit run "${opts.name}" was created against a DIFFERENT rule set (hash mismatch). ` +
          `Resuming against a changed standard would mix verdicts — use a new run name.`,
      );
    }
    return { run, created: false };
  }

  const id = randomUUID();
  await db.execute(sql`
    INSERT INTO public.audit_runs (id, name, source_corpus_id, target_corpus_id, rule_set_hash, model_version, status)
    VALUES (${id}, ${opts.name}, ${opts.sourceCorpusId}, ${opts.targetCorpusId},
            ${opts.ruleSetHash}, ${opts.modelVersion ?? null}, 'running')
  `);
  return {
    run: {
      id,
      name: opts.name,
      sourceCorpusId: opts.sourceCorpusId,
      targetCorpusId: opts.targetCorpusId,
      ruleSetHash: opts.ruleSetHash,
      modelVersion: opts.modelVersion ?? null,
      status: 'running',
    },
    created: true,
  };
}

/**
 * Seed the coverage matrix with pending (element × rule) units. Idempotent:
 * ON CONFLICT DO NOTHING so re-seeding a resumed run neither duplicates cells nor
 * resets already-adjudicated ones. Returns the number of NEW pending cells.
 */
export async function seedCoverageUnits(runId: string, units: AuditUnit[]): Promise<number> {
  let inserted = 0;
  for (const u of units) {
    const r = rows(
      await db.execute(sql`
        INSERT INTO public.audit_coverage (run_id, element_ref, rule_id, verdict)
        VALUES (${runId}, ${u.elementRef}, ${u.ruleId}, 'pending')
        ON CONFLICT (run_id, element_ref, rule_id) DO NOTHING
        RETURNING id
      `),
    );
    if (r.length > 0) inserted += 1;
  }
  return inserted;
}

/**
 * The next still-pending coverage unit, or null when the run is fully swept.
 * Coverage is order-INDEPENDENT (04 §D4 sweep), so ordering is deterministic-but-
 * arbitrary (element_ref, rule_id) purely for stable resume behaviour.
 */
export async function nextPendingAuditUnit(runId: string): Promise<AuditUnit | null> {
  const r = rows(
    await db.execute(sql`
      SELECT element_ref, rule_id
      FROM public.audit_coverage
      WHERE run_id = ${runId} AND verdict = 'pending'
      ORDER BY element_ref, rule_id
      LIMIT 1
    `),
  );
  if (r.length === 0) return null;
  const row = r[0]!;
  return { elementRef: row.element_ref as string, ruleId: row.rule_id as string };
}

/**
 * Stamp a coverage cell with its adjudicated verdict (D6 fork). Idempotent: the
 * UNIQUE(run_id, element_ref, rule_id) UPSERT means replaying the same adjudication
 * settles to one row with no aggregate to inflate. `edgeId` is set only when the
 * adjudication produced a durable bridge (verdict 'violates'/'satisfies'); a
 * coverage-only 'not_applicable' leaves it NULL. The cell must already exist
 * (seeded) OR is created here for free-exploration asserts with no seeded sweep.
 */
export async function stampCoverage(opts: {
  runId: string;
  elementRef: string;
  ruleId: string;
  verdict: CoverageVerdict;
  edgeId?: string | null;
  invocationId?: string | null;
}): Promise<void> {
  await db.execute(sql`
    INSERT INTO public.audit_coverage (run_id, element_ref, rule_id, verdict, edge_id, invocation_id)
    VALUES (${opts.runId}, ${opts.elementRef}, ${opts.ruleId}, ${opts.verdict},
            ${opts.edgeId ?? null}, ${opts.invocationId ?? null})
    ON CONFLICT (run_id, element_ref, rule_id) DO UPDATE SET
      verdict       = EXCLUDED.verdict,
      edge_id       = EXCLUDED.edge_id,
      invocation_id = EXCLUDED.invocation_id,
      updated_at    = now()
  `);
}

export async function setAuditRunStatus(runId: string, status: AuditRunStatus): Promise<void> {
  await db.execute(sql`
    UPDATE public.audit_runs SET status = ${status}, updated_at = now() WHERE id = ${runId}
  `);
}

export interface CoverageProgress {
  pending: number;
  violates: number;
  satisfies: number;
  notApplicable: number;
  checkerUnavailable: number;
  total: number;
}

/** Per-verdict cell counts for a run — the audit_status telemetry surface. */
export async function coverageProgress(runId: string): Promise<CoverageProgress> {
  const r = rows(
    await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE verdict = 'pending')             AS pending,
        COUNT(*) FILTER (WHERE verdict = 'violates')            AS violates,
        COUNT(*) FILTER (WHERE verdict = 'satisfies')           AS satisfies,
        COUNT(*) FILTER (WHERE verdict = 'not_applicable')      AS not_applicable,
        COUNT(*) FILTER (WHERE verdict = 'checker_unavailable') AS checker_unavailable,
        COUNT(*)                                                AS total
      FROM public.audit_coverage WHERE run_id = ${runId}
    `),
  );
  const row = r[0] ?? {};
  return {
    pending: Number(row.pending ?? 0),
    violates: Number(row.violates ?? 0),
    satisfies: Number(row.satisfies ?? 0),
    notApplicable: Number(row.not_applicable ?? 0),
    checkerUnavailable: Number(row.checker_unavailable ?? 0),
    total: Number(row.total ?? 0),
  };
}
