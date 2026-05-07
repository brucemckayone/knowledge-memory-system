/**
 * Phase 2 — k-core decomposition (doc 23.2, nmemo-a7f.2.2)
 *
 * Implements the §4.2 cases. Each test seeds a minimal graph via
 * createTestEntity / createTestFact, invokes the Python topology compute
 * routine against `cognitive_test`, and asserts on the `k_core` column of
 * `entity_topology`.
 *
 * Compute is invoked via the venv python directly (mirrors the sibling
 * topology-components test rationale): going through the long-lived
 * ml-services sidecar would force a restart to point at cognitive_test.
 * The subprocess path drives the same `topology.py` functions (`_export_graph`
 * → `compute_k_core` → `_write_back`).
 *
 * Live HTTP integration with the running sidecar is verified separately via
 * the §5.2 benchmark + manual checks; not gated on this suite.
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
}

/**
 * Run `topology.compute_k_core` (and `compute_components` for canonical
 * write-back parity with production) end-to-end against the test DB.
 * Components is included because `_write_back` is feature-agnostic — running
 * it in isolation against k_core only would still write a row, but pairing
 * with components matches the live `topology_compute()` call shape.
 */
function runTopologyCompute(): ComputeResult {
  const driver = `
import sys, os, json
sys.path.insert(0, r"${ML_SERVICES_DIR.replace(/\\/g, '\\\\')}")
os.environ["DATABASE_URL"] = r"${TEST_DB_URL}"
from app.topology import _export_graph, compute_components, compute_k_core, _write_back, COMPUTATION_VERSION
import psycopg
from psycopg.rows import dict_row
with psycopg.connect(r"${TEST_DB_URL}", row_factory=dict_row) as conn:
    g, n, e = _export_graph(conn)
    comp = compute_components(g)
    kc = compute_k_core(g)
    _write_back(conn, components=comp, k_core=kc, articulation={}, communities={}, centrality={}, computation_version=COMPUTATION_VERSION)
    conn.commit()
    print(json.dumps({"entity_count": n, "edge_count": e}))
`;
  const out = execFileSync(VENV_PYTHON, ['-c', driver], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = out.trim().split(/\r?\n/);
  const lastLine = lines[lines.length - 1] ?? '';
  return JSON.parse(lastLine) as ComputeResult;
}

interface KCoreRow {
  entity_id: string;
  k_core: number | null;
  computation_version: number;
}

async function getKCore(entityId: string): Promise<KCoreRow | null> {
  const rows = (await testDb`
    SELECT entity_id::text AS entity_id, k_core, computation_version
    FROM public.entity_topology WHERE entity_id = ${entityId}::uuid
  `) as unknown as KCoreRow[];
  return rows[0] ?? null;
}

async function topologyRowCount(): Promise<number> {
  const rows = (await testDb`SELECT COUNT(*)::int AS n FROM public.entity_topology`) as unknown as { n: number }[];
  return rows[0]?.n ?? 0;
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

describe('topology-kcore §23.2 — Phase 2 / T0', () => {
  beforeEach(async () => {
    await cleanSlate();
  });

  it('1. empty graph: no rows in entity_topology', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const r = runTopologyCompute();
    expect(r.entity_count).toBe(0);
    expect(r.edge_count).toBe(0);
    expect(await topologyRowCount()).toBe(0);
  });

  it('2. single entity: one row, k_core=0', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const e = await createTestEntity({ canonicalName: 'solo', entityType: 'person' });
    runTopologyCompute();
    const row = await getKCore(e.id);
    expect(row).not.toBeNull();
    expect(row!.k_core).toBe(0);
  });

  it('3. two entities with no edge between them: both k_core=0', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const a = await createTestEntity({ canonicalName: 'a', entityType: 'thing' });
    const b = await createTestEntity({ canonicalName: 'b', entityType: 'thing' });
    runTopologyCompute();
    expect((await getKCore(a.id))!.k_core).toBe(0);
    expect((await getKCore(b.id))!.k_core).toBe(0);
  });

  it('4. two entities with one fact between them: both k_core=1', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const a = await createTestEntity({ canonicalName: 'a', entityType: 'thing' });
    const b = await createTestEntity({ canonicalName: 'b', entityType: 'thing' });
    await createTestFact({ subjectEntityId: a.id, predicate: 'knows', objectEntityId: b.id });
    runTopologyCompute();
    expect((await getKCore(a.id))!.k_core).toBe(1);
    expect((await getKCore(b.id))!.k_core).toBe(1);
  });

  it('5. star graph (1 hub + 4 leaves): every vertex k_core=1', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const hub = await createTestEntity({ canonicalName: 'hub', entityType: 'person' });
    const leaves = [
      await createTestEntity({ canonicalName: 'l1', entityType: 'person' }),
      await createTestEntity({ canonicalName: 'l2', entityType: 'person' }),
      await createTestEntity({ canonicalName: 'l3', entityType: 'person' }),
      await createTestEntity({ canonicalName: 'l4', entityType: 'person' }),
    ];
    for (const leaf of leaves) {
      await createTestFact({ subjectEntityId: hub.id, predicate: 'knows', objectEntityId: leaf.id });
    }
    runTopologyCompute();
    // Per doc 23.2 §4.2: in a star, leaves peel at degree 1; the hub then peels at 1 too.
    expect((await getKCore(hub.id))!.k_core).toBe(1);
    for (const leaf of leaves) {
      expect((await getKCore(leaf.id))!.k_core).toBe(1);
    }
  });

  it('6. triangle (3 entities pairwise connected): all k_core=2', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const a = await createTestEntity({ canonicalName: 'a', entityType: 'thing' });
    const b = await createTestEntity({ canonicalName: 'b', entityType: 'thing' });
    const c = await createTestEntity({ canonicalName: 'c', entityType: 'thing' });
    await createTestFact({ subjectEntityId: a.id, predicate: 'p', objectEntityId: b.id });
    await createTestFact({ subjectEntityId: b.id, predicate: 'p', objectEntityId: c.id });
    await createTestFact({ subjectEntityId: c.id, predicate: 'p', objectEntityId: a.id });
    runTopologyCompute();
    expect((await getKCore(a.id))!.k_core).toBe(2);
    expect((await getKCore(b.id))!.k_core).toBe(2);
    expect((await getKCore(c.id))!.k_core).toBe(2);
  });

  it('7. complete K4 (4 entities, 6 edges): all k_core=3', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const v: { id: string }[] = [];
    for (let i = 0; i < 4; i++) {
      v.push(await createTestEntity({ canonicalName: `k${i}`, entityType: 'thing' }));
    }
    // K4: every pair connected
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
        await createTestFact({ subjectEntityId: v[i]!.id, predicate: 'p', objectEntityId: v[j]!.id });
      }
    }
    runTopologyCompute();
    for (const e of v) {
      expect((await getKCore(e.id))!.k_core).toBe(3);
    }
  });

  it('8. path graph (A-B-C-D): all k_core=1', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const v: { id: string }[] = [];
    for (let i = 0; i < 4; i++) {
      v.push(await createTestEntity({ canonicalName: `p${i}`, entityType: 'thing' }));
    }
    for (let i = 0; i < 3; i++) {
      await createTestFact({ subjectEntityId: v[i]!.id, predicate: 'next', objectEntityId: v[i + 1]!.id });
    }
    runTopologyCompute();
    for (const e of v) {
      expect((await getKCore(e.id))!.k_core).toBe(1);
    }
  });

  it('9. star plus extra edge between two leaves: triangle leaves k_core=2, other leaves k_core=1', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    // Star with hub h and four leaves l1..l4, plus an extra edge l1-l2.
    // The triangle {h, l1, l2} forms a 2-core: each of those three vertices
    // has degree ≥ 2 inside the triangle. l3, l4 are still leaves (degree 1).
    // After peeling l3 and l4 (k=1), the triangle survives intact at k=2.
    const hub = await createTestEntity({ canonicalName: 'hub', entityType: 'thing' });
    const l1 = await createTestEntity({ canonicalName: 'l1', entityType: 'thing' });
    const l2 = await createTestEntity({ canonicalName: 'l2', entityType: 'thing' });
    const l3 = await createTestEntity({ canonicalName: 'l3', entityType: 'thing' });
    const l4 = await createTestEntity({ canonicalName: 'l4', entityType: 'thing' });
    await createTestFact({ subjectEntityId: hub.id, predicate: 'p', objectEntityId: l1.id });
    await createTestFact({ subjectEntityId: hub.id, predicate: 'p', objectEntityId: l2.id });
    await createTestFact({ subjectEntityId: hub.id, predicate: 'p', objectEntityId: l3.id });
    await createTestFact({ subjectEntityId: hub.id, predicate: 'p', objectEntityId: l4.id });
    await createTestFact({ subjectEntityId: l1.id, predicate: 'p', objectEntityId: l2.id });
    runTopologyCompute();
    expect((await getKCore(hub.id))!.k_core).toBe(2);
    expect((await getKCore(l1.id))!.k_core).toBe(2);
    expect((await getKCore(l2.id))!.k_core).toBe(2);
    expect((await getKCore(l3.id))!.k_core).toBe(1);
    expect((await getKCore(l4.id))!.k_core).toBe(1);
  });

  it('10. self-referential fact ignored: entity has k_core=0', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const e = await createTestEntity({ canonicalName: 's', entityType: 'thing' });
    // Bypass createTestFact's no-self-reference guard by direct SQL.
    try {
      await testDb`
        INSERT INTO public.facts (subject_entity_id, predicate, object_entity_id)
        VALUES (${e.id}::uuid, 'cycle', ${e.id}::uuid)
      `;
    } catch {
      // self-reference forbidden at DB level — fine; export filter is moot.
    }
    runTopologyCompute();
    const row = await getKCore(e.id);
    expect(row!.k_core).toBe(0);
  });

  it('11. expired fact excluded: A-B fact bridge becomes k_core=0 for both after expiry', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const a = await createTestEntity({ canonicalName: 'a', entityType: 'thing' });
    const b = await createTestEntity({ canonicalName: 'b', entityType: 'thing' });
    const f = await createTestFact({ subjectEntityId: a.id, predicate: 'knows', objectEntityId: b.id });
    runTopologyCompute();
    expect((await getKCore(a.id))!.k_core).toBe(1);
    expect((await getKCore(b.id))!.k_core).toBe(1);

    await testDb`UPDATE public.facts SET expired_at = NOW() WHERE id = ${f.id}::uuid`;
    runTopologyCompute();
    expect((await getKCore(a.id))!.k_core).toBe(0);
    expect((await getKCore(b.id))!.k_core).toBe(0);
  });

  it('12. same_as link counted as edge: both endpoints k_core=1', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const a = await createTestEntity({ canonicalName: 'a', entityType: 'thing' });
    const b = await createTestEntity({ canonicalName: 'b', entityType: 'thing' });
    // same_as_links CHECK constraint: a_id < b_id; reasoning NOT NULL.
    const [low, high] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
    await testDb`
      INSERT INTO public.same_as_links (entity_a_id, entity_b_id, reasoning, confidence)
      VALUES (${low}::uuid, ${high}::uuid, 'topology kcore test bridge', 0.95)
    `;
    runTopologyCompute();
    expect((await getKCore(a.id))!.k_core).toBe(1);
    expect((await getKCore(b.id))!.k_core).toBe(1);
  });

  it('13. determinism: two consecutive computes produce identical k_core values', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    // Build a mixed graph: a triangle + a path + an isolated vertex.
    const t = [
      await createTestEntity({ canonicalName: 't0', entityType: 'thing' }),
      await createTestEntity({ canonicalName: 't1', entityType: 'thing' }),
      await createTestEntity({ canonicalName: 't2', entityType: 'thing' }),
    ];
    await createTestFact({ subjectEntityId: t[0]!.id, predicate: 'p', objectEntityId: t[1]!.id });
    await createTestFact({ subjectEntityId: t[1]!.id, predicate: 'p', objectEntityId: t[2]!.id });
    await createTestFact({ subjectEntityId: t[2]!.id, predicate: 'p', objectEntityId: t[0]!.id });

    const p = [
      await createTestEntity({ canonicalName: 'p0', entityType: 'thing' }),
      await createTestEntity({ canonicalName: 'p1', entityType: 'thing' }),
      await createTestEntity({ canonicalName: 'p2', entityType: 'thing' }),
    ];
    await createTestFact({ subjectEntityId: p[0]!.id, predicate: 'q', objectEntityId: p[1]!.id });
    await createTestFact({ subjectEntityId: p[1]!.id, predicate: 'q', objectEntityId: p[2]!.id });

    const iso = await createTestEntity({ canonicalName: 'iso', entityType: 'thing' });

    runTopologyCompute();
    const all = [...t, ...p, iso];
    const first = await Promise.all(all.map(e => getKCore(e.id)));
    runTopologyCompute();
    const second = await Promise.all(all.map(e => getKCore(e.id)));

    for (let i = 0; i < all.length; i++) {
      expect(second[i]!.k_core).toBe(first[i]!.k_core);
    }
    // Sanity check the values themselves
    for (const e of t) expect((await getKCore(e.id))!.k_core).toBe(2);
    for (const e of p) expect((await getKCore(e.id))!.k_core).toBe(1);
    expect((await getKCore(iso.id))!.k_core).toBe(0);
  });
});
