/**
 * LearnerLessonContext — section-scoped snapshot of the learner's Graph S/C
 * state used by the lesson-generation pipeline.
 *
 * Single fetch in the orchestrator; threaded through the outliner, prose
 * writers, and artifact builder. Cold-start (no learner-fact touches a
 * section concept) returns the canonical empty context — agents gate all
 * personalisation prompt augmentation on `coldStart === false`, so the
 * cold-start pipeline emits byte-identical user prompts to the v0.3 baseline.
 *
 * Platform-fetch failures degrade to a cold-start context with a logged
 * warning. Lesson generation must never block on a flaky platform call.
 */

import {
  getLearnerFacts,
  type NmemoFact,
} from '../services/nmemo-client.js';

// ---------------------------------------------------------------------------
// Public type — a single typed snapshot threaded through the pipeline.
// ---------------------------------------------------------------------------

export interface ForgottenConcept {
  entityId: string;
  name: string;
  lastConfidence: number;
  daysSince: number;
}

export interface Confusion {
  entityId: string | null;
  concept: string;
  misconception: string;
  sourceText: string | null;
}

export interface MissingPrereq {
  concept: string;
  neededFor: string;
}

export interface EstablishedConcept {
  entityId: string | null;
  concept: string;
  confidence: number;
}

export interface LearnerLessonContext {
  /** True when no learner-facts touched any concept in section.conceptEntityIds. */
  coldStart: boolean;
  /** Learner facts whose objectEntityId or subjectEntityId is in section.conceptEntityIds. */
  relevantFacts: NmemoFact[];
  /** Concepts the learner once knew at confidence >= 0.6 but whose most recent
   *  fact is older than 14 days — i.e. decay candidates. */
  forgottenConcepts: ForgottenConcept[];
  /** Active confusions on the section's concepts. Populated from facts with
   *  predicate ∈ {confused_by, lacks_understanding_of, struggles_with}. */
  confusions: Confusion[];
  /** Prerequisite concepts the learner is flagged as lacking
   *  (predicate=lacks_prerequisite). */
  missingPrereqs: MissingPrereq[];
  /** Strong understandings (confidence >= 0.7) — outliner can skip motivation
   *  prose for these. */
  established: EstablishedConcept[];
  /** Snapshot timestamp (ISO) for staleness checks and logging. */
  fetchedAt: string;
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

const DECAY_DAYS = 14;
const ESTABLISHED_THRESHOLD = 0.7;
const FORGOTTEN_MIN_PEAK = 0.6;
const FETCH_TIMEOUT_MS = 5_000;
const PREREQ_CHAIN_CAP = 5;

/** Promise + timeout that rejects if the source promise hasn't settled. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (err) => { clearTimeout(t); reject(err); },
    );
  });
}

/** True when no learner-fact touches any concept in `sectionConceptIds`. */
export function isColdStart(facts: NmemoFact[], sectionConceptIds: string[]): boolean {
  if (sectionConceptIds.length === 0) return true;
  const ids = new Set(sectionConceptIds);
  return !facts.some((f) =>
    (f.objectEntityId != null && ids.has(f.objectEntityId)) ||
    (f.subjectEntityId != null && ids.has(f.subjectEntityId)),
  );
}

function readCreatedAt(fact: NmemoFact): string | undefined {
  // The /api/learn/learner-facts endpoint includes createdAt on the wire even
  // though the typed interface omits it; defensive read-through.
  const maybe = (fact as unknown as { createdAt?: unknown }).createdAt;
  return typeof maybe === 'string' ? maybe : undefined;
}

function daysSince(iso: string): number {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor((Date.now() - t) / (1000 * 60 * 60 * 24)));
}

function pickConceptName(fact: NmemoFact): string {
  // Prefer object entity id (caller often knows its name from concept lookup),
  // but fall back to objectValue (free-text) for unresolved facts.
  return fact.objectValue?.trim() || fact.objectEntityId || fact.subjectEntityId || 'unknown concept';
}

/**
 * Derive the typed context from the raw learner-fact list, scoped to this
 * section's concept ids. Pure — no I/O — so it's trivially unit-testable.
 *
 * `entityNamesById` is an optional lookup the caller can pre-fetch so the
 * confusion / forgotten / established arrays carry human-readable names.
 * When the lookup misses, we fall back to objectValue or the entity id.
 */
export function deriveLearnerLessonContext(
  facts: NmemoFact[],
  sectionConceptIds: string[],
  entityNamesById: Map<string, string> = new Map(),
  fetchedAt: string = new Date().toISOString(),
): LearnerLessonContext {
  const coldStart = isColdStart(facts, sectionConceptIds);
  const conceptIds = new Set(sectionConceptIds);

  if (coldStart) {
    return {
      coldStart: true,
      relevantFacts: [],
      forgottenConcepts: [],
      confusions: [],
      missingPrereqs: [],
      established: [],
      fetchedAt,
    };
  }

  const relevantFacts: NmemoFact[] = [];
  const confusions: Confusion[] = [];
  const missingPrereqs: MissingPrereq[] = [];
  const established: EstablishedConcept[] = [];
  /** Track most-recent `understands` fact per entity for forgotten-concept derivation. */
  const understandsByEntity = new Map<string, { fact: NmemoFact; createdAt: string | undefined }>();

  for (const f of facts) {
    const touchesObject = f.objectEntityId != null && conceptIds.has(f.objectEntityId);
    const touchesSubject = f.subjectEntityId != null && conceptIds.has(f.subjectEntityId);
    if (!touchesObject && !touchesSubject) continue;
    relevantFacts.push(f);

    const conceptId = touchesObject ? f.objectEntityId! : f.subjectEntityId!;
    const conceptName = entityNamesById.get(conceptId) ?? pickConceptName(f);

    switch (f.predicate) {
      case 'confused_by':
      case 'lacks_understanding_of':
      case 'struggles_with': {
        confusions.push({
          entityId: f.objectEntityId ?? null,
          concept: conceptName,
          misconception: (f.objectValue ?? f.sourceText ?? '').trim() || conceptName,
          sourceText: f.sourceText ?? null,
        });
        break;
      }
      case 'lacks_prerequisite': {
        // For a `lacks_prerequisite` fact, the *subject* is the concept the
        // learner is studying and the *object* is the prereq they lack.
        const prereqName = entityNamesById.get(f.objectEntityId ?? '') ?? f.objectValue ?? f.objectEntityId ?? 'unknown prereq';
        const neededFor = entityNamesById.get(f.subjectEntityId) ?? f.subjectEntityId;
        missingPrereqs.push({ concept: prereqName, neededFor });
        break;
      }
      case 'understands': {
        const conf = f.confidence ?? 0;
        if (conf >= ESTABLISHED_THRESHOLD) {
          established.push({
            entityId: f.objectEntityId ?? null,
            concept: conceptName,
            confidence: conf,
          });
        }
        // Track for forgotten-concept derivation regardless of confidence —
        // a concept once known well but dormant is a candidate.
        const createdAt = readCreatedAt(f);
        const prior = understandsByEntity.get(conceptId);
        const priorTs = prior?.createdAt ? Date.parse(prior.createdAt) : -Infinity;
        const thisTs = createdAt ? Date.parse(createdAt) : -Infinity;
        if (thisTs > priorTs) {
          understandsByEntity.set(conceptId, { fact: f, createdAt });
        }
        break;
      }
      default:
        break;
    }
  }

  // Forgotten-concept derivation: most-recent `understands` fact, peak
  // confidence at or above FORGOTTEN_MIN_PEAK, last fact older than DECAY_DAYS.
  const forgottenConcepts: ForgottenConcept[] = [];
  for (const [entityId, { fact, createdAt }] of understandsByEntity.entries()) {
    const peak = fact.confidence ?? 0;
    if (peak < FORGOTTEN_MIN_PEAK) continue;
    if (!createdAt) continue;
    const days = daysSince(createdAt);
    if (days < DECAY_DAYS) continue;
    forgottenConcepts.push({
      entityId,
      name: entityNamesById.get(entityId) ?? pickConceptName(fact),
      lastConfidence: peak,
      daysSince: days,
    });
  }

  return {
    coldStart: false,
    relevantFacts,
    forgottenConcepts,
    confusions,
    missingPrereqs,
    established,
    fetchedAt,
  };
}

/**
 * Cold-start sentinel — passed to agents when the learner has no relevant
 * state. Prompt augmentation in outliner / prose writer is gated on
 * `coldStart === false`, so passing this object yields byte-identical
 * user prompts to the v0.3 baseline.
 */
export function makeColdStartContext(fetchedAt: string = new Date().toISOString()): LearnerLessonContext {
  return {
    coldStart: true,
    relevantFacts: [],
    forgottenConcepts: [],
    confusions: [],
    missingPrereqs: [],
    established: [],
    fetchedAt,
  };
}

// ---------------------------------------------------------------------------
// Loader — single platform fetch, with degrade-on-failure.
// ---------------------------------------------------------------------------

/**
 * Fetch the learner-fact list once and derive the section-scoped context.
 *
 * On any platform error, timeout, or invalid response, log a single warning
 * and return a cold-start context. The pipeline must never abort because of
 * a flaky platform call.
 *
 * `entityNamesById` is optional; if the orchestrator already has a concept-id
 * → name lookup it can be passed for richer prompts. Caller decides whether
 * to incur an extra round-trip — current implementation does not.
 */
export async function loadLearnerLessonContext(
  sectionConceptIds: string[],
  opts: {
    entityNamesById?: Map<string, string>;
    fetchLearnerFacts?: () => Promise<{ facts: NmemoFact[] }>;
    timeoutMs?: number;
  } = {},
): Promise<LearnerLessonContext> {
  const fetchedAt = new Date().toISOString();
  const fetcher = opts.fetchLearnerFacts ?? getLearnerFacts;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;

  let facts: NmemoFact[];
  try {
    const result = await withTimeout(fetcher(), timeoutMs, 'getLearnerFacts');
    if (!result || !Array.isArray(result.facts)) {
      console.warn('[lesson-generator] learner-state fetch returned non-array facts; treating as cold-start');
      return makeColdStartContext(fetchedAt);
    }
    facts = result.facts;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[lesson-generator] learner-state fetch failed: ${msg}; degrading to cold-start`);
    return makeColdStartContext(fetchedAt);
  }

  return deriveLearnerLessonContext(facts, sectionConceptIds, opts.entityNamesById, fetchedAt);
}

// Internal helpers exposed for unit-style testing.
export const __test = {
  deriveLearnerLessonContext,
  isColdStart,
  withTimeout,
  PREREQ_CHAIN_CAP,
  DECAY_DAYS,
  ESTABLISHED_THRESHOLD,
};
