/**
 * Platform HTTP server — entry point for Docker container.
 * Exposes the pipeline (ingest/store/extract), health check, and graph viz.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve, sep } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono, type Context } from 'hono';
import { store, extract, ingestBatch, enqueueIngest, enqueueExtraction, getIngestQueueStatus } from './pipeline.js';
import type { IngestMode } from './services/batch.js';
import { config } from './config.js';
import { db, checkDatabaseHealth, entities, facts, memoryEntities, causalEvents, causalEdges, entityMeta, sameAsLinks, mergeCandidates, entityAliases, extractionReports, captureIdempotency } from './db/index.js';
import { isNull, sql, eq } from 'drizzle-orm';
import { heroRoute } from './routes/hero.js';
import { notificationsHandler } from './routes/notifications.js';
import { recentHandler } from './routes/recent.js';
import { holdingHandler } from './routes/holding.js';
import { goingHandler } from './routes/going.js';
import { askHandler } from './routes/ask.js';
import {
  openPromisesHandler,
  promiseDetailHandler,
  nudgePromiseHandler,
  markDoneHandler,
  letGoHandler,
  recategorizeHandler,
  dismissSuggestionHandler,
} from './routes/promises.js';
import {
  onboardingCurrentHandler,
  confirmFocusHandler,
  untangleFocusHandler,
  renameFocusHandler,
} from './routes/onboarding.js';
import { riseHandler } from './routes/rise.js';
import { bridgeCurrentHandler, exploreNodeHandler } from './routes/bridge.js';
import {
  reReadCurrentHandler,
  reReadAllHandler,
  reReadThreadHandler,
} from './routes/re-read.js';
import { getMergeCandidates, detectAgedOrphans } from './services/graph-meta.js';
import { ml } from './services/ml-client.js';
import { checkQdrantHealth } from './services/qdrant.js';
import type { ReconciliationDriftInvoker } from './services/causal-agent.js';
import { markDerivedComputed as markDerivedFreshness } from './services/derived-freshness.js';
import { getFactHistory, getEdgeHistory } from './services/audit.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import { triggerCrossClusterAfterCompute } from './services/cross-cluster-generator.js';
import { getTopologySnapshot, getComponentEntities } from './services/topology.js';
import { getClustersSnapshot, getClusterEntities } from './services/clustering.js';
import { getDriftEvents, getDriftState } from './services/drift.js';
import { exportCanonicalGraph, exportRichGraph } from './services/graph-canonical-query.js';
import { Agent, setGlobalDispatcher } from 'undici';

// The platform makes long synchronous fetches to the ml-services agent endpoints
// (graph / reconciliation / gardener — each a `claude -p` subprocess that can run
// minutes). undici's default 300s headersTimeout fires before our per-call
// AbortController watchdog, surfacing as UND_ERR_HEADERS_TIMEOUT ("fetch failed")
// and aborting batch post-processing (e.g. the optimistic arm's reconcile/gardener
// auto-trigger -> 500). Disable the client response timeouts process-wide; the
// AbortController in agentFetch/mlFetch still bounds each call. Mirrors the
// comparison driver's dispatcher. See nmemo-1tc.
setGlobalDispatcher(new Agent({ headersTimeout: 0, bodyTimeout: 0 }));

const __dirname = dirname(fileURLToPath(import.meta.url));
const vizHtmlPath = join(__dirname, '../viz/index.html');

export const app = new Hono();

// ============================================
// iOS API v1 — bearer auth over /api/* (ASK milestone-1)
// ============================================
// Scoped to the /api/* prefix ONLY. /health and the pipeline routes
// (/ingest, /store, /extract) are intentionally NOT under /api and stay
// tokenless — dev over http and every existing endpoint test keep working.
//
// Policy (env-driven, read at request time so tests can flip it per-case):
//   AUTH_REQUIRED unset/false (dev & test default) -> pass through, no auth.
//   AUTH_REQUIRED true -> require `Authorization: Bearer <MNEMO_API_TOKEN>`;
//   on missing/mismatched token respond 401 with EXACT body {"error":"unauthorized"}.
// Keeping this off the zod config schema (read straight from process.env) means
// no existing test that constructs `config` is perturbed.
function authRequired(): boolean {
  const v = (process.env.AUTH_REQUIRED ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

app.use('/api/*', async (c, next) => {
  if (!authRequired()) return next();
  const expected = process.env.MNEMO_API_TOKEN ?? '';
  const header = c.req.header('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const token = match?.[1]?.trim();
  // A non-empty expected token must match exactly. An empty/unset expected
  // token while AUTH_REQUIRED is on is a misconfiguration — reject all to fail
  // closed rather than silently accept every caller.
  if (expected.length === 0 || token !== expected) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  return next();
});

app.get('/health', async (c) => {
  const [db, mlOk, qdrantOk] = await Promise.all([
    checkDatabaseHealth(),
    ml.health(),
    checkQdrantHealth(),
  ]);
  const status = db && mlOk && qdrantOk ? 'ok' : 'degraded';
  return c.json({ status, db, ml: mlOk, qdrant: qdrantOk });
});

// `contentType` (optional) hints the graph agent:
// 'prose' | 'code-ts' | 'code-sql' | 'conversational'.
// Defaults to 'prose' when omitted — backward compatible with all existing callers.
// nmemo-awi: 'conversational' must pass through (not downgrade to prose) so the
// graph agent's conversational system-prompt addendum (3f9.3) fires over HTTP.
type ContentTypeBody = 'prose' | 'code-ts' | 'code-sql' | 'conversational';

export function parseContentType(v: unknown): ContentTypeBody | undefined {
  if (v === 'prose' || v === 'code-ts' || v === 'code-sql' || v === 'conversational') return v;
  return undefined;
}

// iOS milestone-1 capture context (ASK-016 / onboarding). All fields optional;
// persisted with the memory where natural. onboarding_prompt_id is the one field
// the bead pins as must-not-drop — it threads onboarding-context ingests so the
// onboarding arc can attribute substrate growth to the prompt that elicited it.
interface IngestContext {
  seed_entity_id?: string;
  walk_session_id?: string;
  walk_question_id?: string;
  onboarding_prompt_id?: string;
  shared_url?: string;
  // ASK-011 re-read reply context (MNEMO-tcg.6). The PINNED iOS contract sends
  // these CAMELCASE (re-read.md §"Reply recording"; ReReadLetter.swift docs:
  // context.letterCompositionId / context.threadFocusEntityIds). The corpus prose
  // shows the snake_case spelling, and the milestone-1 context fields above are
  // snake_case — so we accept BOTH spellings (camelCase primary per the pin,
  // snake_case fallback) and normalise to the typed CaptureContext below. The iOS
  // reply path also tags source='ios_re_read_reply'.
  letterCompositionId?: string;
  threadFocusEntityIds?: string[];
  letter_composition_id?: string;
  thread_focus_entity_ids?: string[];
}

app.post('/ingest', async (c) => {
  const body = await c.req.json<{
    text: string;
    source?: string;
    contentType?: string;
    stream_id?: string;
    // iOS milestone-1 OPTIONAL additions — pre-iOS callers omit all.
    idempotency_key?: string;
    context?: IngestContext;
    // ISO-8601 client capture time. Honored as the memory's created_at so the
    // basin reflects WHEN the user captured (offline + later sync), not when the
    // server happened to receive. Absent -> server time default (back-compat).
    captured_at?: string;
  }>();
  if (!body.text) return c.json({ error: 'text is required' }, 400);

  // Parse the client capture timestamp; ignore an unparseable value rather than
  // 400 (a bad clock must not block capture — the server-time default applies).
  let capturedAt: Date | undefined;
  if (typeof body.captured_at === 'string' && body.captured_at.trim().length > 0) {
    const parsed = new Date(body.captured_at);
    if (!Number.isNaN(parsed.getTime())) capturedAt = parsed;
  }

  const idempotencyKey =
    typeof body.idempotency_key === 'string' && body.idempotency_key.trim().length > 0
      ? body.idempotency_key.trim()
      : undefined;

  // Idempotent capture (at-most-once under client retries — capture works
  // offline and retries on reconnect). ATOMIC dedup: INSERT the idempotency row
  // FIRST with onConflictDoNothing. If the insert affected 0 rows (conflict),
  // a prior/concurrent request already won the race — re-select its memory_id
  // and return the 202 idempotent short-circuit BEFORE store() (no double-
  // ingest under two concurrent same-key requests — closes the check-then-store
  // TOCTOU window the old select-then-store-then-insert sequence had). Only if
  // THIS request's insert succeeds do we proceed to store()+enqueue. 202 here
  // signals "we already have this; nothing new ran".
  if (idempotencyKey) {
    const inserted = await db
      .insert(captureIdempotency)
      .values({ idempotencyKey, memoryId: null })
      .onConflictDoNothing()
      .returning({ memoryId: captureIdempotency.memoryId });
    if (inserted.length === 0) {
      // Conflict: another request (this one's earlier retry or a concurrent
      // twin) already won the key. Re-select the winning memory_id and short-
      // circuit. The winner inserts the row with memory_id NULL, then backfills
      // after store(); if we read NULL the winner is mid-store — poll a few
      // times so a same-key retry never observes a half-written row.
      for (let attempt = 0; attempt < 20; attempt++) {
        const prior = await db
          .select({ memoryId: captureIdempotency.memoryId })
          .from(captureIdempotency)
          .where(eq(captureIdempotency.idempotencyKey, idempotencyKey))
          .limit(1);
        if (prior[0]?.memoryId) {
          return c.json({ memory_id: prior[0].memoryId, idempotent: true }, 202);
        }
        // Winner still mid-store; brief backoff then retry.
        await new Promise((r) => setTimeout(r, 50));
      }
      // Winner stalled past the poll budget. Fall through to a fresh ingest
      // rather than stranding the client — the worst case is one extra store()
      // under a key whose winner died, which is strictly better than a hang.
    }
  }

  // Keep the onboarding prompt id folded into the source tag (unchanged): the
  // bead's "at minimum do not drop onboarding_prompt_id" — this preserves the
  // existing source-tag channel that downstream readers already rely on.
  const promptId = body.context?.onboarding_prompt_id;
  const source =
    promptId && (!body.source || !body.source.includes('onboarding_prompt:'))
      ? `${body.source ?? 'ios'}|onboarding_prompt:${promptId}`
      : body.source;

  // Persist the FULL capture-context block onto the memory's Qdrant payload (in
  // addition to the source-tag channel above). Map the snake_case wire keys to
  // the typed CaptureContext; only present fields are forwarded/persisted.
  const captureContext = body.context
    ? {
        seedEntityId: body.context.seed_entity_id,
        walkSessionId: body.context.walk_session_id,
        walkQuestionId: body.context.walk_question_id,
        onboardingPromptId: body.context.onboarding_prompt_id,
        sharedUrl: body.context.shared_url,
        // ASK-011 re-read reply context — camelCase (PINNED) wins, snake_case
        // fallback. The post-extraction hook reads these back off the Qdrant payload.
        letterCompositionId: body.context.letterCompositionId ?? body.context.letter_composition_id,
        threadFocusEntityIds: body.context.threadFocusEntityIds ?? body.context.thread_focus_entity_ids,
      }
    : undefined;

  // NON-BLOCKING INGEST (scoping decision #10 — async 202; design/05-capture.md
  // §"Network unavailable" + §"When the placement is uncertain"). The capture
  // POST must return immediately: it never blocks the iOS UI on substrate speed.
  // `store()` is fast (embed + Qdrant upsert) and mints the memory_id; the
  // ~60s `extract()` graph agent runs OFF the request path via
  // `enqueueExtraction`. The node lands in /api/hero on the next fetch AFTER
  // extraction completes.
  //
  // store()+enqueue are wrapped in try/catch mirroring every other /api/*
  // handler (recent/holding/going/onboarding): on throw return a structured
  // 500 + correlation-context log so the failure is traceable to this ingest.
  // The idempotency row is already written (the INSERT-first path above won the
  // race), so a retried POST will still short-circuit — the 500 is recoverable
  // by the client retrying the SAME key.
  let memoryId: string;
  try {
    memoryId = await store(body.text, {
      source,
      contentType: parseContentType(body.contentType),
      // nmemo-3f9.2: optional stream scope for speaker identity. Absent ->
      // implicit single stream (back-compat). No participants array is accepted;
      // speakers are discovered from data, never declared.
      streamId: body.stream_id,
      // Honor the client capture time when supplied; store() falls back to server
      // time when undefined.
      timestamp: capturedAt,
      captureContext,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[ingest] store failed idempotencyKey=${idempotencyKey ?? '-'} source=${source ?? '-'}: ${msg}`,
    );
    return c.json({ error: msg }, 500);
  }

  // Backfill the real memory_id onto the idempotency row we inserted above
  // (it was born with a placeholder so the INSERT-first dedup could win the
  // race before store() minted the id). onConflictDoNothing keeps this a no-op
  // assert if a concurrent twin already wrote the real id.
  if (idempotencyKey) {
    try {
      await db
        .update(captureIdempotency)
        .set({ memoryId })
        .where(eq(captureIdempotency.idempotencyKey, idempotencyKey));
    } catch (err) {
      // Non-fatal: the capture is stored; only the ledger backfill failed. A
      // retry with the same key would now re-ingest (the row still holds the
      // placeholder '') — so log LOUDLY with key + memoryId so the chain is
      // traceable and an operator can repair the row.
      console.warn(
        `[ingest] idempotency ledger backfill failed for idempotency_key=${idempotencyKey} memoryId=${memoryId} (continuing):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Kick extraction off the request path (one-at-a-time background drain, same
  // no-concurrent-graph-agent discipline as the serial ingest queue). The
  // response returns 202 immediately; extract() runs in the background.
  enqueueExtraction(memoryId, parseContentType(body.contentType));

  // 202 Accepted: the memory is stored + idempotent; extraction is queued and
  // will surface in /api/hero shortly. {memory_id} is the decodable contract the
  // iOS CaptureUploader acknowledges on (any 2xx clears the queue entry).
  return c.json({ memory_id: memoryId }, 202);
});

app.post('/store', async (c) => {
  const body = await c.req.json<{ text: string; source?: string; contentType?: string }>();
  if (!body.text) return c.json({ error: 'text is required' }, 400);
  const memoryId = await store(body.text, {
    source: body.source,
    contentType: parseContentType(body.contentType),
  });
  return c.json({ memoryId });
});

app.post('/extract', async (c) => {
  const body = await c.req.json<{ memoryId: string; contentType?: string }>();
  if (!body.memoryId) return c.json({ error: 'memoryId is required' }, 400);
  const result = await extract(body.memoryId, { contentType: parseContentType(body.contentType) });
  return c.json(result);
});

app.post('/ingest/queue', async (c) => {
  const body = await c.req.json<{ text: string; source?: string; contentType?: string }>();
  if (!body.text) return c.json({ error: 'text is required' }, 400);
  const result = enqueueIngest(body.text, body.source, parseContentType(body.contentType));
  return c.json(result, 202);
});

app.get('/ingest/queue/status', (c) => {
  // Snapshot of the in-memory ingest queue. Doc 28 §3.4: the LLM-pipeline
  // generator polls this to know when a queued chunk has finished ingesting.
  return c.json(getIngestQueueStatus());
});

// Batch ingestion (doc 38) — one batched source, chunks tagged with source_id +
// chunk_index. `mode` selects the pipeline arm under comparison: serial (the
// baseline control), epoch (Approach A), optimistic (Approach B). epoch and
// optimistic return 501 until their orchestrators land (Stage 3/4).
async function handleBatch(c: Context, mode: IngestMode) {
  const body = await c.req.json<{ chunks?: string[]; source?: string; contentType?: string; concurrency?: number; stream_id?: string }>();
  if (!Array.isArray(body.chunks) || body.chunks.length === 0) {
    return c.json({ error: 'chunks (non-empty array) is required' }, 400);
  }
  // Per-run concurrency override for the parallel arms (epoch/optimistic); only a
  // positive integer is honoured, else the arm falls back to its env default.
  const concurrency =
    typeof body.concurrency === 'number' && Number.isInteger(body.concurrency) && body.concurrency > 0
      ? body.concurrency
      : undefined;
  try {
    const result = await ingestBatch(body.chunks, {
      source: body.source,
      contentType: parseContentType(body.contentType),
      mode,
      concurrency,
      // nmemo-3f9.2: thread the batch-level stream scope so every chunk's
      // store()/extract()/propose() resolves the same per-stream USER/ASSISTANT
      // speakers across all three arms (one batch = one stream).
      streamId: body.stream_id,
    });
    return c.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/not implemented/i.test(msg)) return c.json({ error: msg }, 501);
    throw err;
  }
}

app.post('/ingest/batch/serial', (c) => handleBatch(c, 'serial'));
app.post('/ingest/batch/epoch', (c) => handleBatch(c, 'epoch'));
app.post('/ingest/batch/optimistic', (c) => handleBatch(c, 'optimistic'));

// ============================================
// Viz routes
// ============================================

// Read viz/index.html per request so edits land live without restarting the
// dev server (matches the /viz/js/* per-request readFileSync pattern).
app.get('/viz', (c) => c.html(readFileSync(vizHtmlPath, 'utf-8')));

// Serve static JS files for the viz. Supports nested module paths
// (canvas/, layers/, panels/, agents/, overlays/) introduced by the viz.1
// ES-module split. Path-traversal protection: resolve against the viz/js
// root and reject anything that escapes it.
const vizJsRoot = resolve(__dirname, '../viz/js') + sep;
app.get('/viz/js/*', async (c) => {
  const path = c.req.path;
  const sub = path.startsWith('/viz/js/') ? path.slice('/viz/js/'.length) : '';
  if (!sub || !sub.endsWith('.js')) return c.text('Not found', 404);
  const target = resolve(vizJsRoot, sub);
  if (!target.startsWith(vizJsRoot)) return c.text('Forbidden', 403);
  try {
    const content = readFileSync(target, 'utf-8');
    return c.text(content, 200, { 'Content-Type': 'application/javascript' });
  } catch {
    return c.text('Not found', 404);
  }
});

app.get('/api/viz/unified', async (c) => {
  // Fetch all data in parallel
  const [ents, fcts, memLinks, events, edges_raw, metaRows, candidates, sameAsRows] = await Promise.all([
    db.select({
      id: entities.id,
      canonicalName: entities.canonicalName,
      entityType: entities.entityType,
      confidence: entities.confidence,
    }).from(entities).limit(200),
    db.select({
      id: facts.id,
      subjectEntityId: facts.subjectEntityId,
      predicate: facts.predicate,
      objectEntityId: facts.objectEntityId,
      objectValue: facts.objectValue,
      confidence: facts.confidence,
      sourceText: facts.sourceText,
      sourceMemoryId: facts.sourceMemoryId,
      createdAt: facts.createdAt,
    }).from(facts).where(isNull(facts.expiredAt)).limit(500),
    db.select({
      entityId: memoryEntities.entityId,
      memoryId: memoryEntities.memoryId,
      mentionText: memoryEntities.mentionText,
      mentionContext: memoryEntities.mentionContext,
    }).from(memoryEntities).limit(2000),
    db.select({
      id: causalEvents.id,
      transitionType: causalEvents.transitionType,
      subjectEntityId: causalEvents.subjectEntityId,
      predicate: causalEvents.predicate,
      occurredAt: causalEvents.occurredAt,
      sourceText: causalEvents.sourceText,
      sourceMemoryId: causalEvents.sourceMemoryId,
      factId: causalEvents.factId,
      deltaConfidence: causalEvents.deltaConfidence,
    }).from(causalEvents).limit(500),
    db.select({
      id: causalEdges.id,
      causeEventId: causalEdges.causeEventId,
      effectEventId: causalEdges.effectEventId,
      strength: causalEdges.strength,
      reasoning: causalEdges.reasoning,
      sourceReferences: causalEdges.sourceReferences,
      createdAt: causalEdges.createdAt,
      // Phase 2 corroboration (bead nmemo-e2i.9) — viz maps these to edge
      // stroke-width + tooltip; same fields already surfaced via MCP in .5.
      corroborationCount: causalEdges.corroborationCount,
      lastCorroborated: causalEdges.lastCorroborated,
      initialStrength: causalEdges.initialStrength,
      decayApplied: causalEdges.decayApplied,
    }).from(causalEdges).where(isNull(causalEdges.expiredAt)).limit(500),
    db.select({
      entityId: entityMeta.entityId,
      mentionCount: entityMeta.mentionCount,
      sourceMemoryCount: entityMeta.sourceMemoryCount,
      factCount: entityMeta.factCount,
      spread: entityMeta.spread,
      summary: entityMeta.summary,
      // nmemo-2yv.52 — freshness signal for the viz detail panel's
      // "Updated N hours/days ago" indicator. See doc 37 §8 for why this
      // is separate from entity_meta.updated_at.
      summaryUpdatedAt: entityMeta.summaryUpdatedAt,
    }).from(entityMeta),
    // Viz wants every candidate (resolved + unresolved) so the merge edges
    // remain visible after resolution. Large explicit limit replaces the
    // legacy unbounded query (bead nmemo-2yv.45).
    getMergeCandidates({ includeResolved: true, limit: 10000 }),
    db.select({
      id: sameAsLinks.id,
      entityAId: sameAsLinks.entityAId,
      entityBId: sameAsLinks.entityBId,
      reasoning: sameAsLinks.reasoning,
      confidence: sameAsLinks.confidence,
      createdAt: sameAsLinks.createdAt,
    }).from(sameAsLinks),
  ]);

  // Build meta lookup
  const metaMap: Record<string, { mentionCount: number; sourceMemoryCount: number; factCount: number; spread: number | null; summary: string | null; summaryUpdatedAt: Date | null }> = {};
  for (const m of metaRows) metaMap[m.entityId] = m;

  // Build source material map
  const sourcesMap: Record<string, Array<{ memoryId: string; mentionText: string | null; context: string | null }>> = {};
  const memoryToEntities: Record<string, string[]> = {};
  for (const m of memLinks) {
    if (!sourcesMap[m.entityId]) sourcesMap[m.entityId] = [];
    sourcesMap[m.entityId]!.push({ memoryId: m.memoryId, mentionText: m.mentionText, context: m.mentionContext });
    if (!memoryToEntities[m.memoryId]) memoryToEntities[m.memoryId] = [];
    memoryToEntities[m.memoryId]!.push(m.entityId);
  }

  // Build unique source memory set
  const allMemoryIds = [...new Set(memLinks.map(m => m.memoryId))];

  // --- NODES ---
  const nodes: Record<string, unknown>[] = [];

  // Entity nodes
  const entityIds = new Set(ents.map(e => e.id));
  for (const e of ents) {
    const meta = metaMap[e.id];
    nodes.push({
      id: e.id,
      _nodeType: 'entity',
      label: e.canonicalName,
      entityType: e.entityType,
      confidence: e.confidence,
      mentionCount: meta?.mentionCount ?? 0,
      sourceMemoryCount: meta?.sourceMemoryCount ?? 0,
      factCount: meta?.factCount ?? 0,
      spread: meta?.spread ?? null,
      summary: meta?.summary ?? null,
      summaryUpdatedAt: meta?.summaryUpdatedAt ?? null,
      sources: sourcesMap[e.id] ?? [],
    });
  }

  // Causal event nodes — enrich with fact object for readable labels
  const entityNameMap: Record<string, string> = {};
  for (const e of ents) entityNameMap[e.id] = e.canonicalName;

  // Build fact lookup for resolving causal event labels
  const factMap: Record<string, { predicate: string; objectEntityId: string | null; objectValue: string | null; subjectEntityId: string }> = {};
  for (const f of fcts) factMap[f.id] = f;

  for (const ev of events) {
    const subjectName = ev.subjectEntityId ? entityNameMap[ev.subjectEntityId] ?? null : null;
    // Build a readable label: "Walton visited Archangel" instead of "created: visited"
    let label = `${ev.transitionType}: ${ev.predicate || '?'}`;
    const fact = ev.factId ? factMap[ev.factId] : null;
    if (fact && subjectName) {
      const objectName = fact.objectEntityId ? (entityNameMap[fact.objectEntityId] ?? null) : fact.objectValue;
      label = objectName
        ? `${subjectName} ${ev.predicate} ${objectName}`
        : `${subjectName} ${ev.predicate || '?'}`;
    }

    nodes.push({
      id: ev.id,
      _nodeType: 'causalEvent',
      label,
      transitionType: ev.transitionType,
      predicate: ev.predicate,
      occurredAt: ev.occurredAt,
      entityId: ev.subjectEntityId,
      entityName: subjectName,
      sourceText: ev.sourceText,
      sourceMemoryId: ev.sourceMemoryId,
      factId: ev.factId,
      deltaConfidence: ev.deltaConfidence,
    });
  }

  // Source memory nodes — label with linked entity names for readability
  for (const memId of allMemoryIds) {
    const linkedEntityIds = memoryToEntities[memId] ?? [];
    const entityNames = [...new Set(linkedEntityIds.map(eid => entityNameMap[eid]).filter(Boolean))];
    const label = entityNames.length > 0
      ? entityNames.slice(0, 3).join(', ') + (entityNames.length > 3 ? '...' : '')
      : `Source ${memId.slice(0, 8)}`;
    // Get a content preview from the first mention context
    const firstMention = memLinks.find(m => m.memoryId === memId && m.mentionContext);
    const preview = firstMention?.mentionContext?.slice(0, 150) ?? null;
    nodes.push({
      id: memId,
      _nodeType: 'sourceMemory',
      label,
      linkedEntityCount: linkedEntityIds.length,
      preview,
    });
  }

  // Value nodes for scalar facts
  let valueIdx = 0;
  const valueNodes: Record<string, string> = {};

  // --- EDGES ---
  const edges: Record<string, unknown>[] = [];

  // Fact edges
  for (const f of fcts) {
    if (f.objectEntityId && entityIds.has(f.subjectEntityId) && entityIds.has(f.objectEntityId)) {
      edges.push({
        id: f.id,
        _edgeType: 'fact',
        source: f.subjectEntityId,
        target: f.objectEntityId,
        predicate: f.predicate,
        confidence: f.confidence,
        sourceText: f.sourceText,
        sourceMemoryId: f.sourceMemoryId,
        createdAt: f.createdAt,
      });
    } else if (!f.objectEntityId && f.objectValue && entityIds.has(f.subjectEntityId)) {
      const vid = `_val_${valueIdx++}`;
      valueNodes[vid] = f.objectValue;
      const label = f.objectValue.length > 30 ? f.objectValue.slice(0, 30) + '...' : f.objectValue;
      nodes.push({ id: vid, _nodeType: 'value', label });
      edges.push({
        id: f.id,
        _edgeType: 'fact',
        source: f.subjectEntityId,
        target: vid,
        predicate: f.predicate,
        confidence: f.confidence,
        sourceText: f.sourceText,
        sourceMemoryId: f.sourceMemoryId,
        createdAt: f.createdAt,
        objectValue: f.objectValue,
      });
    }
  }

  // Causal anchor edges (entity → event)
  const eventIds = new Set(events.map(e => e.id));
  for (const ev of events) {
    if (ev.subjectEntityId && entityIds.has(ev.subjectEntityId)) {
      edges.push({
        id: `_anchor_${ev.id}`,
        _edgeType: 'causalAnchor',
        source: ev.subjectEntityId,
        target: ev.id,
      });
    }
  }

  // Causal edges (event → event)
  for (const ce of edges_raw) {
    if (eventIds.has(ce.causeEventId) && eventIds.has(ce.effectEventId)) {
      edges.push({
        id: ce.id,
        _edgeType: 'causal',
        source: ce.causeEventId,
        target: ce.effectEventId,
        strength: ce.strength,
        reasoning: ce.reasoning,
        sourceReferences: ce.sourceReferences,
        createdAt: ce.createdAt,
        // Phase 2 corroboration (bead nmemo-e2i.9). Width scales with
        // corroborationCount in the canvas renderer; tooltip surfaces both
        // count + last_corroborated.
        corroborationCount: ce.corroborationCount,
        lastCorroborated: ce.lastCorroborated,
        initialStrength: ce.initialStrength,
        decayApplied: ce.decayApplied,
      });
    }
  }

  // Source memory edges (memory → entity)
  // Guard: drop links to entities that no longer exist (orphaned by reconcile/merge).
  for (const memId of allMemoryIds) {
    const linkedEntities = memoryToEntities[memId] ?? [];
    for (const entityId of [...new Set(linkedEntities)]) {
      if (!entityIds.has(entityId)) continue;
      edges.push({
        id: `_src_${memId}_${entityId}`,
        _edgeType: 'sourceLink',
        source: memId,
        target: entityId,
      });
    }
  }

  // Merge candidate edges
  for (const mc of candidates) {
    if (entityIds.has(mc.entityA.id) && entityIds.has(mc.entityB.id)) {
      edges.push({
        id: mc.id,
        _edgeType: 'mergeCandidate',
        source: mc.entityA.id,
        target: mc.entityB.id,
        centroidSimilarity: mc.centroidSimilarity,
        memoryOverlap: mc.memoryOverlap,
        structuralSimilarity: mc.structuralSimilarity,
        combinedScore: mc.combinedScore,
        status: mc.status,
        // mig 017 — viz.4 differentiates cross-cluster vs three-signal merges
        candidateSource: mc.candidateSource,
      });
    }
  }

  // Same-as identity links
  for (const sal of sameAsRows) {
    if (entityIds.has(sal.entityAId) && entityIds.has(sal.entityBId)) {
      edges.push({
        id: sal.id,
        _edgeType: 'sameAs',
        source: sal.entityAId,
        target: sal.entityBId,
        reasoning: sal.reasoning,
        confidence: sal.confidence,
        createdAt: sal.createdAt,
      });
    }
  }

  return c.json({ nodes, edges });
});

// Content-addressed canonical graph (doc 38) — the parallel-ingestion harness
// fetches this after each run to diff structure (determinism/litmus) + counts.
// UUID/timestamp-free, so two runs of the same corpus are comparable.
app.get('/api/graph/canonical', async (c) => {
  return c.json(await exportCanonicalGraph());
});

// Rich graph dump (doc 39 §3.1) — the validity & quality harness fetches this:
// expired facts (supersession audit), causal edge reasoning + source_references,
// contradictions, same_as, and the agents' reports. A superset of
// /api/graph/canonical, which intentionally strips those for byte-comparability.
app.get('/api/graph/full', async (c) => {
  return c.json(await exportRichGraph());
});

app.get('/api/viz/merge-candidates', async (c) => {
  // Viz surface — return every candidate (resolved + unresolved) under a
  // large explicit cap (bead nmemo-2yv.45).
  const candidates = await getMergeCandidates({ includeResolved: true, limit: 10000 });
  return c.json(candidates);
});

app.get('/api/orphan-entities', async (c) => {
  // Aged orphan detection surface (bead nmemo-yh2). Entities with mentions but
  // zero facts, older than ORPHAN_AGE_THRESHOLD_MIN (config default 60min).
  // Query params:
  //   thresholdMin — override the config default (integer, minutes)
  //   limit        — page size cap (default 200)
  const url = new URL(c.req.url);
  const thresholdRaw = url.searchParams.get('thresholdMin');
  const limitRaw = url.searchParams.get('limit');
  const thresholdMin = thresholdRaw != null && thresholdRaw !== ''
    ? parseInt(thresholdRaw, 10)
    : config.ORPHAN_AGE_THRESHOLD_MIN;
  const limit = limitRaw != null && limitRaw !== '' ? parseInt(limitRaw, 10) : undefined;

  if (Number.isNaN(thresholdMin) || thresholdMin < 0) {
    return c.json({ error: 'thresholdMin must be a non-negative integer' }, 400);
  }
  if (limit !== undefined && (Number.isNaN(limit) || limit <= 0)) {
    return c.json({ error: 'limit must be a positive integer' }, 400);
  }

  const orphans = await detectAgedOrphans({ thresholdMin, limit });
  return c.json({
    thresholdMin,
    count: orphans.length,
    orphans,
  });
});

app.post('/api/reconcile', async (c) => {
  // Manually trigger the reconciliation agent to resolve identity questions.
  // Audit attribution (nmemo-2yv.35 sweep): invokeReconciliationAgent →
  // getMcpConfigPath('reconciliation_agent') sets MNEMO_AGENT_ACTOR; every
  // MCP tool write inherits actor='reconciliation_agent' via context.agent.
  const body: { include_reports?: boolean; max_reports?: number } =
    await c.req.json<{ include_reports?: boolean; max_reports?: number }>().catch(() => ({}));
  const includeReports = body.include_reports !== false; // default true
  const maxReports = body.max_reports ?? 10;

  // Check if there is anything to reconcile
  const [candidateRows, unconfirmedRows] = await Promise.all([
    db.select({ id: mergeCandidates.id }).from(mergeCandidates)
      .where(eq(mergeCandidates.status, 'candidate')).limit(1),
    db.select({ id: entityAliases.id }).from(entityAliases)
      .where(eq(entityAliases.aliasType, 'unconfirmed')).limit(1),
  ]);

  if (candidateRows.length === 0 && unconfirmedRows.length === 0) {
    return c.json({ triggered: false, candidateCount: 0, message: 'No unresolved candidates or unconfirmed aliases found.' });
  }

  // Fetch unresolved candidates (default filter — bead nmemo-2yv.45) and recent
  // extraction reports. The SQL filter is canonical; no in-memory dedup needed.
  const [unresolved, recentReports] = await Promise.all([
    getMergeCandidates(),
    includeReports
      ? db.select({ reportText: extractionReports.reportText })
          .from(extractionReports)
          .orderBy(sql`created_at DESC`)
          .limit(maxReports)
      : Promise.resolve([]),
  ]);

  // Invoke reconciliation agent with unresolved candidates
  const { invokeReconciliationAgent } = await import('./services/causal-agent.js');
  const result = await invokeReconciliationAgent({
    candidates: unresolved as Array<Record<string, unknown>>,
    recentReports: recentReports.map(r => r.reportText),
  });

  return c.json({
    triggered: true,
    candidateCount: unresolved.length,
    report: result.result,
  });
});

app.post('/api/reconcile/:id', async (c) => {
  // Per-pair reconcile (bead nmemo-2yv.47 — unified candidates panel fine-grained
  // action). Same agent path as the bulk /api/reconcile, but the agent is
  // invoked with exactly one candidate so its decision is scoped to that pair.
  // Audit attribution mirrors the bulk path (nmemo-2yv.35 sweep): the agent's
  // MCP context inherits actor='reconciliation_agent' via getMcpConfigPath.
  const candidateId = c.req.param('id');
  if (!candidateId) return c.json({ error: 'candidate id required' }, 400);

  // Fetch every unresolved candidate then pick the requested one — preserves
  // the SQL-filter contract from nmemo-2yv.45 (no in-memory dedup) and stays a
  // single function call. At default LIMIT=50 this is bounded; for very large
  // queues a future targeted SELECT could replace it.
  const unresolved = await getMergeCandidates({ includeResolved: true, limit: 10000 });
  const target = unresolved.find((row) => row.id === candidateId);
  if (!target) {
    return c.json({ error: `merge candidate ${candidateId} not found` }, 404);
  }
  if (target.status === 'resolved') {
    return c.json({ triggered: false, message: 'candidate already resolved' });
  }

  const { invokeReconciliationAgent } = await import('./services/causal-agent.js');
  const result = await invokeReconciliationAgent({
    candidates: [target] as Array<Record<string, unknown>>,
    recentReports: [],
  });

  return c.json({
    triggered: true,
    candidateId,
    report: result.result,
  });
});

app.post('/api/garden', async (c) => {
  // Manually trigger the graph gardener to explore and maintain the knowledge graph.
  // Audit attribution (nmemo-2yv.35 sweep): invokeGardenerAgent →
  // getMcpConfigPath('gardener_agent') sets MNEMO_AGENT_ACTOR; every MCP
  // tool write inherits actor='gardener_agent' via context.agent.
  const tStart = Date.now();
  console.log('[garden] manual trigger received');

  const { invokeGardenerAgent } = await import('./services/causal-agent.js');
  const { recordGardeningRun } = await import('./services/gardening.js');
  try {
    console.log('[garden] invoking gardener agent...');
    const result = await invokeGardenerAgent({ trigger: 'manual' });
    const durationMs = Date.now() - tStart;
    console.log(`[garden] complete in ${durationMs}ms`);
    console.log('[garden] --- REPORT ---');
    console.log(result.result || '(no report)');
    console.log('[garden] --- END REPORT ---');

    // Persist via the shared audit-log helper (bead nmemo-2yv.67). The
    // helper is fire-and-forget here — a failed audit write logs a warning
    // but does NOT change the HTTP response. The auto-trigger path in
    // pipeline.ts calls the same helper, so both surfaces are captured.
    recordGardeningRun({
      trigger: 'manual',
      report: result.result || '(no report)',
      durationMs,
    }).catch(err => {
      console.warn('[garden] failed to store report:', err instanceof Error ? err.message : err);
    });

    return c.json({
      triggered: true,
      report: result.result,
      durationMs,
    });
  } catch (err) {
    return c.json({
      triggered: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - tStart,
    }, 500);
  }
});

app.post('/api/decay', async (c) => {
  // Manually trigger confidence decay over the causal-edge graph.
  // Returns the same DecayResult shape produced by applyConfidenceDecay so
  // the reasoning agent / viz can present decayed and expired counts directly.
  const tStart = Date.now();
  console.log('[decay] manual trigger received');

  const { applyConfidenceDecay } = await import('./services/causal.js');
  try {
    // nmemo-2yv.33 — manual REST trigger writes actor='user' so audit rows
    // are distinguishable from pipeline.ts auto-trigger ('system_trigger').
    const result = await applyConfidenceDecay({ actor: 'user' });
    const durationMs = Date.now() - tStart;
    console.log(
      `[decay] manual complete decayed=${result.decayed} expired=${result.expired} durationMs=${durationMs}`,
    );
    return c.json({
      triggered: true,
      decayed: result.decayed,
      expired: result.expired,
      decayedEdgeIds: result.decayedEdgeIds,
      expiredEdgeIds: result.expiredEdgeIds,
      durationMs,
    });
  } catch (err) {
    return c.json(
      {
        triggered: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - tStart,
      },
      500,
    );
  }
});

app.get('/api/impact/:type/:id', async (c) => {
  // Phase 4 — Blast Radius Analysis. Returns the full impact tree for a fact,
  // entity, or causal_event with severity-scored dependents.
  // Query params: ?depth=N (default 3), ?hypothetical=expire|invalidate|weaken
  // (default none — re-scores severity without mutating state).
  const nodeType = c.req.param('type');
  const nodeId = c.req.param('id');

  if (nodeType !== 'fact' && nodeType !== 'entity' && nodeType !== 'causal_event') {
    return c.json(
      { error: `Invalid node_type "${nodeType}" — expected fact|entity|causal_event` },
      400,
    );
  }

  const depthParam = c.req.query('depth');
  const maxDepth = depthParam ? parseInt(depthParam, 10) : undefined;
  if (maxDepth !== undefined && (!Number.isFinite(maxDepth) || maxDepth < 1 || maxDepth > 10)) {
    return c.json({ error: `Invalid depth "${depthParam}" — expected integer in [1, 10]` }, 400);
  }

  const hypothetical = c.req.query('hypothetical');
  if (hypothetical !== undefined && hypothetical !== 'expire') {
    return c.json(
      { error: `Invalid hypothetical "${hypothetical}" — expected expire` },
      400,
    );
  }

  const includePatternsParam = c.req.query('include_patterns');
  const includePatterns = includePatternsParam !== 'false';

  const { analyzeImpact } = await import('./services/impact.js');
  try {
    const report = await analyzeImpact({
      nodeType,
      nodeId,
      maxDepth,
      hypothetical: hypothetical as 'expire' | undefined,
      includePatterns,
      actor: 'http',
    });
    return c.json(report);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not found/i.test(message)) {
      return c.json({ error: message }, 404);
    }
    return c.json({ error: message }, 500);
  }
});

app.get('/api/contradictions', async (c) => {
  // List contradictions for the viz panel. Defaults to unresolved-only, but
  // ?unresolved=false returns the full set including resolved rows.
  const unresolved = c.req.query('unresolved') !== 'false';
  const limit = parseInt(c.req.query('limit') ?? '50', 10);
  const type = c.req.query('type');
  const severity = c.req.query('severity');

  const { getContradictions } = await import('./services/contradictions.js');
  const rows = await getContradictions({
    unresolvedOnly: unresolved,
    limit: Number.isFinite(limit) ? limit : 50,
    contradictionType: type as 'opposing_object' | 'expired_but_cited' | 'cyclic_causal' | 'temporal_impossible' | 'chain_conflict' | undefined,
    severity: severity as 'critical' | 'high' | 'medium' | 'low' | undefined,
  });
  return c.json({ contradictions: rows });
});

app.post('/api/contradictions/detect', async (c) => {
  // Manual trigger for the SQL detection sweep. Same shape as the per-pipeline
  // auto-trigger in `pipeline.ts` so the viz / reasoning agent can drive it
  // explicitly without reaching into the pipeline counter.
  // Audit attribution (nmemo-2yv.35 sweep): detectContradictions writes only
  // to public.contradictions (uses its own detector_agent column, not the
  // fact/edge audit tables). No actor required at this layer.
  const tStart = Date.now();
  console.log('[contradictions] manual detect trigger received');

  const { detectContradictions } = await import('./services/contradictions.js');
  try {
    // Per-heuristic isolation inside detectContradictions (nmemo-2yv.41)
    // means partial failure is surfaced via the result.errors field rather
    // than a thrown exception. We return HTTP 200 with errors populated so
    // the caller sees the surviving heuristics' counts; the outer try/catch
    // remains for unexpected non-heuristic faults (DB connection lost
    // mid-orchestrator, etc.) which still return 500.
    const result = await detectContradictions();
    const durationMs = Date.now() - tStart;
    const errorsPart = result.errors
      ? ` errors=${JSON.stringify(result.errors)}`
      : '';
    console.log(
      `[contradictions] detect complete detected=${result.detected} byType=${JSON.stringify(result.byType)}${errorsPart} durationMs=${durationMs}`,
    );
    return c.json({
      triggered: true,
      detected: result.detected,
      byType: result.byType,
      ...(result.errors ? { errors: result.errors } : {}),
      durationMs,
    });
  } catch (err) {
    return c.json(
      {
        triggered: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - tStart,
      },
      500,
    );
  }
});

app.post('/api/contradictions/:id/resolve', async (c) => {
  const id = c.req.param('id');
  const body: {
    resolution_type?: string;
    resolution_reasoning?: string;
    dismissed_reason?: string;
  } = await c.req.json().catch(() => ({}));

  if (!body.resolution_type || !body.resolution_reasoning) {
    return c.json(
      { resolved: false, error: 'resolution_type and resolution_reasoning are required' },
      400,
    );
  }

  const { resolveContradiction } = await import('./services/contradictions.js');
  try {
    // Audit attribution (nmemo-2yv.35 sweep): actor='user' threads through
    // resolveContradiction → expireFact/invalidateFact/expireCausalEdge,
    // landing on fact_history / causal_edge_history rows for every mutation
    // in the resolution path.
    await resolveContradiction({
      contradictionId: id,
      resolutionType: body.resolution_type as
        | 'expire_a' | 'expire_b' | 'expire_both'
        | 'invalidate_a' | 'invalidate_b'
        | 'expire_edge_a' | 'expire_edge_b' | 'expire_both_edges'
        | 'reconcile' | 'both_valid' | 'dismissed',
      resolutionReasoning: body.resolution_reasoning,
      actor: 'user',
      dismissedReason: body.dismissed_reason,
    });
    return c.json({ resolved: true });
  } catch (err) {
    return c.json(
      { resolved: false, error: err instanceof Error ? err.message : String(err) },
      400,
    );
  }
});

// ============================================
// Phase 6 — Pattern Lifecycle endpoints (nmemo-d9v.14)
// ============================================

app.post('/api/patterns/detect', async (c) => {
  // Audit attribution (nmemo-2yv.35 sweep): detectCausalPatterns writes only
  // to causal_patterns + causal_edges.pattern_id; no fact/edge audit rows.
  const body = await c.req.json().catch(() => ({}));
  const { detectCausalPatterns } = await import('./services/causal-patterns.js');
  try {
    const opts: Record<string, number> = {};
    if (typeof body.min_chain_length === 'number') opts.minChainLength = body.min_chain_length;
    if (typeof body.max_chain_length === 'number') opts.maxChainLength = body.max_chain_length;
    if (typeof body.lookback_days === 'number') opts.lookbackDays = body.lookback_days;
    if (typeof body.instance_threshold === 'number') opts.instanceThreshold = body.instance_threshold;
    if (typeof body.max_chains === 'number') opts.maxChains = body.max_chains;

    const result = await detectCausalPatterns(opts);
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.post('/api/patterns/promote', async (c) => {
  // Audit attribution (nmemo-2yv.35 sweep): promotePatterns mutates only
  // causal_patterns status columns; no fact/edge audit rows.
  const { promotePatterns } = await import('./services/causal-patterns.js');
  try {
    const result = await promotePatterns();
    return c.json(result);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.get('/api/patterns', async (c) => {
  const statusParam = c.req.query('status');
  const limitParam = c.req.query('limit');
  const entityIdParam = c.req.query('entity_id');
  const { activePatterns } = await import('./services/causal-patterns.js');
  try {
    const result = await activePatterns({
      status: statusParam ? (statusParam.split(',') as Array<'staging' | 'candidate' | 'provisional' | 'canonical' | 'rejected'>) : undefined,
      limit: limitParam ? Number.parseInt(limitParam, 10) : undefined,
      entityId: entityIdParam ?? undefined,
    });
    return c.json({ patterns: result });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.get('/api/patterns/:id/instances', async (c) => {
  const id = c.req.param('id');
  const limitParam = c.req.query('limit');
  const limit = limitParam ? Number.parseInt(limitParam, 10) : 10;
  try {
    const rows = await db.execute(sql`
      SELECT id, cause_event_id, effect_event_id, strength, reasoning,
             pattern_position, created_at
      FROM public.causal_edges
      WHERE pattern_id = ${id}::uuid
        AND expired_at IS NULL
      ORDER BY pattern_position, created_at
      LIMIT ${limit}::int
    `);
    return c.json({ instances: rows });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ============================================
// Audit history (mig 009 — viz.6)
// ============================================
// Surfaces fact_history / causal_edge_history rows for a given subject id,
// ordered newest-first. Powers the History tab in the viz detail panel.

app.get('/api/facts/:id/history', async (c) => {
  const id = c.req.param('id');
  const limitParam = c.req.query('limit');
  const limit = limitParam ? Number(limitParam) : 100;
  try {
    // FactHistoryRow has Date fields; Hono's c.json runs JSON.stringify
    // which serialises Date to ISO string at the JSON boundary.
    const rows = await getFactHistory(id, limit);
    return c.json({ history: rows });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.get('/api/causal-edges/:id/history', async (c) => {
  const id = c.req.param('id');
  const limitParam = c.req.query('limit');
  const limit = limitParam ? Number(limitParam) : 100;
  try {
    const rows = await getEdgeHistory(id, limit);
    return c.json({ history: rows });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.get('/api/ghosts/:entityId', async (c) => {
  const entityId = c.req.param('entityId');
  const { findCausalGhosts } = await import('./services/causal-patterns.js');
  try {
    const ghosts = await findCausalGhosts(entityId);
    return c.json({ ghosts });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// nmemo-2yv.51 — canonical read endpoint for entity profiles. Assembles entity
// + facts + connected entities + recent memories + agent-authored summary via
// entity-profile.ts. Becomes the shared shape for MCP tools, the Telegram bot
// (when it returns to HEAD), and future panels. Returns 404 on missing entity;
// 500 on assembly error.
app.get('/api/entity/:id/profile', async (c) => {
  const entityId = c.req.param('id');
  const { getEntityProfile } = await import('./services/entity-profile.js');
  try {
    const profile = await getEntityProfile(entityId);
    if (!profile) {
      return c.json({ error: `Entity ${entityId} not found` }, 404);
    }
    return c.json(profile);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ============================================
// iOS API v1 — home surfaces (ASK-017 hero, ASK-018 notifications)
// ============================================

// GET /api/hero?nodeId=<entityId> — home hero composition (ASK-017). nodeId is
// OPTIONAL (passed through to the handler); absent => the user's self entity
// (ASK-006). Sparse-data / fresh DB => { active: null } (200) so iOS renders the
// pre-data stub. An EXPLICIT nodeId that does not resolve => 404 (iOS "still
// listening" fallback). Any other failure => 500 (same fallback). The route file
// (routes/hero.ts) owns the wire normalization (toHeroResponse) and status map.
app.get('/api/hero', heroRoute);

// GET /api/notifications — active, already-composed notification cards (ASK-018).
// Backend owns composition/persistence/age-out; iOS owns selection/sort/4-card
// cap. Optional ?limit caps the rows read (default 20). The route file
// (routes/notifications.ts) owns compose+persist and the encode-boundary
// discipline (kind == target.type, no blank fields, unique notificationId).
app.get('/api/notifications', notificationsHandler);

// GET /api/recent?limit=N — recent memories timeline (ASK-002). nodeId-free
// recency index read. Sparse/fresh-DB => { entries: [] } (200). The route file
// (routes/recent.ts) owns the wire normalization; the service (services/recent.ts)
// does the Qdrant content fetch + italic entity join + fail-loud row dropping.
app.get('/api/recent', recentHandler);

// GET /api/holding?limit=N — held/ripening/open items (ASK-HOLDING). GET-only;
// nudge/let-go POSTs stay 501 until the promises epic (ASK-016) lands. Sparse /
// fresh-DB / no self entity / unseeded promise predicates => { items: [] } (200).
app.get('/api/holding', holdingHandler);

// GET /api/going-toward — directional commitments throughline (going-toward
// surface). No params. Sparse / not-yet-computed graph => { directions: [] }
// (200). The route file (routes/going.ts) owns the fail-loud wire normalization
// (status closed enum, confirmedSince ISO-8601 rule, italicEntity substring).
app.get('/api/going-toward', goingHandler);

// /api/onboarding/* — the onboarding prompt arc (ASK-010 / EPIC 2). iOS reads
// the current stage + prompt via GET current-prompt and drives the Stage 4
// "is that right?" moment via the three focus mutations. The response to GET
// is a BARE OnboardingState object (no envelope — the iOS APIClient decodes
// Response = OnboardingState directly). The mutation POSTs return 2xx empty on
// success (EmptyResponse). Stage advancement is substrate-driven: the post-
// extract hook (pipeline.drainExtraction) runs evaluateStage after each
// ingest, so /advance is implicit via /ingest (not built). inferred-focus is
// folded into the awaiting_confirmation GET payload (not a separate route).
// The route file (routes/onboarding.ts) owns the fail-loud wire normalization;
// the service (services/onboarding.ts) owns the stage machine + prompts.
app.get('/api/onboarding/current-prompt', onboardingCurrentHandler);
app.post('/api/onboarding/confirm-focus', confirmFocusHandler);
app.post('/api/onboarding/untangle-focus', untangleFocusHandler);
app.post('/api/onboarding/rename-focus', renameFocusHandler);

// POST /api/ask — ask composition (ASK-015). Body { query, voiceInput }. Runs
// hybrid search and composes a Voice-C answer ON DEMAND (one of the only
// on-demand compositions in the product — ask.md §"Result is not
// pregenerated"). Empty search => { answer: null } (200, NO LLM call — the
// empty short-circuit). The route file (routes/ask.ts) owns ONLY the wire
// concerns; the service (services/ask.ts) does search + compose + entity join
// + isHardTopic/isAmbiguous derivation + fail-loud span shaping.
app.post('/api/ask', askHandler);

// GET /api/promises/open — active promises overview (ASK-016 slice 2). Returns
// only {open, held, ripening, nudged} (done/let-go excluded), valid_at ASC
// NULLS LAST, optional ?limit=N for widget sizes. Sparse / fresh DB / no self
// entity / unseeded commitment predicates => { promises: [] } (200, BARE array
// never null). The route file (routes/promises.ts) owns ONLY wire concerns;
// the service (services/promises.ts) does the backend-authoritative 6-state
// derivation + Qdrant source-quote lift + fail-loud row dropping.
//
// ROUTE ORDER: /api/promises/open MUST be registered before /api/promises/:fact_id
// or Hono's pattern matcher routes the literal "open" into the param handler.
app.get('/api/promises/open', openPromisesHandler);
// GET /api/promises/:fact_id — one Promise by fact id (ASK-016 slice 2).
// Returns a BARE Promise object (no wrapper — iOS decodes Response = Promise).
// 404 when the fact is missing, not a commitment predicate, or invalidated/
// expired. 500 on any other failure.
app.get('/api/promises/:fact_id', promiseDetailHandler);
// POST /api/promises/:fact_id/* — the 5 promise mutations (ASK-016 slice 3).
// nudge returns the reshaped bare Promise (200); done/let-go/recategorize/
// dismiss-completion-suggestion return 204 empty (iOS EmptyResponse). The
// route file (routes/promises.ts) owns the 404 (not a commitment/missing) and
// 409 (nudge: no deadline to shift / nudge limit reached) maps; the service
// (services/promises.ts) owns the substrate writes. Paths match iOS verbatim.
app.post('/api/promises/:fact_id/nudge', nudgePromiseHandler);
app.post('/api/promises/:fact_id/done', markDoneHandler);
app.post('/api/promises/:fact_id/let-go', letGoHandler);
app.post('/api/promises/:fact_id/recategorize', recategorizeHandler);
app.post('/api/promises/:fact_id/dismiss-completion-suggestion', dismissSuggestionHandler);

// GET /api/rise/:annotationId — the risen plate (ASK-009 degraded v1). iOS
// passes a SOURCE MEMORY ID; the service composes the iOS RiseData wire shape
// (a single leaf source + optional canonical-pattern match). An unknown / gone
// id is the "source has been let go" SUCCESS-shape (200 { sources: [],
// patternMatch: null, isHardTopic: false }) — NOT a 404 (iOS detects empty
// sources on the success path). 500 reserved for real failures. The route file
// (routes/rise.ts) owns ONLY wire concerns; the service (services/rise.ts) does
// the Qdrant content lift + edge-id / pattern-partner sourcing.
app.get('/api/rise/:annotationId', riseHandler);

// GET /api/bridge/current — the pregenerated bridge narrative (ASK-014 degraded
// v1). The service identifies the highest-betweenness bridge entity, names the
// communities running through it (cluster spokes), and composes a Voice-C
// narrative with in-bounds annotations. { bridgeNarrative: null } is the
// "no bridge yet" SUCCESS-shape (200, iOS unwraps to nil), NOT a 404.
//
// GET /api/explore/node/:entityId — one explore frame (node + 1-hop neighbors).
// 404 for a malformed / unknown id (iOS has no let-go shape for explore).
// secondDegree / secondDegreeStubs are [] in this v1. The route files
// (routes/bridge.ts) own ONLY wire concerns; services/bridge.ts does the
// topology / subgraph sourcing + Voice-C composition. The three handle
// endpoints (confirm/reject/rename) + bridgeShift are DEFERRED (iOS 501 stubs).
app.get('/api/bridge/current', bridgeCurrentHandler);
app.get('/api/explore/node/:entityId', exploreNodeHandler);

// /api/re-read/* — the pregenerated re-read letters (ASK-011 read-path v1). iOS
// reads what is already prepared and NEVER waits (letters are pregenerated). All
// three reads return an ENVELOPE ({letter}|{letters}); null/[] are 200
// success-shapes, NOT 404s (a missing letter routes iOS to explore + query, per
// re-read.md §"The 'no prepared letter' state"). 500 reserved for real failures.
//
// ROUTE ORDER: /current and /all MUST be registered BEFORE the bare /api/re-read/
// so Hono's matcher does not let the bare path shadow the more specific ones.
// The route files (routes/re-read.ts) own ONLY wire concerns; services/re-read.ts
// does the row → wire mapping + the compose/seed entry.
app.get('/api/re-read/current', reReadCurrentHandler);
app.get('/api/re-read/all', reReadAllHandler);
// GET /api/re-read/?threadEntityId=<uuid> — the current letter for one thread.
// Missing threadEntityId → 400 (the one hard reject).
app.get('/api/re-read/', reReadThreadHandler);

/** Tables cleared by /api/viz/clear and /api/reset, in FK-safe deletion order. */
const CLEARABLE_TABLES = [
  'reasoning_reports', 'gardening_reports', 'same_as_links', 'extraction_reports',
  'merge_candidates', 'entity_meta', 'memory_entities', 'entity_aliases',
  'contradictions',
  'fact_history', 'causal_edge_history',
  'causal_edges', 'causal_events', 'causal_patterns', 'facts',
  'entity_merges', 'entities',
] as const;

async function clearGraphTables(): Promise<void> {
  for (const table of CLEARABLE_TABLES) {
    await db.execute(sql.raw(`DELETE FROM ${table}`));
  }
}

app.post('/api/viz/clear', async (c) => {
  // Audit attribution (nmemo-2yv.35 sweep): DELETE-only across CLEARABLE_TABLES;
  // no INSERT into fact_history / causal_edge_history. The history tables are
  // themselves cleared (no orphan rows), so attribution does not apply.
  await clearGraphTables();
  return c.json({ cleared: true });
});

app.post('/api/reset', async (c) => {
  // Audit attribution (nmemo-2yv.35 sweep): DELETE-only across CLEARABLE_TABLES
  // + Qdrant collection clear. No fact/edge audit rows produced.
  await clearGraphTables();
  const { clearMemories } = await import('./services/qdrant.js');
  await clearMemories();
  return c.json({ cleared: true, pg: true, qdrant: true });
});

app.get('/api/viz/stats', async (c) => {
  const [e, f, ce, cx] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int` }).from(entities),
    db.select({ count: sql<number>`count(*)::int` }).from(facts).where(isNull(facts.expiredAt)),
    db.select({ count: sql<number>`count(*)::int` }).from(causalEvents),
    db.select({ count: sql<number>`count(*)::int` }).from(causalEdges).where(isNull(causalEdges.expiredAt)),
  ]);
  return c.json({
    entities: e[0]?.count ?? 0,
    facts: f[0]?.count ?? 0,
    causal_events: ce[0]?.count ?? 0,
    causal_edges: cx[0]?.count ?? 0,
  });
});

// ============================================
// Reasoning Agent
// ============================================

function logReasonRequest(c: { req: { header: (name: string) => string | undefined } }, mode: 'patrol' | 'query', question?: string): void {
  // F5: log every reasoning invocation so spurious callers are identifiable.
  const ua = c.req.header('user-agent') ?? 'unknown';
  const referer = c.req.header('referer') ?? c.req.header('origin') ?? '-';
  const fwd = c.req.header('x-forwarded-for') ?? '-';
  const snippet = question ? ` question="${question.slice(0, 80).replace(/\s+/g, ' ')}"` : '';
  console.log(`[reason] mode=${mode}${snippet} ua="${ua}" referer="${referer}" xff="${fwd}"`);
}

app.post('/api/reason', async (c) => {
  // Audit attribution (nmemo-2yv.35 sweep): invokeReasoningAgent →
  // getMcpConfigPath('reasoning_agent') sets MNEMO_AGENT_ACTOR; every MCP
  // tool write inherits actor='reasoning_agent' via context.agent.
  logReasonRequest(c, 'patrol');
  // Bead nmemo-2yv.77 — mint a single invocation_id per HTTP call. Threaded
  // through invokeReasoningAgent → ml-services POST body → agent system
  // prompt; the agent passes it back on save_reasoning_report so duplicate
  // calls within the same pass UPSERT instead of inserting orphaned rows.
  const invocationId = randomUUID();
  const { invokeReasoningAgent, AgentInvocationTimeoutError } = await import('./services/causal-agent.js');
  const start = Date.now();
  try {
    const result = await invokeReasoningAgent({ mode: 'patrol', invocationId });
    return c.json({ triggered: true, result: result.result, durationMs: Date.now() - start });
  } catch (err) {
    // Bead nmemo-2yv.76: distinguish client-side abort timeouts (504) from
    // upstream non-OK responses (500). A hung Claude Code subprocess inside
    // ml-services produces no HTTP response at all — without the 504, the viz
    // "Reason" button would spin and then report a generic 500 with no hint
    // that the timeout fired.
    if (err instanceof AgentInvocationTimeoutError) {
      return c.json({ triggered: false, error: err.message, durationMs: Date.now() - start }, 504);
    }
    return c.json({ triggered: false, error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - start }, 500);
  }
});

/**
 * Bead nmemo-0wq.3 — the /api/reason/query fallback boundary (doc 38 §6.2.1).
 *
 * Pre-flight flat retrieval on the question; if it fails the §6.1 confidence
 * bar, seed anchors (entities in the weak flat hits + a query-side entity
 * match, §4.1), expand the fact graph, and re-rank the fetched UNIT-grained
 * evidence against the query (§5). Returns the ranked units (capped) for the
 * agent's context, or undefined when flat retrieval SUCCEEDED (no trigger, no
 * extra work — the §6 no-regression constraint) or nothing anchored (§4.2).
 * Single fire per query (§6.3). Lazy imports keep the hot module graph lean.
 */
async function computeQueryFallbackEvidence(question: string): Promise<unknown[] | undefined> {
  const { searchMemoriesByUnit } = await import('./services/qdrant.js');
  const { flatRetrievalFailed, recallViaGraph } = await import('./services/graph-fallback.js');
  const { findSimilarEntities } = await import('./services/entities.js');

  const queryVector = (await ml.embedQuery(question)).vector;
  const flat = await searchMemoriesByUnit(queryVector, { limit: 5 });
  const flatHits = flat.map((m) => ({ id: m.id, score: m.score }));

  // §6.1 trigger: only proceed on flat-retrieval FAILURE. Success returns early
  // — no graph walk, no re-rank, no extra Qdrant reads.
  if (!flatRetrievalFailed(flatHits)) return undefined;

  // §4.1.2 query-side entity seed (entity-similarity over the query text).
  const seedEntities = await findSimilarEntities((await ml.embed(question)).vector, {
    threshold: 0.5,
    limit: 5,
  });
  const ranked = await recallViaGraph(queryVector, flatHits, {
    seedEntityIds: seedEntities.map((e) => e.id),
  });
  if (ranked.length === 0) {
    // §4.2 no-anchor / no-evidence: surface the original flat result unchanged.
    console.log('[reason/query] fallback_skipped_no_anchor');
    return undefined;
  }
  return ranked.map((r) => ({
    unitText: r.unitText,
    parentWindowId: r.parentWindowId,
    factId: r.factId,
    predicate: r.predicate,
    neighbourEntityId: r.neighbourEntityId,
    hop: r.hop,
    rerankScore: r.rerankScore,
    source: 'graph_fallback',
  }));
}

app.post('/api/reason/query', async (c) => {
  // Audit attribution (nmemo-2yv.35 sweep): same dispatch as /api/reason —
  // invokeReasoningAgent threads MNEMO_AGENT_ACTOR='reasoning_agent'.
  const body = await c.req.json<{ question: string }>();
  if (!body.question) return c.json({ error: 'question is required' }, 400);
  logReasonRequest(c, 'query', body.question);
  // Bead nmemo-2yv.77 — invocation_id idempotency key (see /api/reason).
  const invocationId = randomUUID();
  const { invokeReasoningAgent, AgentInvocationTimeoutError } = await import('./services/causal-agent.js');
  const start = Date.now();
  // Bead nmemo-0wq.3 — query-failure fallback boundary check (doc 38 §6.2.1).
  // Pre-flight flat retrieval; if it FAILS the confidence bar (§6.1), run the
  // graph-anchored fallback and hand its ranked unit-grained evidence to the
  // agent alongside the question. Single fire per query (§6.3): the boundary
  // evaluates the trigger at most once and never re-anchors its own hits.
  // Fails open — any error here must not block the normal query path.
  const fallbackEvidence = await computeQueryFallbackEvidence(body.question).catch((err) => {
    console.error(`[reason/query] fallback boundary check failed (continuing without): ${err}`);
    return undefined;
  });
  try {
    const result = await invokeReasoningAgent({ mode: 'query', question: body.question, invocationId, fallbackEvidence });
    return c.json({ triggered: true, result: result.result, durationMs: Date.now() - start });
  } catch (err) {
    // Bead nmemo-2yv.76: 504 on timeout (see /api/reason for rationale).
    if (err instanceof AgentInvocationTimeoutError) {
      return c.json({ triggered: false, error: err.message, durationMs: Date.now() - start }, 504);
    }
    return c.json({ triggered: false, error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - start }, 500);
  }
});

// ============================================
// Graph Stats (Phase 1 — nmemo-a7f.1.1)
// Singleton aggregate stats over the whole graph. See doc 22 §3.3.
// ============================================

app.post('/api/graph-stats/compute', async (c) => {
  // Audit attribution (nmemo-2yv.35 sweep): computeGraphStats writes only to
  // public.graph_stats (singleton aggregate row); no fact/edge audit rows.
  const { computeGraphStats } = await import('./services/graph-stats.js');
  const start = Date.now();
  try {
    const stats = await computeGraphStats();
    return c.json({ ok: true, stats, durationMs: Date.now() - start });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - start }, 500);
  }
});

app.get('/api/graph-stats', async (c) => {
  const { getGraphStats } = await import('./services/graph-stats.js');
  const stats = await getGraphStats();
  return c.json({ stats });
});

// ============================================
// Drift-reconciliation post-compute trigger (bead nmemo-2yv.83)
// Fire-and-forget; never blocks the HTTP response of /api/drift/compute.
// Selects ALL pending drift events (decoupled from "rows from this call")
// so stragglers from previous failed cycles get re-attempted. Per-event
// invocation is serial — the ml-services llm_pool already bounds LLM
// concurrency, and serial keeps logs readable.
// ============================================

// pgvector returns a JSON-shaped literal '[v1,v2,...]'. Defensive parser:
// arrays pass through; strings get parsed; anything else returns [].
function parsePgVector(input: unknown): number[] {
  if (Array.isArray(input)) return input as number[];
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (Array.isArray(parsed)) return parsed as number[];
      } catch {
        // fall through to empty
      }
    }
  }
  return [];
}

function isPermanentFailureStatus(status: number): boolean {
  // Bead spec: HTTP 404 (entity not found) and HTTP 400 (bad payload) are
  // the only specific permanent classes. Everything else falls through to
  // the transient bucket and goes through MAX-attempts exhaustion before
  // being marked permanently failed.
  return status === 400 || status === 404;
}

export async function triggerReconciliationDriftAfterCompute(
  invokerOverride?: ReconciliationDriftInvoker,
): Promise<void> {
  const maxAttempts = config.MAX_RECONCILIATION_ATTEMPTS;
  try {
    // Lazy import inside try so a module-load failure (rare but possible
    // in a future bundling/build edit) lands in the catch rather than
    // becoming an unhandled rejection — the route fires us with void.
    const invoker = invokerOverride
      ?? (await import('./services/causal-agent.js')).invokeReconciliationDriftAgent;
    // NB: payload field source_cluster_id maps to the storage column
    // cluster_id_at_detection (see 016_entity_drift.sql §3.2). The agent
    // request model uses the "source/target" framing; the row schema
    // uses "at-detection/target".
    const pending = (await db.execute(sql`
      SELECT id::text                       AS id,
             entity_id::text                AS entity_id,
             drift_magnitude,
             centroid_snapshot::text        AS centroid_snapshot_text,
             centroid_current::text         AS centroid_current_text,
             cluster_id_at_detection        AS source_cluster_id,
             target_cluster_id              AS target_cluster_id,
             reconciliation_attempt_count   AS reconciliation_attempt_count
      FROM public.entity_drift_events
      WHERE triggered_action = 'reconciliation_invoked'
        AND reconciliation_run_id IS NULL
        AND reconciliation_attempt_count < ${maxAttempts}
      ORDER BY detected_at ASC
    `)) as unknown as Array<{
      id: string;
      entity_id: string;
      drift_magnitude: number;
      centroid_snapshot_text: string;
      centroid_current_text: string;
      source_cluster_id: number | null;
      target_cluster_id: number | null;
      reconciliation_attempt_count: number;
    }>;

    if (pending.length === 0) {
      console.log('[drift-reconciliation] no pending events');
      return;
    }

    console.log(`[drift-reconciliation] processing ${pending.length} pending events (max_attempts=${maxAttempts})`);

    for (const row of pending) {
      // Per-iteration try so one poison row (e.g. unexpected DB error on a
      // single UPDATE) doesn't abort the rest of the batch. Anything that
      // didn't reach a terminal state this cycle is re-selected next cycle.
      try {
        const snapshot = parsePgVector(row.centroid_snapshot_text);
        const current = parsePgVector(row.centroid_current_text);

        const response = await invoker({
          entity_id: row.entity_id,
          drift_magnitude: row.drift_magnitude,
          centroid_snapshot: snapshot,
          centroid_current: current,
          source_cluster_id: row.source_cluster_id,
          target_cluster_id: row.target_cluster_id,
        });

        // Success requires status 200 AND a non-empty string result. An
        // empty/whitespace result (e.g. LLM exhausted max_turns without
        // emitting text) falls through to the transient branch so the row
        // gets re-attempted rather than silently audit-rowed with empty
        // content. invokeReconciliationDriftAgent already coerces malformed
        // JSON / network errors to non-200 statuses, so by the time we get
        // here status=200 AND result is the only "useful body" shape.
        const resultIsUsable = typeof response.result === 'string'
          && response.result.trim().length > 0;
        if (response.status === 200 && resultIsUsable) {
          // SUCCESS: write the agent's report into reasoning_reports (audit
          // table per bead spec), then set the drift event's run_id to the
          // generated row's id. mode='patrol' is the closest existing legal
          // CHECK value — the drift-reconciliation agent IS doing a focused
          // single-entity patrol. actions_taken carries the drift_event_id
          // so the audit row is reverse-traceable to its trigger.
          const inserted = (await db.execute(sql`
            INSERT INTO public.reasoning_reports (mode, report, actions_taken, entity_ids)
            VALUES (
              'patrol',
              ${response.result},
              ${JSON.stringify({ drift_event_id: row.id, source: 'reconciliation_drift_agent' })}::jsonb,
              ARRAY[${row.entity_id}]::uuid[]
            )
            RETURNING id::text AS id
          `)) as unknown as Array<{ id: string }>;

          const runId = inserted[0]?.id;
          if (runId) {
            await db.execute(sql`
              UPDATE public.entity_drift_events
              SET reconciliation_run_id = ${runId}
              WHERE id = ${row.id}::uuid
            `);
            console.log(`[drift-reconciliation] entity=${row.entity_id} drift_event=${row.id} run_id=${runId}`);
          } else {
            console.warn(`[drift-reconciliation] entity=${row.entity_id} drift_event=${row.id} INSERT returned no id`);
          }
        } else if (isPermanentFailureStatus(response.status)) {
          // PERMANENT (specific error class): mark failed immediately.
          await db.execute(sql`
            UPDATE public.entity_drift_events
            SET triggered_action = 'reconciliation_failed',
                error_detail     = ${`HTTP ${response.status}: ${response.error ?? 'no detail'}`}
            WHERE id = ${row.id}::uuid
          `);
          console.warn(`[drift-reconciliation] entity=${row.entity_id} drift_event=${row.id} permanent_failure status=${response.status}`);
        } else {
          // TRANSIENT: increment counter. If counter hits MAX_ATTEMPTS,
          // promote to permanent so 'reconciliation_failed' eventually fires
          // even for chronically-failing events (resolves folded-scope C7).
          const newCount = row.reconciliation_attempt_count + 1;
          const detail = `HTTP ${response.status}: ${response.error ?? 'no detail'}`;
          if (newCount >= maxAttempts) {
            await db.execute(sql`
              UPDATE public.entity_drift_events
              SET reconciliation_attempt_count = ${newCount},
                  triggered_action             = 'reconciliation_failed',
                  error_detail                 = ${`exhausted ${maxAttempts} attempts: ${detail}`}
              WHERE id = ${row.id}::uuid
            `);
            console.warn(`[drift-reconciliation] entity=${row.entity_id} drift_event=${row.id} exhausted_attempts attempts=${newCount}`);
          } else {
            await db.execute(sql`
              UPDATE public.entity_drift_events
              SET reconciliation_attempt_count = ${newCount},
                  error_detail                 = ${detail}
              WHERE id = ${row.id}::uuid
            `);
            console.warn(`[drift-reconciliation] entity=${row.entity_id} drift_event=${row.id} transient_failure attempts=${newCount} status=${response.status}`);
          }
        }
      } catch (rowErr) {
        console.warn(
          `[drift-reconciliation] row drift_event=${row.id} entity=${row.entity_id} failed:`,
          rowErr instanceof Error ? rowErr.message : rowErr,
        );
      }
    }
  } catch (err) {
    console.warn('[drift-reconciliation] helper failed:', err instanceof Error ? err.message : err);
  }
}

// ============================================
// Topology (Phase 2 — nmemo-a7f.2.1, doc 23 §2.4 + 23.1 §3.3)
// POST /api/topology/compute proxies to the ml-services sidecar (igraph).
// GET  /api/components/:component_id reads the local entity_topology table.
// ============================================

app.post('/api/topology/compute', async (c) => {
  // Audit attribution (nmemo-2yv.35 sweep): proxies to ml-services topology
  // compute which writes public.entity_topology + topology_bridges (derived
  // tables); no fact/edge audit rows. Fire-and-forget cross-cluster trigger
  // likewise only writes public.cross_cluster_runs.
  const start = Date.now();
  try {
    const response = await fetch(`${config.ML_SERVICES_URL}/topology/compute`, { method: 'POST' });
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      return c.json({ ok: false, status: response.status, error: body, durationMs: Date.now() - start }, response.status as 409 | 500);
    }
    // Bead nmemo-2yv.84 — reset the derived_freshness counter for this kind
    // on the success path. The post-ingest counter trigger keys off this row.
    // Fire-and-forget: the dynamic import + UPDATE live inside markDerivedComputed's
    // own try/catch (see derived-freshness.ts); failure here must not perturb
    // the route's success response.
    void markDerivedFreshness('topology');
    // Phase 4 trigger (doc 25 §3.2): fire-and-forget the cross-cluster
    // generator. The generator's own freshness gate checks that BOTH topology
    // and clustering computes are fresh; if clustering is stale this run
    // short-circuits with skippedReason='stale_upstream', and the next
    // /api/clustering/compute success path will retry. Advisory lock keeps
    // overlapping invocations safe.
    void triggerCrossClusterAfterCompute('topology');
    return c.json({ ok: true, result: body, durationMs: Date.now() - start });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - start }, 502);
  }
});

// GET /api/topology — full snapshot for the viz topology layer (viz.2).
// Returns one row per entity with all 5 Phase 2 features (component, k-core,
// articulation, community, centrality + predicate_signature) plus the global
// bridges list. Cheap when pre-computed; on a 1k-entity graph it's a few ms.
app.get('/api/topology', async (c) => {
  const snapshot = await getTopologySnapshot();
  return c.json(snapshot);
});

app.get('/api/components/:component_id', async (c) => {
  const idStr = c.req.param('component_id');
  const componentId = Number.parseInt(idStr, 10);
  if (!Number.isInteger(componentId)) {
    return c.json({ error: `component_id must be an integer, got "${idStr}"` }, 400);
  }
  const details = await getComponentEntities(componentId);
  return c.json(details);
});

// ============================================
// Clustering (Phase 3 — nmemo-a7f.3.1, doc 24.1)
// POST /api/clustering/compute proxies to the ml-services sidecar (HDBSCAN).
// GET  /api/clusters/:cluster_id reads the local entity_clusters table.
// ============================================

app.post('/api/clustering/compute', async (c) => {
  // Audit attribution (nmemo-2yv.35 sweep): proxies to ml-services clustering
  // compute writing public.entity_clusters (derived table); no fact/edge
  // audit rows.
  const start = Date.now();
  try {
    const response = await fetch(`${config.ML_SERVICES_URL}/clustering/compute`, { method: 'POST' });
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      return c.json({ ok: false, status: response.status, error: body, durationMs: Date.now() - start }, response.status as 409 | 500);
    }
    // Bead nmemo-2yv.84 — reset the derived_freshness counter on success. The
    // post-ingest counter trigger reads this row to gate the next compute.
    void markDerivedFreshness('clustering');
    // Phase 4 trigger (doc 25 §3.2). Mirrors the topology/compute hook above.
    void triggerCrossClusterAfterCompute('clustering');
    return c.json({ ok: true, result: body, durationMs: Date.now() - start });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - start }, 502);
  }
});

// GET /api/clusters — full snapshot for the viz cluster layer (viz.3).
// One row per entity that participated in the most recent clustering run.
// Skips centroid_snapshot in the main list (768 floats × N is too heavy for
// a polled endpoint); GET /api/clusters/:cluster_id returns it on demand.
app.get('/api/clusters', async (c) => {
  const snapshot = await getClustersSnapshot();
  return c.json(snapshot);
});

app.get('/api/clusters/:cluster_id', async (c) => {
  const idStr = c.req.param('cluster_id');
  const clusterId = Number.parseInt(idStr, 10);
  if (!Number.isInteger(clusterId)) {
    return c.json({ error: `cluster_id must be an integer (use -1 for noise), got "${idStr}"` }, 400);
  }
  const details = await getClusterEntities(clusterId);
  return c.json(details);
});

// ============================================
// Drift detection (Phase 3 — nmemo-a7f.3.2, doc 24.2)
// POST /api/drift/compute proxies to the ml-services sidecar (ADWIN sweep).
// GET  /api/drift/events?entity_id=X reads recent drift events for one entity.
// ============================================

app.post('/api/drift/compute', async (c) => {
  // Audit attribution (nmemo-2yv.35 sweep): proxies to ml-services drift
  // compute writing public.entity_drift_events / entity_drift_state; no
  // fact/edge audit rows. The fire-and-forget reconciliation trigger uses
  // invokeReconciliationDriftAgent which sets MNEMO_AGENT_ACTOR=
  // 'reconciliation_agent' on any downstream MCP tool calls.
  const start = Date.now();
  try {
    const response = await fetch(`${config.ML_SERVICES_URL}/drift/compute`, { method: 'POST' });
    const body = (await response.json()) as Record<string, unknown>;
    if (!response.ok) {
      return c.json({ ok: false, status: response.status, error: body, durationMs: Date.now() - start }, response.status as 409 | 500);
    }
    // Bead nmemo-2yv.83 — fire-and-forget the reconciliation-drift caller.
    // Picks up rows just inserted by this compute call (triggered_action=
    // 'reconciliation_invoked' AND reconciliation_run_id IS NULL) and any
    // stragglers from previous cycles still under MAX_RECONCILIATION_ATTEMPTS.
    void triggerReconciliationDriftAfterCompute();
    // Bead nmemo-2yv.85 — fire-and-forget the cross-cluster generator. Drift
    // events feed the generator (doc 25 §2.2, W2/W3 = 25% of combined score);
    // without this hook, fresh drift events sit unconsumed until the next
    // topology/clustering compute. The generator's freshness gate is keyed on
    // topology+clustering recency (not drift), so this trigger correctly
    // short-circuits with skippedReason='stale_upstream' when those upstreams
    // are stale — drift alone never starves the gate.
    void triggerCrossClusterAfterCompute('drift');
    return c.json({ ok: true, result: body, durationMs: Date.now() - start });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - start }, 502);
  }
});

app.get('/api/drift/events', async (c) => {
  // viz.7 — entity_id is now optional. When absent, return the global feed
  // newest-first (powers the bottom-of-canvas timeline strip). When present,
  // scope to that entity (preserves the original behaviour for the entity-
  // scoped detail panel).
  const entityId = c.req.query('entity_id');
  const limitRaw = c.req.query('limit');
  const defaultLimit = entityId ? 10 : 200;
  const limit = limitRaw ? Math.max(1, Math.min(500, Number.parseInt(limitRaw, 10) || defaultLimit)) : defaultLimit;
  const result = await getDriftEvents({ entityId, limit });
  return c.json(result);
});

// viz.7 — per-entity drift state (observation_count, last_cluster_id,
// last_updated_at) for the Drift section in the entity detail panel.
app.get('/api/drift/state/:entityId', async (c) => {
  const entityId = c.req.param('entityId');
  const state = await getDriftState(entityId);
  return c.json({ state });
});

// ============================================
// Cross-cluster candidate generator (Phase 4 — nmemo-a7f.4.1, doc 25)
// POST /api/cross-cluster/generate runs the in-process generator (no ml-services
//   proxy — the generator is platform-side TypeScript reading entity_topology /
//   entity_clusters / entity_drift_events and writing merge_candidates).
// GET  /api/cross-cluster/candidates lists cross_cluster_generator-sourced
//   merge_candidates ordered by combined_score.
// ============================================

app.post('/api/cross-cluster/generate', async (c) => {
  // Audit attribution (nmemo-2yv.35 sweep): generateCrossClusterCandidates
  // writes public.cross_cluster_runs + merge_candidates rows (candidate-source
  // attribution lives on merge_candidates.candidate_source, not the fact/edge
  // audit tables). No fact/edge audit rows.
  const start = Date.now();
  try {
    const { generateCrossClusterCandidates } = await import('./services/cross-cluster-generator.js');
    const result = await generateCrossClusterCandidates();
    return c.json({ ok: true, result, durationMs: Date.now() - start });
  } catch (err) {
    return c.json(
      { ok: false, error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - start },
      500,
    );
  }
});

app.get('/api/cross-cluster/candidates', async (c) => {
  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Math.max(1, Math.min(500, Number.parseInt(limitRaw, 10) || 100)) : 100;
  // Optional ?status=candidate,staging,provisional,resolved — comma-separated,
  // validated against the merge_candidates CHECK constraint vocabulary. Empty
  // / unset = use the helper's default (['candidate', 'staging']) so the viz
  // panel stops rendering resolved rows forever (bead nmemo-2yv.98).
  const { listCrossClusterCandidates, CROSS_CLUSTER_CANDIDATE_STATUSES } =
    await import('./services/cross-cluster-generator.js');
  const statusRaw = c.req.query('status');
  let statusFilter: readonly string[] | undefined;
  if (statusRaw !== undefined && statusRaw.length > 0) {
    const requested = statusRaw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
    const allowed = new Set<string>(CROSS_CLUSTER_CANDIDATE_STATUSES);
    const invalid = requested.filter((s) => !allowed.has(s));
    if (invalid.length > 0) {
      return c.json(
        {
          error: `invalid status value(s): ${invalid.join(', ')}. Allowed: ${CROSS_CLUSTER_CANDIDATE_STATUSES.join(', ')}`,
        },
        400,
      );
    }
    if (requested.length > 0) statusFilter = requested;
  }
  try {
    // statusFilter === undefined falls through to the helper's default param
    // (['candidate','staging']) — no explicit branching needed.
    const candidates = await listCrossClusterCandidates(limit, statusFilter);
    return c.json({ count: candidates.length, candidates });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// GET /api/cross-cluster/runs — most recent cross_cluster_runs rows for viz +
// operational dashboards (bead nmemo-2yv.92). Mirrors the sibling pattern for
// topology / clustering compute runs.
app.get('/api/cross-cluster/runs', async (c) => {
  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Math.max(1, Math.min(200, Number.parseInt(limitRaw, 10) || 20)) : 20;
  try {
    const { listCrossClusterRuns } = await import('./services/cross-cluster-generator.js');
    const runs = await listCrossClusterRuns(limit);
    return c.json({ count: runs.length, runs });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// ============================================
// Reasoning reports — read-only views for the viz debug panel (bead .81).
// The reasoning agent writes rows via save_reasoning_report (causal-agent.ts);
// computeGraphStats (.49) writes patrol-mode rows from graph_stats sweeps;
// .77 added invocation_id idempotency. The viz panel surfaces these for the
// developer's debug surface (architectural principle from .73). No MCP tool
// exposure — get_reasoning_history stays agent-internal.
//
// Route order matters: `/cadence` and `/by-entity/:id` are declared before
// `/:id` so Hono's pattern matcher doesn't route them into the generic
// single-report handler.
// ============================================

app.get('/api/reasoning-reports', async (c) => {
  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Math.max(1, Math.min(200, Number.parseInt(limitRaw, 10) || 20)) : 20;
  const modeRaw = c.req.query('mode');
  if (modeRaw && modeRaw !== 'patrol' && modeRaw !== 'query') {
    return c.json({ error: `mode must be 'patrol' or 'query' (got '${modeRaw}')` }, 400);
  }
  const mode = modeRaw === 'patrol' || modeRaw === 'query' ? modeRaw : undefined;
  try {
    const { listReasoningReports } = await import('./services/reasoning-reports-query.js');
    const reports = await listReasoningReports({ limit, mode });
    return c.json({ count: reports.length, reports });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.get('/api/reasoning-reports/cadence', async (c) => {
  try {
    const { getReasoningReportCadence } = await import('./services/reasoning-reports-query.js');
    const cadence = await getReasoningReportCadence();
    return c.json(cadence);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// UUID shape guard — keeps SQL casts from raising 22P02 on malformed path
// params for the reasoning-reports routes below.
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

app.get('/api/reasoning-reports/by-entity/:entity_id', async (c) => {
  const entityId = c.req.param('entity_id');
  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Math.max(1, Math.min(200, Number.parseInt(limitRaw, 10) || 20)) : 20;
  if (!UUID_RE.test(entityId)) {
    return c.json({ error: 'entity_id must be a UUID' }, 400);
  }
  try {
    const { listReasoningReportsByEntity } = await import('./services/reasoning-reports-query.js');
    const reports = await listReasoningReportsByEntity(entityId, { limit });
    return c.json({ count: reports.length, reports });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.get('/api/reasoning-reports/:id', async (c) => {
  const id = c.req.param('id');
  if (!UUID_RE.test(id)) {
    return c.json({ error: 'id must be a UUID' }, 400);
  }
  try {
    const { getReasoningReportById } = await import('./services/reasoning-reports-query.js');
    const report = await getReasoningReportById(id);
    if (!report) return c.json({ error: 'reasoning report not found' }, 404);
    return c.json(report);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// MCP health probe — spawns the production graph MCP server (graph-mcp.ts),
// asks for tools/list, returns the catalogue. The URL path stays `mcp-health`
// because it's user-facing observability surface — the rename is internal.
app.get('/api/mcp-health', async (c) => {
  const { checkGraphMcpHealth } = await import('./services/causal-agent.js');
  const result = await checkGraphMcpHealth();
  return c.json(result, result.ok ? 200 : 503);
});

const port = parseInt(process.env.PORT || '3000', 10);

// Skip the network listener when imported under Vitest so endpoint tests can
// drive routes via `app.request()` without binding the dev port.
if (!process.env.VITEST) {
  // Bead nmemo-2yv.132: run the startup-validation gate before serving. The
  // qdrant_dim validator wraps ensureCollections (bead .121); the three
  // others cover ml-services reach, transport health, and port collisions.
  // Strict-only by default — any failure aborts boot.
  //
  // Narrow, dev/test-only exception: SKIP_ML_SERVICES_GATE=1 omits the two
  // external-LLM-stack validators (ml_services + transport) so the iOS
  // live-integration stack can boot the HTTP read surfaces against
  // Postgres+Qdrant while ml-services is intentionally down. The skip itself
  // lives in startup-validation.ts (forced off when NODE_ENV=production); here
  // we only emit a LOUD warning so an operator never mistakes a bypassed boot
  // for a fully-validated one.
  if (
    process.env.NODE_ENV !== 'production' &&
    ['1', 'true', 'yes'].includes((process.env.SKIP_ML_SERVICES_GATE ?? '').trim().toLowerCase())
  ) {
    console.warn(
      '[startup] ⚠️  SKIP_ML_SERVICES_GATE is set — ml-services + transport startup gates are BYPASSED. ' +
        'ml-services is NOT verified reachable. This is a dev/test escape hatch only; never use in production.',
    );
  }
  const { validateStartup } = await import('./services/startup-validation.js');
  const results = await validateStartup();
  const failed = results.filter(r => !r.ok);
  if (failed.length > 0) {
    console.error('[startup] Validation failures:');
    for (const r of failed) {
      console.error(`  - ${r.name}: ${r.detail ?? 'failed'} (${r.durationMs}ms)`);
    }
    process.exit(1);
  }
  const summary = results.map(r => `${r.name}=${r.durationMs}ms`).join(' ');
  console.log(`[startup] All validators passed (${summary})`);
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`Platform listening on :${info.port}`);
  });
  // Bead nmemo-2yv.84 — single home for all time-driven cadences. Today
  // registers the drift patrol job; future cadences (e.g. .71 reasoning
  // patrol if time-driven) land in scheduler.ts.
  startScheduler();
  // Stop cron tasks on shutdown so node-cron's interval doesn't keep the
  // event loop alive after the HTTP server closes.
  const shutdown = (signal: string) => {
    console.log(`[shutdown] ${signal} received — stopping scheduler`);
    stopScheduler();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
