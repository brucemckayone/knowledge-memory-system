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
import { invokeGraphAgent, invokeGardenerAgent } from './services/causal-agent.js';
import { applyConfidenceDecay } from './services/causal.js';
import { detectContradictions } from './services/contradictions.js';
import { updateEntityMeta, detectMergeCandidates } from './services/graph-meta.js';
import { db } from './db/index.js';
import { entities as entitiesTable, facts as factsTable, memoryEntities, extractionReports } from './db/schema.js';
import { eq, inArray } from 'drizzle-orm';

export interface ExtractResult {
  memoryId: string;
  entities: ResolvedEntity[];
  facts: CreatedFact[];
  skipped: SkippedRelationship[];
  filtered: string[];
  timing: Record<string, number>;
  gardener?: { triggered: boolean; report?: string };
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
// Pattern-Detection Auto-Trigger Counter (Phase 6 — nmemo-d9v.13)
// ============================================
const PATTERN_DETECTION_INTERVAL = 3; // run pattern detect+promote every N reasoning patrols
let reasoningPatrolCount = 0;

/**
 * Called from invokeReasoningAgent() on patrol success. Every
 * PATTERN_DETECTION_INTERVAL invocations, runs detectCausalPatterns +
 * promotePatterns. Wrapped in try/catch so any failure logs but never
 * surfaces back into the patrol HTTP response.
 */
export async function incrementPatrolCount(): Promise<void> {
  reasoningPatrolCount++;
  if (reasoningPatrolCount < PATTERN_DETECTION_INTERVAL) return;
  reasoningPatrolCount = 0;

  try {
    const { detectCausalPatterns, promotePatterns } = await import('./services/causal-patterns.js');
    const detection = await detectCausalPatterns();
    const promotion = await promotePatterns();
    console.log(
      `[patterns] auto-trigger: ${detection.newStaging} new staging, ${promotion.promoted.length} promoted, ${promotion.demoted.length} demoted, ${promotion.rejected.length} rejected`,
    );
  } catch (err) {
    console.warn('[patterns] auto-trigger failed:', err instanceof Error ? err.message : err);
  }
}

/** Test-only — reset the counter so unit tests don't have to wait for natural cycles. */
export function _resetReasoningPatrolCount(): void {
  reasoningPatrolCount = 0;
}

// ============================================
// Graph-Stats Auto-Trigger Counter (Phase 1 — nmemo-a7f.1.1, doc 22 §3.3)
// ============================================
const GRAPH_STATS_INTERVAL = 5; // run computeGraphStats every N reasoning patrols
let graphStatsPatrolCount = 0;

/**
 * Called from invokeReasoningAgent() on patrol success. Every
 * GRAPH_STATS_INTERVAL invocations, runs computeGraphStats. Wrapped in
 * try/catch so any failure logs but never surfaces back into the patrol
 * HTTP response (mirrors incrementPatrolCount above).
 */
export async function incrementGraphStatsCount(): Promise<void> {
  graphStatsPatrolCount++;
  if (graphStatsPatrolCount < GRAPH_STATS_INTERVAL) return;
  graphStatsPatrolCount = 0;

  try {
    const { computeGraphStats } = await import('./services/graph-stats.js');
    const stats = await computeGraphStats();
    console.log(
      `[graph-stats] auto-trigger: total_entities=${stats.totalEntities} active_facts=${stats.totalActiveFacts} duration=${stats.computedDurationMs}ms`,
    );
  } catch (err) {
    console.warn('[graph-stats] auto-trigger failed:', err instanceof Error ? err.message : err);
  }
}

/** Test-only — reset the counter so unit tests don't have to wait for natural cycles. */
export function _resetGraphStatsCount(): void {
  graphStatsPatrolCount = 0;
}

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
  metadata?: { source?: string; timestamp?: Date }
): Promise<string> {
  const memoryId = randomUUID();
  const { vector } = await ml.embed(text);
  await storeMemory({
    id: memoryId,
    vector,
    payload: {
      content: text,
      source: metadata?.source ?? 'cli',
      created_at: (metadata?.timestamp ?? new Date()).toISOString(),
      status: 'stored',
    },
  });
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
export async function extract(memoryId: string): Promise<ExtractResult> {
  const timing: Record<string, number> = {};

  // 1. Fetch memory from Qdrant
  const memory = await getMemory(memoryId);
  if (!memory?.payload) throw new Error(`Memory ${memoryId} not found in Qdrant`);
  const content = memory.payload.content as string;

  // 2. Invoke the unified graph agent
  const t0 = Date.now();
  const agentResult = await invokeGraphAgent({
    sourceText: content,
    memoryId,
    source: memory.payload.source as string | undefined,
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
        gardenerResult = { triggered: true, report: gardenResult.result };
      } catch (err) {
        console.warn('[gardener] failed:', err instanceof Error ? err.message : err);
        gardenerResult = { triggered: false };
      }
      timing.gardener = Date.now() - tGarden;
    }

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

      // Phase 5: SQL contradiction detection sweep. Independent try/catch so
      // a heuristic failure never masks decay results.
      const tContra = Date.now();
      try {
        const contraResult = await detectContradictions();
        console.log(
          `[contradictions] auto-detect complete detected=${contraResult.detected} byType=${JSON.stringify(contraResult.byType)}`,
        );
      } catch (err) {
        console.warn('[contradictions] auto-detect failed:', err instanceof Error ? err.message : err);
      }
      timing.contradictions = Date.now() - tContra;
    }
  }

  return { memoryId, entities: resolvedEntities, facts: createdFacts, skipped: [], filtered: [], timing, gardener: gardenerResult };
}

/**
 * Store + auto-extract. The default entry point for most usage.
 * Equivalent to: const id = await store(text); return await extract(id);
 */
export async function ingest(
  text: string,
  metadata?: { source?: string; timestamp?: Date }
): Promise<IngestResult> {
  const rid = randomUUID().slice(0, 8);
  const tag = `[ingest:${rid}]`;
  const totalStart = Date.now();
  console.log(`${tag} start source=${metadata?.source ?? 'unknown'} len=${text.length}`);

  const memoryId = await store(text, metadata);
  console.log(`${tag} stored memoryId=${memoryId} +${Date.now() - totalStart}ms`);

  const extractResult = await extract(memoryId);
  console.log(`${tag} extracted entities=${extractResult.entities.length} facts=${extractResult.facts.length} +${Date.now() - totalStart}ms`);

  extractResult.timing.total = Date.now() - totalStart;
  console.log(`${tag} done total=${extractResult.timing.total}ms`);
  return extractResult;
}

// ============================================
// Serial Ingest Queue
// ============================================

interface QueueItem {
  text: string;
  source?: string;
}

const ingestQueue: QueueItem[] = [];
let draining = false;

/**
 * Enqueue text for ingestion. Returns immediately.
 * Items are processed one at a time in FIFO order —
 * no concurrent graph agent processes, no race conditions.
 */
export function enqueueIngest(text: string, source?: string): { queued: true; position: number } {
  ingestQueue.push({ text, source });
  const position = ingestQueue.length;
  console.log(`[queue] enqueued position=${position} source=${source ?? 'unknown'} len=${text.length}`);
  drainQueue(); // kick the worker (no-op if already running)
  return { queued: true, position };
}

async function drainQueue(): Promise<void> {
  if (draining) return;
  draining = true;
  while (ingestQueue.length > 0) {
    const item = ingestQueue.shift()!;
    try {
      await ingest(item.text, { source: item.source });
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
