/**
 * Canonical Graph — content-addressed snapshot for run-to-run comparison.
 *
 * Used by the parallel-ingestion comparison harness (doc 38) to diff the graph
 * produced by two ingestion runs — chiefly the determinism / temporal litmus
 * test ("same corpus in reverse chunk order → same graph") and the structural
 * quality scorecard (vs the serial baseline).
 *
 * This module is PURE (no DB import) so the keying/diff logic is unit-testable
 * without infra. The DB fetch lives in `graph-canonical-query.ts`, which feeds
 * raw rows into {@link buildCanonicalGraph}.
 *
 * Why not reuse the snapshot dumps (`scripts/load-snapshot.ts`)? Those are
 * pg_dump binaries carrying random UUIDs and wall-clock timestamps — two runs
 * of the same corpus never byte-match. This form is *content-addressed*:
 *
 *   - entities      → key `name|type` (lower-cased)
 *   - facts (active)→ key `subjectKey :: predicate :: objectKey|value`
 *   - causal events → key `factKey :: transitionType` (falls back to
 *                     `subjectKey :: predicate :: transitionType`)
 *   - causal edges  → key `causeEventKey => effectEventKey`
 *   - same_as       → order-independent `keyA <-> keyB`
 *
 * Volatile fields (UUIDs, timestamps, source_memory_id, reasoning text) are
 * excluded from `structuralHash`. Scalars that legitimately vary with
 * corroboration ORDER (fact confidence, edge strength) are kept as detail for
 * tolerance comparison but are NOT in the structural hash — so the litmus test
 * passes when the *structure* matches even if a confidence bump landed in a
 * different order.
 *
 * The keyed collections are intentionally MULTISETS: a duplicate entity
 * ("Victor" + "Victor Frankenstein" both typed person, or two identical active
 * facts from a write race) shows up as a repeated key. That repetition is the
 * entity-explosion / fact-dup signal the scorecard measures — do NOT dedup.
 */

import { createHash } from 'node:crypto';

/** Raw rows fetched from the graph, before canonicalisation. */
export interface RawGraphRows {
  entities: Array<{ id: string; name: string; type: string }>;
  facts: Array<{
    id: string;
    subj: string;
    pred: string;
    objId: string | null;
    objVal: string | null;
    conf: number | null;
  }>;
  events: Array<{
    id: string;
    subj: string | null;
    pred: string | null;
    tt: string;
    factId: string | null;
  }>;
  edges: Array<{ id: string; cause: string; effect: string; strength: number | null }>;
  sameAs: Array<{ a: string; b: string }>;
}

export interface CanonicalGraph {
  /** Sorted multiset of `name|type` entity keys (repeats = duplicate entities). */
  entities: string[];
  /** Sorted multiset of active-fact triple keys + confidence detail. */
  facts: Array<{ key: string; confidence: number | null }>;
  /** Sorted multiset of causal-event content keys. */
  events: string[];
  /** Sorted multiset of `cause => effect` edge keys + strength detail. */
  edges: Array<{ key: string; strength: number }>;
  /** Sorted multiset of order-independent same_as pair keys. */
  sameAs: string[];
  counts: {
    entities: number;
    distinctEntities: number;
    activeFacts: number;
    distinctFacts: number;
    events: number;
    activeEdges: number;
    sameAs: number;
  };
  /** sha256 over the sorted structural keys only — the litmus / determinism key. */
  structuralHash: string;
}

/** Natural key for an entity: case-folded `name|type`. */
export function entityKey(name: string, type: string): string {
  return `${name.trim().toLowerCase()}|${type.trim().toLowerCase()}`;
}

/**
 * Build the canonical, content-addressed form from raw graph rows. Pure —
 * deterministic in the input, independent of row order (rows are sorted by
 * content key), so two runs of the same corpus produce an identical
 * `structuralHash` regardless of ingestion order. That order-independence is
 * the unit-level proof behind the litmus test.
 */
export function buildCanonicalGraph(raw: RawGraphRows): CanonicalGraph {
  // entity uuid -> canonical `name|type` key
  const entById = new Map<string, string>();
  for (const e of raw.entities) entById.set(e.id, entityKey(e.name, e.type));
  const resolveEnt = (id: string | null): string | null =>
    id == null ? null : entById.get(id) ?? `missing:${id}`;

  // facts -> structural triple keys (and a uuid->key map for events)
  const factKeyById = new Map<string, string>();
  const factEntries: Array<{ key: string; confidence: number | null }> = [];
  for (const f of raw.facts) {
    const subj = resolveEnt(f.subj) ?? `missing:${f.subj}`;
    const obj = f.objId
      ? resolveEnt(f.objId)
      : f.objVal != null
        ? `value:${f.objVal.trim().toLowerCase()}`
        : 'value:∅';
    const key = `${subj} :: ${f.pred} :: ${obj}`;
    factKeyById.set(f.id, key);
    factEntries.push({ key, confidence: f.conf ?? null });
  }

  // causal events -> content keys (prefer the fact's structural key)
  const eventKeyById = new Map<string, string>();
  const eventKeys: string[] = [];
  for (const ev of raw.events) {
    const factKey = ev.factId ? factKeyById.get(ev.factId) : undefined;
    const base = factKey ?? `${resolveEnt(ev.subj) ?? '∅'} :: ${ev.pred ?? '∅'}`;
    const key = `${base} :: ${ev.tt}`;
    eventKeyById.set(ev.id, key);
    eventKeys.push(key);
  }

  // causal edges -> cause=>effect keys
  const edgeEntries: Array<{ key: string; strength: number }> = [];
  for (const ed of raw.edges) {
    const c = eventKeyById.get(ed.cause) ?? `missing:${ed.cause}`;
    const e = eventKeyById.get(ed.effect) ?? `missing:${ed.effect}`;
    edgeEntries.push({ key: `${c} => ${e}`, strength: Math.round((ed.strength ?? 0) * 1000) / 1000 });
  }

  // same_as -> order-independent pair keys
  const sameAsKeys: string[] = [];
  for (const s of raw.sameAs) {
    const a = resolveEnt(s.a) ?? `missing:${s.a}`;
    const b = resolveEnt(s.b) ?? `missing:${s.b}`;
    sameAsKeys.push([a, b].sort().join(' <-> '));
  }

  // deterministic ordering
  const entityKeys = [...entById.values()].sort();
  factEntries.sort((x, y) => x.key.localeCompare(y.key));
  eventKeys.sort();
  edgeEntries.sort((x, y) => x.key.localeCompare(y.key));
  sameAsKeys.sort();

  // structural hash: keys only, no scalars / volatile fields
  const structural = JSON.stringify({
    entities: entityKeys,
    facts: factEntries.map((f) => f.key),
    events: eventKeys,
    edges: edgeEntries.map((e) => e.key),
    sameAs: sameAsKeys,
  });
  const structuralHash = createHash('sha256').update(structural).digest('hex');

  return {
    entities: entityKeys,
    facts: factEntries,
    events: eventKeys,
    edges: edgeEntries,
    sameAs: sameAsKeys,
    counts: {
      entities: entityKeys.length,
      distinctEntities: new Set(entityKeys).size,
      activeFacts: factEntries.length,
      distinctFacts: new Set(factEntries.map((f) => f.key)).size,
      events: eventKeys.length,
      activeEdges: edgeEntries.length,
      sameAs: sameAsKeys.length,
    },
    structuralHash,
  };
}

// ============================================
// Diff + scorecard
// ============================================

export interface CanonicalDiff {
  /** True when the two graphs are structurally identical (the litmus pass). */
  structuralMatch: boolean;
  /** Structural keys present in A but not B (multiset-aware), capped for readability. */
  entitiesOnlyInA: string[];
  entitiesOnlyInB: string[];
  factsOnlyInA: string[];
  factsOnlyInB: string[];
  edgesOnlyInA: string[];
  edgesOnlyInB: string[];
  /** Duplicate-key counts each side (entity explosion / fact-dup signal). */
  duplicateEntitiesA: number;
  duplicateEntitiesB: number;
  duplicateFactsA: number;
  duplicateFactsB: number;
  countsA: CanonicalGraph['counts'];
  countsB: CanonicalGraph['counts'];
}

/** Multiset difference: items in `a` not covered by `b` (respecting repeat counts). */
export function multisetMinus(a: string[], b: string[]): string[] {
  const remaining = new Map<string, number>();
  for (const k of b) remaining.set(k, (remaining.get(k) ?? 0) + 1);
  const out: string[] = [];
  for (const k of a) {
    const n = remaining.get(k) ?? 0;
    if (n > 0) remaining.set(k, n - 1);
    else out.push(k);
  }
  return out;
}

const CAP = 50;
const dups = (keys: string[]): number => keys.length - new Set(keys).size;

/**
 * Diff two canonical graphs. `a` is conventionally the candidate run, `b` the
 * baseline (or the reverse-order run for the litmus test). Lists are capped at
 * {@link CAP} entries for readability; counts are exact.
 */
export function diffCanonicalGraphs(a: CanonicalGraph, b: CanonicalGraph): CanonicalDiff {
  const aFactKeys = a.facts.map((f) => f.key);
  const bFactKeys = b.facts.map((f) => f.key);
  const aEdgeKeys = a.edges.map((e) => e.key);
  const bEdgeKeys = b.edges.map((e) => e.key);
  return {
    structuralMatch: a.structuralHash === b.structuralHash,
    entitiesOnlyInA: multisetMinus(a.entities, b.entities).slice(0, CAP),
    entitiesOnlyInB: multisetMinus(b.entities, a.entities).slice(0, CAP),
    factsOnlyInA: multisetMinus(aFactKeys, bFactKeys).slice(0, CAP),
    factsOnlyInB: multisetMinus(bFactKeys, aFactKeys).slice(0, CAP),
    edgesOnlyInA: multisetMinus(aEdgeKeys, bEdgeKeys).slice(0, CAP),
    edgesOnlyInB: multisetMinus(bEdgeKeys, aEdgeKeys).slice(0, CAP),
    duplicateEntitiesA: dups(a.entities),
    duplicateEntitiesB: dups(b.entities),
    duplicateFactsA: dups(aFactKeys),
    duplicateFactsB: dups(bFactKeys),
    countsA: a.counts,
    countsB: b.counts,
  };
}

// ============================================
// Scorecard (run comparison — doc 38 §7)
// ============================================

export interface ArmRun {
  mode: string;
  /** Canonical graph after a forward-order ingest of the corpus. */
  graph: CanonicalGraph;
  /** Canonical graph after a reverse chunk-order ingest (litmus). Optional. */
  reverseGraph?: CanonicalGraph;
  /** Wall-clock for the forward ingest, ms (the throughput signal). */
  wallClockMs: number;
}

export interface ArmScore {
  mode: string;
  wallClockMs: number;
  counts: CanonicalGraph['counts'];
  duplicateEntities: number;
  duplicateFacts: number;
  /** Forward vs reverse structural identity (Bug A/B). null if no reverse run. */
  litmusPass: boolean | null;
  /** Diff vs the baseline arm — null for the baseline itself. */
  vsBaseline: {
    structuralMatch: boolean;
    entitiesExtra: number; // present in this arm, absent from baseline
    entitiesMissing: number; // present in baseline, absent from this arm
    factsExtra: number;
    factsMissing: number;
  } | null;
}

export interface Scorecard {
  baselineMode: string;
  arms: ArmScore[];
}

/**
 * Compose the run-comparison scorecard from one canonical graph per arm. Pure.
 * The baseline arm (default 'serial' — the FIFO control) is the reference every
 * other arm is diffed against; each arm's litmus pass is forward-vs-reverse
 * structural identity. Diff magnitudes use uncapped multiset differences.
 */
export function buildScorecard(runs: ArmRun[], baselineMode = 'serial'): Scorecard {
  const baseline = runs.find((r) => r.mode === baselineMode);
  const arms: ArmScore[] = runs.map((run) => {
    const litmusPass = run.reverseGraph
      ? run.graph.structuralHash === run.reverseGraph.structuralHash
      : null;
    let vsBaseline: ArmScore['vsBaseline'] = null;
    if (baseline && run.mode !== baselineMode) {
      const armFacts = run.graph.facts.map((f) => f.key);
      const baseFacts = baseline.graph.facts.map((f) => f.key);
      vsBaseline = {
        structuralMatch: run.graph.structuralHash === baseline.graph.structuralHash,
        entitiesExtra: multisetMinus(run.graph.entities, baseline.graph.entities).length,
        entitiesMissing: multisetMinus(baseline.graph.entities, run.graph.entities).length,
        factsExtra: multisetMinus(armFacts, baseFacts).length,
        factsMissing: multisetMinus(baseFacts, armFacts).length,
      };
    }
    return {
      mode: run.mode,
      wallClockMs: run.wallClockMs,
      counts: run.graph.counts,
      duplicateEntities: run.graph.counts.entities - run.graph.counts.distinctEntities,
      duplicateFacts: run.graph.counts.activeFacts - run.graph.counts.distinctFacts,
      litmusPass,
      vsBaseline,
    };
  });
  return { baselineMode, arms };
}
