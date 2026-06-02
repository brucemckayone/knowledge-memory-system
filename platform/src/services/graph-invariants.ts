/**
 * Graph-integrity invariants (doc 39 section 2.C + section 5 phase 2, nmemo-hm4.3).
 *
 * PURE, deterministic checks over the rich graph dump ({@link RichGraph}) - no
 * LLM, no DB. Each invariant returns a pass/fail verdict plus the exact
 * offending rows, so the comparison harness can fold them into metrics.json and
 * a human (or a later review bead) can audit every violation.
 *
 * The headline bug this layer exists to catch: the pipeline only supersedes
 * facts whose predicate is `exclusive` in the canonical ontology AND matches an
 * earlier predicate string exactly. Cross-predicate role/title/HQ sprawl
 * (`job_title`/`title`/`role_at`/`cto_at`, `headquartered_in`) is never
 * exclusive, so Elena Vasquez accumulates 5 coexisting active title facts and
 * Helix is `headquartered_in` both boston AND austin.
 * {@link singleActivePerExclusiveGroup} flags exactly that, using the
 * augmentation groups below to bridge the gap the ontology leaves.
 *
 * Allowed imports: a TYPE-ONLY `RichGraph` (erased at runtime) and the pure
 * `predicate-ontology.ts` value module - so this module never transitively
 * imports the DB pool and stays unit-testable under vitest.unit.config.ts.
 */

import type { RichGraph } from './graph-canonical-query.js';
import { normalizePredicate, getPredicateInfo } from './predicate-ontology.js';

// ============================================
// Exclusive-group resolution
// ============================================

/**
 * Cross-predicate exclusivity groups the canonical ontology does NOT model -
 * the role/title and HQ sprawl behind the headline bug. Members are matched
 * against the raw lowercased predicate OR its canonical normalisation.
 */
const AUGMENTATION_GROUPS: Record<string, Set<string>> = {
  role_title: new Set([
    'job_title', 'title', 'role_at', 'role', 'position', 'job', 'occupation',
    'works_as', 'serves_as', 'holds_title', 'has_title', 'has_role',
    'cto_at', 'cto_of', 'ceo_of', 'cfo_of', 'coo_of',
    'chief_technology_officer', 'chief_executive_officer',
  ]),
  org_hq: new Set([
    'headquartered_in', 'headquarters', 'hq', 'hq_in', 'head_office_in', 'head_office',
  ]),
};

/**
 * Resolve the exclusivity group a predicate belongs to, or null when it is not
 * exclusive (and so not checked by {@link singleActivePerExclusiveGroup}).
 *
 * Order matters: augmentation groups win first (they fold several
 * ontology-exclusive predicates like `ceo_of` into a broader role group), then
 * any ontology-exclusive predicate is its own group keyed by its canonical form.
 */
export function resolveExclusiveGroup(predicate: string): string | null {
  const raw = predicate.toLowerCase();
  const norm = normalizePredicate(predicate);
  for (const [group, members] of Object.entries(AUGMENTATION_GROUPS)) {
    if (members.has(raw) || members.has(norm)) return group;
  }
  if (getPredicateInfo(norm)?.isExclusive) return norm;
  return null;
}

// ============================================
// Result shapes
// ============================================

export type Severity = 'error' | 'warning' | 'info';

/** One offending row (or set of rows) for an invariant. Ids are optional per kind. */
export interface Violation {
  kind: string;
  subjectId?: string;
  entityIds?: string[];
  factIds?: string[];
  edgeIds?: string[];
  detail: string;
}

export interface InvariantResult {
  name: string;
  description: string;
  severity: Severity;
  pass: boolean;
  violations: Violation[];
}

export interface InvariantReport {
  results: InvariantResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    /** Total violation count across severity==='error' invariants. */
    errorViolations: number;
  };
}

/** Tunable thresholds for {@link objectValueNotSentence} - an object_value that reads as a sentence. */
const MAX_OBJECT_VALUE_LEN = 64;
const MAX_OBJECT_VALUE_WORDS = 12;

type RichFact = RichGraph['facts'][number];

/** A fact is active when it has not been superseded/expired. */
const isActive = (f: RichFact): boolean => f.expiredAt == null;

/** Stable object identity: the linked entity id, else a `value:`-prefixed literal. */
const objectIdentity = (f: RichFact): string =>
  f.objectEntityId ?? `value:${f.objectValue ?? ''}`;

const result = (
  name: string,
  description: string,
  severity: Severity,
  violations: Violation[],
): InvariantResult => ({ name, description, severity, pass: violations.length === 0, violations });

// ============================================
// Invariants
// ============================================

/**
 * (a) ERROR - at most one active fact per (subject, exclusivity group) with a
 * distinct object. The headline supersession-gap check: must flag Elena's 5
 * coexisting titles and Helix's two HQs.
 */
export function singleActivePerExclusiveGroup(graph: RichGraph): InvariantResult {
  // (subject :: group) -> { subjectId, group, objects: object identity -> fact ids }
  interface Bucket { subjectId: string; group: string; objects: Map<string, string[]> }
  const byKey = new Map<string, Bucket>();
  for (const f of graph.facts) {
    if (!isActive(f)) continue;
    const group = resolveExclusiveGroup(f.predicate);
    if (group == null) continue;
    const key = `${f.subjectEntityId} ${group}`;
    const bucket = byKey.get(key) ?? { subjectId: f.subjectEntityId, group, objects: new Map<string, string[]>() };
    const obj = objectIdentity(f);
    bucket.objects.set(obj, [...(bucket.objects.get(obj) ?? []), f.id]);
    byKey.set(key, bucket);
  }

  const violations: Violation[] = [];
  for (const { subjectId, group, objects } of byKey.values()) {
    if (objects.size <= 1) continue; // at most one distinct object -> no conflict
    const factIds = [...objects.values()].flat();
    const conflicting = [...objects.keys()].join(', ');
    violations.push({
      kind: 'exclusive_group_conflict',
      subjectId,
      factIds,
      detail: `subject ${subjectId} holds ${objects.size} active facts in exclusive group '${group}' with distinct objects: ${conflicting}`,
    });
  }
  return result(
    'singleActivePerExclusiveGroup',
    'At most one active fact per (subject, exclusive predicate group); supersession should expire the rest.',
    'error',
    violations,
  );
}

/** Non-empty source references: a non-empty array, or an object with >0 keys. */
function hasSourceReferences(refs: unknown): boolean {
  if (Array.isArray(refs)) return refs.length > 0;
  if (refs != null && typeof refs === 'object') return Object.keys(refs).length > 0;
  return false;
}

/**
 * (b) ERROR - every causal edge carries justification (non-empty trimmed
 * `reasoning` + non-empty `sourceReferences`) and is not a self-loop (cause !=
 * effect event; and not two events that resolve to the same underlying fact).
 */
export function causalJustification(graph: RichGraph): InvariantResult {
  const factIdByEvent = new Map<string, string | null>();
  for (const ev of graph.events) factIdByEvent.set(ev.id, ev.factId);

  const violations: Violation[] = [];
  for (const e of graph.edges) {
    if (!e.reasoning || e.reasoning.trim() === '') {
      violations.push({ kind: 'missing_reasoning', edgeIds: [e.id], detail: `edge ${e.id} has empty reasoning` });
    }
    if (!hasSourceReferences(e.sourceReferences)) {
      violations.push({ kind: 'missing_source_references', edgeIds: [e.id], detail: `edge ${e.id} has empty source_references` });
    }
    if (e.causeEventId === e.effectEventId) {
      violations.push({ kind: 'self_loop', edgeIds: [e.id], detail: `edge ${e.id} is a self-loop (cause event === effect event)` });
      continue;
    }
    // Distinct events, but both pointing at the same non-null fact is still a self-loop in fact-space.
    const causeFact = factIdByEvent.get(e.causeEventId) ?? null;
    const effectFact = factIdByEvent.get(e.effectEventId) ?? null;
    if (causeFact != null && effectFact != null && causeFact === effectFact) {
      violations.push({
        kind: 'self_loop_fact',
        edgeIds: [e.id],
        factIds: [causeFact],
        detail: `edge ${e.id} links two events that share fact ${causeFact} (self-loop in fact-space)`,
      });
    }
  }
  return result(
    'causalJustification',
    'Every causal edge has non-empty reasoning + source_references and is not a self-loop.',
    'error',
    violations,
  );
}

/**
 * (c) ERROR - no dangling references. Every fact/event/edge/contradiction/
 * same_as foreign key points at a row that exists in the dump.
 */
export function referentialIntegrity(graph: RichGraph): InvariantResult {
  const entityIds = new Set(graph.entities.map((e) => e.id));
  const factIds = new Set(graph.facts.map((f) => f.id));
  const eventIds = new Set(graph.events.map((ev) => ev.id));
  const edgeIds = new Set(graph.edges.map((e) => e.id));

  const violations: Violation[] = [];
  const dangling = (
    kind: string,
    rowId: string,
    field: string,
    refId: string,
    extra: Partial<Violation> = {},
  ): void => {
    violations.push({ kind, detail: `${field} ${refId} (on ${rowId}) references a missing row`, ...extra });
  };

  for (const f of graph.facts) {
    if (!entityIds.has(f.subjectEntityId)) dangling('dangling_fact_subject', f.id, 'fact.subjectEntityId', f.subjectEntityId, { factIds: [f.id], entityIds: [f.subjectEntityId] });
    if (f.objectEntityId != null && !entityIds.has(f.objectEntityId)) dangling('dangling_fact_object', f.id, 'fact.objectEntityId', f.objectEntityId, { factIds: [f.id], entityIds: [f.objectEntityId] });
  }
  for (const ev of graph.events) {
    if (ev.factId != null && !factIds.has(ev.factId)) dangling('dangling_event_fact', ev.id, 'event.factId', ev.factId, { factIds: [ev.factId] });
    if (ev.subjectEntityId != null && !entityIds.has(ev.subjectEntityId)) dangling('dangling_event_subject', ev.id, 'event.subjectEntityId', ev.subjectEntityId, { entityIds: [ev.subjectEntityId] });
  }
  for (const e of graph.edges) {
    if (!eventIds.has(e.causeEventId)) dangling('dangling_edge_cause', e.id, 'edge.causeEventId', e.causeEventId, { edgeIds: [e.id] });
    if (!eventIds.has(e.effectEventId)) dangling('dangling_edge_effect', e.id, 'edge.effectEventId', e.effectEventId, { edgeIds: [e.id] });
  }
  for (const c of graph.contradictions) {
    if (c.factAId != null && !factIds.has(c.factAId)) dangling('dangling_contradiction_fact_a', c.id, 'contradiction.factAId', c.factAId, { factIds: [c.factAId] });
    if (c.factBId != null && !factIds.has(c.factBId)) dangling('dangling_contradiction_fact_b', c.id, 'contradiction.factBId', c.factBId, { factIds: [c.factBId] });
    if (c.edgeAId != null && !edgeIds.has(c.edgeAId)) dangling('dangling_contradiction_edge_a', c.id, 'contradiction.edgeAId', c.edgeAId, { edgeIds: [c.edgeAId] });
    if (c.edgeBId != null && !edgeIds.has(c.edgeBId)) dangling('dangling_contradiction_edge_b', c.id, 'contradiction.edgeBId', c.edgeBId, { edgeIds: [c.edgeBId] });
    if (c.entityId != null && !entityIds.has(c.entityId)) dangling('dangling_contradiction_entity', c.id, 'contradiction.entityId', c.entityId, { entityIds: [c.entityId] });
  }
  for (const s of graph.sameAs) {
    if (!entityIds.has(s.entityAId)) dangling('dangling_sameas_a', s.id, 'sameAs.entityAId', s.entityAId, { entityIds: [s.entityAId] });
    if (!entityIds.has(s.entityBId)) dangling('dangling_sameas_b', s.id, 'sameAs.entityBId', s.entityBId, { entityIds: [s.entityBId] });
  }
  return result(
    'referentialIntegrity',
    'All fact/event/edge/contradiction/same_as foreign keys resolve to existing rows.',
    'error',
    violations,
  );
}

/**
 * (d) WARNING - an active fact's literal object should be a value, not a
 * sentence. Flags non-entity object_values longer than {@link MAX_OBJECT_VALUE_LEN}
 * chars or {@link MAX_OBJECT_VALUE_WORDS} words.
 */
export function objectValueNotSentence(graph: RichGraph): InvariantResult {
  const violations: Violation[] = [];
  for (const f of graph.facts) {
    if (!isActive(f)) continue;
    if (f.objectEntityId != null || f.objectValue == null) continue;
    const value = f.objectValue;
    const words = value.trim().split(/\s+/).filter(Boolean).length;
    if (value.length > MAX_OBJECT_VALUE_LEN || words > MAX_OBJECT_VALUE_WORDS) {
      violations.push({
        kind: 'object_value_sentence',
        factIds: [f.id],
        subjectId: f.subjectEntityId,
        detail: `fact ${f.id} object_value reads as a sentence (${value.length} chars, ${words} words): "${value}"`,
      });
    }
  }
  return result(
    'objectValueNotSentence',
    `Active literal object_values should be values, not sentences (<= ${MAX_OBJECT_VALUE_LEN} chars and <= ${MAX_OBJECT_VALUE_WORDS} words).`,
    'warning',
    violations,
  );
}

/**
 * (e) INFO - entities referenced by no active fact (as subject or object).
 * Orphans are not necessarily wrong (a freshly merged-in entity, an entity only
 * referenced by expired facts), hence info severity.
 */
export function orphanEntities(graph: RichGraph): InvariantResult {
  const referenced = new Set<string>();
  for (const f of graph.facts) {
    if (!isActive(f)) continue;
    referenced.add(f.subjectEntityId);
    if (f.objectEntityId != null) referenced.add(f.objectEntityId);
  }
  const violations: Violation[] = [];
  for (const e of graph.entities) {
    if (!referenced.has(e.id)) {
      violations.push({ kind: 'orphan_entity', entityIds: [e.id], detail: `entity ${e.id} (${e.name}) is referenced by no active fact` });
    }
  }
  return result(
    'orphanEntities',
    'Entities referenced by no active fact (as subject or object).',
    'info',
    violations,
  );
}

// ============================================
// Runner
// ============================================

/**
 * Run all graph-integrity invariants over a rich graph dump. Pure +
 * deterministic. `errorViolations` totals the offending rows across the
 * error-severity invariants - the headline pass/fail signal for metrics.json.
 */
export function runInvariants(graph: RichGraph): InvariantReport {
  const results: InvariantResult[] = [
    singleActivePerExclusiveGroup(graph),
    causalJustification(graph),
    referentialIntegrity(graph),
    objectValueNotSentence(graph),
    orphanEntities(graph),
  ];
  const passed = results.filter((r) => r.pass).length;
  const errorViolations = results
    .filter((r) => r.severity === 'error')
    .reduce((n, r) => n + r.violations.length, 0);
  return {
    results,
    summary: {
      total: results.length,
      passed,
      failed: results.length - passed,
      errorViolations,
    },
  };
}
