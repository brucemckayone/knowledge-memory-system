/**
 * Platform HTTP server — entry point for Docker container.
 * Exposes the pipeline (ingest/store/extract), health check, and graph viz.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { ingest, store, extract, enqueueIngest, getIngestQueueStatus } from './pipeline.js';
import { config } from './config.js';
import { db, checkDatabaseHealth, entities, facts, memoryEntities, causalEvents, causalEdges, entityMeta, sameAsLinks, mergeCandidates, entityAliases, extractionReports } from './db/index.js';
import { isNull, sql, eq } from 'drizzle-orm';
import { getMergeCandidates } from './services/graph-meta.js';
import { ml } from './services/ml-client.js';
import { checkQdrantHealth } from './services/qdrant.js';
import type { ReconciliationDriftInvoker } from './services/causal-agent.js';
import { markDerivedComputed as markDerivedFreshness } from './services/derived-freshness.js';
import { startScheduler, stopScheduler } from './scheduler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const vizHtmlPath = join(__dirname, '../viz/index.html');

export const app = new Hono();

app.get('/health', async (c) => {
  const [db, mlOk, qdrantOk] = await Promise.all([
    checkDatabaseHealth(),
    ml.health(),
    checkQdrantHealth(),
  ]);
  const status = db && mlOk && qdrantOk ? 'ok' : 'degraded';
  return c.json({ status, db, ml: mlOk, qdrant: qdrantOk });
});

// `contentType` (optional) hints the graph agent: 'prose' | 'code-ts' | 'code-sql'.
// Defaults to 'prose' when omitted — backward compatible with all existing callers.
type ContentTypeBody = 'prose' | 'code-ts' | 'code-sql';

function parseContentType(v: unknown): ContentTypeBody | undefined {
  if (v === 'prose' || v === 'code-ts' || v === 'code-sql') return v;
  return undefined;
}

app.post('/ingest', async (c) => {
  const body = await c.req.json<{ text: string; source?: string; contentType?: string }>();
  if (!body.text) return c.json({ error: 'text is required' }, 400);
  const result = await ingest(body.text, {
    source: body.source,
    contentType: parseContentType(body.contentType),
  });
  return c.json(result);
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

// Test endpoint for entity summary tools
app.post('/api/viz/test-summary', async (c) => {
  const { handleToolCall } = await import('./services/causal-agent.js');
  const body = await c.req.json<{ entity_id: string; summary: string }>();
  const result = await handleToolCall('update_entity_summary', body);
  return c.json(JSON.parse(result));
});
app.get('/api/viz/test-query-facts', async (c) => {
  const { handleToolCall } = await import('./services/causal-agent.js');
  const entityId = c.req.query('entity_id');
  if (!entityId) return c.json({ error: 'entity_id required' }, 400);
  const result = await handleToolCall('query_entity_facts', { entity_id: entityId });
  return c.json(JSON.parse(result));
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
    }).from(causalEdges).where(isNull(causalEdges.expiredAt)).limit(500),
    db.select({
      entityId: entityMeta.entityId,
      mentionCount: entityMeta.mentionCount,
      sourceMemoryCount: entityMeta.sourceMemoryCount,
      factCount: entityMeta.factCount,
      spread: entityMeta.spread,
      summary: entityMeta.summary,
    }).from(entityMeta),
    getMergeCandidates(),
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
  const metaMap: Record<string, { mentionCount: number; sourceMemoryCount: number; factCount: number; spread: number | null; summary: string | null }> = {};
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

app.get('/api/viz/merge-candidates', async (c) => {
  const candidates = await getMergeCandidates();
  return c.json(candidates);
});

app.post('/api/viz/run-meta', async (c) => {
  // Run the migration first (idempotent)
  const { readFileSync: readFs } = await import('node:fs');
  // Try both paths (tsx runs from src/, compiled from dist/)
  // Run all graph meta migrations in order
  for (const migFile of ['003_graph_meta.sql', '004_entity_summary.sql']) {
    let migSql: string;
    try {
      migSql = readFs(join(__dirname, 'db/migrations', migFile), 'utf-8');
    } catch {
      migSql = readFs(join(__dirname, '../db/migrations', migFile), 'utf-8');
    }
    await db.execute(sql.raw(migSql));
  }

  // Get all entity IDs
  const allEntities = await db.select({ id: entities.id }).from(entities);
  const entityIds = allEntities.map(e => e.id);

  // Compute meta + detect candidates
  const { updateEntityMeta: update, detectMergeCandidates: detect } = await import('./services/graph-meta.js');
  await update(entityIds);
  const candidateCount = await detect(entityIds);

  return c.json({ entitiesProcessed: entityIds.length, candidatesDetected: candidateCount });
});

app.post('/api/reconcile', async (c) => {
  // Manually trigger the reconciliation agent to resolve identity questions
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

  // Fetch candidates and recent extraction reports
  const [allCandidates, recentReports] = await Promise.all([
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
  const unresolved = allCandidates.filter(c => c.status !== 'resolved');
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

app.post('/api/garden', async (c) => {
  // Manually trigger the graph gardener to explore and maintain the knowledge graph
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
    const result = await applyConfidenceDecay();
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
  const tStart = Date.now();
  console.log('[contradictions] manual detect trigger received');

  const { detectContradictions } = await import('./services/contradictions.js');
  try {
    const result = await detectContradictions();
    const durationMs = Date.now() - tStart;
    console.log(
      `[contradictions] detect complete detected=${result.detected} byType=${JSON.stringify(result.byType)} durationMs=${durationMs}`,
    );
    return c.json({
      triggered: true,
      detected: result.detected,
      byType: result.byType,
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
  type Row = {
    id: string;
    event_type: string;
    previous_confidence: number | null;
    new_confidence: number | null;
    previous_valid_at: Date | null;
    new_valid_at: Date | null;
    previous_invalid_at: Date | null;
    new_invalid_at: Date | null;
    reasoning: string;
    source_references: unknown;
    reasoning_report_id: string | null;
    causal_event_id: string | null;
    actor: string;
    occurred_at: Date;
  };
  try {
    const rows = (await db.execute(sql`
      SELECT
        id::text,
        event_type,
        previous_confidence, new_confidence,
        previous_valid_at, new_valid_at,
        previous_invalid_at, new_invalid_at,
        reasoning,
        source_references,
        reasoning_report_id::text,
        causal_event_id::text,
        actor,
        occurred_at
      FROM public.fact_history
      WHERE fact_id = ${id}::uuid
      ORDER BY occurred_at DESC
      LIMIT 200
    `)) as unknown as Row[];
    return c.json({
      history: rows.map((r) => ({
        id: r.id,
        eventType: r.event_type,
        previousConfidence: r.previous_confidence,
        newConfidence: r.new_confidence,
        previousValidAt: r.previous_valid_at?.toISOString() ?? null,
        newValidAt: r.new_valid_at?.toISOString() ?? null,
        previousInvalidAt: r.previous_invalid_at?.toISOString() ?? null,
        newInvalidAt: r.new_invalid_at?.toISOString() ?? null,
        reasoning: r.reasoning,
        sourceReferences: r.source_references,
        reasoningReportId: r.reasoning_report_id,
        causalEventId: r.causal_event_id,
        actor: r.actor,
        occurredAt: r.occurred_at instanceof Date ? r.occurred_at.toISOString() : String(r.occurred_at),
      })),
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.get('/api/causal-edges/:id/history', async (c) => {
  const id = c.req.param('id');
  type Row = {
    id: string;
    event_type: string;
    previous_strength: number | null;
    new_strength: number | null;
    previous_reasoning: string | null;
    new_reasoning: string | null;
    added_source_refs: unknown;
    reasoning: string;
    reasoning_report_id: string | null;
    actor: string;
    occurred_at: Date;
  };
  try {
    const rows = (await db.execute(sql`
      SELECT
        id::text,
        event_type,
        previous_strength, new_strength,
        previous_reasoning, new_reasoning,
        added_source_refs,
        reasoning,
        reasoning_report_id::text,
        actor,
        occurred_at
      FROM public.causal_edge_history
      WHERE edge_id = ${id}::uuid
      ORDER BY occurred_at DESC
      LIMIT 200
    `)) as unknown as Row[];
    return c.json({
      history: rows.map((r) => ({
        id: r.id,
        eventType: r.event_type,
        previousStrength: r.previous_strength,
        newStrength: r.new_strength,
        previousReasoning: r.previous_reasoning,
        newReasoning: r.new_reasoning,
        addedSourceRefs: r.added_source_refs,
        reasoning: r.reasoning,
        reasoningReportId: r.reasoning_report_id,
        actor: r.actor,
        occurredAt: r.occurred_at instanceof Date ? r.occurred_at.toISOString() : String(r.occurred_at),
      })),
    });
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
  await clearGraphTables();
  return c.json({ cleared: true });
});

app.post('/api/reset', async (c) => {
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
  logReasonRequest(c, 'patrol');
  const { invokeReasoningAgent } = await import('./services/causal-agent.js');
  const start = Date.now();
  try {
    const result = await invokeReasoningAgent({ mode: 'patrol' });
    return c.json({ triggered: true, result: result.result, durationMs: Date.now() - start });
  } catch (err) {
    return c.json({ triggered: false, error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - start }, 500);
  }
});

app.post('/api/reason/query', async (c) => {
  const body = await c.req.json<{ question: string }>();
  if (!body.question) return c.json({ error: 'question is required' }, 400);
  logReasonRequest(c, 'query', body.question);
  const { invokeReasoningAgent } = await import('./services/causal-agent.js');
  const start = Date.now();
  try {
    const result = await invokeReasoningAgent({ mode: 'query', question: body.question });
    return c.json({ triggered: true, result: result.result, durationMs: Date.now() - start });
  } catch (err) {
    return c.json({ triggered: false, error: err instanceof Error ? err.message : String(err), durationMs: Date.now() - start }, 500);
  }
});

// ============================================
// Graph Stats (Phase 1 — nmemo-a7f.1.1)
// Singleton aggregate stats over the whole graph. See doc 22 §3.3.
// ============================================

app.post('/api/graph-stats/compute', async (c) => {
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
// Phase 4 — Cross-cluster generator post-compute trigger (doc 25 §3.2)
// Fire-and-forget; never blocks the HTTP response of /topology/compute or
// /clustering/compute. The generator's freshness gate handles the "both
// upstreams fresh" precondition; the advisory lock handles overlap.
// ============================================
export async function triggerCrossClusterAfterCompute(after: 'topology' | 'clustering'): Promise<void> {
  try {
    const { generateCrossClusterCandidates } = await import('./services/cross-cluster-generator.js');
    const result = await generateCrossClusterCandidates();
    if (result.ran) {
      console.log(
        `[cross-cluster] auto-trigger after ${after}/compute: candidates=${result.candidatesInserted} ` +
        `drift_driven=${result.driftDrivenCandidates} component_pairs=${result.componentPairsEvaluated} ` +
        `duration=${result.durationMs}ms`,
      );
    } else {
      console.log(`[cross-cluster] auto-trigger after ${after}/compute skipped: ${result.skippedReason}`);
    }
  } catch (err) {
    console.warn(`[cross-cluster] auto-trigger after ${after}/compute failed:`, err instanceof Error ? err.message : err);
  }
}

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
  const { db } = await import('./db/index.js');
  const { sql } = await import('drizzle-orm');

  type EntityRow = {
    entity_id: string;
    component_id: number | null;
    component_size: number | null;
    k_core: number | null;
    is_articulation_point: boolean;
    community_id: number | null;
    participation_coef: number | null;
    pagerank: number | null;
    betweenness_sampled: number | null;
    predicate_signature: string | null;
    computed_at: Date | null;
    computation_version: number | null;
  };
  type BridgeRow = {
    source_entity_id: string;
    target_entity_id: string;
    fact_id: string | null;
    same_as_link_id: string | null;
    computed_at: Date;
  };

  const entityRows = (await db.execute(sql`
    SELECT
      entity_id::text             AS entity_id,
      component_id,
      component_size,
      k_core,
      is_articulation_point,
      community_id,
      participation_coef,
      pagerank,
      betweenness_sampled,
      predicate_signature::text   AS predicate_signature,
      computed_at,
      computation_version
    FROM public.entity_topology
  `)) as unknown as EntityRow[];

  const bridgeRows = (await db.execute(sql`
    SELECT
      source_entity_id::text  AS source_entity_id,
      target_entity_id::text  AS target_entity_id,
      fact_id::text           AS fact_id,
      same_as_link_id::text   AS same_as_link_id,
      computed_at
    FROM public.topology_bridges
  `)) as unknown as BridgeRow[];

  // Parse pgvector text "[0.1,0.2,...]" to number[] so the client doesn't
  // have to. Returns null when the signature is missing (zero-norm column).
  function parseVector(s: string | null): number[] | null {
    if (!s) return null;
    const trimmed = s.replace(/^\[|\]$/g, '');
    if (!trimmed) return null;
    const parts = trimmed.split(',').map((x) => Number.parseFloat(x));
    return parts.every((x) => Number.isFinite(x)) ? parts : null;
  }

  const entities = entityRows.map((r) => ({
    id: r.entity_id,
    componentId: r.component_id,
    componentSize: r.component_size,
    kCore: r.k_core,
    isArticulationPoint: r.is_articulation_point,
    communityId: r.community_id,
    participationCoef: r.participation_coef,
    pagerank: r.pagerank,
    betweennessSampled: r.betweenness_sampled,
    predicateSignature: parseVector(r.predicate_signature),
    computedAt: r.computed_at instanceof Date ? r.computed_at.toISOString() : null,
  }));

  const bridges = bridgeRows.map((r) => ({
    sourceEntityId: r.source_entity_id,
    targetEntityId: r.target_entity_id,
    factId: r.fact_id,
    sameAsLinkId: r.same_as_link_id,
    computedAt: r.computed_at instanceof Date ? r.computed_at.toISOString() : String(r.computed_at),
  }));

  return c.json({ entities, bridges });
});

app.get('/api/components/:component_id', async (c) => {
  const idStr = c.req.param('component_id');
  const componentId = Number.parseInt(idStr, 10);
  if (!Number.isInteger(componentId)) {
    return c.json({ error: `component_id must be an integer, got "${idStr}"` }, 400);
  }
  const { db } = await import('./db/index.js');
  const { sql } = await import('drizzle-orm');
  const rows = (await db.execute(sql`
    SELECT
      e.id::text          AS entity_id,
      e.canonical_name    AS canonical_name,
      e.entity_type       AS entity_type,
      et.component_id     AS component_id,
      et.component_size   AS component_size,
      et.computed_at      AS computed_at,
      et.computation_version AS computation_version
    FROM public.entity_topology et
    JOIN public.entities e ON e.id = et.entity_id
    WHERE et.component_id = ${componentId}
    ORDER BY e.canonical_name ASC
  `)) as unknown as Array<{
    entity_id: string;
    canonical_name: string;
    entity_type: string;
    component_id: number;
    component_size: number;
    computed_at: Date;
    computation_version: number;
  }>;
  if (rows.length === 0) {
    return c.json({ component_id: componentId, size: 0, entities: [] });
  }
  const head = rows[0]!;
  return c.json({
    component_id: head.component_id,
    size: head.component_size,
    computed_at: head.computed_at instanceof Date ? head.computed_at.toISOString() : String(head.computed_at),
    computation_version: head.computation_version,
    entities: rows.map((r) => ({
      id: r.entity_id,
      canonical_name: r.canonical_name,
      entity_type: r.entity_type,
    })),
  });
});

// ============================================
// Clustering (Phase 3 — nmemo-a7f.3.1, doc 24.1)
// POST /api/clustering/compute proxies to the ml-services sidecar (HDBSCAN).
// GET  /api/clusters/:cluster_id reads the local entity_clusters table.
// ============================================

app.post('/api/clustering/compute', async (c) => {
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
  const { db } = await import('./db/index.js');
  const { sql } = await import('drizzle-orm');

  type EntityRow = {
    entity_id: string;
    cluster_id: number;
    cluster_probability: number | null;
    cluster_size: number | null;
    computed_at: Date;
  };
  type SummaryRow = { cluster_id: number; size: number };

  const [entityRows, summaryRows] = await Promise.all([
    db.execute(sql`
      SELECT
        entity_id::text       AS entity_id,
        cluster_id,
        cluster_probability,
        cluster_size,
        computed_at
      FROM public.entity_clusters
    `) as unknown as Promise<EntityRow[]>,
    db.execute(sql`
      SELECT cluster_id, COUNT(*)::int AS size
      FROM public.entity_clusters
      GROUP BY cluster_id
      ORDER BY cluster_id
    `) as unknown as Promise<SummaryRow[]>,
  ]);

  const summary: Record<string, number> = {};
  let noiseCount = 0;
  let clusterCount = 0;
  for (const r of summaryRows) {
    summary[String(r.cluster_id)] = r.size;
    if (r.cluster_id === -1) noiseCount = r.size;
    else clusterCount += 1;
  }

  let computedAt: string | null = null;
  if (entityRows.length > 0 && entityRows[0]!.computed_at instanceof Date) {
    computedAt = entityRows[0]!.computed_at.toISOString();
  }

  return c.json({
    entities: entityRows.map((r) => ({
      id: r.entity_id,
      clusterId: r.cluster_id,
      clusterProbability: r.cluster_probability,
      clusterSize: r.cluster_size,
    })),
    summary,
    noiseCount,
    clusterCount,
    computedAt,
  });
});

app.get('/api/clusters/:cluster_id', async (c) => {
  const idStr = c.req.param('cluster_id');
  const clusterId = Number.parseInt(idStr, 10);
  if (!Number.isInteger(clusterId)) {
    return c.json({ error: `cluster_id must be an integer (use -1 for noise), got "${idStr}"` }, 400);
  }
  const { db } = await import('./db/index.js');
  const { sql } = await import('drizzle-orm');
  const rows = (await db.execute(sql`
    SELECT
      e.id::text             AS entity_id,
      e.canonical_name       AS canonical_name,
      e.entity_type          AS entity_type,
      ec.cluster_id          AS cluster_id,
      ec.cluster_size        AS cluster_size,
      ec.cluster_probability AS cluster_probability,
      ec.computed_at         AS computed_at,
      ec.computation_version AS computation_version
    FROM public.entity_clusters ec
    JOIN public.entities e ON e.id = ec.entity_id
    WHERE ec.cluster_id = ${clusterId}
    ORDER BY ec.cluster_probability DESC NULLS LAST, e.canonical_name ASC
  `)) as unknown as Array<{
    entity_id: string;
    canonical_name: string;
    entity_type: string;
    cluster_id: number;
    cluster_size: number | null;
    cluster_probability: number | null;
    computed_at: Date;
    computation_version: number;
  }>;
  if (rows.length === 0) {
    return c.json({ cluster_id: clusterId, size: 0, entities: [] });
  }
  const head = rows[0]!;
  return c.json({
    cluster_id: head.cluster_id,
    size: head.cluster_size,
    computed_at: head.computed_at instanceof Date ? head.computed_at.toISOString() : String(head.computed_at),
    computation_version: head.computation_version,
    entities: rows.map((r) => ({
      id: r.entity_id,
      canonical_name: r.canonical_name,
      entity_type: r.entity_type,
      cluster_probability: r.cluster_probability,
    })),
  });
});

// ============================================
// Drift detection (Phase 3 — nmemo-a7f.3.2, doc 24.2)
// POST /api/drift/compute proxies to the ml-services sidecar (ADWIN sweep).
// GET  /api/drift/events?entity_id=X reads recent drift events for one entity.
// ============================================

app.post('/api/drift/compute', async (c) => {
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
  const { db } = await import('./db/index.js');
  const { sql } = await import('drizzle-orm');
  const rows = (await db.execute(sql`
    SELECT
      id::text                  AS event_id,
      entity_id::text           AS entity_id,
      detected_at,
      drift_magnitude,
      cluster_id_at_detection,
      target_cluster_id,
      triggered_action,
      reconciliation_run_id,
      error_detail,
      computation_version
    FROM public.entity_drift_events
    WHERE (${entityId ?? null}::text IS NULL OR entity_id = ${entityId ?? null}::uuid)
    ORDER BY detected_at DESC
    LIMIT ${limit}
  `)) as unknown as Array<{
    event_id: string;
    entity_id: string;
    detected_at: Date;
    drift_magnitude: number;
    cluster_id_at_detection: number | null;
    target_cluster_id: number | null;
    triggered_action: string;
    reconciliation_run_id: string | null;
    error_detail: string | null;
    computation_version: number;
  }>;
  return c.json({
    entity_id: entityId ?? null,
    count: rows.length,
    events: rows.map((r) => ({
      ...r,
      detected_at: r.detected_at instanceof Date ? r.detected_at.toISOString() : String(r.detected_at),
    })),
  });
});

// viz.7 — per-entity drift state (observation_count, last_cluster_id,
// last_updated_at) for the Drift section in the entity detail panel.
app.get('/api/drift/state/:entityId', async (c) => {
  const entityId = c.req.param('entityId');
  const { db } = await import('./db/index.js');
  const { sql } = await import('drizzle-orm');
  const rows = (await db.execute(sql`
    SELECT
      observation_count,
      last_cluster_id,
      river_version,
      last_updated_at
    FROM public.entity_drift_state
    WHERE entity_id = ${entityId}::uuid
  `)) as unknown as Array<{
    observation_count: number;
    last_cluster_id: number | null;
    river_version: string;
    last_updated_at: Date;
  }>;
  if (rows.length === 0) return c.json({ state: null });
  const r = rows[0]!;
  return c.json({
    state: {
      observationCount: r.observation_count,
      lastClusterId: r.last_cluster_id,
      riverVersion: r.river_version,
      lastUpdatedAt: r.last_updated_at instanceof Date ? r.last_updated_at.toISOString() : String(r.last_updated_at),
    },
  });
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
  try {
    const { listCrossClusterCandidates } = await import('./services/cross-cluster-generator.js');
    const candidates = await listCrossClusterCandidates(limit);
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
  // Strict-only — any failure aborts boot. No env-var opt-out (bead .132
  // Decision section).
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
