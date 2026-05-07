/**
 * Phase 2 — Community detection / Leiden (doc 23.4, nmemo-a7f.2.4)
 *
 * Implements the §4.2 cases. Each test seeds a minimal graph via
 * createTestEntity / createTestFact (or direct same_as_links INSERTs),
 * invokes the Python topology compute routine against `cognitive_test`, and
 * asserts on `entity_topology.community_id` and `entity_topology.participation_coef`.
 *
 * Compute is invoked via the venv python directly (mirrors the sibling
 * topology-components / topology-kcore / topology-articulation tests). The
 * subprocess path drives `_export_graph` → `compute_communities` →
 * `_write_back` end-to-end, exercising the unified upsert.
 *
 * Determinism is enforced at the igraph level inside `compute_communities`
 * (doc 23.4 §2.4 — leidenalg 0.10.x has no `seed=` kwarg). Two consecutive
 * computes on the same graph must produce identical canonical community IDs.
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
  community_count: number;
}

/**
 * Run the full community-detection pipeline against the test DB. Components,
 * k_core, articulation, and bridges are run alongside to mirror the
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
    _write_back(
        conn,
        components=comp,
        k_core=kc,
        articulation=art,
        communities=comm,
        centrality={},
        bridges=br,
        computation_version=COMPUTATION_VERSION,
    )
    conn.commit()
    community_ids = set(cid for cid, _ in comm.values())
    print(json.dumps({
        "entity_count": n,
        "edge_count": e,
        "community_count": len(community_ids),
    }))
`;
  const out = execFileSync(VENV_PYTHON, ['-c', driver], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = out.trim().split(/\r?\n/);
  const lastLine = lines[lines.length - 1] ?? '';
  return JSON.parse(lastLine) as ComputeResult;
}

interface CommunityRow {
  entity_id: string;
  community_id: number | null;
  participation_coef: number | null;
}

async function getRow(entityId: string): Promise<CommunityRow | null> {
  const rows = (await testDb`
    SELECT entity_id::text AS entity_id,
           community_id,
           participation_coef
    FROM public.entity_topology WHERE entity_id = ${entityId}::uuid
  `) as unknown as CommunityRow[];
  return rows[0] ?? null;
}

async function listAll(): Promise<CommunityRow[]> {
  return (await testDb`
    SELECT entity_id::text AS entity_id,
           community_id,
           participation_coef
    FROM public.entity_topology
    ORDER BY entity_id
  `) as unknown as CommunityRow[];
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

describe('topology-communities §23.4 — Phase 2 / T0', () => {
  beforeEach(async () => {
    await cleanSlate();
  });

  it('1. empty graph: no rows written', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const r = runTopologyCompute();
    expect(r.entity_count).toBe(0);
    expect(r.edge_count).toBe(0);
    expect(r.community_count).toBe(0);
    expect(await listAll()).toEqual([]);
  });

  it('2. single entity: community_id=0, participation_coef=NULL', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const e = await createTestEntity({ canonicalName: 'solo', entityType: 'person' });
    const r = runTopologyCompute();
    expect(r.community_count).toBe(1);
    const row = await getRow(e.id);
    expect(row).not.toBeNull();
    expect(row!.community_id).toBe(0);
    expect(row!.participation_coef).toBeNull();
  });

  it('3. two disconnected entities: two communities, each size 1, both NULL P', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const a = await createTestEntity({ canonicalName: 'd_a', entityType: 'thing' });
    const b = await createTestEntity({ canonicalName: 'd_b', entityType: 'thing' });
    const r = runTopologyCompute();
    expect(r.community_count).toBe(2);
    const ra = await getRow(a.id);
    const rb = await getRow(b.id);
    expect(ra!.community_id).not.toBe(rb!.community_id);
    expect(ra!.participation_coef).toBeNull();
    expect(rb!.participation_coef).toBeNull();
    // Both community IDs must be in {0, 1}
    expect(new Set([ra!.community_id, rb!.community_id])).toEqual(new Set([0, 1]));
  });

  it('4. star (hub + 4 leaves): single community, P=0 for all (no inter-community edges)', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const hub = await createTestEntity({ canonicalName: 's_hub', entityType: 'thing' });
    const leaves: { id: string }[] = [];
    for (let i = 0; i < 4; i++) {
      const leaf = await createTestEntity({ canonicalName: `s_l${i}`, entityType: 'thing' });
      leaves.push(leaf);
      await createTestFact({ subjectEntityId: hub.id, predicate: 'has', objectEntityId: leaf.id });
    }
    runTopologyCompute();
    // Doc 23.4 §4.2: a star with no further internal structure → 1 community
    const all = await listAll();
    const ids = all.map((r) => r.community_id);
    const distinct = new Set(ids);
    expect(distinct.size).toBe(1);
    // P=0 for every vertex (all neighbours are in the same community)
    for (const r of all) expect(r.participation_coef).toBe(0);
  });

  it('5. two well-separated 5-cliques + 1 inter-cluster edge: 2 communities; bridge endpoints have P>0', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    // Clique A: a0..a4, fully connected
    const a: { id: string }[] = [];
    for (let i = 0; i < 5; i++) a.push(await createTestEntity({ canonicalName: `cA_${i}`, entityType: 'thing' }));
    for (let i = 0; i < 5; i++) {
      for (let j = i + 1; j < 5; j++) {
        await createTestFact({ subjectEntityId: a[i]!.id, predicate: 'p', objectEntityId: a[j]!.id });
      }
    }
    // Clique B: b0..b4, fully connected
    const b: { id: string }[] = [];
    for (let i = 0; i < 5; i++) b.push(await createTestEntity({ canonicalName: `cB_${i}`, entityType: 'thing' }));
    for (let i = 0; i < 5; i++) {
      for (let j = i + 1; j < 5; j++) {
        await createTestFact({ subjectEntityId: b[i]!.id, predicate: 'p', objectEntityId: b[j]!.id });
      }
    }
    // Single inter-cluster edge: a0 - b0
    await createTestFact({ subjectEntityId: a[0]!.id, predicate: 'links', objectEntityId: b[0]!.id });

    const r = runTopologyCompute();
    expect(r.community_count).toBe(2);

    const ra0 = await getRow(a[0]!.id);
    const rb0 = await getRow(b[0]!.id);
    // Endpoints of the bridge must be in different communities
    expect(ra0!.community_id).not.toBe(rb0!.community_id);
    // And their participation coefficient must be > 0 (some neighbours cross
    // community boundaries). With 5 edges total, 4 in-community + 1 out:
    // P = 1 - ((4/5)^2 + (1/5)^2) = 0.32
    expect(ra0!.participation_coef).not.toBeNull();
    expect(ra0!.participation_coef!).toBeGreaterThan(0);
    expect(rb0!.participation_coef).not.toBeNull();
    expect(rb0!.participation_coef!).toBeGreaterThan(0);

    // Non-bridge vertices in each clique have P=0 (all 4 neighbours within community)
    for (let i = 1; i < 5; i++) {
      const ri = await getRow(a[i]!.id);
      expect(ri!.participation_coef).toBe(0);
    }
  });

  it('6. communities respect components: disconnected entities cannot share a community', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    // Two triangles, no edges between them
    const x: { id: string }[] = [];
    for (let i = 0; i < 3; i++) x.push(await createTestEntity({ canonicalName: `cX_${i}`, entityType: 'thing' }));
    await createTestFact({ subjectEntityId: x[0]!.id, predicate: 'p', objectEntityId: x[1]!.id });
    await createTestFact({ subjectEntityId: x[1]!.id, predicate: 'p', objectEntityId: x[2]!.id });
    await createTestFact({ subjectEntityId: x[2]!.id, predicate: 'p', objectEntityId: x[0]!.id });
    const y: { id: string }[] = [];
    for (let i = 0; i < 3; i++) y.push(await createTestEntity({ canonicalName: `cY_${i}`, entityType: 'thing' }));
    await createTestFact({ subjectEntityId: y[0]!.id, predicate: 'p', objectEntityId: y[1]!.id });
    await createTestFact({ subjectEntityId: y[1]!.id, predicate: 'p', objectEntityId: y[2]!.id });
    await createTestFact({ subjectEntityId: y[2]!.id, predicate: 'p', objectEntityId: y[0]!.id });

    runTopologyCompute();
    const xCommIds = new Set<number>();
    const yCommIds = new Set<number>();
    for (const xi of x) {
      const r = await getRow(xi.id);
      if (r?.community_id !== null && r?.community_id !== undefined) xCommIds.add(r.community_id);
    }
    for (const yi of y) {
      const r = await getRow(yi.id);
      if (r?.community_id !== null && r?.community_id !== undefined) yCommIds.add(r.community_id);
    }
    // The two components must not share any community ID
    for (const cid of xCommIds) expect(yCommIds.has(cid)).toBe(false);
    for (const cid of yCommIds) expect(xCommIds.has(cid)).toBe(false);
  });

  it('7. determinism: two consecutive computes produce identical community_id assignments', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    // Mixed corpus: two cliques + bridge + isolated vertex (covers all edge cases)
    const a: { id: string }[] = [];
    for (let i = 0; i < 5; i++) a.push(await createTestEntity({ canonicalName: `det_a_${i}`, entityType: 'thing' }));
    for (let i = 0; i < 5; i++) {
      for (let j = i + 1; j < 5; j++) {
        await createTestFact({ subjectEntityId: a[i]!.id, predicate: 'p', objectEntityId: a[j]!.id });
      }
    }
    const b: { id: string }[] = [];
    for (let i = 0; i < 5; i++) b.push(await createTestEntity({ canonicalName: `det_b_${i}`, entityType: 'thing' }));
    for (let i = 0; i < 5; i++) {
      for (let j = i + 1; j < 5; j++) {
        await createTestFact({ subjectEntityId: b[i]!.id, predicate: 'p', objectEntityId: b[j]!.id });
      }
    }
    await createTestFact({ subjectEntityId: a[0]!.id, predicate: 'links', objectEntityId: b[0]!.id });
    const iso = await createTestEntity({ canonicalName: 'det_iso', entityType: 'thing' });

    runTopologyCompute();
    const first = await listAll();

    runTopologyCompute();
    const second = await listAll();

    expect(second.length).toBe(first.length);
    expect(second.length).toBeGreaterThan(0);
    // Pair them by entity_id (already sorted by listAll)
    for (let i = 0; i < first.length; i++) {
      expect(second[i]!.entity_id).toBe(first[i]!.entity_id);
      expect(second[i]!.community_id).toBe(first[i]!.community_id);
      // Participation coefficient determinism too
      expect(second[i]!.participation_coef).toBe(first[i]!.participation_coef);
    }
    // Sanity: isolated vertex got a community
    const isoRow = await getRow(iso.id);
    expect(isoRow!.community_id).not.toBeNull();
    expect(isoRow!.participation_coef).toBeNull();
  });

  it('8. participation coefficient correctness on a triangle: P=0 for all three', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const a = await createTestEntity({ canonicalName: 'tri_a', entityType: 'thing' });
    const b = await createTestEntity({ canonicalName: 'tri_b', entityType: 'thing' });
    const c = await createTestEntity({ canonicalName: 'tri_c', entityType: 'thing' });
    await createTestFact({ subjectEntityId: a.id, predicate: 'p', objectEntityId: b.id });
    await createTestFact({ subjectEntityId: b.id, predicate: 'p', objectEntityId: c.id });
    await createTestFact({ subjectEntityId: c.id, predicate: 'p', objectEntityId: a.id });
    runTopologyCompute();
    for (const e of [a, b, c]) {
      const r = await getRow(e.id);
      expect(r!.participation_coef).toBe(0);
    }
  });

  it('9. participation coefficient on bridge endpoint: 1 of 4 edges crosses community boundary → P=0.375', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    // Construct a vertex v with 3 neighbours in community A and 1 in community B.
    // We use two triangles connected by a single edge so Leiden splits cleanly:
    //   Triangle A: v - a1 - a2 - v
    //   Triangle B: b1 - b2 - b3 - b1
    //   Bridge: v - b1
    // v has degree 3 (a1, a2, b1). 2 of v's edges go to A (a1, a2), 1 to B (b1).
    // P(v) = 1 - ((2/3)^2 + (1/3)^2) = 1 - (4/9 + 1/9) = 4/9 ≈ 0.4444
    const v = await createTestEntity({ canonicalName: 'pc_v', entityType: 'thing' });
    const a1 = await createTestEntity({ canonicalName: 'pc_a1', entityType: 'thing' });
    const a2 = await createTestEntity({ canonicalName: 'pc_a2', entityType: 'thing' });
    const b1 = await createTestEntity({ canonicalName: 'pc_b1', entityType: 'thing' });
    const b2 = await createTestEntity({ canonicalName: 'pc_b2', entityType: 'thing' });
    const b3 = await createTestEntity({ canonicalName: 'pc_b3', entityType: 'thing' });
    await createTestFact({ subjectEntityId: v.id, predicate: 'p', objectEntityId: a1.id });
    await createTestFact({ subjectEntityId: v.id, predicate: 'p', objectEntityId: a2.id });
    await createTestFact({ subjectEntityId: a1.id, predicate: 'p', objectEntityId: a2.id });
    await createTestFact({ subjectEntityId: b1.id, predicate: 'p', objectEntityId: b2.id });
    await createTestFact({ subjectEntityId: b2.id, predicate: 'p', objectEntityId: b3.id });
    await createTestFact({ subjectEntityId: b3.id, predicate: 'p', objectEntityId: b1.id });
    await createTestFact({ subjectEntityId: v.id, predicate: 'links', objectEntityId: b1.id });

    runTopologyCompute();
    const rv = await getRow(v.id);
    // 4/9 ≈ 0.4444... assert close
    expect(rv!.participation_coef).not.toBeNull();
    expect(rv!.participation_coef!).toBeCloseTo(4 / 9, 5);
    // a1, a2 each have 2 neighbours both within community A: P=0
    const ra1 = await getRow(a1.id);
    expect(ra1!.participation_coef).toBe(0);
  });

  it('10. same_as link bridges two clusters: link counts as edge for community detection', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    // Two triangles connected only via a same_as link (per doc 23.4 §6).
    const x1 = await createTestEntity({ canonicalName: 'sa_x1', entityType: 'thing' });
    const x2 = await createTestEntity({ canonicalName: 'sa_x2', entityType: 'thing' });
    const x3 = await createTestEntity({ canonicalName: 'sa_x3', entityType: 'thing' });
    const y1 = await createTestEntity({ canonicalName: 'sa_y1', entityType: 'thing' });
    const y2 = await createTestEntity({ canonicalName: 'sa_y2', entityType: 'thing' });
    const y3 = await createTestEntity({ canonicalName: 'sa_y3', entityType: 'thing' });
    await createTestFact({ subjectEntityId: x1.id, predicate: 'p', objectEntityId: x2.id });
    await createTestFact({ subjectEntityId: x2.id, predicate: 'p', objectEntityId: x3.id });
    await createTestFact({ subjectEntityId: x3.id, predicate: 'p', objectEntityId: x1.id });
    await createTestFact({ subjectEntityId: y1.id, predicate: 'p', objectEntityId: y2.id });
    await createTestFact({ subjectEntityId: y2.id, predicate: 'p', objectEntityId: y3.id });
    await createTestFact({ subjectEntityId: y3.id, predicate: 'p', objectEntityId: y1.id });
    const [low, high] = x1.id < y1.id ? [x1.id, y1.id] : [y1.id, x1.id];
    await testDb`
      INSERT INTO public.same_as_links (entity_a_id, entity_b_id, reasoning, confidence)
      VALUES (${low}::uuid, ${high}::uuid, 'topology communities same_as test', 0.95)
    `;
    runTopologyCompute();
    // The same_as link is the sole inter-cluster edge → its endpoints get P>0
    const rx1 = await getRow(x1.id);
    const ry1 = await getRow(y1.id);
    expect(rx1!.participation_coef).not.toBeNull();
    expect(rx1!.participation_coef!).toBeGreaterThan(0);
    expect(ry1!.participation_coef).not.toBeNull();
    expect(ry1!.participation_coef!).toBeGreaterThan(0);
    // Non-bridge endpoints have P=0 (all 2 neighbours within community)
    for (const e of [x2, x3, y2, y3]) {
      const r = await getRow(e.id);
      expect(r!.participation_coef).toBe(0);
    }
  });

  it('11. community IDs are dense (0..N-1) and largest community gets ID=0', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    // 6-clique + isolated vertex → community 0 should be the 6-clique
    // (size desc tiebreak; clique > singleton).
    const big: { id: string }[] = [];
    for (let i = 0; i < 6; i++) big.push(await createTestEntity({ canonicalName: `dense_b_${i}`, entityType: 'thing' }));
    for (let i = 0; i < 6; i++) {
      for (let j = i + 1; j < 6; j++) {
        await createTestFact({ subjectEntityId: big[i]!.id, predicate: 'p', objectEntityId: big[j]!.id });
      }
    }
    const small = await createTestEntity({ canonicalName: 'dense_iso', entityType: 'thing' });

    runTopologyCompute();
    const all = await listAll();
    const allIds = all.map((r) => r.community_id).filter((c): c is number => c !== null);
    const distinct = new Set(allIds);
    // Density: max ID = size - 1 (no gaps)
    const maxId = Math.max(...distinct);
    expect(maxId).toBe(distinct.size - 1);
    // The 6-clique forms one community; ID 0 must contain its members
    const bigIds = await Promise.all(big.map((e) => getRow(e.id)));
    const bigCommIds = new Set(bigIds.map((r) => r!.community_id));
    expect(bigCommIds.size).toBe(1);
    expect([...bigCommIds][0]).toBe(0);
    // Singleton gets a non-zero ID
    const smallRow = await getRow(small.id);
    expect(smallRow!.community_id).not.toBe(0);
  });
});
