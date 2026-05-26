/**
 * Phase 2 — Connected components (doc 23.1, nmemo-a7f.2.1)
 *
 * Implements the eleven §4.2 cases. Each test seeds a minimal graph via
 * createTestEntity / createTestFact, invokes the Python topology compute
 * routine against `cognitive_test`, and asserts on `entity_topology` rows.
 *
 * Compute is invoked via the venv python directly rather than through HTTP.
 * Going through `ml-services` would require the running sidecar to point at
 * cognitive_test, which forces a restart of a long-lived dev process. The
 * subprocess path drives the same `topology.py` functions, with full
 * per-test control of DATABASE_URL and zero external state.
 *
 * The integration with the live sidecar (POST /api/topology/compute) is
 * covered by the bead .86 HTTP-layer test scaffolding in
 * topology-clustering-drift-http.test.ts (app.request() + mocked ml-services)
 * and the §5.2 benchmark; not gated on this suite.
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
  hasVectorExtension,
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
  component_count: number;
}

/**
 * Run `topology.compute_components` end-to-end against the test DB.
 * Spawns the venv python with a tiny inline driver. Stdout's last JSON line
 * carries the summary; intermediate logging is ignored.
 */
function runTopologyCompute(): ComputeResult {
  // Python here uses os.environ override before importing topology so the
  // module-level _DEFAULT_DB_URL does not leak the dev DB into the sidecar
  // call site. The `_export_graph` / `compute_components` / `_write_back`
  // pipeline mirrors what POST /topology/compute drives in production.
  const driver = `
import sys, os, json
sys.path.insert(0, r"${ML_SERVICES_DIR.replace(/\\/g, '\\\\')}")
os.environ["DATABASE_URL"] = r"${TEST_DB_URL}"
from app.topology import _export_graph, compute_components, _write_back, COMPUTATION_VERSION
import psycopg
from psycopg.rows import dict_row
with psycopg.connect(r"${TEST_DB_URL}", row_factory=dict_row) as conn:
    g, n, e = _export_graph(conn)
    comp = compute_components(g)
    _write_back(conn, components=comp, k_core={}, articulation={}, communities={}, centrality={}, computation_version=COMPUTATION_VERSION)
    conn.commit()
    component_ids = set(cid for cid, _ in comp.values())
    print(json.dumps({"entity_count": n, "edge_count": e, "component_count": len(component_ids)}))
`;
  const out = execFileSync(VENV_PYTHON, ['-c', driver], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = out.trim().split(/\r?\n/);
  const lastLine = lines[lines.length - 1] ?? '';
  return JSON.parse(lastLine) as ComputeResult;
}

interface TopologyRow {
  entity_id: string;
  component_id: number | null;
  component_size: number | null;
  computation_version: number;
}

async function getTopology(entityId: string): Promise<TopologyRow | null> {
  const rows = (await testDb`
    SELECT entity_id::text AS entity_id, component_id, component_size, computation_version
    FROM public.entity_topology WHERE entity_id = ${entityId}::uuid
  `) as unknown as TopologyRow[];
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
  // same_as_links isn't in the default ordered list either
  await testDb`DELETE FROM public.same_as_links`;
}

describe('topology-components §23.1 — Phase 2 / T0', () => {
  beforeEach(async () => {
    await cleanSlate();
  });

  it('1. empty graph: compute returns no rows in entity_topology', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const r = runTopologyCompute();
    expect(r.entity_count).toBe(0);
    expect(r.edge_count).toBe(0);
    expect(r.component_count).toBe(0);
    expect(await topologyRowCount()).toBe(0);
  });

  it('2. single entity: one row, component_id=0, size=1', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const e = await createTestEntity({ canonicalName: 'solo', entityType: 'person' });
    runTopologyCompute();
    const row = await getTopology(e.id);
    expect(row).not.toBeNull();
    expect(row!.component_id).toBe(0);
    expect(row!.component_size).toBe(1);
  });

  it('3. two disconnected entities: two components, sizes 1 and 1', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const a = await createTestEntity({ canonicalName: 'a', entityType: 'thing' });
    const b = await createTestEntity({ canonicalName: 'b', entityType: 'thing' });
    runTopologyCompute();
    const ra = await getTopology(a.id);
    const rb = await getTopology(b.id);
    expect(ra!.component_size).toBe(1);
    expect(rb!.component_size).toBe(1);
    // Different component IDs (ordering deterministic by UUID — we don't pin the order here)
    expect(ra!.component_id).not.toBe(rb!.component_id);
    expect(new Set([ra!.component_id, rb!.component_id])).toEqual(new Set([0, 1]));
  });

  it('4. star graph (hub + 3 leaves): one component, size 4', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const hub = await createTestEntity({ canonicalName: 'hub', entityType: 'person' });
    const leaves = [
      await createTestEntity({ canonicalName: 'l1', entityType: 'person' }),
      await createTestEntity({ canonicalName: 'l2', entityType: 'person' }),
      await createTestEntity({ canonicalName: 'l3', entityType: 'person' }),
    ];
    for (const leaf of leaves) {
      await createTestFact({ subjectEntityId: hub.id, predicate: 'knows', objectEntityId: leaf.id });
    }
    runTopologyCompute();
    const allIds = [hub.id, ...leaves.map(l => l.id)];
    const rows = await Promise.all(allIds.map(getTopology));
    expect(rows.every(r => r!.component_id === 0)).toBe(true);
    expect(rows.every(r => r!.component_size === 4)).toBe(true);
  });

  it('5. two clusters of different sizes (5 vs 3): larger gets component_id=0', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    // Cluster A: 5 entities forming a chain
    const a: { id: string }[] = [];
    for (let i = 0; i < 5; i++) {
      a.push(await createTestEntity({ canonicalName: `a${i}`, entityType: 'thing' }));
    }
    for (let i = 0; i < 4; i++) {
      await createTestFact({ subjectEntityId: a[i]!.id, predicate: 'next', objectEntityId: a[i + 1]!.id });
    }
    // Cluster B: 3 entities forming a chain
    const b: { id: string }[] = [];
    for (let i = 0; i < 3; i++) {
      b.push(await createTestEntity({ canonicalName: `b${i}`, entityType: 'thing' }));
    }
    for (let i = 0; i < 2; i++) {
      await createTestFact({ subjectEntityId: b[i]!.id, predicate: 'next', objectEntityId: b[i + 1]!.id });
    }
    runTopologyCompute();
    const rowsA = await Promise.all(a.map(e => getTopology(e.id)));
    const rowsB = await Promise.all(b.map(e => getTopology(e.id)));
    expect(rowsA.every(r => r!.component_id === 0)).toBe(true);
    expect(rowsA.every(r => r!.component_size === 5)).toBe(true);
    expect(rowsB.every(r => r!.component_id === 1)).toBe(true);
    expect(rowsB.every(r => r!.component_size === 3)).toBe(true);
  });

  it('6. same_as link bridges two clusters: before 2 components, after 1', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const a = await createTestEntity({ canonicalName: 'a', entityType: 'thing' });
    const b = await createTestEntity({ canonicalName: 'b', entityType: 'thing' });
    runTopologyCompute();
    const beforeA = await getTopology(a.id);
    const beforeB = await getTopology(b.id);
    expect(beforeA!.component_id).not.toBe(beforeB!.component_id);

    // Insert same_as link in canonical order (a_id < b_id per schema CHECK)
    const [low, high] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
    await testDb`
      INSERT INTO public.same_as_links (entity_a_id, entity_b_id, reasoning, confidence)
      VALUES (${low}::uuid, ${high}::uuid, 'topology test bridge', 0.95)
    `;
    runTopologyCompute();
    const afterA = await getTopology(a.id);
    const afterB = await getTopology(b.id);
    expect(afterA!.component_id).toBe(afterB!.component_id);
    expect(afterA!.component_size).toBe(2);
  });

  it('7. expired fact excluded: fact-bridged pair becomes 2 components after expiry', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const a = await createTestEntity({ canonicalName: 'a', entityType: 'thing' });
    const b = await createTestEntity({ canonicalName: 'b', entityType: 'thing' });
    const f = await createTestFact({ subjectEntityId: a.id, predicate: 'knows', objectEntityId: b.id });
    runTopologyCompute();
    let ra = await getTopology(a.id);
    let rb = await getTopology(b.id);
    expect(ra!.component_id).toBe(rb!.component_id);

    await testDb`UPDATE public.facts SET expired_at = NOW() WHERE id = ${f.id}::uuid`;
    runTopologyCompute();
    ra = await getTopology(a.id);
    rb = await getTopology(b.id);
    expect(ra!.component_id).not.toBe(rb!.component_id);
  });

  it('8. self-referential fact ignored: entity has component_size=1', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const e = await createTestEntity({ canonicalName: 's', entityType: 'thing' });
    // Bypass createTestFact's no-self-reference guard by direct SQL — the
    // export query in topology.py is what we're testing, not the guard.
    await testDb`
      INSERT INTO public.facts (subject_entity_id, predicate, object_value)
      VALUES (${e.id}::uuid, 'self_attr', 'literal')
    `;
    // ALSO insert a self-referential fact directly (subject = object). The
    // 007_no_self_reference.sql migration may forbid this — if so, the
    // inserts below throws and the export-side filter is moot. We catch
    // and continue: the test still validates the read-side state.
    try {
      await testDb`
        INSERT INTO public.facts (subject_entity_id, predicate, object_entity_id)
        VALUES (${e.id}::uuid, 'cycle', ${e.id}::uuid)
      `;
    } catch {
      // self-reference forbidden at the DB level — fine, the topology export
      // already filters; this test then just covers the literal-only case.
    }
    runTopologyCompute();
    const row = await getTopology(e.id);
    expect(row!.component_size).toBe(1);
    expect(row!.component_id).toBe(0);
  });

  it('9. determinism: two consecutive computes produce identical component_id values', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const e = await createTestEntity({ canonicalName: `d${i}`, entityType: 'thing' });
      ids.push(e.id);
    }
    // Two cluster-of-three chains
    await createTestFact({ subjectEntityId: ids[0]!, predicate: 'p', objectEntityId: ids[1]! });
    await createTestFact({ subjectEntityId: ids[1]!, predicate: 'p', objectEntityId: ids[2]! });
    await createTestFact({ subjectEntityId: ids[3]!, predicate: 'p', objectEntityId: ids[4]! });
    await createTestFact({ subjectEntityId: ids[4]!, predicate: 'p', objectEntityId: ids[5]! });

    runTopologyCompute();
    const first = await Promise.all(ids.map(getTopology));
    runTopologyCompute();
    const second = await Promise.all(ids.map(getTopology));

    for (let i = 0; i < ids.length; i++) {
      expect(second[i]!.component_id).toBe(first[i]!.component_id);
      expect(second[i]!.component_size).toBe(first[i]!.component_size);
    }
  });

  it('10. idempotency: rerun without graph change preserves component_id and component_size', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const a = await createTestEntity({ canonicalName: 'a', entityType: 'thing' });
    const b = await createTestEntity({ canonicalName: 'b', entityType: 'thing' });
    await createTestFact({ subjectEntityId: a.id, predicate: 'p', objectEntityId: b.id });
    runTopologyCompute();
    const before = await getTopology(a.id);
    runTopologyCompute();
    const after = await getTopology(a.id);
    expect(after!.component_id).toBe(before!.component_id);
    expect(after!.component_size).toBe(before!.component_size);
    expect(after!.computation_version).toBe(before!.computation_version);
  });

  it('11. compute writes a topology_compute_runs row with status=completed', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    if (!hasVectorExtension) return skipCtx(ctx);
    // The driver script in runTopologyCompute() bypasses the run lifecycle
    // because it calls _export_graph + _write_back directly. Drive the
    // full HTTP-equivalent by spawning python that calls topology_compute()
    // with the FastAPI-router function bypassed (no HTTP) but full lifecycle.
    const driver = `
import sys, os, json
sys.path.insert(0, r"${ML_SERVICES_DIR.replace(/\\/g, '\\\\')}")
os.environ["DATABASE_URL"] = r"${TEST_DB_URL}"
from app.topology import topology_compute
result = topology_compute()
print(json.dumps({"run_id": result.run_id, "status": result.status, "component_count": result.component_count}))
`;
    const out = execFileSync(VENV_PYTHON, ['-c', driver], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = out.trim().split(/\r?\n/);
    const summary = JSON.parse(lines[lines.length - 1] ?? '{}') as { run_id: string; status: string; component_count: number };
    expect(summary.status).toBe('completed');

    const runs = (await testDb`
      SELECT id::text AS id, status, computation_version, entities_processed
      FROM public.topology_compute_runs ORDER BY started_at DESC LIMIT 1
    `) as unknown as { id: string; status: string; computation_version: number; entities_processed: number | null }[];
    expect(runs[0]?.status).toBe('completed');
    expect(runs[0]?.id).toBe(summary.run_id);
  });
});
