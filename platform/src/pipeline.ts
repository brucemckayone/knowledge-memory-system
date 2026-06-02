/**
 * Pipeline — Core data flow for the sparse truth graph.
 *
 * store(text)   → embed + Qdrant write → returns memoryId
 * extract(id)   → unified graph agent (ORIENT → EXTRACT → RELATE → CAUSE → VERIFY)
 * ingest(text)  → store + extract (the default entry point)
 */

import { randomUUID, createHash } from 'crypto';
import { ml } from './services/ml-client.js';
import { storeMemory, storeMemoryWithUnits, getMemory } from './services/qdrant.js';
import { config } from './config.js';
import { invokeGraphAgent, invokeGardenerAgent, type ContentType } from './services/causal-agent.js';
import { findOrCreateSpeaker } from './services/entities.js';
import { recordGardeningRun } from './services/gardening.js';
import { applyConfidenceDecay } from './services/causal.js';
import { detectContradictions } from './services/contradictions.js';
import { updateEntityMeta, detectMergeCandidates } from './services/graph-meta.js';
import { db } from './db/index.js';
import { entities as entitiesTable, facts as factsTable, memoryEntities, extractionReports, mergeCandidates, entityAliases, factUnits } from './db/schema.js';
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
}

// ============================================
// Stream / speaker plumbing (nmemo-3f9.2)
// ============================================
// stream_id scopes speaker identity (see findOrCreateSpeaker / stream_participants).
// When a caller omits it, every memory lands in one implicit stream so the
// pre-3f9 single-user behaviour is preserved (back-compat).
const DEFAULT_STREAM_ID = 'default';

// Assistant-role labels ride in the source text (e.g. "ASSISTANT: ..."), they
// are never declared on /ingest. We only seed an assistant speaker when such a
// label actually appears — the Frankenstein narrative path (no role labels)
// therefore seeds only the user, leaving the narrator path untouched.
const ASSISTANT_LABEL_RE = /^\s*(assistant|ai|bot)\s*:/im;

export function textHasAssistantTurns(text: string): boolean {
  return ASSISTANT_LABEL_RE.test(text);
}

/**
 * Pre-resolve the default stream speakers and render the Participants block
 * injected into the graph agent's EXTRACTION CONTEXT (nmemo-3f9.2).
 *
 * Resolution is DETERMINISTIC via findOrCreateSpeaker (keyed on
 * (streamId, speakerKey)) — it never name/embedding-resolves the anonymous
 * user. The user speaker is always seeded; the assistant only when the source
 * text carries assistant-role labels. Named third parties are NOT pre-resolved
 * — they emerge through normal entity extraction.
 *
 * Returns the prompt block plus the resolved entity ids (for assertions).
 */
export async function resolveStreamParticipants(
  streamId: string,
  text: string,
): Promise<{ block: string; userEntityId: string; assistantEntityId?: string }> {
  const user = await findOrCreateSpeaker(streamId, 'user', 'user');
  const lines = [
    '## Participants in this stream',
    `- USER -> entity ${user.id} (anonymous): anchor first-person I/my/me here`,
  ];

  let assistantEntityId: string | undefined;
  if (textHasAssistantTurns(text)) {
    const assistant = await findOrCreateSpeaker(streamId, 'assistant', 'assistant');
    assistantEntityId = assistant.id;
    lines.push(
      `- ASSISTANT -> entity ${assistant.id} (type assistant): assistant turns; do NOT anchor to the user`,
    );
  }

  return { block: lines.join('\n'), userEntityId: user.id, assistantEntityId };
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

/** A single small overlapping embedding unit carved out of a parent window. */
export interface EmbeddingUnit {
  /** Unit text — a `unitChars`-wide window of the parent text. */
  text: string;
  /** Inclusive char start offset into the parent window. */
  charStart: number;
  /** Exclusive char end offset into the parent window. */
  charEnd: number;
}

/**
 * Split a window into small OVERLAPPING units (epic nmemo-yxj, Decision 1).
 *
 * Each unit is `unitChars` wide and the next unit starts `unitChars - overlap`
 * chars later, so adjacent units share an `overlap`-char tail/head — a fact
 * straddling a unit boundary survives in at least one whole unit. The returned
 * char offsets index into `text` and form the SAME coordinate system as
 * memory_entities.mention_start/end and facts.source_text spans, which future
 * fact->unit linkage (yxj.6) and centroid de-dilution rely on — do NOT treat
 * the offsets as throwaway.
 *
 * Pure + synchronous so it is unit-testable without infra. Callers embed each
 * returned unit; the splitter itself never touches the embedder. Empty text
 * (length 0) yields zero units (nothing to retrieve). Text at or below one unit
 * width yields exactly one unit spanning the whole window (no degenerate
 * trailing duplicate).
 *
 * Precondition: `overlap < unitChars` (enforced at config load). With a
 * non-positive stride the loop would never advance — we assert rather than
 * silently clamp so a misconfiguration surfaces loudly.
 */
export function splitIntoUnits(
  text: string,
  unitChars: number = config.EMBED_UNIT_CHARS,
  overlap: number = config.EMBED_UNIT_OVERLAP,
): EmbeddingUnit[] {
  const stride = unitChars - overlap;
  if (stride <= 0) {
    throw new Error(
      `splitIntoUnits: overlap (${overlap}) must be < unitChars (${unitChars}); stride=${stride} would not advance`,
    );
  }
  if (text.length === 0) return [];

  const units: EmbeddingUnit[] = [];
  for (let start = 0; start < text.length; start += stride) {
    const end = Math.min(start + unitChars, text.length);
    units.push({ text: text.slice(start, end), charStart: start, charEnd: end });
    // The final unit reaches the end of the text; stop so a short trailing
    // remainder smaller than `overlap` does not spawn a duplicate sub-unit.
    if (end === text.length) break;
  }
  return units;
}

// The RFC-4122 v5 URL namespace, used as the fixed namespace for unit point
// ids. Any stable UUID works as the namespace — the per-window uniqueness comes
// from feeding the memoryId into the name. Constant here so the scheme is
// reproducible across processes.
const UNIT_ID_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

/**
 * Deterministic unit satellite point id (nmemo-yxj.6 enabler).
 *
 * yxj.2 originally minted unit ids with randomUUID(), so they lived ONLY in the
 * Qdrant payload and could not be reconstructed offline. extract() needs the
 * real unit ids to write fact_units links, which would otherwise force a read
 * of the shared Qdrant 'memories' collection. Deriving the id as
 * uuidv5(memoryId, unitIndex) instead makes it a pure function of
 * (memoryId, index): store() writes the same payload under this id, and
 * extract() recomputes the identical id from the window text + splitIntoUnits
 * index with ZERO Qdrant reads. Re-storing/re-extracting the same window is now
 * idempotent at the id level.
 *
 * Implemented as a hand-rolled RFC-4122 v5 (SHA-1 of namespace||name) so we add
 * no dependency — the `uuid` package is not installed and CLAUDE.md sanctions
 * `crypto`. Output is a canonical lowercase UUID string, matching the TEXT
 * shape Qdrant accepts and fact_units.unit_point_id stores.
 */
export function unitPointId(memoryId: string, unitIndex: number): string {
  const nsBytes = Buffer.from(UNIT_ID_NAMESPACE.replace(/-/g, ''), 'hex');
  const nameBytes = Buffer.from(`${memoryId}:${unitIndex}`, 'utf8');
  const hash = createHash('sha1').update(nsBytes).update(nameBytes).digest();
  const bytes = hash.subarray(0, 16);
  // Set version (5) and RFC-4122 variant bits.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** A computed fact->unit evidentiary link (pre-persist shape for fact_units). */
export interface FactUnitLink {
  unitPointId: string;
  charStart: number | null;
  charEnd: number | null;
  matchKind: 'offset_overlap' | 'window_fallback';
}

/**
 * Map a fact's source_text span to the embedding unit(s) that evidence it
 * (nmemo-yxj.6). PURE: given the parent window content, the fact's verbatim
 * source_text, and the window's memoryId, it locates the span and returns one
 * link per overlapping unit — no Qdrant, no embedding, no DB.
 *
 * - Units come from the same splitIntoUnits the writer used, so their indices
 *   (and thus deterministic unitPointId) line up with what store() persisted.
 * - A span overlaps a unit when [spanStart,spanEnd) intersects
 *   [unit.charStart,unit.charEnd) (half-open; touching-at-a-boundary does NOT
 *   overlap). A span straddling a boundary maps to BOTH units — overlap in
 *   splitIntoUnits guarantees at least one unit contains it whole, but we keep
 *   every overlapping unit so the fallback can rank them.
 * - Fallback to a single window_fallback row (keyed on the window's own point
 *   id = memoryId) when source_text is empty/null, is not found verbatim, or
 *   repeats (indexOf vs lastIndexOf disagree → ambiguous offset).
 */
export function mapFactToUnits(
  memoryId: string,
  windowContent: string,
  sourceText: string | null | undefined,
  units: EmbeddingUnit[],
): FactUnitLink[] {
  const windowFallback = (): FactUnitLink[] => [
    { unitPointId: memoryId, charStart: null, charEnd: null, matchKind: 'window_fallback' },
  ];

  if (!sourceText) return windowFallback();
  const first = windowContent.indexOf(sourceText);
  if (first === -1) return windowFallback();
  // Repeats are ambiguous — we cannot say which occurrence the fact meant.
  if (windowContent.lastIndexOf(sourceText) !== first) return windowFallback();

  const spanStart = first;
  const spanEnd = first + sourceText.length;
  const links: FactUnitLink[] = [];
  units.forEach((u, i) => {
    // Half-open overlap: spanStart < unit.charEnd AND unit.charStart < spanEnd.
    if (spanStart < u.charEnd && u.charStart < spanEnd) {
      links.push({
        unitPointId: unitPointId(memoryId, i),
        charStart: u.charStart,
        charEnd: u.charEnd,
        matchKind: 'offset_overlap',
      });
    }
  });
  // A zero-length unit set (e.g. empty window) degrades to window fallback.
  return links.length > 0 ? links : windowFallback();
}

/**
 * Store raw text in Qdrant with embedding. Fast — just embed + store.
 * Returns the memoryId which can be used for later extraction.
 *
 * Storage shape (epic nmemo-yxj, Decision 1 — parent-as-point + unit satellites):
 *   - PARENT point: id=memoryId, vector=whole-window embedding,
 *     payload {content=full window, point_type=window, source, created_at,
 *     status, content_type, stream_id}. This stays the canonical memory point:
 *     extract() reads getMemory(memoryId).content, facts.source_memory_id
 *     anchors here, and entity_meta centroids are computed from window vectors
 *     via getMemoryVectors over memory_entities (graph-meta.ts). Keeping the
 *     parent a real vectored point preserves all three — relocating the window
 *     vector onto a unit would silently null every centroid.
 *   - UNIT points: one per small overlapping unit; id=fresh uuid;
 *     vector=unit embedding; payload {point_type=unit, parent_window_id=memoryId,
 *     unit_text, char_start, char_end, stream_id}. Units carry ONLY their own
 *     text + offsets, NOT a copy of the window and NOT fact provenance. They are
 *     a retrieval index that points back to the parent window for context.
 *
 * The collection stays single-vector 768-dim Cosine (more points, NOT named/
 * multi-vectors). Extraction is unchanged: extract() still runs ONCE over the
 * whole parent window, so the Haiku call count is identical to the pre-unit
 * baseline — only the embedding/retrieval granularity changes underneath.
 */
export async function store(
  text: string,
  metadata?: { source?: string; timestamp?: Date; contentType?: ContentType; streamId?: string }
): Promise<string> {
  const memoryId = randomUUID();
  const streamId = metadata?.streamId ?? DEFAULT_STREAM_ID;

  // Embed the whole window (parent point) and each small unit (satellites) in
  // parallel. nomic caps at ~2048 tokens; units are far below the cap by
  // construction, and the parent window is already chunked upstream to fit.
  const units = splitIntoUnits(text);
  // nmemo-1cp: stored memory passages embed behind the nomic `search_document: `
  // prefix (queries use `search_query: `). Memories retrieval only — entity/fact
  // embeds stay raw.
  const [{ vector: windowVector }, unitEmbeds] = await Promise.all([
    ml.embedDocument(text),
    Promise.all(units.map((u) => ml.embedDocument(u.text))),
  ]);

  await storeMemoryWithUnits({
    parent: {
      id: memoryId,
      vector: windowVector,
      payload: {
        content: text,
        point_type: 'window',
        source: metadata?.source ?? 'cli',
        created_at: (metadata?.timestamp ?? new Date()).toISOString(),
        status: 'stored',
        content_type: metadata?.contentType ?? 'prose',
        // nmemo-3f9.2: stream scope for speaker identity. Persisted beside
        // source/content_type so standalone re-extraction (extract(memoryId))
        // recovers it, and so query-time metadata-scoped retrieval can filter.
        stream_id: streamId,
      },
    },
    units: units.map((u, i) => ({
      // Deterministic id (nmemo-yxj.6 enabler): uuidv5(memoryId, unitIndex)
      // instead of randomUUID() so extract() can recompute the same id from the
      // window text alone and write fact_units links with ZERO Qdrant reads.
      id: unitPointId(memoryId, i),
      vector: unitEmbeds[i]!.vector,
      payload: {
        point_type: 'unit',
        parent_window_id: memoryId,
        unit_text: u.text,
        char_start: u.charStart,
        char_end: u.charEnd,
        // Carry stream_id so unit-grained retrieval can apply the same
        // metadata scope filter as the parent without a join back.
        stream_id: streamId,
      },
    })),
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
export async function extract(memoryId: string, opts?: { contentType?: ContentType }): Promise<ExtractResult> {
  const timing: Record<string, number> = {};

  // 1. Fetch memory from Qdrant
  const memory = await getMemory(memoryId);
  if (!memory?.payload) throw new Error(`Memory ${memoryId} not found in Qdrant`);
  const content = memory.payload.content as string;
  // contentType resolution order: explicit opts > stored Qdrant payload > 'prose'
  const contentType: ContentType =
    opts?.contentType ?? (memory.payload.content_type as ContentType | undefined) ?? 'prose';

  // nmemo-3f9.2: recover the stream scope from the stored payload (so standalone
  // re-extraction still resolves the right speakers) and pre-resolve the default
  // stream participants. Resolution is platform-side + deterministic; the agent
  // is TOLD the speaker ids in the EXTRACTION CONTEXT and does not fuzzy-resolve
  // first-person references for these defaults.
  const streamId = (memory.payload.stream_id as string | undefined) ?? DEFAULT_STREAM_ID;
  const participants = await resolveStreamParticipants(streamId, content);

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
    streamId,
    participants: participants.block,
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

  const factRows = await db
    .select({
      id: factsTable.id,
      subjectEntityId: factsTable.subjectEntityId,
      predicate: factsTable.predicate,
      objectEntityId: factsTable.objectEntityId,
      objectValue: factsTable.objectValue,
      confidence: factsTable.confidence,
      sourceText: factsTable.sourceText,
    })
    .from(factsTable)
    .where(eq(factsTable.sourceMemoryId, memoryId));

  // nmemo-yxj.6: write the ADDITIVE fact->unit evidentiary links. Pure offset
  // mapping of each fact's verbatim source_text span onto the window's units
  // (recomputed from `content` via the SAME splitIntoUnits the writer used, so
  // unit indices — and thus the deterministic unitPointId — line up with what
  // store() persisted). Zero Qdrant reads, zero embeddings. Best-effort: a
  // failure here logs but never blocks extraction, and never touches the
  // canonical facts.source_memory_id (satellite invariant). Idempotent
  // re-writes via ON CONFLICT DO NOTHING (stable ids make re-extract a no-op).
  if (factRows.length > 0) {
    const tUnits = Date.now();
    try {
      const units = splitIntoUnits(content);
      const linkRows = factRows.flatMap((f) =>
        mapFactToUnits(memoryId, content, f.sourceText, units).map((l) => ({
          factId: f.id,
          unitPointId: l.unitPointId,
          charStart: l.charStart,
          charEnd: l.charEnd,
          matchKind: l.matchKind,
        })),
      );
      if (linkRows.length > 0) {
        await db.insert(factUnits).values(linkRows).onConflictDoNothing();
      }
    } catch (err) {
      console.warn('[pipeline] failed to write fact_units links (continuing):', err instanceof Error ? err.message : err);
    }
    timing.factUnits = Date.now() - tUnits;
  }

  const createdFacts: CreatedFact[] = factRows.map(f => {
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

  return { memoryId, entities: resolvedEntities, facts: createdFacts, skipped: [], filtered: [], timing, gardener: gardenerResult, reconciliation: reconciliationResult };
}

/**
 * Store + auto-extract. The default entry point for most usage.
 * Equivalent to: const id = await store(text); return await extract(id);
 */
export async function ingest(
  text: string,
  metadata?: { source?: string; timestamp?: Date; contentType?: ContentType; streamId?: string }
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
