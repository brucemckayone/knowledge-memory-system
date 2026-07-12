/**
 * Onboarding state machine service (iOS API v1 — ASK-010 / EPIC 2).
 *
 * Evaluates the substrate signals after each ingest and advances the user's
 * position in the onboarding prompt arc (design/08-onboarding.md §"Stage
 * transitions"), pre-composes the current-stage prompt DETERMINISTICALLY
 * (NO LLM — single-sentence Voice-C questions), and shapes the result to the
 * iOS OnboardingState wire. iOS reads via GET /api/onboarding/current-prompt and
 * renders; the three focus mutations (confirm / untangle / rename) advance or
 * garden the candidate list.
 *
 * Sources aggregated (all pre-computed, no inline LLM) — the SAME 4 graph
 * sources going.ts aggregates, plus a memory_count read:
 *   - memory_index   (raw SQL count)                          — entry count (S1→S2)
 *   - entity_clusters (getClustersSnapshot / clustering.ts)   — cluster + prob (S2→S3)
 *                                                                + the -1 noise skip
 *   - entity_topology (getTopologySnapshot / topology.ts)     — community_id (S3→S4)
 *   - entity_drift_events (getDriftEvents / drift.ts)         — stability / movement
 *                                                                (S3→S4 drift threshold)
 *   - entities + memory_entities (raw SQL)                    — canonical_name + the
 *                                                                supporting-entry count
 *                                                                (entity_meta.source_memory_count)
 *
 * WIRE CONTRACT this service must satisfy (iOS OnboardingState.swift): the
 * response is a BARE OnboardingState object (no envelope), camelCase, fields:
 *   - stage         ∈ stage_1|stage_2|stage_3|awaiting_confirmation|confirmed
 *                    (an unknown value => iOS dataCorrupted; never emit else)
 *   - prompt        = { promptId, text, kind, issuedAt } all non-empty;
 *                    kind ∈ opening|entity-citing|themed|confirmation|re-entry-softener;
 *                    issuedAt is ISO-8601 (the iOS APIClient JSONDecoder uses .iso8601).
 *                    prompt:null is meaningful (confirmed stage, OR hard-topic).
 *   - isHardTopic   absent→false (decoder default). v1 ships false (see DECISION).
 *   - inferredFocus = [{ entityId, name, supportingEntries≥0 }] present ONLY at
 *                    awaiting_confirmation; absent/null otherwise.
 *
 * The prompt arc + the hard-rule "a stage never regresses"
 * (design/08-onboarding.md:137) are owned HERE: advancement writes the new
 * stage + a freshly-composed prompt to user_onboarding_state; GET is a pure
 * read of that pre-computed state (composition cadence per §"Composition
 * cadence": compose ON stage transition, never synchronously on GET).
 *
 * DECISIONS (documented in code comments where they bite):
 *   - Stability proxy (S2→S3, S3→S4): the cluster/topology tables carry only a
 *     single computed_at snapshot, not a per-cluster stability history. We
 *     approximate "stable over recent ingests" by the cluster's representative
 *     entity's first_seen_at being ≥ STABILITY_INGESTS ingests ago — mirroring
 *     going.ts:58-64's first_seen_at proxy ("an entity first seen <N ago
 *     cannot yet have a stable throughline"). N is a tunable knob below.
 *   - isHardTopic ships false in v1 — no grief/crisis classifier exists; the
 *     iOS decoder handles absent→false. FOLLOW-UP: ship a classifier.
 *   - evaluateStage is called UNCONDITIONALLY on every extraction drain
 *     (pipeline.drainExtraction): the stage machine is substrate-driven, not
 *     source-gated (a non-onboarding ingest still densifies the graph —
 *     design/08-onboarding.md:15). Best-effort: a try/catch warns + never fails
 *     the extraction.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { getClustersSnapshot } from './clustering.js';
import { getTopologySnapshot } from './topology.js';
import { getDriftEvents } from './drift.js';
import { getSelfEntity } from './entities.js';
import { assertVoiceC } from './voice-c-composer.js';

// =============================================================================
// Tunable knobs
// =============================================================================

/** ≥3 entries AND ≥1 entity above confidence advances Stage 1 → Stage 2
 *  (design/08-onboarding.md:130). memory_index count is the entry signal. */
const MIN_ENTRIES_STAGE_2 = 3;

/** An entity with source_memory_count (entity_meta) at least this counts as the
 *  "≥1 entity above confidence threshold" signal for S1→S2. entity_meta is the
 *  pre-computed per-entity rollup; source_memory_count is the closest
 *  persisted confidence proxy (an entity mentioned in ≥2 distinct memories is
 *  above the noise floor). 1 means "mentioned in ≥1 memory" — the floor. */
const MIN_ENTITY_CONFIDENCE_STAGE_2 = 1;

/** HDBSCAN cluster_probability floor for a cluster to count toward S2→S3
 *  (design/08-onboarding.md:131: "cluster_probability ≥ 0.6"). */
const MIN_CLUSTER_PROBABILITY = 0.6;

/** STABILITY PROXY. "stable over recent updates" (design/08-onboarding.md:131)
 *  is approximated by the cluster's representative entity having been seen at
 *  least this many MEMORY_INDEX entries (ingests) ago. The cluster tables
 *  carry only a single computed_at snapshot, not a stability history — so we
 *  cannot directly ask "has this cluster been the same shape for N ingests?".
 *  first_seen_at of the representative entity, measured against the running
 *  memory_index count, is a conservative proxy: an entity first seen in the
 *  most recent ingest cannot yet be stable. Mirrors going.ts's first_seen_at
 *  decision (going.ts:58-64, 319-332).
 *
 *  NOTE: first_seen_at is a TIMESTAMP, not an ingest-index. We convert via the
 *  memory_index created_at sequence — but that requires a join we avoid in the
 *  hot path. Instead we use a TIME window STABILITY_HOURS as the proxy unit,
 *  documented here: a representative entity older than STABILITY_HOURS counts
 *  as stable. This is the same wall-clock proxy going.ts applies (4 weeks for
 *  throughline confirmation); onboarding's window is much shorter because the
 *  arc advances over days, not months. */
const STABILITY_HOURS = 24;

/** ≥2 stable clusters advances Stage 3 → awaiting_confirmation
 *  (design/08-onboarding.md:132). */
const MIN_STABLE_CLUSTERS = 2;

/** ≥3 supporting entries per cluster for the S3→S4 gate
 *  (design/08-onboarding.md:132). entity_meta.source_memory_count is the
 *  supporting-entry count per representative entity. */
const MIN_SUPPORTING_ENTRIES_PER_CLUSTER = 3;

/** ≥2 distinct communities for the S3→S4 gate (design/08-onboarding.md:132). */
const MIN_COMMUNITIES = 2;

/** Drift magnitude ceiling for the S3→S4 gate ("drift state below threshold"
 *  — design/08-onboarding.md:132). We count entities whose LATEST drift event
 *  exceeds this magnitude; if any qualifying cluster's representative moved
 *  recently, that cluster is not yet stable. */
const DRIFT_MAGNITUDE_CEILING = 0.5;

/** How many top clusters' representative entities feed the Stage 4 confirmation
 *  prompt + the inferredFocus candidate list. design/08-onboarding.md:111
 *  shows a 3-name example; we cap at 3. */
const MAX_INFERRED_FOCUS = 3;

// =============================================================================
// Wire DTO (camelCase — matches the iOS CodingKeys exactly)
// =============================================================================

export type OnboardingStage =
  | 'stage_1'
  | 'stage_2'
  | 'stage_3'
  | 'awaiting_confirmation'
  | 'confirmed';

export type PromptKind =
  | 'opening'
  | 'entity-citing'
  | 'themed'
  | 'confirmation'
  | 're-entry-softener';

export interface OnboardingPrompt {
  promptId: string;
  text: string;
  kind: PromptKind;
  /** ISO-8601 — the iOS APIClient JSONDecoder uses .iso8601. */
  issuedAt: string;
}

export interface InferredFocusItem {
  entityId: string;
  name: string;
  supportingEntries: number;
}

/** The bare OnboardingState object shipped on the wire (no envelope).
 *  isHardTopic + inferredFocus are emitted via `undefined` (omit) when absent,
 *  so the JSON omits them — the iOS decoder's decodeIfPresent handles
 *  absent→false / absent→null. */
export interface OnboardingState {
  stage: OnboardingStage;
  prompt: OnboardingPrompt | null;
  isHardTopic?: boolean;
  inferredFocus?: InferredFocusItem[] | null;
}

const STAGE_ORDER: OnboardingStage[] = [
  'stage_1',
  'stage_2',
  'stage_3',
  'awaiting_confirmation',
  'confirmed',
];

function stageRank(s: OnboardingStage): number {
  return STAGE_ORDER.indexOf(s);
}

// =============================================================================
// Curated prompt sets (DETERMINISTIC — no LLM; single-sentence Voice-C)
// =============================================================================
// The texts are drawn from design/08-onboarding.md §"The prompt arc" stages and
// the iOS FixtureOnboardingProvider (FixtureOnboardingProvider.swift:171-279 —
// read for the exact Voice-C forms). Each is assertVoiceC-guarded at compose
// time. The selection within a stage is rotation-stable: pick by (entryCount %
// set.length) so a sparse Stage-1 user sees varied openings across days
// (§"Composition cadence") but a given graph state always picks the same one.

const OPENING_PROMPTS: readonly string[] = [
  "what's been on your mind lately?",
  "what hasn't been said yet?",
  "what's present, right now?",
];

// FOLLOW-UP: re-entry softeners (design/08-onboarding.md §"Re-entry softeners")
// are dormancy-triggered, not stage-driven. The iOS PromptKind enum includes
// 're-entry-softener' and the wire carries it, but composing one requires a
// dormancy signal (last-ingest age) that this substrate-driven evaluator does
// not yet track. Out of scope for EPIC 2's stage-machine floor; file as a
// follow-up. The 're-entry-softener' kind is still a valid wire value and the
// decoder accepts it; this service just does not yet issue one.

// =============================================================================
// Deterministic prompt composer
// =============================================================================

/** Lowercase + collapse whitespace, mirroring going.ts:168 + voice-c-composer's
 *  normalization, so assertVoiceC + the substring guarantees hold. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Compose the prompt for a stage DETERMINISTICALLY. No LLM. Returns the
 * { promptId, text, kind, issuedAt } object ready to persist + ship, or null
 * for stages that show no prompt (confirmed; v1 never emits hard-topic prompts
 * either, but isHardTopic stays false so this path is the confirmed case).
 *
 * Pre-composed ON stage transition (the service persists this); GET never
 * composes synchronously. The prompt is STABLE per stage+graph-state: the
 * rotation key is deterministic, so re-evaluations that don't advance the
 * stage re-issue the same prompt (no flicker).
 *
 * @param rotationKey  a stable per-evaluation integer (entry count) that
 *                     rotates selection WITHIN a stage's curated set.
 */
function composePrompt(
  stage: OnboardingStage,
  ctx: {
    entryCount: number;
    representativeEntityName?: string;
    topFocusNames?: string[];
  },
  rotationKey: number,
): OnboardingPrompt | null {
  const issuedAt = new Date().toISOString();
  const promptId = `onboarding:${stage}:${rotationKey}`;

  switch (stage) {
    case 'stage_1': {
      const set = OPENING_PROMPTS;
      const text = set[Math.abs(rotationKey) % set.length]!;
      assertVoiceC(text);
      return { promptId, text, kind: 'opening', issuedAt };
    }
    case 'stage_2': {
      // Entity-citing: cite the representative entity the user actually
      // mentioned. Template mirrors FixtureOnboardingProvider.stage2.
      const raw = ctx.representativeEntityName ?? '';
      const name = normalizeName(raw);
      if (name.length === 0) {
        // No citable entity (shouldn't happen at stage_2 — the gate requires
        // one) — fall back to an opening so the home never shows a blank.
        const text = OPENING_PROMPTS[0]!;
        assertVoiceC(text);
        return { promptId, text, kind: 'opening', issuedAt };
      }
      const text = `you mentioned ${name}. — what is it really, this season?`;
      assertVoiceC(text);
      return { promptId, text, kind: 'entity-citing', issuedAt };
    }
    case 'stage_3': {
      // Themed: reference the two strongest cluster representatives.
      // Template mirrors FixtureOnboardingProvider.stage3. Single em-dash (the
      // prompt is one sentence — Voice C punctuation).
      const names = (ctx.topFocusNames ?? []).map(normalizeName).filter((n) => n.length > 0);
      if (names.length >= 2) {
        const text = `${names[0]} and ${names[1]} have the same shape. — what is the sentence underneath?`;
        assertVoiceC(text);
        return { promptId, text, kind: 'themed', issuedAt };
      }
      // Fewer than 2 names — a degenerate themed prompt; fall back to opening.
      const text = "what hasn't been said yet?";
      assertVoiceC(text);
      return { promptId, text, kind: 'opening', issuedAt };
    }
    case 'awaiting_confirmation': {
      // PINNED confirmation template (design/08-onboarding.md:111).
      // "[count] things have come up most: [name], [name], [name]. — is that right?"
      const names = (ctx.topFocusNames ?? []).map(normalizeName).filter((n) => n.length > 0);
      const count = names.length;
      const list = names.join(', ');
      const text =
        count > 0
          ? `${numberWord(count)} ${count === 1 ? 'thing has' : 'things have'} come up most: ${list}. — is that right?`
          : 'a few things have come up. — is that right?';
      assertVoiceC(text);
      return { promptId, text, kind: 'confirmation', issuedAt };
    }
    case 'confirmed':
    default:
      // No prompt at confirmed (§"Beyond Stage 4"). prompt:null is meaningful.
      return null;
  }
}

/** English lowercase number word for 1–3 (the confirmation template's count).
 *  Falls back to the digit for anything else — Voice C allows numerals where a
 *  word would be awkward, but the curated examples stay worded. */
function numberWord(n: number): string {
  switch (n) {
    case 1: return 'one';
    case 2: return 'two';
    case 3: return 'three';
    default: return String(n);
  }
}

// =============================================================================
// Substrate read helpers
// =============================================================================

/** Count ingested memories (memory_index rows). The S1→S2 "≥3 entries" signal. */
async function readEntryCount(): Promise<number> {
  const rows = (await db.execute(sql`
    SELECT COUNT(*)::int AS n FROM public.memory_index
  `)) as unknown as Array<{ n: number }>;
  return Math.max(0, Number(rows[0]?.n ?? 0) || 0);
}

interface EntityRow {
  entityId: string;
  canonicalName: string;
  firstSeenAt: Date | null;
  sourceMemoryCount: number;
  clusterId: number | null;
  clusterProbability: number | null;
  communityId: number | null;
  /** True for the SELF entity ("me") — the default-stream USER speaker,
   *  resolved via the stream_participants join (same as /api/hero), NOT the
   *  unreliable entities.properties.is_self flag. Self is kept as a cluster
   *  member but is never a cluster representative / focus candidate. */
  isSelf: boolean;
}

/**
 * Gather the entity substrate joined across the 4 graph tables + entity_meta.
 * One round-trip; the cluster/topology snapshots are read separately (they are
 * already-cheap pre-computed reads, same as going.ts).
 *
 * entity_meta.source_memory_count is the supporting-entries count (the iOS
 * InferredFocus.supportingEntries). first_seen_at feeds the stability proxy.
 */
async function gatherEntities(): Promise<EntityRow[]> {
  const clusters = await getClustersSnapshot();
  const topo = await getTopologySnapshot();
  // Resolve the SELF entity the same way /api/hero does — the (default, user)
  // stream_participants join (getSelfEntity), not the properties.is_self flag.
  const self = await getSelfEntity();
  const selfId = self?.id ?? null;
  const clusterByEntity = new Map<
    string,
    { clusterId: number; clusterProbability: number | null }
  >();
  for (const e of clusters.entities) {
    clusterByEntity.set(e.id, {
      clusterId: e.clusterId,
      clusterProbability: e.clusterProbability,
    });
  }
  const communityByEntity = new Map<string, number>();
  for (const e of topo.entities) {
    if (e.communityId !== null) communityByEntity.set(e.id, e.communityId);
  }

  // All entities with entity_meta rollup. LEFT JOIN entity_meta so entities
  // without a meta row (shouldn't happen, but defensive) get a 0 count.
  const rows = (await db.execute(sql`
    SELECT
      e.id::text              AS entity_id,
      e.canonical_name        AS canonical_name,
      e.first_seen_at         AS first_seen_at,
      COALESCE(em.source_memory_count, 0)::int AS source_memory_count
    FROM public.entities e
    LEFT JOIN public.entity_meta em ON em.entity_id = e.id
  `)) as unknown as Array<{
    entity_id: string;
    canonical_name: string;
    first_seen_at: Date | null;
    source_memory_count: number | null;
  }>;

  return rows.map((r) => {
    const c = clusterByEntity.get(r.entity_id);
    return {
      entityId: r.entity_id,
      canonicalName: r.canonical_name,
      firstSeenAt: r.first_seen_at instanceof Date ? r.first_seen_at : null,
      sourceMemoryCount: Math.max(0, Number(r.source_memory_count ?? 0) || 0),
      clusterId: c?.clusterId ?? null,
      clusterProbability: c?.clusterProbability ?? null,
      communityId: communityByEntity.get(r.entity_id) ?? null,
      isSelf: selfId !== null && r.entity_id === selfId,
    } satisfies EntityRow;
  });
}

/** Entities that drifted above DRIFT_MAGNITUDE_CEILING recently (within the
 *  stability window). A cluster whose representative is in this set is not yet
 *  stable (S3→S4 drift gate). Mirrors going.ts:349-367. */
async function driftedUnstable(now: Date): Promise<Set<string>> {
  const cutoff = new Date(now.getTime() - STABILITY_HOURS * 60 * 60 * 1000);
  const result = await getDriftEvents({ entityId: null, limit: 500 });
  const drifted = new Set<string>();
  for (const ev of result.events) {
    const detected = new Date(ev.detected_at);
    if (detected < cutoff) continue;
    if (ev.drift_magnitude >= DRIFT_MAGNITUDE_CEILING) {
      drifted.add(ev.entity_id);
    }
  }
  return drifted;
}

interface ClusterCandidate {
  clusterId: number;
  representative: EntityRow;
  members: EntityRow[];
  /** Distinct supporting memories across the cluster's members. */
  supportingEntries: number;
  stable: boolean;
}

/** Build candidate clusters (cluster_id != -1) with their highest-source-memory
 *  representative, member roster, supporting-entry count, and stability flag. */
async function gatherStableClusters(
  entities: EntityRow[],
  now: Date,
): Promise<ClusterCandidate[]> {
  const drifted = await driftedUnstable(now);
  const stableCutoff = new Date(now.getTime() - STABILITY_HOURS * 60 * 60 * 1000);

  // Group non-noise entities by cluster_id.
  const byCluster = new Map<number, EntityRow[]>();
  for (const e of entities) {
    if (e.clusterId === null || e.clusterId === -1) continue;
    const list = byCluster.get(e.clusterId);
    if (list) list.push(e);
    else byCluster.set(e.clusterId, [e]);
  }

  const candidates: ClusterCandidate[] = [];
  for (const [clusterId, members] of byCluster) {
    // Representative = highest source_memory_count (ties → canonical_name for
    // determinism), AND cluster_probability >= MIN_CLUSTER_PROBABILITY.
    // Use the max cluster_probability seen in the cluster as the cluster's
    // probability signal (HDBSCAN assigns per-entity; the cluster's strength
    // is its strongest member).
    const clusterProb = members
      .map((m) => m.clusterProbability ?? 0)
      .reduce((a, b) => Math.max(a, b), 0);
    if (clusterProb < MIN_CLUSTER_PROBABILITY) continue;

    members.sort((a, b) => {
      if (b.sourceMemoryCount !== a.sourceMemoryCount) {
        return b.sourceMemoryCount - a.sourceMemoryCount;
      }
      return a.canonicalName.localeCompare(b.canonicalName);
    });
    // The SELF entity ("me") is the most-mentioned node in any cluster it lands
    // in, but it must never be the cluster's FACE: the stage-3 themed prompt and
    // the awaiting_confirmation inferredFocus both cite the representative, and
    // "you mentioned user (stream default)" / "…is that right?" over "me" is
    // nonsense. Keep self as a MEMBER (it still counts toward supportingEntries)
    // but pick the strongest NON-self entity as representative; fall back to
    // members[0] only for the degenerate self-only cluster.
    const representative = members.find((m) => !m.isSelf) ?? members[0]!;

    // Supporting entries = sum of member source_memory_count (distinct-memory
    // rollup; minor double-count risk across co-mentioning entities is
    // acceptable for a proxy count — the iOS field is >=0, not exact).
    const supportingEntries = members.reduce(
      (sum, m) => sum + m.sourceMemoryCount,
      0,
    );

    // STABILITY PROXY: representative first_seen_at older than the window AND
    // no member drifted above ceiling within the window.
    const oldEnough =
      representative.firstSeenAt !== null && representative.firstSeenAt <= stableCutoff;
    const anyDrifted = members.some((m) => drifted.has(m.entityId));
    const stable = oldEnough && !anyDrifted;

    candidates.push({
      clusterId,
      representative,
      members,
      supportingEntries,
      stable,
    });
  }

  // Most-supported first; tie-break by cluster id for determinism.
  candidates.sort((a, b) => {
    if (b.supportingEntries !== a.supportingEntries) {
      return b.supportingEntries - a.supportingEntries;
    }
    return a.clusterId - b.clusterId;
  });
  return candidates;
}

// =============================================================================
// State persistence (single-row v1 UPSERT)
// =============================================================================

const V1_ROW_ID = 'v1';

interface PersistedPrompt {
  promptId: string;
  text: string;
  kind: PromptKind;
  issuedAt: string;
}

interface PersistedState {
  stage: OnboardingStage;
  prompt: PersistedPrompt | null;
  inferredFocus: InferredFocusItem[] | null;
  confirmedFocus: string[] | null;
  isHardTopic: boolean;
  lastAdvancedAt: Date | null;
}

async function readPersistedState(): Promise<PersistedState> {
  const rows = (await db.execute(sql`
    SELECT
      stage,
      current_prompt_id,
      current_prompt_text,
      current_prompt_kind,
      current_prompt_issued_at,
      inferred_focus,
      confirmed_focus,
      is_hard_topic,
      last_advanced_at
    FROM public.user_onboarding_state
    WHERE id = ${V1_ROW_ID}
  `)) as unknown as Array<{
    stage: OnboardingStage;
    current_prompt_id: string | null;
    current_prompt_text: string | null;
    current_prompt_kind: PromptKind | null;
    current_prompt_issued_at: Date | null;
    inferred_focus: unknown;
    confirmed_focus: unknown;
    is_hard_topic: boolean;
    last_advanced_at: Date | null;
  }>;

  if (rows.length === 0) {
    // First read on a fresh DB: seed the default stage_1 row. Compose the
    // initial opening prompt so GET immediately returns a usable state
    // (rather than a prompt-less stage_1 — the home's hero would be blank).
    const seeded = await seedInitialState();
    return seeded;
  }

  const r = rows[0]!;
  let prompt: PersistedPrompt | null = null;
  if (
    r.current_prompt_id &&
    r.current_prompt_text &&
    r.current_prompt_kind &&
    r.current_prompt_issued_at
  ) {
    const issuedAt =
      r.current_prompt_issued_at instanceof Date
        ? r.current_prompt_issued_at.toISOString()
        : new Date(r.current_prompt_issued_at).toISOString();
    prompt = {
      promptId: r.current_prompt_id,
      text: r.current_prompt_text,
      kind: r.current_prompt_kind,
      issuedAt,
    };
  }
  return {
    stage: r.stage,
    prompt,
    inferredFocus: parseInferredFocus(r.inferred_focus),
    confirmedFocus: parseConfirmedFocus(r.confirmed_focus),
    isHardTopic: r.is_hard_topic,
    lastAdvancedAt:
      r.last_advanced_at instanceof Date ? r.last_advanced_at : null,
  };
}

/** Compose the initial opening prompt + seed the v1 row at stage_1. Returns
 *  the seeded state. Idempotent-ish: only called when the row is absent. */
async function seedInitialState(): Promise<PersistedState> {
  const prompt = composePrompt('stage_1', { entryCount: 0 }, 0);
  const now = new Date();
  await db.execute(sql`
    INSERT INTO public.user_onboarding_state
      (id, stage, current_prompt_id, current_prompt_text, current_prompt_kind,
       current_prompt_issued_at, is_hard_topic, updated_at)
    VALUES
      (${V1_ROW_ID}, 'stage_1',
       ${prompt?.promptId ?? null}, ${prompt?.text ?? null},
       ${prompt?.kind ?? null}, ${now}, false, ${now})
    ON CONFLICT (id) DO NOTHING
  `);
  return {
    stage: 'stage_1',
    prompt: prompt
      ? {
          promptId: prompt.promptId,
          text: prompt.text,
          kind: prompt.kind,
          issuedAt: now.toISOString(),
        }
      : null,
    inferredFocus: null,
    confirmedFocus: null,
    isHardTopic: false,
    lastAdvancedAt: null,
  };
}

/** Persist a stage advancement (or a no-advance prompt re-issue): the stage +
 *  its freshly-composed prompt (+ the inferredFocus list if entering
 *  awaiting_confirmation). A stage never regresses — the caller guarantees
 *  newStage outranks the current. last_advanced_at is bumped on every write;
 *  that's harmless (it's an evaluation timestamp, not strictly an advancement
 *  one) and keeps updated_at fresh. */
async function persistState(args: {
  newStage: OnboardingStage;
  prompt: PersistedPrompt | null;
  inferredFocus: InferredFocusItem[] | null;
}): Promise<void> {
  const now = new Date();
  const issuedAt = args.prompt ? new Date(args.prompt.issuedAt) : now;
  // JSONB write: pass the JSON string as a parameter and cast ::jsonb. NULL
  // stays NULL (no cast needed). postgres-js parameterizes the value, so this
  // is injection-safe (unlike sql.raw string-interpolation).
  const inferredFocusValue =
    args.inferredFocus !== null ? JSON.stringify(args.inferredFocus) : null;
  await db.execute(sql`
    UPDATE public.user_onboarding_state SET
      stage = ${args.newStage},
      current_prompt_id = ${args.prompt?.promptId ?? null},
      current_prompt_text = ${args.prompt?.text ?? null},
      current_prompt_kind = ${args.prompt?.kind ?? null},
      current_prompt_issued_at = ${issuedAt},
      inferred_focus = ${inferredFocusValue}::jsonb,
      last_advanced_at = ${now},
      updated_at = ${now}
    WHERE id = ${V1_ROW_ID}
  `);
}

function parseInferredFocus(raw: unknown): InferredFocusItem[] | null {
  // JSONB columns come back as a STRING under the default postgres-js config
  // (the connection in db/index.ts sets no JSON transform), so parse first.
  const arr = unwrapJsonArray(raw);
  if (arr === null) return null;
  const items: InferredFocusItem[] = [];
  for (const entry of arr) {
    if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as Record<string, unknown>).entityId === 'string' &&
      typeof (entry as Record<string, unknown>).name === 'string'
    ) {
      const e = entry as Record<string, unknown>;
      items.push({
        entityId: e.entityId as string,
        name: e.name as string,
        supportingEntries: Math.max(0, Number(e.supportingEntries ?? 0) || 0),
      });
    }
  }
  return items;
}

function parseConfirmedFocus(raw: unknown): string[] | null {
  const arr = unwrapJsonArray(raw);
  if (arr === null) return null;
  return arr.filter((x): x is string => typeof x === 'string');
}

/** Coerce a JSONB column read (string-encoded JSON or already-parsed) into an
 *  array, or null if it is not array-shaped. Handles the postgres-js default
 *  of returning JSONB as a string. */
function unwrapJsonArray(raw: unknown): unknown[] | null {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

// =============================================================================
// Stage evaluator (substrate-driven, called after each extract drain)
// =============================================================================

/**
 * Evaluate the substrate signals against the current persisted stage and
 * ADVANCE if a higher stage's gate is met. A stage never regresses
 * (design/08-onboarding.md:137). On advancement, pre-composes the new stage's
 * prompt (so the next GET serves it immediately — §"Composition cadence").
 *
 * INVARIANT: untangle-focus does NOT call this (only mutates the candidate
 * list). Only the post-extract hook + the confirm-focus handler call this.
 *
 * Best-effort by contract: the pipeline wraps this in try/catch + warn-log so
 * an evaluation failure never fails an extraction.
 */
export async function evaluateStage(now: Date = new Date()): Promise<OnboardingStage> {
  const persisted = await readPersistedState();
  const current = persisted.stage;

  // Read substrate.
  const entryCount = await readEntryCount();
  const entities = await gatherEntities();

  // --- Compute the highest stage the substrate supports. ---
  let targetStage: OnboardingStage = 'stage_1';

  // S1 → S2: ≥3 entries AND ≥1 entity above confidence.
  const entitiesAboveConfidence = entities.filter(
    (e) => e.sourceMemoryCount >= MIN_ENTITY_CONFIDENCE_STAGE_2,
  ).length;
  if (entryCount >= MIN_ENTRIES_STAGE_2 && entitiesAboveConfidence >= 1) {
    targetStage = 'stage_2';
  }

  // S2 → S3: ≥1 stable cluster with cluster_probability ≥0.6.
  const clusters = await gatherStableClusters(entities, now);
  const stableHighProbClusters = clusters.filter((c) => c.stable);
  if (stableHighProbClusters.length >= 1 && stageRank(targetStage) >= stageRank('stage_2')) {
    // (gatherStableClusters already filters by MIN_CLUSTER_PROBABILITY.)
    targetStage = 'stage_3';
  }

  // S3 → awaiting_confirmation: ≥2 stable clusters AND ≥3 supporting
  // entries/cluster AND drift below threshold AND ≥2 communities.
  const communities = new Set(
    entities.map((e) => e.communityId).filter((c): c is number => c !== null),
  );
  const qualifyingClusters = stableHighProbClusters.filter(
    (c) => c.supportingEntries >= MIN_SUPPORTING_ENTRIES_PER_CLUSTER,
  );
  const driftBelowThreshold = clusters.every((c) => c.stable || c.supportingEntries < MIN_SUPPORTING_ENTRIES_PER_CLUSTER);
  if (
    stageRank(targetStage) >= stageRank('stage_3') &&
    qualifyingClusters.length >= MIN_STABLE_CLUSTERS &&
    communities.size >= MIN_COMMUNITIES &&
    driftBelowThreshold
  ) {
    targetStage = 'awaiting_confirmation';
  }

  // Never regress + never auto-advance past awaiting_confirmation (the
  // awaiting→confirmed transition is the user's confirm-focus POST, not a
  // substrate signal). If already confirmed or awaiting, stay.
  if (stageRank(current) >= stageRank('awaiting_confirmation')) {
    // Confirmed is terminal; awaiting waits for the user. Re-issue the
    // current prompt if it was lost (defensive), but do not advance.
    return current;
  }
  if (stageRank(targetStage) <= stageRank(current)) {
    // No advancement. Re-issue the current stage's prompt if missing (e.g.
    // first seed failed) so GET always has a prompt at stages 1-3.
    if (current !== 'confirmed' && persisted.prompt === null) {
      await reissueCurrentStagePrompt(current, entities, entryCount, now);
    }
    return current;
  }

  // ADVANCE. Compose the new stage's prompt + (if awaiting) the inferredFocus.
  const topNames = stableHighProbClusters
    .slice(0, MAX_INFERRED_FOCUS)
    .map((c) => normalizeName(c.representative.canonicalName));
  const representativeName =
    entities
      .filter((e) => !e.isSelf) // never cite "me" in the stage_2 entity-citing prompt
      .sort((a, b) => b.sourceMemoryCount - a.sourceMemoryCount)[0]?.canonicalName;

  const prompt = composePrompt(targetStage, {
    entryCount,
    representativeEntityName: representativeName,
    topFocusNames: topNames,
  }, entryCount);

  let inferredFocus: InferredFocusItem[] | null = null;
  if (targetStage === 'awaiting_confirmation') {
    inferredFocus = stableHighProbClusters
      .slice(0, MAX_INFERRED_FOCUS)
      .map((c) => ({
        entityId: c.representative.entityId,
        name: normalizeName(c.representative.canonicalName),
        supportingEntries: c.supportingEntries,
      }))
      .filter((f) => f.name.length > 0);
  }

  await persistState({
    newStage: targetStage,
    prompt: prompt
      ? {
          promptId: prompt.promptId,
          text: prompt.text,
          kind: prompt.kind,
          issuedAt: prompt.issuedAt,
        }
      : null,
    inferredFocus,
  });

  console.log(
    `[onboarding] advanced ${current} → ${targetStage}` +
      (prompt ? ` (prompt kind=${prompt.kind})` : '') +
      (inferredFocus ? ` inferredFocus=${inferredFocus.length}` : ''),
  );
  return targetStage;
}

/** Re-issue the current stage's prompt when the persisted prompt is null but
 *  the stage is one that should show a prompt (1–3). Used on the no-advance
 *  path if the row was seeded without a prompt. */
async function reissueCurrentStagePrompt(
  stage: OnboardingStage,
  entities: EntityRow[],
  entryCount: number,
  now: Date,
): Promise<void> {
  const representativeName = entities
    .filter((e) => !e.isSelf) // never cite "me" when re-issuing an entity-citing prompt
    .sort((a, b) => b.sourceMemoryCount - a.sourceMemoryCount)[0]?.canonicalName;
  const prompt = composePrompt(
    stage,
    { entryCount, representativeEntityName: representativeName },
    entryCount,
  );
  if (!prompt) return;
  await persistState({ newStage: stage, prompt: { ...prompt }, inferredFocus: null });
  void now;
}

// =============================================================================
// Public: GET current state (shapes persisted state to the iOS wire)
// =============================================================================

/**
 * Read the persisted onboarding state and shape it to the bare iOS
 * OnboardingState wire object (no envelope). Pure read — never composes
 * synchronously (composition happened on stage transition, per
 * §"Composition cadence"). Returns the seeded stage_1 + opening prompt on a
 * fresh DB (the row is seeded with a prompt so the home's hero is never blank).
 *
 * Wire shaping:
 *   - stage          as-is (the closed enum is DB-CHECK-guarded).
 *   - prompt         as-is or null.
 *   - isHardTopic    OMITTED when false (decoder absent→false); present when true.
 *   - inferredFocus  present ONLY at awaiting_confirmation; omitted otherwise
 *                    (the decoder's decodeIfPresent handles absent→null).
 */
export async function getOnboardingState(): Promise<OnboardingState> {
  const persisted = await readPersistedState();
  const wire: OnboardingState = {
    stage: persisted.stage,
    prompt: persisted.prompt,
  };
  // isHardTopic: v1 always false — omit so the wire carries no flag (the
  // common case). When a classifier ships (FOLLOW-UP), emit true here.
  if (persisted.isHardTopic) {
    wire.isHardTopic = true;
  }
  // inferredFocus: present ONLY at awaiting_confirmation.
  if (persisted.stage === 'awaiting_confirmation') {
    wire.inferredFocus = persisted.inferredFocus ?? [];
  }
  return wire;
}

// =============================================================================
// Public: focus mutations
// =============================================================================

/** Confirm-focus POST body: { entityIds: string[] }. */
export interface ConfirmFocusBody {
  entityIds?: unknown;
}

/** Untangle-focus POST body: { entityId: string }. */
export interface UntangleFocusBody {
  entityId?: unknown;
}

/** Rename-focus POST body: { entityId: string, newName: string }. */
export interface RenameFocusBody {
  entityId?: unknown;
  newName?: unknown;
}

/**
 * Confirm the inferred focus areas (the Stage 4 "is that right?" yes-tap).
 * Records the confirmed entity ids and ADVANCES awaiting_confirmation →
 * confirmed. The confirmed ids feed the going-toward emergence gate downstream
 * (design/08-onboarding.md §"Sections emerging"). Returns the new stage.
 *
 * Validates: the current stage MUST be awaiting_confirmation (confirming out
 * of any other stage is a no-op advance — throw so the route 400s). Body
 * entityIds MUST be a non-empty array of strings.
 */
export async function confirmFocus(
  body: ConfirmFocusBody,
  now: Date = new Date(),
): Promise<OnboardingStage> {
  if (!Array.isArray(body.entityIds) || body.entityIds.length === 0) {
    throw new ValidationError('entityIds must be a non-empty array of strings');
  }
  const entityIds = body.entityIds.filter(
    (x): x is string => typeof x === 'string' && x.length > 0,
  );
  if (entityIds.length === 0) {
    throw new ValidationError('entityIds must contain at least one non-empty string');
  }

  const persisted = await readPersistedState();
  if (persisted.stage !== 'awaiting_confirmation') {
    // Confirming outside Stage 4 is invalid — the route 400s.
    throw new ValidationError(
      `confirm-focus requires stage awaiting_confirmation (current: ${persisted.stage})`,
    );
  }

  // Record confirmed ids + advance to confirmed. No prompt at confirmed.
  await db.execute(sql`
    UPDATE public.user_onboarding_state SET
      stage = 'confirmed',
      current_prompt_id = NULL,
      current_prompt_text = NULL,
      current_prompt_kind = NULL,
      current_prompt_issued_at = NULL,
      inferred_focus = NULL,
      confirmed_focus = ${JSON.stringify(entityIds)}::jsonb,
      last_advanced_at = ${now},
      updated_at = ${now}
    WHERE id = ${V1_ROW_ID}
  `);
  console.log(`[onboarding] confirmed focus: ${entityIds.length} entity ids`);
  return 'confirmed';
}

/**
 * Untangle (remove) one inferred focus area from the Stage 4 candidate list.
 * INVARIANT: does NOT advance the stage (design/08-onboarding.md — only mutates
 * the candidate list). The stage stays awaiting_confirmation. If the list
 * becomes empty, the user is left in awaiting_confirmation with an empty list
 * (the home shows the empty confirmation prompt); they may still drop-in to
 * add material, which re-evaluates on the next drain.
 */
export async function untangleFocus(body: UntangleFocusBody): Promise<void> {
  if (typeof body.entityId !== 'string' || body.entityId.length === 0) {
    throw new ValidationError('entityId must be a non-empty string');
  }
  const entityId = body.entityId;

  const persisted = await readPersistedState();
  if (persisted.stage !== 'awaiting_confirmation') {
    throw new ValidationError(
      `untangle-focus requires stage awaiting_confirmation (current: ${persisted.stage})`,
    );
  }
  const current = persisted.inferredFocus ?? [];
  const next = current.filter((f) => f.entityId !== entityId);
  await db.execute(sql`
    UPDATE public.user_onboarding_state SET
      inferred_focus = ${JSON.stringify(next)}::jsonb,
      updated_at = ${new Date()}
    WHERE id = ${V1_ROW_ID}
  `);
  console.log(
    `[onboarding] untangled ${entityId.slice(0, 8)}: inferredFocus ${current.length} → ${next.length}`,
  );
}

/**
 * Rename one inferred focus area's label (the Stage 4 inline edit; doubles as
 * gardening of Graph S — design/08-onboarding.md §"Stage 4"). Mutates the
 * candidate list's `name` for the matching entityId. Does NOT advance.
 *
 * ALSO updates the canonical entity name in public.entities so the rename
 * propagates to the graph (going-toward, hero). The iOS RenameFocusRequest
 * note says this "doubles as gardening of Graph S."
 */
export async function renameFocus(body: RenameFocusBody): Promise<void> {
  if (typeof body.entityId !== 'string' || body.entityId.length === 0) {
    throw new ValidationError('entityId must be a non-empty string');
  }
  if (typeof body.newName !== 'string' || body.newName.trim().length === 0) {
    throw new ValidationError('newName must be a non-empty string');
  }
  const entityId = body.entityId;
  const newName = body.newName.trim();

  const persisted = await readPersistedState();
  if (persisted.stage !== 'awaiting_confirmation') {
    throw new ValidationError(
      `rename-focus requires stage awaiting_confirmation (current: ${persisted.stage})`,
    );
  }
  const current = persisted.inferredFocus ?? [];
  let renamed = false;
  const next = current.map((f) => {
    if (f.entityId === entityId) {
      renamed = true;
      return { ...f, name: newName };
    }
    return f;
  });
  if (!renamed) {
    throw new ValidationError(
      `rename-focus: entityId ${entityId} not in inferredFocus`,
    );
  }
  await db.execute(sql`
    UPDATE public.user_onboarding_state SET
      inferred_focus = ${JSON.stringify(next)}::jsonb,
      updated_at = ${new Date()}
    WHERE id = ${V1_ROW_ID}
  `);
  // Propagate the rename to the graph's canonical entity name (gardening of
  // Graph S — design/08-onboarding.md §"Stage 4" rename doubles as gardening).
  try {
    await db.execute(sql`
      UPDATE public.entities SET canonical_name = ${newName}
      WHERE id = ${entityId}::uuid
    `);
  } catch (err) {
    // A bad entityId (not a uuid / not present) should not fail the rename of
    // the candidate list — the list is the source of truth for the onboarding
    // surface. Warn + continue.
    console.warn(
      `[onboarding] rename-focus: canonical_name update skipped for ${entityId}:`,
      err instanceof Error ? err.message : err,
    );
  }
  console.log(`[onboarding] renamed ${entityId.slice(0, 8)} → "${newName}"`);
}

// =============================================================================
// Validation error (route maps to 400)
// =============================================================================

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}
