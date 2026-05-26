/**
 * Phase 2 — Articulation points & bridges (doc 23.3, nmemo-a7f.2.3)
 *
 * Implements the §4.2 cases. Each test seeds a minimal graph via
 * createTestEntity / createTestFact (or direct same_as_links INSERTs),
 * invokes the Python topology compute routine against `cognitive_test`, and
 * asserts on `entity_topology.is_articulation_point` and `topology_bridges`.
 *
 * Compute is invoked via the venv python directly (mirrors the sibling
 * topology-components and topology-kcore tests). The subprocess path drives
 * the same `topology.py` functions (`_export_graph` → `compute_articulation`
 * + `compute_bridges` → `_write_back`) and exercises the unconditional
 * `DELETE FROM topology_bridges` + bulk INSERT pattern from doc 23.3 §3.2 /
 * master 23 §2.3.2.
 *
 * Live HTTP integration with the running sidecar is covered by the bead .86
 * HTTP-layer test scaffolding in topology-clustering-drift-http.test.ts
 * (app.request() + mocked ml-services) and the §5.2 benchmark; not gated
 * on this suite.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  testDb,
  createTestEntity,
  createTestFact,
  deleteFromTables,
  skipCtx,
} from '../setup.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VENV_PYTHON = join(__dirname, '..', '..', '..', '..', 'ml-services', '.venv', 'Scripts', 'python.exe');
const ML_SERVICES_DIR = join(__dirname, '..', '..', '..', '..', 'ml-services');
const TEST_DB_URL = process.env.TEST_DATABASE_URL
  ?? 'postgresql://cognitive:cognitive@127.0.0.1:5433/cognitive_test';

interface ComputeResult {
  entity_count: number;
  edge_count: number;
  articulation_point_count: number;
  bridge_count: number;
}

/**
 * Run the full articulation + bridge pipeline against the test DB. Components
 * and k_core are run alongside to mirror production write-back shape (the
 * unified `_write_back` upserts every active feature in one transaction).
 */
function runTopologyCompute(): ComputeResult {
  const driver = `
import sys, os, json
sys.path.insert(0, r"${ML_SERVICES_DIR.replace(/\\/g, '\\\\')}")
os.environ["DATABASE_URL"] = r"${TEST_DB_URL}"
from app.topology import (
    _export_graph,
    compute_components,
    compute_k_core,
    compute_articulation,
    compute_bridges,
    _write_back,
    COMPUTATION_VERSION,
)
import psycopg
from psycopg.rows import dict_row
with psycopg.connect(r"${TEST_DB_URL}", row_factory=dict_row) as conn:
    g, n, e = _export_graph(conn)
    comp = compute_components(g)
    kc = compute_k_core(g)
    art = compute_articulation(g)
    br = compute_bridges(g)
    _write_back(
        conn,
        components=comp,
        k_core=kc,
        articulation=art,
        communities={},
        centrality={},
        bridges=br,
        computation_version=COMPUTATION_VERSION,
    )
    conn.commit()
    print(json.dumps({
        "entity_count": n,
        "edge_count": e,
        "articulation_point_count": sum(1 for v in art.values() if v),
        "bridge_count": len(br),
    }))
`;
  const out = execFileSync(VENV_PYTHON, ['-c', driver], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = out.trim().split(/\r?\n/);
  const lastLine = lines[lines.length - 1] ?? '';
  return JSON.parse(lastLine) as ComputeResult;
}

interface ArticulationRow {
  entity_id: string;
  is_articulation_point: boolean;
}

async function isArticulation(entityId: string): Promise<boolean> {
  const rows = (await testDb`
    SELECT entity_id::text AS entity_id, is_articulation_point
    FROM public.entity_topology WHERE entity_id = ${entityId}::uuid
  `) as unknown as ArticulationRow[];
  return rows[0]?.is_articulation_point === true;
}

interface BridgeRow {
  source_entity_id: string;
  target_entity_id: string;
  fact_id: string | null;
  same_as_link_id: string | null;
}

async function listBridges(): Promise<BridgeRow[]> {
  return (await testDb`
    SELECT source_entity_id::text AS source_entity_id,
           target_entity_id::text AS target_entity_id,
           fact_id::text AS fact_id,
           same_as_link_id::text AS same_as_link_id
    FROM public.topology_bridges
    ORDER BY source_entity_id, target_entity_id
  `) as unknown as BridgeRow[];
}

async function bridgeBetween(idA: string, idB: string): Promise<BridgeRow | null> {
  const [low, high] = idA < idB ? [idA, idB] : [idB, idA];
  const rows = (await testDb`
    SELECT source_entity_id::text AS source_entity_id,
           target_entity_id::text AS target_entity_id,
           fact_id::text AS fact_id,
           same_as_link_id::text AS same_as_link_id
    FROM public.topology_bridges
    WHERE source_entity_id = ${low}::uuid
      AND target_entity_id = ${high}::uuid
  `) as unknown as BridgeRow[];
  return rows[0] ?? null;
}

async function cleanSlate(): Promise<void> {
  await deleteFromTables({
    tables: [
      'fact_history',
      'memory_entities',
      'facts',
      'merge_candidates',
      'entities',
    ],
    acknowledgeGlobal: true,
  });
  await testDb`DELETE FROM public.entity_topology`;
  await testDb`DELETE FROM public.topology_compute_runs`;
  await testDb`DELETE FROM public.topology_bridges`;
  await testDb`DELETE FROM public.same_as_links`;
}

describe('topology-articulation §23.3 — Phase 2 / T0', () => {
  beforeEach(async () => {
    await cleanSlate();
  });

  it('1. empty graph: no articulation points, no bridges', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const r = runTopologyCompute();
    expect(r.entity_count).toBe(0);
    expect(r.edge_count).toBe(0);
    expect(r.articulation_point_count).toBe(0);
    expect(r.bridge_count).toBe(0);
    expect(await listBridges()).toEqual([]);
  });

  it('2. single entity: not articulation, no bridges', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const e = await createTestEntity({ canonicalName: 'solo', entityType: 'person' });
    const r = runTopologyCompute();
    expect(r.articulation_point_count).toBe(0);
    expect(await isArticulation(e.id)).toBe(false);
    expect(await listBridges()).toEqual([]);
  });

  it('3. two entities + one fact: edge is a bridge; neither endpoint is articulation', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const a = await createTestEntity({ canonicalName: 'a', entityType: 'thing' });
    const b = await createTestEntity({ canonicalName: 'b', entityType: 'thing' });
    const f = await createTestFact({ subjectEntityId: a.id, predicate: 'knows', objectEntityId: b.id });
    const r = runTopologyCompute();
    expect(r.bridge_count).toBe(1);
    expect(await isArticulation(a.id)).toBe(false);
    expect(await isArticulation(b.id)).toBe(false);
    const bridge = await bridgeBetween(a.id, b.id);
    expect(bridge).not.toBeNull();
    expect(bridge!.fact_id).toBe(f.id);
    expect(bridge!.same_as_link_id).toBeNull();
    // canonical ordering CHECK: source < target
    expect(bridge!.source_entity_id < bridge!.target_entity_id).toBe(true);
  });

  it('4. path A-B-C-D: B and C are articulation; A,D are not; every edge is a bridge', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const a = await createTestEntity({ canonicalName: 'p_a', entityType: 'thing' });
    const b = await createTestEntity({ canonicalName: 'p_b', entityType: 'thing' });
    const c = await createTestEntity({ canonicalName: 'p_c', entityType: 'thing' });
    const d = await createTestEntity({ canonicalName: 'p_d', entityType: 'thing' });
    await createTestFact({ subjectEntityId: a.id, predicate: 'next', objectEntityId: b.id });
    await createTestFact({ subjectEntityId: b.id, predicate: 'next', objectEntityId: c.id });
    await createTestFact({ subjectEntityId: c.id, predicate: 'next', objectEntityId: d.id });
    runTopologyCompute();
    expect(await isArticulation(a.id)).toBe(false);
    expect(await isArticulation(b.id)).toBe(true);
    expect(await isArticulation(c.id)).toBe(true);
    expect(await isArticulation(d.id)).toBe(false);
    expect((await listBridges()).length).toBe(3);
  });

  it('5. triangle: no articulation points, no bridges', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const a = await createTestEntity({ canonicalName: 't_a', entityType: 'thing' });
    const b = await createTestEntity({ canonicalName: 't_b', entityType: 'thing' });
    const c = await createTestEntity({ canonicalName: 't_c', entityType: 'thing' });
    await createTestFact({ subjectEntityId: a.id, predicate: 'p', objectEntityId: b.id });
    await createTestFact({ subjectEntityId: b.id, predicate: 'p', objectEntityId: c.id });
    await createTestFact({ subjectEntityId: c.id, predicate: 'p', objectEntityId: a.id });
    const r = runTopologyCompute();
    expect(r.articulation_point_count).toBe(0);
    expect(r.bridge_count).toBe(0);
    expect(await isArticulation(a.id)).toBe(false);
    expect(await isArticulation(b.id)).toBe(false);
    expect(await isArticulation(c.id)).toBe(false);
  });

  it('6. two triangles connected by one edge: connector is bridge; its endpoints are articulation', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    // Triangle 1: a1-a2-a3, Triangle 2: b1-b2-b3, bridge: a1-b1
    const a1 = await createTestEntity({ canonicalName: 'a1', entityType: 'thing' });
    const a2 = await createTestEntity({ canonicalName: 'a2', entityType: 'thing' });
    const a3 = await createTestEntity({ canonicalName: 'a3', entityType: 'thing' });
    const b1 = await createTestEntity({ canonicalName: 'b1', entityType: 'thing' });
    const b2 = await createTestEntity({ canonicalName: 'b2', entityType: 'thing' });
    const b3 = await createTestEntity({ canonicalName: 'b3', entityType: 'thing' });
    await createTestFact({ subjectEntityId: a1.id, predicate: 'p', objectEntityId: a2.id });
    await createTestFact({ subjectEntityId: a2.id, predicate: 'p', objectEntityId: a3.id });
    await createTestFact({ subjectEntityId: a3.id, predicate: 'p', objectEntityId: a1.id });
    await createTestFact({ subjectEntityId: b1.id, predicate: 'p', objectEntityId: b2.id });
    await createTestFact({ subjectEntityId: b2.id, predicate: 'p', objectEntityId: b3.id });
    await createTestFact({ subjectEntityId: b3.id, predicate: 'p', objectEntityId: b1.id });
    const connector = await createTestFact({
      subjectEntityId: a1.id,
      predicate: 'links',
      objectEntityId: b1.id,
    });
    runTopologyCompute();
    expect(await isArticulation(a1.id)).toBe(true);
    expect(await isArticulation(b1.id)).toBe(true);
    // Non-connector triangle vertices should NOT be articulation
    for (const e of [a2, a3, b2, b3]) {
      expect(await isArticulation(e.id)).toBe(false);
    }
    const bridges = await listBridges();
    expect(bridges.length).toBe(1);
    expect(bridges[0]!.fact_id).toBe(connector.id);
    expect(bridges[0]!.same_as_link_id).toBeNull();
  });

  it('7. star (hub + 4 leaves): hub is articulation; every spoke is a bridge', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const hub = await createTestEntity({ canonicalName: 's_hub', entityType: 'thing' });
    const leaves: { id: string }[] = [];
    const factIds: string[] = [];
    for (let i = 0; i < 4; i++) {
      const leaf = await createTestEntity({ canonicalName: `s_l${i}`, entityType: 'thing' });
      leaves.push(leaf);
      const f = await createTestFact({ subjectEntityId: hub.id, predicate: 'has', objectEntityId: leaf.id });
      factIds.push(f.id);
    }
    runTopologyCompute();
    expect(await isArticulation(hub.id)).toBe(true);
    for (const leaf of leaves) {
      expect(await isArticulation(leaf.id)).toBe(false);
    }
    const bridges = await listBridges();
    expect(bridges.length).toBe(4);
    // Each spoke fact must appear as a bridge
    const recordedFactIds = new Set(bridges.map((b) => b.fact_id));
    for (const fid of factIds) expect(recordedFactIds.has(fid)).toBe(true);
  });

  it('8. same_as link bridges two disconnected clusters: link appears in topology_bridges', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    // Cluster 1: triangle x1-x2-x3
    const x1 = await createTestEntity({ canonicalName: 'x1', entityType: 'thing' });
    const x2 = await createTestEntity({ canonicalName: 'x2', entityType: 'thing' });
    const x3 = await createTestEntity({ canonicalName: 'x3', entityType: 'thing' });
    await createTestFact({ subjectEntityId: x1.id, predicate: 'p', objectEntityId: x2.id });
    await createTestFact({ subjectEntityId: x2.id, predicate: 'p', objectEntityId: x3.id });
    await createTestFact({ subjectEntityId: x3.id, predicate: 'p', objectEntityId: x1.id });
    // Cluster 2: triangle y1-y2-y3
    const y1 = await createTestEntity({ canonicalName: 'y1', entityType: 'thing' });
    const y2 = await createTestEntity({ canonicalName: 'y2', entityType: 'thing' });
    const y3 = await createTestEntity({ canonicalName: 'y3', entityType: 'thing' });
    await createTestFact({ subjectEntityId: y1.id, predicate: 'p', objectEntityId: y2.id });
    await createTestFact({ subjectEntityId: y2.id, predicate: 'p', objectEntityId: y3.id });
    await createTestFact({ subjectEntityId: y3.id, predicate: 'p', objectEntityId: y1.id });
    // Bridge them with a same_as link x1 ↔ y1
    const [low, high] = x1.id < y1.id ? [x1.id, y1.id] : [y1.id, x1.id];
    const inserted = (await testDb`
      INSERT INTO public.same_as_links (entity_a_id, entity_b_id, reasoning, confidence)
      VALUES (${low}::uuid, ${high}::uuid, 'topology articulation test', 0.95)
      RETURNING id::text AS id
    `) as unknown as { id: string }[];
    const linkId = inserted[0]!.id;

    runTopologyCompute();
    const bridges = await listBridges();
    expect(bridges.length).toBe(1);
    expect(bridges[0]!.same_as_link_id).toBe(linkId);
    expect(bridges[0]!.fact_id).toBeNull();
    expect(await isArticulation(x1.id)).toBe(true);
    expect(await isArticulation(y1.id)).toBe(true);
  });

  it('9. fact + same_as on same pair: neither edge is a bridge (multi-edge handling)', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const a = await createTestEntity({ canonicalName: 'me_a', entityType: 'thing' });
    const b = await createTestEntity({ canonicalName: 'me_b', entityType: 'thing' });
    await createTestFact({ subjectEntityId: a.id, predicate: 'knows', objectEntityId: b.id });
    const [low, high] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
    await testDb`
      INSERT INTO public.same_as_links (entity_a_id, entity_b_id, reasoning, confidence)
      VALUES (${low}::uuid, ${high}::uuid, 'multi-edge test', 0.9)
    `;
    runTopologyCompute();
    // igraph's bridges() does not flag an edge whose endpoints are also
    // connected by another edge — see doc 23.3 §6 multi-edges entry.
    expect((await listBridges()).length).toBe(0);
    expect(await isArticulation(a.id)).toBe(false);
    expect(await isArticulation(b.id)).toBe(false);
  });

  it('10. component of size 2: no articulation point in that pair', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    // Same as test 3 but explicit on the §6 edge case.
    const a = await createTestEntity({ canonicalName: 'pair_a', entityType: 'thing' });
    const b = await createTestEntity({ canonicalName: 'pair_b', entityType: 'thing' });
    await createTestFact({ subjectEntityId: a.id, predicate: 'p', objectEntityId: b.id });
    runTopologyCompute();
    expect(await isArticulation(a.id)).toBe(false);
    expect(await isArticulation(b.id)).toBe(false);
  });

  it('11. cascade: expiring a bridge fact recomputes the bridge as gone, both endpoints isolated', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const a = await createTestEntity({ canonicalName: 'cas_a', entityType: 'thing' });
    const b = await createTestEntity({ canonicalName: 'cas_b', entityType: 'thing' });
    const f = await createTestFact({ subjectEntityId: a.id, predicate: 'knows', objectEntityId: b.id });
    runTopologyCompute();
    expect((await listBridges()).length).toBe(1);

    await testDb`UPDATE public.facts SET expired_at = NOW() WHERE id = ${f.id}::uuid`;
    runTopologyCompute();
    expect((await listBridges()).length).toBe(0);
    expect(await isArticulation(a.id)).toBe(false);
    expect(await isArticulation(b.id)).toBe(false);
  });

  it('12. determinism: two consecutive computes produce identical articulation + bridge sets', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    // Mixed: two triangles with a connecting fact (predictable single bridge,
    // two articulation points) plus an isolated entity.
    const a1 = await createTestEntity({ canonicalName: 'd_a1', entityType: 'thing' });
    const a2 = await createTestEntity({ canonicalName: 'd_a2', entityType: 'thing' });
    const a3 = await createTestEntity({ canonicalName: 'd_a3', entityType: 'thing' });
    const b1 = await createTestEntity({ canonicalName: 'd_b1', entityType: 'thing' });
    const b2 = await createTestEntity({ canonicalName: 'd_b2', entityType: 'thing' });
    const b3 = await createTestEntity({ canonicalName: 'd_b3', entityType: 'thing' });
    const iso = await createTestEntity({ canonicalName: 'd_iso', entityType: 'thing' });
    await createTestFact({ subjectEntityId: a1.id, predicate: 'p', objectEntityId: a2.id });
    await createTestFact({ subjectEntityId: a2.id, predicate: 'p', objectEntityId: a3.id });
    await createTestFact({ subjectEntityId: a3.id, predicate: 'p', objectEntityId: a1.id });
    await createTestFact({ subjectEntityId: b1.id, predicate: 'p', objectEntityId: b2.id });
    await createTestFact({ subjectEntityId: b2.id, predicate: 'p', objectEntityId: b3.id });
    await createTestFact({ subjectEntityId: b3.id, predicate: 'p', objectEntityId: b1.id });
    await createTestFact({ subjectEntityId: a1.id, predicate: 'links', objectEntityId: b1.id });

    runTopologyCompute();
    const ids = [a1, a2, a3, b1, b2, b3, iso].map((e) => e.id);
    const aps1 = await Promise.all(ids.map((id) => isArticulation(id)));
    const br1 = await listBridges();

    runTopologyCompute();
    const aps2 = await Promise.all(ids.map((id) => isArticulation(id)));
    const br2 = await listBridges();

    expect(aps2).toEqual(aps1);
    expect(br2.length).toBe(br1.length);
    // Same fact_id / same_as_link_id sets across recomputes
    const set1 = new Set(br1.map((b) => `${b.fact_id ?? ''}|${b.same_as_link_id ?? ''}`));
    const set2 = new Set(br2.map((b) => `${b.fact_id ?? ''}|${b.same_as_link_id ?? ''}`));
    expect(set2).toEqual(set1);
    // Sanity: exactly one bridge (the connector) and exactly two articulation points (a1, b1)
    expect(br1.length).toBe(1);
    expect(aps1.filter(Boolean).length).toBe(2);
  });

  it('13. bridges table is rewritten unconditionally on every compute (DELETE then INSERT)', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    // First compute with a bridge present.
    const a = await createTestEntity({ canonicalName: 'rw_a', entityType: 'thing' });
    const b = await createTestEntity({ canonicalName: 'rw_b', entityType: 'thing' });
    const f = await createTestFact({ subjectEntityId: a.id, predicate: 'knows', objectEntityId: b.id });
    runTopologyCompute();
    expect((await listBridges()).length).toBe(1);

    // Add a parallel same_as link; the original fact is no longer a bridge.
    const [low, high] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
    await testDb`
      INSERT INTO public.same_as_links (entity_a_id, entity_b_id, reasoning, confidence)
      VALUES (${low}::uuid, ${high}::uuid, 'rewrite test', 0.9)
    `;
    runTopologyCompute();
    // After recompute the multi-edge pair has no bridge — the prior row must be gone.
    expect((await listBridges()).length).toBe(0);

    // Drop the same_as link; bridge should reappear (and the row must be a fresh INSERT).
    await testDb`DELETE FROM public.same_as_links`;
    runTopologyCompute();
    const after = await listBridges();
    expect(after.length).toBe(1);
    expect(after[0]!.fact_id).toBe(f.id);
  });
});
