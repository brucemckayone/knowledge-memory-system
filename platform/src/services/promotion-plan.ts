/**
 * Promotion planner — the DETERMINISTIC, DB-FREE core of epoch-v2 promotion
 * (doc 41 §5 a–e, §10; bead nmemo-vpz.3 / E3).
 *
 * "Agents propose, reconciliation disposes" (doc 41 §1). The parallel extraction
 * proposers (Phase 2) write candidate entities/facts into per-epoch staging in
 * clean isolation. This module is the *authority* that, given the prior canonical
 * state + the full staged proposal set, computes — as a pure function — exactly
 * what the canonical graph should become:
 *
 *   (a) entity resolution    handle → canonical id | fresh cluster key
 *   (b) fact ref-rewrite     subject/object handles → resolved refs
 *   (c) group supersession   keep latest-valid per (subject, exclusive group)
 *   (d) triple dedup (P1)    identical triples corroborate, not duplicate
 *   (e) cleanup              drop self-loops; record genuine ambiguity
 *
 * The result is a {@link PromotionPlan} — a description of mutations, NOT the
 * mutations themselves. `promotion.ts` (the DB layer) loads the inputs, calls
 * {@link planPromotion}, and applies the plan in ONE transaction with audit rows.
 *
 * WHY pure + DB-free (same constraint exclusive-groups.ts carries): order
 * independence is the headline acceptance (doc 38 litmus, doc 41 §10). Because
 * planning touches no DB and mints no random ids — fresh entities are keyed by
 * deterministic *cluster keys*, real UUIDs are assigned later by the applier —
 * the litmus `planPromotion(forward) deep-equals planPromotion(reverse)` is a
 * plain unit test with zero infra. The only run-to-run variance left is the LLM
 * extraction layer, exactly as doc 41 §10 argues.
 *
 * Allowed imports: the DB-free exclusive-group ontology + the pure
 * predicate-ontology value module only. Never the DB pool.
 */

import {
  resolveExclusiveGroup,
  compareFactPrecedence,
  type FactPrecedence,
} from './exclusive-groups.js';

// ============================================
// Inputs — prior canonical (scoped) + staged proposals
// ============================================

/** A canonical entity already in the graph, scoped to what resolution needs. */
export interface PriorEntity {
  id: string;
  name: string;
  type: string;
}

/**
 * A canonical ACTIVE fact, scoped to supersession + triple-dedup. `exclusiveGroup`
 * is resolved by the loader (or planner) via the shared ontology so prior actives
 * and new proposals are grouped by the same key (doc 41 §9.1).
 */
export interface PriorFact {
  id: string;
  subjectEntityId: string;
  predicate: string;
  objectEntityId: string | null;
  objectValue: string | null;
  validAt: Date | null;
  confidence: number | null;
}

/** Staged proposed entity (mig 040 `staging_proposed_entities`, camelCased). */
export interface StagedEntity {
  handle: string;
  name: string;
  type: string;
  summary: string | null;
  anchorCanonicalId: string | null;
}

/** Staged proposed fact (mig 040 `staging_proposed_facts`, camelCased). */
export interface StagedFact {
  stagedFactId: string;
  subjectHandle: string;
  predicate: string;
  objectHandle: string | null;
  objectValue: string | null;
  validAt: Date | null;
  undated: boolean;
  chunkIndex: number | null;
  confidence: number | null;
  reasoning: string | null;
  /** Stored at propose time from the shared ontology; null = not exclusive. */
  exclusiveGroup: string | null;
}

export interface PriorCanonical {
  entities: PriorEntity[];
  /** Only the ACTIVE facts whose subject is touched this epoch are needed. */
  activeFacts: PriorFact[];
}

export interface StagedProposals {
  entities: StagedEntity[];
  facts: StagedFact[];
}

// ============================================
// Output — the promotion plan
// ============================================

/**
 * A resolved entity reference. `canonical` points at an existing/anchored
 * canonical id; `cluster` points at a fresh entity the applier will mint and
 * key by `clusterKey` (doc 41 §5a — no UUID minting in the pure planner).
 */
export type ResolvedRef =
  | { kind: 'canonical'; id: string }
  | { kind: 'cluster'; key: string };

/** A fresh entity to mint at apply time (one per fresh cluster). */
export interface PlannedEntity {
  clusterKey: string;
  name: string;
  type: string;
  summary: string | null;
  /** Staged handles folded into this cluster (provenance + apply-time map). */
  memberHandles: string[];
}

/** A staged fact to write to canonical, with its resolved refs + active state. */
export interface PlannedFact {
  stagedFactId: string;
  subjectRef: ResolvedRef;
  predicate: string;
  objectRef: ResolvedRef | null;
  objectValue: string | null;
  validAt: Date | null;
  chunkIndex: number | null;
  confidence: number;
  reasoning: string | null;
  exclusiveGroup: string | null;
  /** false = inserted already-expired (lost group supersession to a peer/prior). */
  active: boolean;
  /** Set when active=false because a later-valid fact in the group won. */
  expireReason: string | null;
  /** Staged dup triples folded into this one (corroboration, doc 41 §5d). */
  corroboratesStagedFactIds: string[];
}

/** A prior-canonical active fact that loses group supersession and must expire. */
export interface PlannedExpiry {
  factId: string;
  reason: string;
  /** The staged winner that superseded it (for the audit row), if any. */
  supersededByStagedFactId: string | null;
}

/** A staged triple that matches a prior-canonical active triple → corroborate. */
export interface PlannedCorroboration {
  priorFactId: string;
  /** max(prior, staged) confidence; applier raises only if higher. */
  confidence: number;
  stagedFactIds: string[];
}

/**
 * Residue the deterministic backbone cannot settle (doc 41 §5g, §8a.5). In E3 the
 * arbiter is a STUB (full recast is E5): each escalation is RECORDED and a
 * conservative default is applied so promotion always completes deterministically
 * (decision: conservative default + record escalation).
 *   - identity: a short name word-prefixes ≥2 DISTINCT canonical entities → keep
 *     the cluster DISTINCT (mint fresh) rather than guess which one.
 *   - conflict: an exclusive-group collision that valid_at+chunk_index ordering
 *     cannot break (equal on both, different object) → still pick by the
 *     confidence/id tiebreak, but flag it.
 */
export type Escalation =
  | {
      kind: 'identity';
      reason: string;
      clusterName: string;
      type: string;
      candidateIds: string[];
    }
  | {
      kind: 'conflict';
      reason: string;
      subjectRef: ResolvedRef;
      exclusiveGroup: string;
      factIds: string[];
    };

export interface PromotionPlan {
  entitiesToMint: PlannedEntity[];
  factsToInsert: PlannedFact[];
  factsToExpire: PlannedExpiry[];
  corroborations: PlannedCorroboration[];
  escalations: Escalation[];
  /** stagedFactIds dropped because subject resolved == object resolved. */
  droppedSelfLoops: string[];
}

// ============================================
// Name normalisation (deterministic, conservative)
// ============================================

const TITLE_PREFIXES = ['dr.', 'dr', 'mr.', 'mr', 'mrs.', 'mrs', 'ms.', 'ms', 'prof.', 'prof'];

/**
 * Normalise an entity name for deterministic clustering: lowercase, strip a
 * leading honorific, collapse whitespace, drop surrounding punctuation. Kept
 * deliberately conservative (doc 41 §12 #3 — "conservative first, tighten during
 * hardening"). E5 may enrich this; today it must be a pure, total function so the
 * litmus stays deterministic.
 */
export function normalizeName(name: string): string {
  let n = name.trim().toLowerCase().replace(/\s+/g, ' ');
  for (const p of TITLE_PREFIXES) {
    if (n.startsWith(p + ' ')) {
      n = n.slice(p.length + 1).trim();
      break;
    }
  }
  // Strip surrounding non-alphanumerics (keep internal spaces/hyphens).
  return n.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
}

/**
 * Word-prefix test: is `short` a token-boundary prefix of `long` (or equal)?
 * "helix" ⊑ "helix robotics" (true); "helix" ⊑ "helixology" (false). This is the
 * conservative containment rule that merges the doc-41 `nmemo-wyb` helix /
 * helix-robotics duplicate without over-merging unrelated names.
 */
function isWordPrefix(short: string, long: string): boolean {
  return short === long || long.startsWith(short + ' ');
}

const clusterKeyFor = (normName: string, type: string): string => `cluster:${type}|${normName}`;
const refKey = (ref: ResolvedRef): string =>
  ref.kind === 'canonical' ? `c:${ref.id}` : `k:${ref.key}`;
const objectKeyOf = (ref: ResolvedRef | null, objectValue: string | null): string =>
  ref ? refKey(ref) : `v:${objectValue ?? ''}`;

// ============================================
// (a) Entity resolution
// ============================================

interface EntityResolution {
  /** handle → resolved ref. */
  byHandle: Map<string, ResolvedRef>;
  entitiesToMint: PlannedEntity[];
  escalations: Escalation[];
}

/**
 * Deterministic entity resolution over the full proposal set (doc 41 §5a — "dedup
 * once, with full visibility"; this is where the 3-Elenas problem dies).
 *
 * Rules, in order, per (normalised name, type):
 *  1. Anchored proposals inherit their `anchorCanonicalId`; an anchored name also
 *     pins that (name,type) so unanchored peers resolve to the same canonical id.
 *  2. Exact normalised match against an anchor or a prior canonical entity → that id.
 *  3. Word-prefix match against prior canonical entities (either direction): a
 *     UNIQUE canonical id → resolve to it (merges helix → "helix robotics"); ≥2
 *     DISTINCT ids → identity escalation, keep the cluster distinct.
 *  4. Otherwise fresh: word-prefix-connected unanchored clusters of the same type
 *     fold into one fresh entity, keyed deterministically by the component's
 *     lexicographically-smallest normalised name (order-independent).
 */
function resolveEntities(prior: PriorEntity[], staged: StagedEntity[]): EntityResolution {
  const byHandle = new Map<string, ResolvedRef>();
  const escalations: Escalation[] = [];

  // Prior canonical by type → [{id, norm}]. (name,type) may legitimately repeat
  // across distinct ids only if the graph already has dupes; we treat each row.
  const priorByType = new Map<string, Array<{ id: string; norm: string }>>();
  for (const e of prior) {
    const list = priorByType.get(e.type) ?? [];
    list.push({ id: e.id, norm: normalizeName(e.name) });
    priorByType.set(e.type, list);
  }

  // Anchored proposals pin (norm,type) → canonicalId so peers align (rule 1).
  const anchorByNameType = new Map<string, string>();
  for (const e of staged) {
    if (e.anchorCanonicalId) {
      byHandle.set(e.handle, { kind: 'canonical', id: e.anchorCanonicalId });
      anchorByNameType.set(`${e.type}|${normalizeName(e.name)}`, e.anchorCanonicalId);
    }
  }

  // Unanchored handles grouped by (norm,type).
  const unanchored = staged.filter((e) => !e.anchorCanonicalId);
  const clustersByKey = new Map<string, { norm: string; type: string; handles: string[] }>();
  for (const e of unanchored) {
    const norm = normalizeName(e.name);
    const key = `${e.type}|${norm}`;
    const c = clustersByKey.get(key) ?? { norm, type: e.type, handles: [] };
    c.handles.push(e.handle);
    clustersByKey.set(key, c);
  }

  // Resolve each (norm,type) cluster to an existing id where possible (rules 1–3).
  // Clusters that stay fresh are collected for type-local component merging (4).
  const freshByType = new Map<string, Array<{ norm: string; handles: string[] }>>();
  for (const c of clustersByKey.values()) {
    const anchorId = anchorByNameType.get(`${c.type}|${c.norm}`);
    if (anchorId) {
      for (const h of c.handles) byHandle.set(h, { kind: 'canonical', id: anchorId });
      continue;
    }
    const priors = priorByType.get(c.type) ?? [];
    const exact = priors.find((p) => p.norm === c.norm);
    if (exact) {
      for (const h of c.handles) byHandle.set(h, { kind: 'canonical', id: exact.id });
      continue;
    }
    // Word-prefix match against prior canonical (either direction).
    const matchedIds = [
      ...new Set(
        priors
          .filter((p) => isWordPrefix(c.norm, p.norm) || isWordPrefix(p.norm, c.norm))
          .map((p) => p.id),
      ),
    ];
    if (matchedIds.length === 1) {
      for (const h of c.handles) byHandle.set(h, { kind: 'canonical', id: matchedIds[0]! });
      continue;
    }
    if (matchedIds.length >= 2) {
      escalations.push({
        kind: 'identity',
        reason: `"${c.norm}" word-prefix-matches ${matchedIds.length} distinct canonical entities of type ${c.type}; cannot disambiguate deterministically`,
        clusterName: c.norm,
        type: c.type,
        candidateIds: matchedIds.sort(),
      });
      // Conservative default: keep distinct (fall through to fresh).
    }
    const list = freshByType.get(c.type) ?? [];
    list.push({ norm: c.norm, handles: c.handles });
    freshByType.set(c.type, list);
  }

  // (4) Fold word-prefix-connected fresh clusters of the same type into one
  // entity. Union-find over prefix edges; component key = smallest norm name
  // (deterministic ⇒ order-independent). Fresh↔fresh merges are the cheap absorb
  // doc 41 §4 accepts (the dangerous case — merging into the WRONG existing id —
  // is guarded by rule 3's distinct-id escalation above).
  const entitiesToMint: PlannedEntity[] = [];
  for (const [type, clusters] of freshByType) {
    const parent = new Map<string, string>();
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      let cur = x;
      while (parent.get(cur) !== r) {
        const next = parent.get(cur)!;
        parent.set(cur, r);
        cur = next;
      }
      return r;
    };
    for (const c of clusters) parent.set(c.norm, c.norm);
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const a = clusters[i]!.norm;
        const b = clusters[j]!.norm;
        if (isWordPrefix(a, b) || isWordPrefix(b, a)) {
          const ra = find(a);
          const rb = find(b);
          if (ra !== rb) parent.set(ra > rb ? ra : rb, ra > rb ? rb : ra); // attach to smaller
        }
      }
    }
    const components = new Map<string, { norms: string[]; handles: string[] }>();
    for (const c of clusters) {
      const root = find(c.norm);
      const comp = components.get(root) ?? { norms: [], handles: [] };
      comp.norms.push(c.norm);
      comp.handles.push(...c.handles);
      components.set(root, comp);
    }
    for (const [root, comp] of components) {
      const key = clusterKeyFor(root, type);
      // Display name = the most specific (longest) member name, ties broken
      // lexicographically — deterministic and the friendliest canonical label.
      const name = [...comp.norms].sort((a, b) => b.length - a.length || (a < b ? -1 : 1))[0]!;
      entitiesToMint.push({ clusterKey: key, name, type, summary: null, memberHandles: comp.handles.sort() });
      for (const h of comp.handles) byHandle.set(h, { kind: 'cluster', key });
    }
  }

  return { byHandle, entitiesToMint, escalations };
}

// ============================================
// planPromotion — the pure entry point
// ============================================

/**
 * Compute the canonical-graph mutations for one epoch's promotion (doc 41 §5).
 * Pure: no DB, no embeddings, no random ids — same (prior, staged) always yields
 * the same plan, and `planPromotion(forward) deep-equals planPromotion(reverse)`
 * (doc 41 §10, the doc-38 litmus by construction).
 */
export function planPromotion(prior: PriorCanonical, staged: StagedProposals): PromotionPlan {
  // (a) Entity resolution.
  const { byHandle, entitiesToMint, escalations } = resolveEntities(prior.entities, staged.entities);

  // (b) Ref-rewrite + (e) self-loop drop. A staged fact whose subject handle is
  // unknown is dropped defensively (a proposer referenced a non-proposed entity).
  const droppedSelfLoops: string[] = [];
  interface RewrittenFact {
    f: StagedFact;
    subjectRef: ResolvedRef;
    objectRef: ResolvedRef | null;
    subjKey: string;
    objKey: string;
    tripleKey: string;
  }
  const rewritten: RewrittenFact[] = [];
  for (const f of staged.facts) {
    const subjectRef = byHandle.get(f.subjectHandle);
    if (!subjectRef) continue; // dangling subject — not proposable; skip
    let objectRef: ResolvedRef | null = null;
    if (f.objectHandle) {
      objectRef = byHandle.get(f.objectHandle) ?? null;
      if (!objectRef) continue; // dangling object handle — skip
    }
    const subjKey = refKey(subjectRef);
    const objKey = objectKeyOf(objectRef, f.objectValue);
    if (objKey === subjKey) {
      droppedSelfLoops.push(f.stagedFactId);
      continue;
    }
    rewritten.push({
      f,
      subjectRef,
      objectRef,
      subjKey,
      objKey,
      tripleKey: `${subjKey}|${f.predicate}|${objKey}`,
    });
  }

  // (d) Triple dedup across the epoch — identical triples corroborate. The
  // representative is the precedence WINNER of the dup set (latest-valid), so the
  // surviving fact carries the right validAt/chunkIndex into supersession.
  const precedenceOf = (r: RewrittenFact): FactPrecedence => ({
    validAt: r.f.validAt,
    chunkIndex: r.f.chunkIndex,
    confidence: r.f.confidence,
    id: r.f.stagedFactId,
  });
  const dupGroups = new Map<string, RewrittenFact[]>();
  for (const r of rewritten) {
    const g = dupGroups.get(r.tripleKey) ?? [];
    g.push(r);
    dupGroups.set(r.tripleKey, g);
  }
  // Representative per triple + folded-in dup ids + max confidence.
  const reps: Array<{ r: RewrittenFact; confidence: number; foldedIds: string[] }> = [];
  for (const g of dupGroups.values()) {
    const sorted = [...g].sort((a, b) => compareFactPrecedence(precedenceOf(a), precedenceOf(b)));
    const rep = sorted[sorted.length - 1]!; // winner last
    const confidence = Math.max(...g.map((x) => x.f.confidence ?? 0));
    const foldedIds = g.filter((x) => x !== rep).map((x) => x.f.stagedFactId).sort();
    reps.push({ r: rep, confidence, foldedIds });
  }

  // Dedup against prior-canonical actives: a staged triple that already exists
  // active corroborates the prior fact instead of inserting a new row (doc 41 §5d).
  const priorTripleIndex = new Map<string, PriorFact>();
  for (const pf of prior.activeFacts) {
    const objKey = pf.objectEntityId ? `c:${pf.objectEntityId}` : `v:${pf.objectValue ?? ''}`;
    priorTripleIndex.set(`c:${pf.subjectEntityId}|${pf.predicate}|${objKey}`, pf);
  }

  const corroborations: PlannedCorroboration[] = [];
  const insertable: Array<{ r: RewrittenFact; confidence: number; foldedIds: string[] }> = [];
  for (const rep of reps) {
    const priorMatch = priorTripleIndex.get(rep.r.tripleKey);
    if (priorMatch) {
      corroborations.push({
        priorFactId: priorMatch.id,
        confidence: Math.max(priorMatch.confidence ?? 0, rep.confidence),
        stagedFactIds: [rep.r.f.stagedFactId, ...rep.foldedIds].sort(),
      });
    } else {
      insertable.push(rep);
    }
  }

  // (c) Group-aware supersession in (validAt, chunkIndex, confidence, id) order
  // over prior actives + new insertables per (canonical subject, exclusive group).
  // Prior-canonical actives only have a stable canonical id, so they group under a
  // `c:<id>` subject key — fresh-cluster subjects never collide with them.
  interface GroupMember {
    prec: FactPrecedence;
    objKey: string;
    insertableRep?: { r: RewrittenFact; confidence: number; foldedIds: string[] };
    priorFact?: PriorFact;
  }
  const groups = new Map<string, GroupMember[]>();
  const groupKey = (subjKey: string, group: string): string => `${subjKey}::${group}`;

  for (const rep of insertable) {
    const group = rep.r.f.exclusiveGroup ?? resolveExclusiveGroup(rep.r.f.predicate);
    if (!group) continue;
    const k = groupKey(rep.r.subjKey, group);
    const arr = groups.get(k) ?? [];
    arr.push({
      prec: { ...precedenceOf(rep.r), confidence: rep.confidence },
      objKey: rep.r.objKey,
      insertableRep: rep,
    });
    groups.set(k, arr);
  }
  for (const pf of prior.activeFacts) {
    const group = resolveExclusiveGroup(pf.predicate);
    if (!group) continue;
    const subjKey = `c:${pf.subjectEntityId}`;
    const k = groupKey(subjKey, group);
    if (!groups.has(k)) continue; // no new proposal in this group → leave prior alone
    const objKey = pf.objectEntityId ? `c:${pf.objectEntityId}` : `v:${pf.objectValue ?? ''}`;
    groups.get(k)!.push({
      prec: { validAt: pf.validAt, chunkIndex: null, confidence: pf.confidence, id: pf.id },
      objKey,
      priorFact: pf,
    });
  }

  // Within each group: winner (last after ascending sort) stays active; the rest
  // expire. Prior losers → factsToExpire; insertable losers → active=false.
  const factsToExpire: PlannedExpiry[] = [];
  const supersededInsertable = new Map<string, string>(); // stagedFactId → expireReason
  for (const [k, members] of groups) {
    if (members.length < 2) continue;
    const sorted = [...members].sort((a, b) => compareFactPrecedence(a.prec, b.prec));
    const winner = sorted[sorted.length - 1]!;
    const runnerUp = sorted[sorted.length - 2]!;
    const group = k.split('::')[1]!;

    // Conflict escalation (doc 41 §5g, §8a.5): winner and runner-up tie on the
    // meaningful keys (valid_at + chunk_index) yet assert different objects —
    // ordering cannot break it. Record + keep the deterministic pick.
    if (
      cmpValidAtChunk(winner.prec, runnerUp.prec) === 0 &&
      winner.objKey !== runnerUp.objKey
    ) {
      escalations.push({
        kind: 'conflict',
        reason: `exclusive group "${group}" has co-equal facts (same valid_at + chunk_index) with different objects; resolved by confidence/id tiebreak`,
        subjectRef: winner.insertableRep
          ? winner.insertableRep.r.subjectRef
          : { kind: 'canonical', id: winner.priorFact!.subjectEntityId },
        exclusiveGroup: group,
        factIds: members
          .map((m) => (m.insertableRep ? m.insertableRep.r.f.stagedFactId : m.priorFact!.id))
          .sort(),
      });
    }

    const winnerStagedId = winner.insertableRep?.r.f.stagedFactId ?? null;
    for (const m of sorted.slice(0, -1)) {
      const reason = `superseded by latest-valid in exclusive group "${group}"`;
      if (m.priorFact) {
        factsToExpire.push({
          factId: m.priorFact.id,
          reason,
          supersededByStagedFactId: winnerStagedId,
        });
      } else if (m.insertableRep) {
        supersededInsertable.set(m.insertableRep.r.f.stagedFactId, reason);
      }
    }
  }

  // Materialise factsToInsert from insertables, stamping active/expireReason.
  const factsToInsert: PlannedFact[] = insertable.map((rep) => {
    const expireReason = supersededInsertable.get(rep.r.f.stagedFactId) ?? null;
    return {
      stagedFactId: rep.r.f.stagedFactId,
      subjectRef: rep.r.subjectRef,
      predicate: rep.r.f.predicate,
      objectRef: rep.r.objectRef,
      objectValue: rep.r.objectRef ? null : rep.r.f.objectValue,
      validAt: rep.r.f.validAt,
      chunkIndex: rep.r.f.chunkIndex,
      confidence: rep.confidence,
      reasoning: rep.r.f.reasoning,
      exclusiveGroup: rep.r.f.exclusiveGroup ?? resolveExclusiveGroup(rep.r.f.predicate),
      active: expireReason == null,
      expireReason,
      corroboratesStagedFactIds: rep.foldedIds,
    };
  });

  // Canonical sort of every array so the plan is order-independent by value and
  // the litmus is a plain deep-equal (doc 41 §10).
  return {
    entitiesToMint: entitiesToMint.sort((a, b) => (a.clusterKey < b.clusterKey ? -1 : 1)),
    factsToInsert: factsToInsert.sort((a, b) => (a.stagedFactId < b.stagedFactId ? -1 : 1)),
    factsToExpire: factsToExpire.sort((a, b) => (a.factId < b.factId ? -1 : 1)),
    corroborations: corroborations.sort((a, b) => (a.priorFactId < b.priorFactId ? -1 : 1)),
    escalations: escalations.sort((a, b) => (escalationKey(a) < escalationKey(b) ? -1 : 1)),
    droppedSelfLoops: droppedSelfLoops.sort(),
  };
}

/** Compare only the meaningful ordering keys (valid_at then chunk_index). */
function cmpValidAtChunk(a: FactPrecedence, b: FactPrecedence): number {
  const av = a.validAt ?? null;
  const bv = b.validAt ?? null;
  if (av && bv && av.getTime() !== bv.getTime()) return av.getTime() - bv.getTime();
  if (av && !bv) return 1;
  if (!av && bv) return -1;
  const ac = a.chunkIndex ?? null;
  const bc = b.chunkIndex ?? null;
  if (ac != null && bc != null) return ac - bc;
  if (ac != null && bc == null) return 1;
  if (ac == null && bc != null) return -1;
  return 0;
}

const escalationKey = (e: Escalation): string =>
  e.kind === 'identity' ? `identity|${e.type}|${e.clusterName}` : `conflict|${e.exclusiveGroup}|${e.factIds.join(',')}`;
