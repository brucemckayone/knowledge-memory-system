/**
 * Platform HTTP server — entry point for Docker container.
 * Exposes the pipeline (ingest/store/extract), health check, and graph viz.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { ingest, store, extract, enqueueIngest } from './pipeline.js';
import { db, checkDatabaseHealth, entities, facts, memoryEntities, causalEvents, causalEdges, entityMeta, sameAsLinks, mergeCandidates, entityAliases, extractionReports, gardeningReports } from './db/index.js';
import { isNull, sql, inArray, eq } from 'drizzle-orm';
import { getMergeCandidates } from './services/graph-meta.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const vizHtml = readFileSync(join(__dirname, '../viz/index.html'), 'utf-8');

const app = new Hono();

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

app.post('/api/viz/clear', async (c) => {
  // Delete in FK-safe order
  for (const table of ['reasoning_reports', 'gardening_reports', 'same_as_links', 'extraction_reports', 'merge_candidates', 'entity_meta', 'memory_entities', 'entity_aliases', 'causal_edges', 'causal_events', 'causal_patterns', 'facts', 'entity_merges', 'entities']) {
    await db.execute(sql.raw(`DELETE FROM ${table}`));
  }
  return c.json({ cleared: true });
});

app.post('/api/reset', async (c) => {
  // 1. Clear PG tables (FK-safe order)
  for (const table of ['reasoning_reports', 'gardening_reports', 'same_as_links', 'extraction_reports', 'merge_candidates', 'entity_meta', 'memory_entities', 'entity_aliases', 'causal_edges', 'causal_events', 'causal_patterns', 'facts', 'entity_merges', 'entities']) {
    await db.execute(sql.raw(`DELETE FROM ${table}`));
  }
  // 2. Clear Qdrant
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

// MCP health probe — spawns causal-mcp.ts, asks for tools/list, returns the catalogue.
app.get('/api/mcp-health', async (c) => {
  const { checkCausalMcpHealth } = await import('./services/causal-agent.js');
  const result = await checkCausalMcpHealth();
  return c.json(result, result.ok ? 200 : 503);
});

const port = parseInt(process.env.PORT || '3000', 10);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Platform listening on :${info.port}`);
});
