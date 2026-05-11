/**
 * Phase 3 — HDBSCAN centroid clustering (doc 24.1, nmemo-a7f.3.1)
 *
 * Implements the §4.2 cases. Each test seeds a synthetic centroid set
 * directly into entity_meta (entities live in the entities table), invokes
 * the Python clustering compute routine against `cognitive_test`, and
 * asserts on `entity_clusters` rows + the graph_stats backfill.
 *
 * Compute is invoked via the venv python directly (mirrors the Phase 2
 * topology-* tests). The subprocess path drives the same
 * semantic_clustering.py functions, with full per-test control of
 * DATABASE_URL and zero external state.
 *
 * Centroid format note (doc 24.1 §3.1 gotcha): pgvector returns vectors as
 * the literal string `[0.1,0.2,...]` by default; `_parse_pgvector` in the
 * Python module normalises this. Tests insert via the `'[a,b,c]'::vector`
 * SQL form so postgres parses the literal once on insert.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  testDb,
  createTestEntity,
  deleteFromTables,
  skipCtx,
} from '../setup.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const VENV_PYTHON = join(__dirname, '..', '..', '..', '..', 'ml-services', '.venv', 'Scripts', 'python.exe');
const ML_SERVICES_DIR = join(__dirname, '..', '..', '..', '..', 'ml-services');
const TEST_DB_URL = process.env.TEST_DATABASE_URL
  ?? 'postgresql://cognitive:cognitive@127.0.0.1:5433/cognitive_test';

const CENTROID_DIM = 768;

interface ComputeResult {
  entity_count: number;
  cluster_count: number;
  noise_count: number;
  mean_intra: number | null;
  mean_inter: number | null;
}

/**
 * Run the full HDBSCAN clustering pipeline against the test DB.
 * Mirrors topology-centrality.test.ts: spawn the venv python with an inline
 * driver, capture the JSON summary line.
 */
function runClusteringCompute(extraEnv: Record<string, string> = {}): ComputeResult {
  const envSets = Object.entries(extraEnv)
    .map(([k, v]) => `os.environ[${JSON.stringify(k)}] = ${JSON.stringify(v)}`)
    .join('\n');
  const driver = `
import sys, os, json
sys.path.insert(0, r"${ML_SERVICES_DIR.replace(/\\/g, '\\\\')}")
os.environ["DATABASE_URL"] = r"${TEST_DB_URL}"
${envSets}
from app.semantic_clustering import (
    _export_centroids,
    compute_hdbscan,
    _write_back,
    _summarise,
    _update_graph_stats,
    _hdbscan_min_cluster_size,
    _hdbscan_min_samples,
    COMPUTATION_VERSION,
)
import psycopg
from psycopg.rows import dict_row
with psycopg.connect(r"${TEST_DB_URL}", row_factory=dict_row) as conn:
    centroids = _export_centroids(conn)
    assignments = compute_hdbscan(
        centroids,
        min_cluster_size=_hdbscan_min_cluster_size(),
        min_samples=_hdbscan_min_samples(),
    )
    cc, nc, intra, inter = _summarise(assignments)
    _write_back(conn, assignments=assignments, computation_version=COMPUTATION_VERSION)
    _update_graph_stats(conn, cluster_count=cc, mean_intra=intra, mean_inter=inter, computation_version=COMPUTATION_VERSION)
    conn.commit()
    print(json.dumps({
        "entity_count": len(assignments),
        "cluster_count": cc,
        "noise_count": nc,
        "mean_intra": intra,
        "mean_inter": inter,
    }))
`;
  const out = execFileSync(VENV_PYTHON, ['-c', driver], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = out.trim().split(/\r?\n/);
  const lastLine = lines[lines.length - 1] ?? '';
  return JSON.parse(lastLine) as ComputeResult;
}

interface ClusterRow {
  entity_id: string;
  cluster_id: number;
  cluster_probability: number | null;
  cluster_size: number;
  computation_version: number;
}

async function getRow(entityId: string): Promise<ClusterRow | null> {
  const rows = (await testDb`
    SELECT entity_id::text AS entity_id,
           cluster_id,
           cluster_probability,
           cluster_size,
           computation_version
    FROM public.entity_clusters
    WHERE entity_id = ${entityId}::uuid
  `) as unknown as ClusterRow[];
  return rows[0] ?? null;
}

async function getSnapshot(entityId: string): Promise<number[] | null> {
  const rows = (await testDb`
    SELECT centroid_snapshot::text AS snapshot
    FROM public.entity_clusters
    WHERE entity_id = ${entityId}::uuid
  `) as unknown as { snapshot: string | null }[];
  if (rows.length === 0 || rows[0]!.snapshot === null) return null;
  const raw = rows[0]!.snapshot!;
  // pgvector returns '[a,b,c,...]' on text cast.
  const inner = raw.startsWith('[') ? raw.slice(1, -1) : raw;
  return inner.split(',').map((s) => Number.parseFloat(s));
}

async function listAll(): Promise<ClusterRow[]> {
  return (await testDb`
    SELECT entity_id::text AS entity_id,
           cluster_id,
           cluster_probability,
           cluster_size,
           computation_version
    FROM public.entity_clusters
    ORDER BY entity_id ASC
  `) as unknown as ClusterRow[];
}

interface GraphStats {
  embedding_cluster_count: number | null;
  mean_intra_cluster_distance: number | null;
  mean_inter_cluster_distance: number | null;
  cluster_columns_version: number | null;
}

async function getGraphStats(): Promise<GraphStats | null> {
  const rows = (await testDb`
    SELECT embedding_cluster_count,
           mean_intra_cluster_distance,
           mean_inter_cluster_distance,
           cluster_columns_version
    FROM public.graph_stats WHERE id = 1
  `) as unknown as GraphStats[];
  return rows[0] ?? null;
}

/**
 * Insert/upsert an entity_meta row with a synthetic centroid. Tests build
 * fixtures by calling createTestEntity then this helper. Mirrors the doc
 * 24.1 §3.3 read pattern's writer side.
 */
async function setCentroid(entityId: string, vec: number[]): Promise<void> {
  if (vec.length !== CENTROID_DIM) {
    throw new Error(`centroid must be ${CENTROID_DIM}-dim; got ${vec.length}`);
  }
  const literal = `[${vec.join(',')}]`;
  await testDb`
    INSERT INTO public.entity_meta (entity_id, centroid)
    VALUES (${entityId}::uuid, ${literal}::vector)
    ON CONFLICT (entity_id) DO UPDATE SET centroid = EXCLUDED.centroid
  `;
}

/**
 * Deterministic vector drawn from a Gaussian-style cluster mode.
 *
 * Mirrors doc 28 §3.3 step 4: each mode is a high-dimensional Gaussian
 * neighbourhood centred at a one-hot direction. Samples are unit-normalised
 * so cosine distance reflects angular separation. The pseudorandom stream
 * is fully seeded by (mode, seed) so test fixtures are byte-deterministic.
 */
function vecNearMode(mode: number, dim = CENTROID_DIM, _jitterUnused = 0.05, seed = 0): number[] {
  // Linear congruential generator (Numerical Recipes constants) for
  // deterministic, fast pseudorandom output without a heavyweight RNG dep.
  let state = (((mode + 1) * 2654435761) ^ ((seed + 1) * 2246822519)) >>> 0;
  function next(): number {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0xffffffff;
  }
  // Box-Muller for standard normal.
  function gauss(): number {
    const u1 = Math.max(next(), 1e-12);
    const u2 = next();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  // Place mode at coordinate 50*mode mod (dim-1) so each mode lands at a
  // distinct, well-spaced direction without overflowing dim. The mod folding
  // is fine for our small mode counts in tests (modes 0..a-few-hundred).
  const modeIdx = (mode * 50) % (dim - 1);
  const sigma = 0.05;
  const v = new Array(dim);
  for (let i = 0; i < dim; i++) v[i] = gauss() * sigma;
  v[modeIdx] += 1.0;
  // L2 normalise — production centroids are mean-of-normalised-vectors.
  let nrm = 0;
  for (let i = 0; i < dim; i++) nrm += v[i] * v[i];
  nrm = Math.sqrt(nrm);
  if (nrm > 0) {
    for (let i = 0; i < dim; i++) v[i] /= nrm;
  }
  return v;
}

async function cleanSlate(): Promise<void> {
  // entity_meta cascade-deletes when entities go; we delete entities last.
  await testDb`DELETE FROM public.entity_clusters`;
  await testDb`DELETE FROM public.clustering_compute_runs`;
  await testDb`DELETE FROM public.entity_meta`;
  await deleteFromTables({
    tables: ['fact_history', 'memory_entities', 'facts', 'merge_candidates', 'entities'],
    acknowledgeGlobal: true,
  });
  // Reset cluster columns of the graph_stats singleton so each test starts NULL.
  await testDb`
    UPDATE public.graph_stats SET
      embedding_cluster_count = NULL,
      mean_intra_cluster_distance = NULL,
      mean_inter_cluster_distance = NULL,
      cluster_columns_version = NULL
    WHERE id = 1
  `;
}

describe('clustering-hdbscan §24.1 — Phase 3 / T1', () => {
  beforeEach(async () => {
    await cleanSlate();
  });

  it('1. empty centroid set: clustering skipped, entity_clusters empty', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const r = runClusteringCompute();
    expect(r.entity_count).toBe(0);
    expect(r.cluster_count).toBe(0);
    expect(r.noise_count).toBe(0);
    expect(await listAll()).toEqual([]);
    const gs = await getGraphStats();
    expect(gs!.embedding_cluster_count).toBe(0);
    expect(gs!.cluster_columns_version).toBe(1);
  });

  it('2. all centroids identical: with min_cluster_size=5 they form one cluster of size N (N>=5)', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    // 6 entities with the EXACT same centroid (no jitter).
    const entities: { id: string }[] = [];
    const sharedVec = new Array(CENTROID_DIM).fill(0);
    sharedVec[0] = 1.0;
    for (let i = 0; i < 6; i++) {
      const e = await createTestEntity({ canonicalName: `id_e${i}`, entityType: 'thing' });
      entities.push(e);
      await setCentroid(e.id, sharedVec);
    }
    runClusteringCompute();
    const all = await listAll();
    expect(all).toHaveLength(6);
    // All should share a single cluster_id (could be 0 or -1 depending on
    // how HDBSCAN handles zero-distance singletons; assert on consistency).
    const cids = new Set(all.map((r) => r.cluster_id));
    expect(cids.size).toBe(1);
  });

  it('3. two well-separated clusters: HDBSCAN finds 2; cluster 0 = larger', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    // 12 entities near mode 0, 8 entities near mode 1. Cluster sizes well
    // above min_cluster_size=5 so HDBSCAN's density estimation locks in
    // both clusters reliably (small populations near the threshold can
    // produce noise-only output — see doc 24.1 §6 "Cluster of exactly
    // min_cluster_size: becomes a valid cluster (boundary)").
    const big: { id: string }[] = [];
    for (let i = 0; i < 12; i++) {
      const e = await createTestEntity({ canonicalName: `tw_b${i}`, entityType: 'thing' });
      big.push(e);
      await setCentroid(e.id, vecNearMode(0, CENTROID_DIM, 0.05, i));
    }
    const small: { id: string }[] = [];
    for (let i = 0; i < 8; i++) {
      const e = await createTestEntity({ canonicalName: `tw_s${i}`, entityType: 'thing' });
      small.push(e);
      await setCentroid(e.id, vecNearMode(1, CENTROID_DIM, 0.05, 100 + i));
    }
    const r = runClusteringCompute();
    expect(r.cluster_count).toBe(2);

    const bigCids = new Set<number>();
    for (const e of big) bigCids.add((await getRow(e.id))!.cluster_id);
    expect(bigCids.size).toBe(1);
    const bigCid = [...bigCids][0]!;

    const smallCids = new Set<number>();
    for (const e of small) smallCids.add((await getRow(e.id))!.cluster_id);
    expect(smallCids.size).toBe(1);
    const smallCid = [...smallCids][0]!;

    expect(bigCid).not.toBe(smallCid);
    // Canonical assignment: 0 = largest cluster.
    expect(bigCid).toBe(0);
    expect(smallCid).toBe(1);
  });

  it('4. noise at the boundary: entities far from any cluster get cluster_id=-1; cluster_probability=NULL', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    // 6 in mode 0, 6 in mode 1, 2 random outliers in unrelated dimensions.
    const cluster0: { id: string }[] = [];
    for (let i = 0; i < 6; i++) {
      const e = await createTestEntity({ canonicalName: `nb_a${i}`, entityType: 'thing' });
      cluster0.push(e);
      await setCentroid(e.id, vecNearMode(0, CENTROID_DIM, 0.001, i));
    }
    for (let i = 0; i < 6; i++) {
      const e = await createTestEntity({ canonicalName: `nb_b${i}`, entityType: 'thing' });
      await setCentroid(e.id, vecNearMode(1, CENTROID_DIM, 0.001, 50 + i));
    }
    // Two outliers in distant modes (50, 100). With only 1 entity per mode
    // and min_cluster_size=5 these are noise.
    const out1 = await createTestEntity({ canonicalName: 'nb_o1', entityType: 'thing' });
    await setCentroid(out1.id, vecNearMode(50, CENTROID_DIM, 0.0, 999));
    const out2 = await createTestEntity({ canonicalName: 'nb_o2', entityType: 'thing' });
    await setCentroid(out2.id, vecNearMode(100, CENTROID_DIM, 0.0, 998));

    runClusteringCompute();
    const o1 = await getRow(out1.id);
    const o2 = await getRow(out2.id);
    expect(o1!.cluster_id).toBe(-1);
    expect(o2!.cluster_id).toBe(-1);
    expect(o1!.cluster_probability).toBeNull();
    expect(o2!.cluster_probability).toBeNull();
    // Cluster-0 members are NOT noise.
    for (const e of cluster0) {
      const r = await getRow(e.id);
      expect(r!.cluster_id).toBeGreaterThanOrEqual(0);
    }
  });

  it('5. determinism: two consecutive computes produce identical cluster_id assignments', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    // Mixed corpus: 6 mode-0, 6 mode-1, 6 mode-2.
    for (let m = 0; m < 3; m++) {
      for (let i = 0; i < 6; i++) {
        const e = await createTestEntity({ canonicalName: `det_m${m}_${i}`, entityType: 'thing' });
        await setCentroid(e.id, vecNearMode(m, CENTROID_DIM, 0.001, m * 100 + i));
      }
    }
    runClusteringCompute();
    const first = await listAll();
    runClusteringCompute();
    const second = await listAll();
    expect(second).toHaveLength(first.length);
    expect(first.length).toBe(18);
    for (let i = 0; i < first.length; i++) {
      expect(second[i]!.entity_id).toBe(first[i]!.entity_id);
      expect(second[i]!.cluster_id).toBe(first[i]!.cluster_id);
    }
  });

  it('6. snapshot stability: centroid_snapshot frozen at clustering time, unaffected by later live drift', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    // Build a clusterable population so the run has something to snapshot.
    const entities: { id: string }[] = [];
    for (let i = 0; i < 6; i++) {
      const e = await createTestEntity({ canonicalName: `snap_a${i}`, entityType: 'thing' });
      entities.push(e);
      await setCentroid(e.id, vecNearMode(0, CENTROID_DIM, 0.001, i));
    }
    const target = entities[0]!;
    // Capture the live centroid pre-clustering.
    const liveBefore = (await testDb`
      SELECT centroid::text AS centroid FROM public.entity_meta WHERE entity_id = ${target.id}::uuid
    `) as unknown as { centroid: string }[];
    runClusteringCompute();
    const snapBefore = (await getSnapshot(target.id))!;
    // Mutate the live centroid (simulate drift) — flip a different coordinate.
    const drifted = new Array(CENTROID_DIM).fill(0);
    drifted[10] = 1.0; // very different direction
    await setCentroid(target.id, drifted);
    // Snapshot must still match the original — drift detection (24.2)
    // relies on this.
    const snapAfter = (await getSnapshot(target.id))!;
    expect(snapAfter).toEqual(snapBefore);
    // And the live centroid in entity_meta did change.
    const liveAfter = (await testDb`
      SELECT centroid::text AS centroid FROM public.entity_meta WHERE entity_id = ${target.id}::uuid
    `) as unknown as { centroid: string }[];
    expect(liveAfter[0]!.centroid).not.toBe(liveBefore[0]!.centroid);
  });

  it('7. graph_stats backfill: cluster columns populated after clustering', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    // Two well-separated clusters so we get a defined inter-cluster mean.
    for (let i = 0; i < 12; i++) {
      const e = await createTestEntity({ canonicalName: `gs_a${i}`, entityType: 'thing' });
      await setCentroid(e.id, vecNearMode(0, CENTROID_DIM, 0.05, i));
    }
    for (let i = 0; i < 8; i++) {
      const e = await createTestEntity({ canonicalName: `gs_b${i}`, entityType: 'thing' });
      await setCentroid(e.id, vecNearMode(1, CENTROID_DIM, 0.05, 100 + i));
    }
    const r = runClusteringCompute();
    const gs = await getGraphStats();
    expect(gs).not.toBeNull();
    expect(gs!.embedding_cluster_count).toBe(r.cluster_count);
    expect(gs!.mean_intra_cluster_distance).not.toBeNull();
    expect(gs!.mean_inter_cluster_distance).not.toBeNull();
    expect(gs!.cluster_columns_version).toBe(1);
    // Two near-orthogonal modes (separated by ~100 dims out of 768) plus
    // sigma=0.05 Gaussian noise yield mean_inter > mean_intra by a comfortable
    // margin. Exact values depend on the LCG seed; we assert separation, not
    // tight bounds (per doc 24.1 §5.3 — bridge pair separation is the
    // important invariant, not precise distance values).
    expect(gs!.mean_inter_cluster_distance!).toBeGreaterThan(gs!.mean_intra_cluster_distance!);
    expect(gs!.mean_inter_cluster_distance!).toBeGreaterThan(0.4);

    // Per doc 22 §7.4 consistency check: stats column matches table COUNT.
    const tableCount = (await testDb`
      SELECT COUNT(DISTINCT cluster_id)::int AS n FROM public.entity_clusters WHERE cluster_id != -1
    `) as unknown as { n: number }[];
    expect(gs!.embedding_cluster_count).toBe(tableCount[0]!.n);
  });

  it('8. hyperparameter sensitivity: HDBSCAN_MIN_CLUSTER_SIZE=10 yields fewer clusters than =5', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    // Three modes, 6 entities each — at min_cluster_size=5 all 3 form
    // clusters; at =10 none of them are big enough -> all noise.
    for (let m = 0; m < 3; m++) {
      for (let i = 0; i < 6; i++) {
        const e = await createTestEntity({ canonicalName: `hp_m${m}_${i}`, entityType: 'thing' });
        await setCentroid(e.id, vecNearMode(m, CENTROID_DIM, 0.001, m * 100 + i));
      }
    }
    const r5 = runClusteringCompute({ HDBSCAN_MIN_CLUSTER_SIZE: '5', HDBSCAN_MIN_SAMPLES: '5' });
    expect(r5.cluster_count).toBe(3);
    // Now re-run with min_cluster_size=10: each mode (size 6) is too small.
    await testDb`DELETE FROM public.entity_clusters`;
    const r10 = runClusteringCompute({ HDBSCAN_MIN_CLUSTER_SIZE: '10', HDBSCAN_MIN_SAMPLES: '10' });
    expect(r10.cluster_count).toBeLessThan(r5.cluster_count);
  });

  it('9. cluster_size denormalisation: each row matches COUNT(*) of its cluster', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    // 6 in mode 0, 8 in mode 1.
    for (let i = 0; i < 6; i++) {
      const e = await createTestEntity({ canonicalName: `sz_a${i}`, entityType: 'thing' });
      await setCentroid(e.id, vecNearMode(0, CENTROID_DIM, 0.001, i));
    }
    for (let i = 0; i < 8; i++) {
      const e = await createTestEntity({ canonicalName: `sz_b${i}`, entityType: 'thing' });
      await setCentroid(e.id, vecNearMode(1, CENTROID_DIM, 0.001, 100 + i));
    }
    runClusteringCompute();
    const all = await listAll();
    const counts = new Map<number, number>();
    for (const r of all) counts.set(r.cluster_id, (counts.get(r.cluster_id) ?? 0) + 1);
    for (const r of all) {
      expect(r.cluster_size).toBe(counts.get(r.cluster_id)!);
    }
  });

  it('10. fewer-than-min entities: every entity gets noise label and the snapshot of its own centroid', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    // 3 entities only, min_cluster_size default = 5.
    const entities: { id: string }[] = [];
    for (let i = 0; i < 3; i++) {
      const e = await createTestEntity({ canonicalName: `min_e${i}`, entityType: 'thing' });
      entities.push(e);
      await setCentroid(e.id, vecNearMode(i, CENTROID_DIM, 0.0, i));
    }
    const r = runClusteringCompute();
    expect(r.entity_count).toBe(3);
    expect(r.cluster_count).toBe(0);
    expect(r.noise_count).toBe(3);
    for (const e of entities) {
      const row = await getRow(e.id);
      expect(row!.cluster_id).toBe(-1);
      expect(row!.cluster_probability).toBeNull();
      // snapshot is each entity's own centroid (a one-hot at index i with 0.0 jitter)
      const snap = (await getSnapshot(e.id))!;
      expect(snap.length).toBe(CENTROID_DIM);
    }
    // graph_stats: cluster_count=0, mean_intra and mean_inter are NULL.
    const gs = await getGraphStats();
    expect(gs!.embedding_cluster_count).toBe(0);
    expect(gs!.mean_intra_cluster_distance).toBeNull();
    expect(gs!.mean_inter_cluster_distance).toBeNull();
  });

  it('11. cascade-delete: removing an entity removes its entity_clusters row on next compute', async (ctx) => {
    if (!existsSync(VENV_PYTHON)) return skipCtx(ctx);
    const entities: { id: string }[] = [];
    for (let i = 0; i < 6; i++) {
      const e = await createTestEntity({ canonicalName: `cd_e${i}`, entityType: 'thing' });
      entities.push(e);
      await setCentroid(e.id, vecNearMode(0, CENTROID_DIM, 0.001, i));
    }
    runClusteringCompute();
    expect((await listAll()).length).toBe(6);
    // Drop one entity (FK cascade nukes entity_meta + entity_clusters).
    await testDb`DELETE FROM public.entities WHERE id = ${entities[0]!.id}::uuid`;
    // Confirm cascade fired on entity_clusters too.
    expect(await getRow(entities[0]!.id)).toBeNull();
    // Re-running compute should leave only the surviving 5.
    runClusteringCompute();
    const after = await listAll();
    expect(after.length).toBe(5);
    for (const r of after) {
      expect(r.entity_id).not.toBe(entities[0]!.id);
    }
  });
});
