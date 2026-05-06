/**
 * Platform HTTP server — entry point for Docker container.
 * Exposes the pipeline (ingest/store/extract), health check, and graph viz.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { ingest, store, extract, enqueueIngest, getIngestQueueStatus } from './pipeline.js';
import { db, checkDatabaseHealth, entities, facts, memoryEntities, causalEvents, causalEdges, entityMeta, sameAsLinks, mergeCandidates, entityAliases, extractionReports, gardeningReports } from './db/index.js';
import { isNull, sql, inArray, eq } from 'drizzle-orm';
import { getMergeCandidates } from './services/graph-meta.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const vizHtml = readFileSync(join(__dirname, '../viz/index.html'), 'utf-8');

export const app = new Hono();

app.get('/health', async (c) => {
  const db = await checkDatabaseHealth();
  return c.json({ status: db ? 'ok' : 'degraded', db });
});

app.post('/ingest', async (c) => {
  const body = await c.req.json<{ text: string; source?: string }>();
  if (!body.text) return c.json({ error: 'text is required' }, 400);
  const result = await ingest(body.text, { source: body.source });
  return c.json(result);
});

app.post('/store', async (c) => {
  const body = await c.req.json<{ text: string; source?: string }>();
  if (!body.text) return c.json({ error: 'text is required' }, 400);
  const memoryId = await store(body.text, { source: body.source });
  return c.json({ memoryId });
});

app.post('/extract', async (c) => {
  const body = await c.req.json<{ memoryId: string }>();
  if (!body.memoryId) return c.json({ error: 'memoryId is required' }, 400);
  const result = await extract(body.memoryId);
  return c.json(result);
});

app.post('/ingest/queue', async (c) => {
  const body = await c.req.json<{ text: string; source?: string }>();
  if (!body.text) return c.json({ error: 'text is required' }, 400);
  const result = enqueueIngest(body.text, body.source);
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

app.get('/viz', (c) => c.html(vizHtml));

// Serve static JS files for the viz
app.get('/viz/js/:file', async (c) => {
  const file = c.req.param('file');
  if (!file.endsWith('.js')) return c.text('Not found', 404);
  try {
    const content = readFileSync(join(__dirname, '../viz/js', file), 'utf-8');
    return c.text(content, 200, { 'Content-Type': 'application/javascript' });
  } catch {
    return c.text('Not found', 404);
  }
});

app.get('/api/viz/entity-source-vectors', async (c) => {
  // For each entity, return its linked memory IDs so we can
  // compute cluster-based similarity from Qdrant vectors
  const links = await db.select({
    entityId: memoryEntities.entityId,
    entityName: entities.canonicalName,
    memoryId: memoryEntities.memoryId,
  }).from(memoryEntities)
    .innerJoin(entities, sql`${memoryEntities.entityId} = ${entities.id}`);

  // Group by entity
  const byEntity: Record<string, { name: string; memoryIds: string[] }> = {};
  for (const l of links) {
    if (!byEntity[l.entityId]) byEntity[l.entityId] = { name: l.entityName, memoryIds: [] };
    byEntity[l.entityId]!.memoryIds.push(l.memoryId);
  }
  return c.json(byEntity);
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

app.get('/api/viz/causal-edge-sources', async (c) => {
  const edges = await db.select({
    id: causalEdges.id,
    strength: causalEdges.strength,
    reasoning: causalEdges.reasoning,
    sourceReferences: causalEdges.sourceReferences,
    sourceMemoryId: causalEdges.sourceMemoryId,
    sourceText: causalEdges.sourceText,
  }).from(causalEdges).where(isNull(causalEdges.expiredAt));
  return c.json(edges);
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
  for (const memId of allMemoryIds) {
    const linkedEntities = memoryToEntities[memId] ?? [];
    for (const entityId of [...new Set(linkedEntities)]) {
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
  try {
    console.log('[garden] invoking gardener agent...');
    const result = await invokeGardenerAgent({ trigger: 'manual' });
    const durationMs = Date.now() - tStart;
    console.log(`[garden] complete in ${durationMs}ms`);
    console.log('[garden] --- REPORT ---');
    console.log(result.result || '(no report)');
    console.log('[garden] --- END REPORT ---');

    // Store report
    db.insert(gardeningReports).values({
      triggerType: 'manual',
      reportText: result.result || '(no report)',
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
  if (
    hypothetical !== undefined &&
    hypothetical !== 'expire' &&
    hypothetical !== 'invalidate' &&
    hypothetical !== 'weaken'
  ) {
    return c.json(
      { error: `Invalid hypothetical "${hypothetical}" — expected expire|invalidate|weaken` },
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
      hypothetical: hypothetical as 'expire' | 'invalidate' | 'weaken' | undefined,
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

app.get('/api/viz/graph-s', async (c) => {
  const [ents, fcts, memLinks] = await Promise.all([
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
  ]);

  // Build source material map: entityId → [{memoryId, mentionText, context}]
  const sourcesMap: Record<string, { memoryId: string; mentionText: string | null; context: string | null }[]> = {};
  for (const m of memLinks) {
    if (!sourcesMap[m.entityId]) sourcesMap[m.entityId] = [];
    sourcesMap[m.entityId]!.push({
      memoryId: m.memoryId,
      mentionText: m.mentionText,
      context: m.mentionContext,
    });
  }

  const nodes: Record<string, unknown>[] = ents.map(e => ({
    id: e.id, label: e.canonicalName, type: e.entityType, confidence: e.confidence,
    sources: sourcesMap[e.id] ?? [],
  }));

  // Build a set of entity IDs for quick lookup
  const entityIds = new Set(ents.map(e => e.id));
  const links: Record<string, unknown>[] = [];
  let valueIdx = 0;

  for (const f of fcts) {
    if (f.objectEntityId && entityIds.has(f.subjectEntityId) && entityIds.has(f.objectEntityId)) {
      links.push({
        id: f.id, source: f.subjectEntityId, target: f.objectEntityId,
        predicate: f.predicate, confidence: f.confidence, objectValue: null,
        sourceText: f.sourceText, sourceMemoryId: f.sourceMemoryId,
      });
    } else if (!f.objectEntityId && f.objectValue && entityIds.has(f.subjectEntityId)) {
      const vid = `_val_${valueIdx++}`;
      const label = f.objectValue.length > 30 ? f.objectValue.slice(0, 30) + '...' : f.objectValue;
      nodes.push({ id: vid, label, type: '_value', _isValue: true, sources: [] });
      links.push({
        id: f.id, source: f.subjectEntityId, target: vid,
        predicate: f.predicate, confidence: f.confidence, objectValue: f.objectValue,
        sourceText: f.sourceText, sourceMemoryId: f.sourceMemoryId,
      });
    }
  }

  return c.json({ nodes, links });
});

app.get('/api/viz/graph-c', async (c) => {
  const [events, edges] = await Promise.all([
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
    }).from(causalEvents).limit(200),
    db.select({
      id: causalEdges.id,
      causeEventId: causalEdges.causeEventId,
      effectEventId: causalEdges.effectEventId,
      strength: causalEdges.strength,
      reasoning: causalEdges.reasoning,
    }).from(causalEdges).where(isNull(causalEdges.expiredAt)).limit(500),
  ]);

  // Resolve entity names + types for anchor nodes
  const entityIdSet = new Set(events.map(e => e.subjectEntityId).filter(Boolean) as string[]);
  let entityMap: Record<string, { name: string; type: string }> = {};
  if (entityIdSet.size > 0) {
    const ents = await db.select({
      id: entities.id,
      canonicalName: entities.canonicalName,
      entityType: entities.entityType,
    }).from(entities).where(inArray(entities.id, [...entityIdSet]));
    entityMap = Object.fromEntries(ents.map(e => [e.id, { name: e.canonicalName, type: e.entityType }]));
  }

  const nodes: Record<string, unknown>[] = [];
  const links: Record<string, unknown>[] = [];

  // Add entity anchor nodes (larger, dimmer — context for the events)
  for (const [id, ent] of Object.entries(entityMap)) {
    nodes.push({
      id, label: ent.name, _nodeType: 'entity', entityType: ent.type,
    });
  }

  // Add causal event nodes
  for (const e of events) {
    const entName = e.subjectEntityId ? entityMap[e.subjectEntityId]?.name : null;
    nodes.push({
      id: e.id,
      label: `${e.transitionType}: ${e.predicate || '?'}`,
      _nodeType: 'event',
      transitionType: e.transitionType,
      predicate: e.predicate,
      occurredAt: e.occurredAt,
      entityName: entName,
      sourceText: e.sourceText,
      sourceMemoryId: e.sourceMemoryId,
      factId: e.factId,
      deltaConfidence: e.deltaConfidence,
    });
    // Link event → its entity anchor
    if (e.subjectEntityId && entityMap[e.subjectEntityId]) {
      links.push({
        id: `_anchor_${e.id}`,
        source: e.subjectEntityId,
        target: e.id,
        _linkType: 'anchor',
      });
    }
  }

  // Add causal edges (CAUSED)
  const eventIds = new Set(events.map(e => e.id));
  for (const e of edges) {
    if (eventIds.has(e.causeEventId) && eventIds.has(e.effectEventId)) {
      links.push({
        id: e.id, source: e.causeEventId, target: e.effectEventId,
        _linkType: 'caused',
        strength: e.strength, reasoning: e.reasoning,
      });
    }
  }

  return c.json({ nodes, links });
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
// Learning Platform API (/api/learn/)
// Thin write layer for the learning platform's MCP server.
// Keeps the learning platform fully decoupled — all graph ops go via HTTP.
// ============================================

app.post('/api/learn/record', async (c) => {
  const body = await c.req.json<{
    subjectName: string;
    subjectType: string;
    predicate: string;
    objectName?: string;
    objectType?: string;
    objectValue?: string;
    confidence?: number;
    sourceText?: string;
  }>();

  if (!body.subjectName || !body.predicate) {
    return c.json({ error: 'subjectName and predicate are required' }, 400);
  }

  const { resolveEntity } = await import('./services/entities.js');
  const { createFact } = await import('./services/facts.js');

  const subject = await resolveEntity(
    body.subjectName,
    body.sourceText ?? body.subjectName,
    body.subjectType,
  );

  let objectEntityId: string | undefined;
  if (body.objectName) {
    const obj = await resolveEntity(
      body.objectName,
      body.sourceText ?? body.objectName,
      body.objectType ?? 'concept',
    );
    objectEntityId = obj.id;
  }

  const factId = await createFact({
    subjectEntityId: subject.id,
    predicate: body.predicate,
    objectEntityId,
    objectValue: body.objectValue,
    confidence: body.confidence ?? 0.8,
    sourceText: body.sourceText,
    actor: 'user',
    reasoning: `Learning platform: ${body.predicate} via /api/learn/record`,
  });

  return c.json({ entityId: subject.id, factId });
});

app.get('/api/learn/concept/:name', async (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  const { findEntitiesByName } = await import('./services/entities.js');
  const { getEntityFacts } = await import('./services/facts.js');

  const matches = await findEntitiesByName(name, { fuzzy: true, limit: 5 });
  if (matches.length === 0) return c.json({ entity: null, facts: [] });

  const best = matches[0]!;
  const factsResult = await getEntityFacts(best.id);

  return c.json({
    entity: {
      id: best.id,
      canonicalName: best.canonicalName,
      entityType: best.entityType,
      confidence: best.confidence,
    },
    facts: factsResult,
  });
});

app.get('/api/learn/learner-facts', async (c) => {
  const { findEntitiesByName } = await import('./services/entities.js');
  const { getEntityFacts } = await import('./services/facts.js');

  const matches = await findEntitiesByName('Learner', { fuzzy: false, limit: 3, type: 'person' });
  const learnerEntity = matches[0];

  if (!learnerEntity) return c.json({ facts: [] });

  const facts = await getEntityFacts(learnerEntity.id);
  return c.json({ facts, learnerId: learnerEntity.id });
});

// MCP health probe — spawns causal-mcp.ts, asks for tools/list, returns the catalogue.
app.get('/api/mcp-health', async (c) => {
  const { checkCausalMcpHealth } = await import('./services/causal-agent.js');
  const result = await checkCausalMcpHealth();
  return c.json(result, result.ok ? 200 : 503);
});

const port = parseInt(process.env.PORT || '3000', 10);

// Skip the network listener when imported under Vitest so endpoint tests can
// drive routes via `app.request()` without binding the dev port.
if (!process.env.VITEST) {
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`Platform listening on :${info.port}`);
  });
}
