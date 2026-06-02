/**
 * Pipeline — Core data flow for the sparse truth graph.
 *
 * store(text)   → embed + Qdrant write → returns memoryId
 * extract(id)   → unified graph agent (ORIENT → EXTRACT → RELATE → CAUSE → VERIFY)
 * ingest(text)  → store + extract (the default entry point)
 */

import { randomUUID } from 'crypto';
import { ml } from './services/ml-client.js';
import { storeMemory, getMemory } from './services/qdrant.js';
import { invokeGraphAgent, invokeGardenerAgent, type ContentType } from './services/causal-agent.js';
import { prepareBatch, type BatchItem, type IngestMode } from './services/batch.js';
import { mapWithConcurrency, withRetry, isQueueFull } from './services/concurrency.js';
import { recordGardeningRun } from './services/gardening.js';
import { applyConfidenceDecay } from './services/causal.js';
import { detectContradictions } from './services/contradictions.js';
import { updateEntityMeta, detectMergeCandidates } from './services/graph-meta.js';
import { db } from './db/index.js';
import { entities as entitiesTable, facts as factsTable, memoryEntities, extractionReports, mergeCandidates, entityAliases } from './db/schema.js';
import { eq, inArray, sql } from 'drizzle-orm';

export interface ExtractResult {
  memoryId: string;
  entities: ResolvedEntity[];
  facts: CreatedFact[];
  skipped: SkippedRelationship[];
  filtered: string[];
  timing: Record<string, number>;
  gardener?: { triggered: boolean; report?: string };
  reconciliation?: { triggered: boolean; candidateCount?: number; report?: string; skippedReason?: string };
  /**
   * Contradictions newly DETECTED during this chunk's SQL sweep (the `detected`
   * count from {@link detectContradictions}). 0 when the sweep did not run on
   * this chunk (it fires only every DECAY_RUN_INTERVAL graph-agent runs) or
   * threw. Summed across chunks by the comparison harness and compared against
   * the contradictions REFLECTED in the final table — the doc 39 §2.B
   * detected-vs-reflected gap (nmemo-hm4.5).
   */
  contradictionsDetected: number;
}

// ============================================
// Gardener Auto-Trigger Counter
// ============================================
const GARDENER_RUN_INTERVAL = 5; // trigger gardener every N graph agent runs
let graphAgentRunCount = 0;

// ============================================
// Confidence-Decay Auto-Trigger Counter
// ============================================
const DECAY_RUN_INTERVAL = 10; // run applyConfidenceDecay every N graph agent runs
let decayRunCount = 0;

// ============================================
// Reconciliation Agent Auto-Trigger (bead nmemo-2yv.61)
// ============================================
// Pipeline-level cost-bound for the reconciliation agent. Fire-and-forget
// after every ingest IF there is unresolved work AND we haven't fired in
// the last RECONCILIATION_MIN_INTERVAL_MS. Process-local state — survives
// only within a single platform process. A restart resets the cooldown,
// which is acceptable since the next ingest will refresh the timestamp.
const RECONCILIATION_MIN_INTERVAL_MS = Number.parseInt(
  process.env.RECONCILIATION_MIN_INTERVAL_MS ?? `${5 * 60 * 1000}`,
  10,
);
let lastReconciliationRunAt = 0;

/** Test-only — reset the cooldown so unit tests don't depend on wall-clock state. */
export function _resetReconciliationCooldown(): void {
  lastReconciliationRunAt = 0;
}

/**
 * Reconciliation auto-trigger body, extracted for testability (bead .61).
 * Returns the telemetry shape that lands on ExtractResult.reconciliation.
 * Optional `invokerOverride` lets tests stub the LLM call.
 */
export type ReconciliationAgentInvoker = (params: {
  candidates: Array<Record<string, unknown>>;
  recentReports?: string[];
}) => Promise<{ result: string }>;

export async function maybeTriggerReconciliation(
  invokerOverride?: ReconciliationAgentInvoker,
): Promise<ExtractResult['reconciliation']> {
  const sinceLast = Date.now() - lastReconciliationRunAt;
  if (sinceLast < RECONCILIATION_MIN_INTERVAL_MS) {
    return {
      triggered: false,
      skippedReason: `cooldown ${Math.floor(sinceLast / 1000)}s < ${Math.floor(RECONCILIATION_MIN_INTERVAL_MS / 1000)}s`,
    };
  }
  try {
    const [candidateRows, unconfirmedRows] = await Promise.all([
      // Auto-trigger fires on EITHER 'staging' or 'candidate' status — the
      // bead's locked spec is broader than the /api/reconcile manual handler
      // (which only fires on 'candidate'). detectMergeCandidates inserts
      // 'staging' for below-threshold pairs and 'candidate' for above; both
      // need the agent's attention.
      db.select({ id: mergeCandidates.id }).from(mergeCandidates)
        .where(inArray(mergeCandidates.status, ['staging', 'candidate'])).limit(1),
      db.select({ id: entityAliases.id }).from(entityAliases)
        .where(eq(entityAliases.aliasType, 'unconfirmed')).limit(1),
    ]);
    if (candidateRows.length === 0 && unconfirmedRows.length === 0) {
      return { triggered: false, skippedReason: 'no_pending_work' };
    }
    // Reserve the cooldown slot BEFORE the long-running agent call so a tight
    // ingest loop in the same process doesn't double-fire while the previous
    // agent is still in flight.
    lastReconciliationRunAt = Date.now();
    const invoker = invokerOverride ?? (await import('./services/causal-agent.js')).invokeReconciliationAgent;
    const { getMergeCandidates } = await import('./services/graph-meta.js');
    // Default getMergeCandidates() returns unresolved candidates only — the SQL
    // filter is canonical; no in-memory dedup needed (bead nmemo-2yv.45).
    const [unresolved, recentReports] = await Promise.all([
      getMergeCandidates(),
      db.select({ reportText: extractionReports.reportText })
        .from(extractionReports)
        .orderBy(sql`created_at DESC`)
        .limit(10),
    ]);
    console.log(`[reconciliation] auto-triggering candidates=${unresolved.length} unconfirmed_aliases=${unconfirmedRows.length}`);
    const result = await invoker({
      candidates: unresolved as Array<Record<string, unknown>>,
      recentReports: recentReports.map(r => r.reportText),
    });
    if (result.result) {
      console.log(`[reconciliation] report:\n${result.result.slice(0, 500)}${result.result.length > 500 ? '…' : ''}`);
    }
    return { triggered: true, candidateCount: unresolved.length, report: result.result };
  } catch (err) {
    console.warn('[reconciliation] auto-trigger failed:', err instanceof Error ? err.message : err);
    return { triggered: false, skippedReason: 'error' };
  }
}

// Bead nmemo-2yv.72 removed the pattern-detection and graph-stats patrol
// counters that previously lived here (reasoningPatrolCount /
// graphStatsPatrolCount, PATTERN_DETECTION_INTERVAL=3,
// GRAPH_STATS_INTERVAL=5). Both cadences are now DB-reactive via the
// derived_freshness table — fact inserts tick per-kind counters in
// public.derived_freshness, and src/services/derived-freshness.ts owns the
// threshold-fire helpers (maybeFirePatternDetection,
// maybeFireGraphStats). See doc 32 §2 + doc 34 §3.4 for the principle.

export interface IngestResult extends ExtractResult {}

export interface ResolvedEntity {
  id: string;
  canonicalName: string;
  entityType: string;
  isNew: boolean;
  confidence: number;
}

export interface CreatedFact {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
}

export interface SkippedRelationship {
  subject: string;
  predicate: string;
  object: string;
  reason: string;
}

/**
 * Store raw text in Qdrant with embedding. Fast — just embed + store.
 * Returns the memoryId which can be used for later extraction.
 */
export async function store(
  text: string,
  metadata?: { source?: string; timestamp?: Date; contentType?: ContentType; sourceId?: string; chunkIndex?: number }
): Promise<string> {
  const memoryId = randomUUID();
  const { vector } = await ml.embed(text);
  const payload: Record<string, unknown> = {
    content: text,
    source: metadata?.source ?? 'cli',
    created_at: (metadata?.timestamp ?? new Date()).toISOString(),
    status: 'stored',
    content_type: metadata?.contentType ?? 'prose',
  };
  // Batch provenance (doc 38 S1). source_id groups all chunks of one batched
  // source; chunk_index is the narration-order key the reconcile step uses for
  // temporal alignment. Omitted for single-chunk ingest (backward compatible).
  if (metadata?.sourceId !== undefined) payload.source_id = metadata.sourceId;
  if (metadata?.chunkIndex !== undefined) payload.chunk_index = metadata.chunkIndex;
  await storeMemory({ id: memoryId, vector, payload });
  return memoryId;
}

/**
 * Extract entities and relationships from an already-stored memory.
 *
 * Invokes the unified graph agent which runs five phases:
 * ORIENT → EXTRACT → RELATE → CAUSE → VERIFY
 *
 * The agent creates entities, facts, causal events, and causal edges
 * directly via MCP tool calls. After the agent finishes, we query
 * the DB for what was created and update graph meta statistics.
 */
export async function extract(memoryId: string, opts?: { contentType?: ContentType }): Promise<ExtractResult> {
  const timing: Record<string, number> = {};

  // 1. Fetch memory from Qdrant
  const memory = await getMemory(memoryId);
  if (!memory?.payload) throw new Error(`Memory ${memoryId} not found in Qdrant`);
  const content = memory.payload.content as string;
  // contentType resolution order: explicit opts > stored Qdrant payload > 'prose'
  const contentType: ContentType =
    opts?.contentType ?? (memory.payload.content_type as ContentType | undefined) ?? 'prose';

  // 2. Invoke the unified graph agent
  // Bead nmemo-upn: fetch the latest prior extraction report (any memory_id
  // other than the current one) and thread it into the agent prompt as
  // continuity context. Best-effort — a fetch failure logs but never blocks
  // extraction. Excluding the current memory_id is defensive: the current
  // chunk's own report is never persisted before this call (it's the
  // fire-and-forget INSERT below), but a re-extract of the same memory_id
  // could otherwise feed the agent its own prior report.
  const tPrior = Date.now();
  let previousReport: string | null = null;
  try {
    const priorRows = await db
      .select({ reportText: extractionReports.reportText })
      .from(extractionReports)
      .where(sql`memory_id <> ${memoryId}::uuid`)
      .orderBy(sql`created_at DESC`)
      .limit(1);
    previousReport = priorRows[0]?.reportText ?? null;
  } catch (err) {
    console.warn('[pipeline] failed to fetch prior extraction report (continuing without):', err instanceof Error ? err.message : err);
  }
  timing.priorReportFetch = Date.now() - tPrior;

  const t0 = Date.now();
  const agentResult = await invokeGraphAgent({
    sourceText: content,
    memoryId,
    source: memory.payload.source as string | undefined,
    contentType,
    previousReport,
  });
  timing.graphAgent = Date.now() - t0;
  if (agentResult.result) {
    // Log the full structured report — this is the agent's reasoning trace
    console.log(`[graph-agent] report:\n${agentResult.result}`);
    // Persist for reconciliation agent consumption (fire-and-forget — never blocks extraction).
    // Drizzle's query builder is thenable; wrap in Promise.resolve so .catch attaches before
    // any rejection lands, and `void` makes the unawaited intent explicit.
    void Promise.resolve(
      db.insert(extractionReports).values({ memoryId, reportText: agentResult.result }),
    ).catch((err) => {
      console.warn('[pipeline] failed to store extraction report:', err instanceof Error ? err.message : err);
    });
  }

  // 3. Query what the agent created (entities + facts linked to this memory)
  const entityLinks = await db
    .select({ entityId: memoryEntities.entityId })
    .from(memoryEntities)
    .where(eq(memoryEntities.memoryId, memoryId));

  const entityIds = [...new Set(entityLinks.map(e => e.entityId))];

  const resolvedEntities: ResolvedEntity[] = entityIds.length > 0
    ? (await db
        .select({
          id: entitiesTable.id,
          canonicalName: entitiesTable.canonicalName,
          entityType: entitiesTable.entityType,
          confidence: entitiesTable.confidence,
        })
        .from(entitiesTable)
        .where(inArray(entitiesTable.id, entityIds))
      ).map(e => ({
        id: e.id,
        canonicalName: e.canonicalName,
        entityType: e.entityType,
        isNew: false,
        confidence: e.confidence,
      }))
    : [];

  const createdFacts: CreatedFact[] = (await db
    .select({
      id: factsTable.id,
      subjectEntityId: factsTable.subjectEntityId,
      predicate: factsTable.predicate,
      objectEntityId: factsTable.objectEntityId,
      objectValue: factsTable.objectValue,
      confidence: factsTable.confidence,
    })
    .from(factsTable)
    .where(eq(factsTable.sourceMemoryId, memoryId))
  ).map(f => {
    const subjectName = resolvedEntities.find(e => e.id === f.subjectEntityId)?.canonicalName ?? f.subjectEntityId;
    const objectName = f.objectEntityId
      ? resolvedEntities.find(e => e.id === f.objectEntityId)?.canonicalName ?? f.objectEntityId
      : f.objectValue ?? '';
    return {
      id: f.id,
      subject: subjectName,
      predicate: f.predicate,
      object: objectName,
      confidence: f.confidence ?? 1,
    };
  });

  // 4. Update graph meta (entity stats + merge candidate detection)
  let gardenerResult: { triggered: boolean; report?: string } | undefined;
  let reconciliationResult: ExtractResult['reconciliation'];
  // Contradictions detected on this chunk's SQL sweep; stays 0 unless the
  // periodic sweep runs below (and succeeds). Surfaced on ExtractResult so the
  // harness can compute the detected-vs-reflected gap (nmemo-hm4.5).
  let contradictionsDetected = 0;
  if (entityIds.length > 0) {
    const tMeta = Date.now();
    try {
      await updateEntityMeta(entityIds);
      const newCandidates = await detectMergeCandidates(entityIds);
      if (newCandidates > 0) {
        console.log(`[graph-meta] ${newCandidates} merge candidate(s) detected`);
      }
    } catch (err) {
      console.warn('[graph-meta] failed:', err instanceof Error ? err.message : err);
    }
    timing.graphMeta = Date.now() - tMeta;

    // 5. Auto-trigger gardener every N graph agent runs
    graphAgentRunCount++;
    if (graphAgentRunCount >= GARDENER_RUN_INTERVAL) {
      const tGarden = Date.now();
      const runsSince = graphAgentRunCount;
      graphAgentRunCount = 0; // reset before async call
      console.log(`[gardener] auto-triggering after ${runsSince} graph agent runs`);
      try {
        const gardenResult = await invokeGardenerAgent({
          trigger: 'auto',
          graphAgentRunsSinceLast: runsSince,
        });
        if (gardenResult.result) {
          console.log(`[gardener] report:\n${gardenResult.result}`);
        }
        // Bead nmemo-2yv.67 — persist auto-triggered runs to the audit log
        // via the shared helper. Inside the same try/catch so a failed
        // audit write logs but never blocks the pipeline. Same shape as
        // the manual /api/garden handler.
        await recordGardeningRun({
          trigger: 'auto',
          runsSinceLast: runsSince,
          report: gardenResult.result || '(no report)',
          durationMs: Date.now() - tGarden,
        }).catch(err => {
          console.warn('[gardener] failed to store report:', err instanceof Error ? err.message : err);
        });
        gardenerResult = { triggered: true, report: gardenResult.result };
      } catch (err) {
        console.warn('[gardener] failed:', err instanceof Error ? err.message : err);
        gardenerResult = { triggered: false };
      }
      timing.gardener = Date.now() - tGarden;
    }

    // 5b. Reconciliation agent auto-trigger (bead nmemo-2yv.61). Same
    //     fire-and-forget shape as gardener — never blocks the pipeline
    //     result. The body is extracted to maybeTriggerReconciliation()
    //     for testability of the cooldown gate. See its docstring for
    //     the conditional rules.
    const tRecon = Date.now();
    reconciliationResult = await maybeTriggerReconciliation();
    timing.reconciliation = Date.now() - tRecon;

    // 6. Auto-trigger confidence decay every N graph agent runs (independent
    //    of the gardener counter — they cycle on different intervals).
    //    Phase 5: piggyback contradiction detection on the same counter.
    //    Both are cheap periodic SQL with no shared state — they run in
    //    sequence so a decay-induced expiry can be picked up by the next
    //    detectExpiredButCited sweep within the same auto-trigger tick.
    decayRunCount++;
    if (decayRunCount >= DECAY_RUN_INTERVAL) {
      const tDecay = Date.now();
      const runsSince = decayRunCount;
      decayRunCount = 0; // reset before async call
      console.log(`[decay] auto-triggering applyConfidenceDecay after ${runsSince} graph agent runs`);
      try {
        const decayResult = await applyConfidenceDecay();
        console.log(
          `[decay] complete decayed=${decayResult.decayed} expired=${decayResult.expired}`,
        );
      } catch (err) {
        console.warn('[decay] failed:', err instanceof Error ? err.message : err);
      }
      timing.decay = Date.now() - tDecay;

      // Phase 5: SQL contradiction detection sweep. Per-heuristic isolation
      // inside detectContradictions (nmemo-2yv.41) means the orchestrator no
      // longer throws on a single-heuristic failure — surviving heuristics'
      // counts land in byType, the failing heuristic's message lands in
      // errors[type]. The defensive outer try/catch stays for unexpected
      // non-heuristic faults (DB connection lost mid-orchestrator etc.).
      const tContra = Date.now();
      try {
        const contraResult = await detectContradictions();
        contradictionsDetected = contraResult.detected;
        const errorsPart = contraResult.errors
          ? ` errors=${JSON.stringify(contraResult.errors)}`
          : '';
        console.log(
          `[contradictions] auto-detect complete detected=${contraResult.detected} byType=${JSON.stringify(contraResult.byType)}${errorsPart}`,
        );
      } catch (err) {
        console.warn('[contradictions] auto-detect failed:', err instanceof Error ? err.message : err);
      }
      timing.contradictions = Date.now() - tContra;
    }
  }

  return { memoryId, entities: resolvedEntities, facts: createdFacts, skipped: [], filtered: [], timing, gardener: gardenerResult, reconciliation: reconciliationResult, contradictionsDetected };
}

/**
 * Store + auto-extract. The default entry point for most usage.
 * Equivalent to: const id = await store(text); return await extract(id);
 */
export async function ingest(
  text: string,
  metadata?: { source?: string; timestamp?: Date; contentType?: ContentType }
): Promise<IngestResult> {
  const rid = randomUUID().slice(0, 8);
  const tag = `[ingest:${rid}]`;
  const totalStart = Date.now();
  console.log(`${tag} start source=${metadata?.source ?? 'unknown'} contentType=${metadata?.contentType ?? 'prose'} len=${text.length}`);

  const memoryId = await store(text, metadata);
  console.log(`${tag} stored memoryId=${memoryId} +${Date.now() - totalStart}ms`);

  const extractResult = await extract(memoryId, { contentType: metadata?.contentType });
  console.log(`${tag} extracted entities=${extractResult.entities.length} facts=${extractResult.facts.length} +${Date.now() - totalStart}ms`);

  extractResult.timing.total = Date.now() - totalStart;
  console.log(`${tag} done total=${extractResult.timing.total}ms`);
  return extractResult;
}

// ============================================
// Batch ingestion (doc 38 — parallel ingestion)
// ============================================

export interface BatchIngestOptions {
  source?: string;
  /** Reuse an existing source id (e.g. re-ingest); otherwise one is generated. */
  sourceId?: string;
  contentType?: ContentType;
  /** Which pipeline arm to run. Default 'serial' (the baseline control). */
  mode?: IngestMode;
}

export interface BatchIngestResult {
  sourceId: string;
  mode: IngestMode;
  chunkCount: number;
  results: ExtractResult[];
  timing: { total: number };
}

/**
 * Baseline / control arm: store + extract each chunk strictly in chunk_index
 * order. This is the serial FIFO behaviour the parallel arms are measured
 * against (doc 38 §7) — deterministic, correct, slow.
 */
async function runSerialBatch(items: BatchItem[]): Promise<ExtractResult[]> {
  const results: ExtractResult[] = [];
  for (const item of items) {
    const memoryId = await store(item.text, {
      source: item.source,
      sourceId: item.sourceId,
      chunkIndex: item.chunkIndex,
      contentType: item.contentType,
    });
    results.push(await extract(memoryId, { contentType: item.contentType }));
  }
  return results;
}

/** Max concurrent agent extractions per batch — keep ≈ ML_LLM_WORKERS so the
 *  pool absorbs the fan-out; excess returns 503 and we back off + retry. */
const EPOCH_CONCURRENCY = Number.parseInt(process.env.EPOCH_CONCURRENCY ?? '6', 10);

/**
 * Narrow a set of touched entity ids to those that STILL EXIST. The parallel
 * arms harvest entity ids from the extraction results, but concurrent per-chunk
 * reconciliation can merge (and delete) some of those entities before the
 * barrier/final reconcile runs. Feeding a dead id into updateEntityMeta /
 * detectMergeCandidates FK-violates (entity_meta / merge_candidates reference
 * public.entities) and aborts the whole reconcile pass. A merged entity's data
 * already lives on its survivor, which is itself in the touched set when it was
 * extracted — so the survivor's meta is still refreshed; only the dead
 * tombstone id is dropped.
 */
async function filterLiveEntityIds(entityIds: string[]): Promise<string[]> {
  if (entityIds.length === 0) return [];
  const rows = await db
    .select({ id: entitiesTable.id })
    .from(entitiesTable)
    .where(inArray(entitiesTable.id, entityIds));
  return rows.map((r) => r.id);
}

/**
 * Approach A — epoch / barrier. Store every chunk, fan extraction out in
 * parallel (bounded + 503-retry) so the agents write the live graph
 * concurrently, then run one barrier reconcile over everything the epoch
 * touched. Duplicate active facts are already prevented at write time by P1
 * (uniq_facts_active_triple); the barrier handles entity-identity dedup.
 *
 * NOTE (doc 38, deferred): explicit chunk_index temporal re-alignment is not
 * yet applied — exclusive-predicate supersession is valid_at-based in
 * createFact (order-independent when valid_at is extracted). chunk_index is
 * persisted on each memory for a future realign pass; behavioural correctness
 * of this arm is established at the benchmark/litmus stage.
 */
async function runEpochBatch(items: BatchItem[]): Promise<ExtractResult[]> {
  // Phase 1: store all chunks (bounded — embeddings hit the Ollama pool too).
  const stored = await mapWithConcurrency(items, EPOCH_CONCURRENCY, async (item) => ({
    memoryId: await store(item.text, {
      source: item.source,
      sourceId: item.sourceId,
      chunkIndex: item.chunkIndex,
      contentType: item.contentType,
    }),
    item,
  }));

  // Phase 2: parallel agent extraction (the free-for-all writes).
  const results = await mapWithConcurrency(stored, EPOCH_CONCURRENCY, ({ memoryId, item }) =>
    withRetry(() => extract(memoryId, { contentType: item.contentType }), {
      retries: 4,
      isRetryable: isQueueFull,
      baseDelayMs: 500,
    }),
  );

  // Phase 3: barrier reconcile over every entity the epoch touched (filtered to
  // entities that survived any concurrent merge — see filterLiveEntityIds).
  const touchedIds = [...new Set(results.flatMap((r) => r.entities.map((e) => e.id)))];
  const entityIds = await filterLiveEntityIds(touchedIds);
  if (entityIds.length > 0) {
    try {
      await updateEntityMeta(entityIds);
      await detectMergeCandidates(entityIds);
      _resetReconciliationCooldown(); // the barrier always fires, regardless of cooldown
      await maybeTriggerReconciliation();
    } catch (err) {
      console.warn('[epoch] barrier reconcile failed:', err instanceof Error ? err.message : err);
    }
  }
  return results;
}

const OPTIMISTIC_CONCURRENCY = Number.parseInt(process.env.OPTIMISTIC_CONCURRENCY ?? '6', 10);
const OPTIMISTIC_RECONCILE_INTERVAL_MS = Number.parseInt(
  process.env.OPTIMISTIC_RECONCILE_INTERVAL_MS ?? '3000',
  10,
);

/**
 * Approach B — continuous optimistic concurrency. Agents write the live graph
 * in parallel (bounded + 503-retry) with NO barrier; a reconcile loop runs
 * concurrently alongside them. Safe against in-flight writes via P1
 * (uniq_facts_active_triple prevents duplicate facts; the racing INSERT is
 * caught + corroborated in createFact) and P3 (facts.subject_entity_id
 * RESTRICT — a merge racing a write rolls back instead of cascade-deleting,
 * doc 05 Bug C). The agent recovers from a stale-entity write via the P2
 * actionable MCP error ([entity_missing] → re-resolve).
 */
async function runOptimisticBatch(items: BatchItem[]): Promise<ExtractResult[]> {
  // Phase 1: store all chunks (bounded).
  const stored = await mapWithConcurrency(items, OPTIMISTIC_CONCURRENCY, async (item) => ({
    memoryId: await store(item.text, {
      source: item.source,
      sourceId: item.sourceId,
      chunkIndex: item.chunkIndex,
      contentType: item.contentType,
    }),
    item,
  }));

  // Concurrent reconcile loop — runs alongside extraction (no barrier).
  let extracting = true;
  const reconcileLoop = (async () => {
    while (extracting) {
      await new Promise((r) => setTimeout(r, OPTIMISTIC_RECONCILE_INTERVAL_MS));
      if (!extracting) break;
      try {
        _resetReconciliationCooldown();
        await maybeTriggerReconciliation();
      } catch (err) {
        console.warn('[optimistic] concurrent reconcile tick failed:', err instanceof Error ? err.message : err);
      }
    }
  })();

  // Phase 2: parallel agent extraction (continuous optimistic writes).
  // try/finally guarantees the reconcile loop is stopped + awaited even if
  // extraction throws — otherwise the loop (and this call) would hang.
  let results: ExtractResult[];
  try {
    results = await mapWithConcurrency(stored, OPTIMISTIC_CONCURRENCY, ({ memoryId, item }) =>
      withRetry(() => extract(memoryId, { contentType: item.contentType }), {
        retries: 4,
        isRetryable: isQueueFull,
        baseDelayMs: 500,
      }),
    );
  } finally {
    extracting = false;
    await reconcileLoop;
  }

  // Final reconcile sweep over every touched entity (filtered to survivors of
  // any concurrent merge — see filterLiveEntityIds).
  const touchedIds = [...new Set(results.flatMap((r) => r.entities.map((e) => e.id)))];
  const entityIds = await filterLiveEntityIds(touchedIds);
  if (entityIds.length > 0) {
    try {
      await updateEntityMeta(entityIds);
      await detectMergeCandidates(entityIds);
      _resetReconciliationCooldown();
      await maybeTriggerReconciliation();
    } catch (err) {
      console.warn('[optimistic] final reconcile failed:', err instanceof Error ? err.message : err);
    }
  }
  return results;
}

/**
 * Ingest a batch of chunks belonging to one source. Stores every chunk tagged
 * with a shared `sourceId` + its `chunkIndex`, then runs the selected pipeline
 * arm. `serial` is the comparison baseline; `epoch`/`optimistic` are the two
 * candidate architectures under evaluation.
 */
export async function ingestBatch(
  chunks: string[],
  opts: BatchIngestOptions = {},
): Promise<BatchIngestResult> {
  const mode: IngestMode = opts.mode ?? 'serial';
  const sourceId = opts.sourceId ?? randomUUID();
  const tag = `[ingestBatch:${sourceId.slice(0, 8)}:${mode}]`;
  const start = Date.now();
  console.log(`${tag} start chunks=${chunks.length} source=${opts.source ?? 'unknown'}`);

  const items = prepareBatch(chunks, { source: opts.source, sourceId, contentType: opts.contentType });
  const runner =
    mode === 'serial' ? runSerialBatch : mode === 'epoch' ? runEpochBatch : runOptimisticBatch;
  const results = await runner(items);

  const total = Date.now() - start;
  console.log(`${tag} done chunks=${chunks.length} results=${results.length} +${total}ms`);
  return { sourceId, mode, chunkCount: chunks.length, results, timing: { total } };
}

// ============================================
// Serial Ingest Queue
// ============================================

interface QueueItem {
  text: string;
  source?: string;
  contentType?: ContentType;
}

const ingestQueue: QueueItem[] = [];
let draining = false;

/**
 * Enqueue text for ingestion. Returns immediately.
 * Items are processed one at a time in FIFO order —
 * no concurrent graph agent processes, no race conditions.
 */
export function enqueueIngest(
  text: string,
  source?: string,
  contentType?: ContentType,
): { queued: true; position: number } {
  ingestQueue.push({ text, source, contentType });
  const position = ingestQueue.length;
  console.log(`[queue] enqueued position=${position} source=${source ?? 'unknown'} contentType=${contentType ?? 'prose'} len=${text.length}`);
  drainQueue(); // kick the worker (no-op if already running)
  return { queued: true, position };
}

async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  while (ingestQueue.length > 0) {
    const item = ingestQueue.shift()!;
    try {
      await ingest(item.text, { source: item.source, contentType: item.contentType });
    } catch (err) {
      console.error(`[queue] ingest failed:`, err instanceof Error ? err.message : err);
    }
  }
  draining = false;
}

/**
 * Snapshot of the in-memory ingest queue. The LLM-pipeline snapshot generator
 * (doc 28 §3.4) polls this between chunks: a chunk is "complete" when the
 * queue is empty AND no item is currently draining. Returns immediately —
 * no I/O.
 */
export function getIngestQueueStatus(): { queued: number; draining: boolean } {
  return { queued: ingestQueue.length, draining };
}
