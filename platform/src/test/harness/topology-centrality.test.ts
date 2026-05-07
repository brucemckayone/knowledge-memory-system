/**
 * Phase 2 — Centrality / PageRank + sampled betweenness (doc 23.5, nmemo-a7f.2.5)
 *
 * Implements the §4.2 cases. Each test seeds a minimal graph via
 * createTestEntity / createTestFact (or direct same_as_links INSERTs),
 * invokes the Python topology compute routine against `cognitive_test`, and
 * asserts on `entity_topology.pagerank` and `entity_topology.betweenness_sampled`.
 *
 * Compute is invoked via the venv python directly (mirrors the sibling
 * topology-{components,kcore,articulation,communities} tests). The subprocess
 * path drives `_export_graph` → `compute_centrality` → `_write_back` end-to-end,
 * exercising the unified upsert.
 *
 * Determinism: PageRank is intrinsically deterministic for a fixed graph (the
 * power-iteration converges to the same fixed point). Sampled betweenness is
 * deterministic too because `compute_betweenness` pins NetworkX's `seed=42`
 * (doc 23.5 §3.1). Two consecutive computes on the same graph must produce
 * identical values bit-for-bit.
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
  pagerank_sum: number;
  pagerank_max: number;
  betweenness_max: number;
}

/**
 * Run the full centrality pipeline against the test DB. Components, k_core,
 * articulation, bridges, and communities run alongside to mirror the
 * production write-back shape (the unified `_write_back` upserts every active
 * feature in one transaction per master 23 §2.3.2).
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
    compute_communities,
    compute_centrality,
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
    comm = compute_communities(g, computation_version=COMPUTATION_VERSION)
    cent = compute_centrality(g)
    _write_back(
        conn,
        components=comp,
        k_core=kc,
        articulation=art,
        communities=comm,
        centrality=cent,
        bridges=br,
        computation_version=COMPUTATION_VERSION,
    )
    conn.commit()
    pr_vals = [pr for pr, _ in cent.values()] if cent else []
    bw_vals = [bw for _, bw in cent.values()] if cent else []
    print(json.dumps({
        "entity_count": n,
        "edge_count": e,
        "pagerank_sum": sum(pr_vals),
        "pagerank_max": max(pr_vals) if pr_vals else 0.0,
        "betweenness_max": max(bw_vals) if bw_vals else 0.0,
    }))
`;
  const out = execFileSync(VENV_PYTHON, ['-c', driver], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = out.trim().split(/\r?\n/);
  const lastLine = lines[lines.length - 1] ?? '';
  return JSON.parse(lastLine) as ComputeResult;
}

interface CentralityRow {
  entity_id: string;
  pagerank: number | null;
  betweenness_sampled: number | null;
}

async function getRow(entityId: string): Promise<CentralityRow | null> {
  const rows = (await testDb`
    SELECT entity_id::text AS entity_id,
           pagerank,
           betweenness_sampled
    FROM public.entity_topology WHERE entity_id = ${entityId}::uuid
  `) as unknown as CentralityRow[];
  return rows[0] ?? null;
}

async function listAll(): Promise<CentralityRow[]> {
  return (await testDb`
    SELECT entity_id::text AS entity_id,
           pagerank,
           betweenness_sampled
    FROM public.entity_topology
    ORDER BY entity_id
  `) as unknown as CentralityRow[];
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

// PageRank sum-invariant tolerance — matches algorithm convergence per doc
// 23.5 §2.1 (PAGERANK_EPS = 1e-6) and §4.2 cold-eyes review W1.
const PR_SUM_TOL = 1e-6;

describe('topology-centrality §23.5 — Phase 2 / T0', () => {
  beforeEach(async () => {
    await cleanSlate();
  });

  it('1. empty graph: no rows written', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const r = runTopologyCompute();
    expect(r.entity_count).toBe(0);
    expect(r.edge_count).toBe(0);
    expect(await listAll()).toEqual([]);
  });

  it('2. single entity: pagerank=1.0, betweenness=0', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const e = await createTestEntity({ canonicalName: 'cent_solo', entityType: 'person' });
    runTopologyCompute();
    const row = await getRow(e.id);
    expect(row).not.toBeNull();
    expect(row!.pagerank).not.toBeNull();
    expect(row!.pagerank!).toBeCloseTo(1.0, 9);
    expect(row!.betweenness_sampled).toBe(0);
  });

  it('3. two disconnected entities: each pagerank=0.5, betweenness=0', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const a = await createTestEntity({ canonicalName: 'cent_da', entityType: 'thing' });
    const b = await createTestEntity({ canonicalName: 'cent_db', entityType: 'thing' });
    runTopologyCompute();
    const ra = await getRow(a.id);
    const rb = await getRow(b.id);
    expect(ra!.pagerank!).toBeCloseTo(0.5, 6);
    expect(rb!.pagerank!).toBeCloseTo(0.5, 6);
    expect(ra!.betweenness_sampled).toBe(0);
    expect(rb!.betweenness_sampled).toBe(0);
  });

  it('4. star (1 hub, 4 leaves): hub PR > leaves; leaves all equal; hub bw=1.0; leaves bw=0', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const hub = await createTestEntity({ canonicalName: 'cent_hub', entityType: 'thing' });
    const leaves: { id: string }[] = [];
    for (let i = 0; i < 4; i++) {
      const leaf = await createTestEntity({ canonicalName: `cent_l${i}`, entityType: 'thing' });
      leaves.push(leaf);
      await createTestFact({ subjectEntityId: hub.id, predicate: 'has', objectEntityId: leaf.id });
    }
    runTopologyCompute();
    const hubRow = await getRow(hub.id);
    const leafRows = await Promise.all(leaves.map((l) => getRow(l.id)));
    // Hub has highest PR
    for (const lr of leafRows) {
      expect(hubRow!.pagerank!).toBeGreaterThan(lr!.pagerank!);
    }
    // Leaves all equal
    const firstLeafPr = leafRows[0]!.pagerank!;
    for (const lr of leafRows) {
      expect(lr!.pagerank!).toBeCloseTo(firstLeafPr, 9);
    }
    // Hub betweenness = 1.0 (every shortest path between leaves passes through it)
    expect(hubRow!.betweenness_sampled!).toBeCloseTo(1.0, 6);
    for (const lr of leafRows) {
      expect(lr!.betweenness_sampled).toBe(0);
    }
  });

  it('5. triangle: equal PR (1/3 each); all betweenness=0', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const a = await createTestEntity({ canonicalName: 'tri_pa', entityType: 'thing' });
    const b = await createTestEntity({ canonicalName: 'tri_pb', entityType: 'thing' });
    const c = await createTestEntity({ canonicalName: 'tri_pc', entityType: 'thing' });
    await createTestFact({ subjectEntityId: a.id, predicate: 'p', objectEntityId: b.id });
    await createTestFact({ subjectEntityId: b.id, predicate: 'p', objectEntityId: c.id });
    await createTestFact({ subjectEntityId: c.id, predicate: 'p', objectEntityId: a.id });
    runTopologyCompute();
    for (const e of [a, b, c]) {
      const r = await getRow(e.id);
      expect(r!.pagerank!).toBeCloseTo(1 / 3, 6);
      expect(r!.betweenness_sampled).toBe(0);
    }
  });

  it('6. path A-B-C-D: B & C have positive betweenness; A & D = 0', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const A = await createTestEntity({ canonicalName: 'path_A', entityType: 'thing' });
    const B = await createTestEntity({ canonicalName: 'path_B', entityType: 'thing' });
    const C = await createTestEntity({ canonicalName: 'path_C', entityType: 'thing' });
    const D = await createTestEntity({ canonicalName: 'path_D', entityType: 'thing' });
    await createTestFact({ subjectEntityId: A.id, predicate: 'p', objectEntityId: B.id });
    await createTestFact({ subjectEntityId: B.id, predicate: 'p', objectEntityId: C.id });
    await createTestFact({ subjectEntityId: C.id, predicate: 'p', objectEntityId: D.id });
    runTopologyCompute();
    const rA = await getRow(A.id);
    const rB = await getRow(B.id);
    const rC = await getRow(C.id);
    const rD = await getRow(D.id);
    expect(rB!.betweenness_sampled!).toBeGreaterThan(0);
    expect(rC!.betweenness_sampled!).toBeGreaterThan(0);
    expect(rA!.betweenness_sampled).toBe(0);
    expect(rD!.betweenness_sampled).toBe(0);
  });

  it('7. bridge graph (two triangles + bridge edge): bridge endpoints have higher bw than non-endpoints', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    // Triangle A: a1-a2-a3-a1; Triangle B: b1-b2-b3-b1; bridge a3-b1
    const a1 = await createTestEntity({ canonicalName: 'br_a1', entityType: 'thing' });
    const a2 = await createTestEntity({ canonicalName: 'br_a2', entityType: 'thing' });
    const a3 = await createTestEntity({ canonicalName: 'br_a3', entityType: 'thing' });
    const b1 = await createTestEntity({ canonicalName: 'br_b1', entityType: 'thing' });
    const b2 = await createTestEntity({ canonicalName: 'br_b2', entityType: 'thing' });
    const b3 = await createTestEntity({ canonicalName: 'br_b3', entityType: 'thing' });
    await createTestFact({ subjectEntityId: a1.id, predicate: 'p', objectEntityId: a2.id });
    await createTestFact({ subjectEntityId: a2.id, predicate: 'p', objectEntityId: a3.id });
    await createTestFact({ subjectEntityId: a3.id, predicate: 'p', objectEntityId: a1.id });
    await createTestFact({ subjectEntityId: b1.id, predicate: 'p', objectEntityId: b2.id });
    await createTestFact({ subjectEntityId: b2.id, predicate: 'p', objectEntityId: b3.id });
    await createTestFact({ subjectEntityId: b3.id, predicate: 'p', objectEntityId: b1.id });
    await createTestFact({ subjectEntityId: a3.id, predicate: 'links', objectEntityId: b1.id });
    runTopologyCompute();
    const ra1 = await getRow(a1.id);
    const ra3 = await getRow(a3.id);
    const rb1 = await getRow(b1.id);
    const rb3 = await getRow(b3.id);
    // Bridge endpoints (a3, b1) dominate
    expect(ra3!.betweenness_sampled!).toBeGreaterThan(ra1!.betweenness_sampled!);
    expect(rb1!.betweenness_sampled!).toBeGreaterThan(rb3!.betweenness_sampled!);
    expect(ra3!.betweenness_sampled!).toBeGreaterThan(0);
    expect(rb1!.betweenness_sampled!).toBeGreaterThan(0);
  });

  it('8. PageRank sum invariant: SUM(pagerank) ≈ 1.0 within tolerance', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    // Mix: clique + path + isolated vertex (covers connected & disconnected)
    const clique: { id: string }[] = [];
    for (let i = 0; i < 4; i++) clique.push(await createTestEntity({ canonicalName: `sum_c${i}`, entityType: 'thing' }));
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
        await createTestFact({ subjectEntityId: clique[i]!.id, predicate: 'p', objectEntityId: clique[j]!.id });
      }
    }
    const p1 = await createTestEntity({ canonicalName: 'sum_p1', entityType: 'thing' });
    const p2 = await createTestEntity({ canonicalName: 'sum_p2', entityType: 'thing' });
    await createTestFact({ subjectEntityId: p1.id, predicate: 'p', objectEntityId: p2.id });
    await createTestEntity({ canonicalName: 'sum_iso', entityType: 'thing' });

    const r = runTopologyCompute();
    expect(Math.abs(r.pagerank_sum - 1.0)).toBeLessThan(PR_SUM_TOL);
    // Database-level invariant too
    const rows = (await testDb`
      SELECT COALESCE(SUM(pagerank), 0)::float AS s FROM public.entity_topology
    `) as unknown as { s: number }[];
    expect(Math.abs(rows[0]!.s - 1.0)).toBeLessThan(PR_SUM_TOL);
  });

  it('9. determinism: two consecutive computes produce identical pagerank + betweenness', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    // Mixed corpus to exercise both PageRank fixed-point and the seeded
    // betweenness path. n stays well below the BETWEENNESS_EXACT_THRESHOLD=200,
    // so we exercise the exact-igraph branch — deterministic by construction.
    // (The seeded sampled branch is exercised in the §5 benchmark.)
    const a: { id: string }[] = [];
    for (let i = 0; i < 5; i++) a.push(await createTestEntity({ canonicalName: `det_pa_${i}`, entityType: 'thing' }));
    for (let i = 0; i < 5; i++) {
      for (let j = i + 1; j < 5; j++) {
        await createTestFact({ subjectEntityId: a[i]!.id, predicate: 'p', objectEntityId: a[j]!.id });
      }
    }
    const b: { id: string }[] = [];
    for (let i = 0; i < 5; i++) b.push(await createTestEntity({ canonicalName: `det_pb_${i}`, entityType: 'thing' }));
    for (let i = 0; i < 5; i++) {
      for (let j = i + 1; j < 5; j++) {
        await createTestFact({ subjectEntityId: b[i]!.id, predicate: 'p', objectEntityId: b[j]!.id });
      }
    }
    await createTestFact({ subjectEntityId: a[0]!.id, predicate: 'links', objectEntityId: b[0]!.id });

    runTopologyCompute();
    const first = await listAll();
    runTopologyCompute();
    const second = await listAll();

    expect(second.length).toBe(first.length);
    expect(second.length).toBeGreaterThan(0);
    for (let i = 0; i < first.length; i++) {
      expect(second[i]!.entity_id).toBe(first[i]!.entity_id);
      expect(second[i]!.pagerank).toBe(first[i]!.pagerank);
      expect(second[i]!.betweenness_sampled).toBe(first[i]!.betweenness_sampled);
    }
  });

  it('10. disconnected components: PageRank still sums to 1; betweenness=0 for size<3 components', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    // Triangle (size 3) + edge (size 2) + isolated (size 1)
    const t1 = await createTestEntity({ canonicalName: 'disc_t1', entityType: 'thing' });
    const t2 = await createTestEntity({ canonicalName: 'disc_t2', entityType: 'thing' });
    const t3 = await createTestEntity({ canonicalName: 'disc_t3', entityType: 'thing' });
    await createTestFact({ subjectEntityId: t1.id, predicate: 'p', objectEntityId: t2.id });
    await createTestFact({ subjectEntityId: t2.id, predicate: 'p', objectEntityId: t3.id });
    await createTestFact({ subjectEntityId: t3.id, predicate: 'p', objectEntityId: t1.id });
    const e1 = await createTestEntity({ canonicalName: 'disc_e1', entityType: 'thing' });
    const e2 = await createTestEntity({ canonicalName: 'disc_e2', entityType: 'thing' });
    await createTestFact({ subjectEntityId: e1.id, predicate: 'p', objectEntityId: e2.id });
    const iso = await createTestEntity({ canonicalName: 'disc_iso', entityType: 'thing' });

    const r = runTopologyCompute();
    expect(Math.abs(r.pagerank_sum - 1.0)).toBeLessThan(PR_SUM_TOL);

    // Triangle: bw=0 (cycle); 2-edge: bw=0 (path of length 1, no intermediate); iso: bw=0
    for (const e of [t1, t2, t3, e1, e2, iso]) {
      const row = await getRow(e.id);
      expect(row!.betweenness_sampled).toBe(0);
      // PageRank populated for every vertex
      expect(row!.pagerank).not.toBeNull();
      expect(row!.pagerank!).toBeGreaterThan(0);
    }
  });

  it('11. same_as link counts as edge for centrality', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    // Two triangles connected only via a same_as link (per doc 23.5 §6).
    const x1 = await createTestEntity({ canonicalName: 'sa_cx1', entityType: 'thing' });
    const x2 = await createTestEntity({ canonicalName: 'sa_cx2', entityType: 'thing' });
    const x3 = await createTestEntity({ canonicalName: 'sa_cx3', entityType: 'thing' });
    const y1 = await createTestEntity({ canonicalName: 'sa_cy1', entityType: 'thing' });
    const y2 = await createTestEntity({ canonicalName: 'sa_cy2', entityType: 'thing' });
    const y3 = await createTestEntity({ canonicalName: 'sa_cy3', entityType: 'thing' });
    await createTestFact({ subjectEntityId: x1.id, predicate: 'p', objectEntityId: x2.id });
    await createTestFact({ subjectEntityId: x2.id, predicate: 'p', objectEntityId: x3.id });
    await createTestFact({ subjectEntityId: x3.id, predicate: 'p', objectEntityId: x1.id });
    await createTestFact({ subjectEntityId: y1.id, predicate: 'p', objectEntityId: y2.id });
    await createTestFact({ subjectEntityId: y2.id, predicate: 'p', objectEntityId: y3.id });
    await createTestFact({ subjectEntityId: y3.id, predicate: 'p', objectEntityId: y1.id });
    const [low, high] = x1.id < y1.id ? [x1.id, y1.id] : [y1.id, x1.id];
    await testDb`
      INSERT INTO public.same_as_links (entity_a_id, entity_b_id, reasoning, confidence)
      VALUES (${low}::uuid, ${high}::uuid, 'topology centrality same_as test', 0.95)
    `;
    runTopologyCompute();
    // The same_as link is the sole inter-cluster edge → its endpoints sit on
    // every shortest path between the two triangles → their betweenness > 0
    const rx1 = await getRow(x1.id);
    const ry1 = await getRow(y1.id);
    expect(rx1!.betweenness_sampled!).toBeGreaterThan(0);
    expect(ry1!.betweenness_sampled!).toBeGreaterThan(0);
    // Non-bridge vertices in each triangle have betweenness=0
    for (const e of [x2, x3, y2, y3]) {
      const r = await getRow(e.id);
      expect(r!.betweenness_sampled).toBe(0);
    }
  });

  it('12. all vertices get non-NULL pagerank + betweenness_sampled (no gaps)', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    // 5 entities, sparse edges
    const e0 = await createTestEntity({ canonicalName: 'gap_e0', entityType: 'thing' });
    const e1 = await createTestEntity({ canonicalName: 'gap_e1', entityType: 'thing' });
    const e2 = await createTestEntity({ canonicalName: 'gap_e2', entityType: 'thing' });
    const e3 = await createTestEntity({ canonicalName: 'gap_e3', entityType: 'thing' });
    const e4 = await createTestEntity({ canonicalName: 'gap_e4', entityType: 'thing' });
    await createTestFact({ subjectEntityId: e0.id, predicate: 'p', objectEntityId: e1.id });
    await createTestFact({ subjectEntityId: e1.id, predicate: 'p', objectEntityId: e2.id });
    runTopologyCompute();
    for (const e of [e0, e1, e2, e3, e4]) {
      const r = await getRow(e.id);
      expect(r).not.toBeNull();
      expect(r!.pagerank).not.toBeNull();
      expect(r!.betweenness_sampled).not.toBeNull();
    }
  });
});
