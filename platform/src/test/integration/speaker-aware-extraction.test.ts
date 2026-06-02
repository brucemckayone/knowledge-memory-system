/**
 * Speaker-aware extraction — REAL graph-agent regression (nmemo-3f9.5).
 *
 * This is the end-to-end proof for epic nmemo-3f9: the conversational
 * content_type path anchors first-person facts to the DETERMINISTICALLY
 * resolved stream speaker (findOrCreateSpeaker, NOT name/embedding), keeps
 * user vs assistant subjects DISTINCT, subject-anchors corroborations about the
 * user to the user, and leaves the prose/narrative path UNCHANGED.
 *
 * Each block ingests a small synthetic input through the production ingest()
 * (store + the real Haiku graph agent), conversational + stream-scoped, then
 * asserts the resulting Graph S rows in cognitive_test. LLM extraction is
 * non-deterministic, so assertions are TOLERANT: a fact is matched by a
 * reasonable predicate/object shape and — critically — by its SUBJECT entity
 * (the structural invariant under test), never by an exact predicate string.
 *
 * Isolation (beads nmemo-wow / agf / awi): setup.ts forces
 * DATABASE_URL=cognitive_test + QDRANT_COLLECTION=memories_test, and those are
 * forwarded to the spawned graph-MCP server, so the agent's writes land in the
 * test DB + test collection, never production. Gated on isMLServiceAvailable()
 * — skips cleanly when ml-services is down. Per-run stream ids keep reruns from
 * colliding; afterAll deletes only what each block created (entities cascade to
 * facts/memory_entities/stream_participants; stream_participants is NOT in the
 * deleteFromTables allowlist so we delete it explicitly).
 *
 * Acceptance coverage (bd show nmemo-3f9.5):
 *   (a) first-person, no proper name -> a fact anchored to the stream USER entity
 *   (b) multi-speaker -> user vs assistant facts on DISTINCT subject entities
 *       (assistant entity_type='assistant')
 *   (c) assistant utterance ABOUT the user -> anchored to USER; pure assistant
 *       self-opinion -> NOT anchored to the user (subject-anchoring, Decision 2)
 *   (d) prose narrative regression -> still extracts on the UNCHANGED prose path
 *
 * (e) (cross-cluster auto-merge guard) is covered DB-only by the 3f9.6 suite in
 * src/test/harness/cross-cluster-generator.test.ts; (f) (q[0] degree re-ingest)
 * by src/test/integration/q0-degree-retest.test.ts. Both are referenced here so
 * a reader sees the full acceptance map in one place.
 *
 * STATUS (nmemo-hms, 2026-06-02): all 7 assertions PASS on the real Haiku
 * agent. The 3f9.5 HALT (Haiku ignored the appended conversational override and
 * kept applying the base prompt's proper-noun gate + WORKFLOW 3 narrator-
 * inference, dropping/mis-anchoring user facts) was fixed by RESTRUCTURING the
 * graph-agent prompt: instead of base+appended-override, the conversational
 * content_type now COMPOSES from a separate base whose PHASE 2 / WORKFLOW 3 /
 * REMINDERS segments are conversational variants — the proper-noun gate is
 * ABSENT, so there is nothing for Haiku to disobey (graph_agent.py
 * GRAPH_AGENT_CONVERSATIONAL_SYSTEM_PROMPT). The prose path is byte-identical
 * (Frankenstein regression holds by construction). All four blocks (a) first-
 * person self-fact, (b) multi-speaker distinct subjects, (c) about-user
 * subject-anchoring, (d) prose regression are therefore plain `it(...)`. See
 * doc 33 "nmemo-hms" for the agent-reasoning evidence and the prompt structure.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { testDb, isMLServiceAvailable, isQdrantAvailable, skipCtx } from '../setup.js';
import { ingest } from '../../pipeline.js';
import { findOrCreateSpeaker } from '../../services/entities.js';

// A generous timeout for a single real-Haiku ingest (the agent runs the full
// ORIENT->EXTRACT->RELATE->CAUSE->VERIFY loop; ~1-3 min observed per chunk).
const AGENT_TIMEOUT_MS = 10 * 60 * 1000;

interface FactRow {
  id: string;
  predicate: string;
  object_value: string | null;
  object_entity_id: string | null;
  subject_entity_id: string;
  subject_name: string;
  subject_type: string;
  source_text: string | null;
}

/** All active facts whose SUBJECT is one of the given entities. */
async function factsForSubjects(entityIds: string[]): Promise<FactRow[]> {
  if (entityIds.length === 0) return [];
  return (await testDb`
    SELECT f.id, f.predicate, f.object_value, f.object_entity_id::text AS object_entity_id,
           f.subject_entity_id::text AS subject_entity_id,
           e.canonical_name AS subject_name, e.entity_type AS subject_type,
           f.source_text
    FROM public.facts f
    JOIN public.entities e ON e.id = f.subject_entity_id
    WHERE f.subject_entity_id = ANY(${entityIds}::uuid[])
      AND f.expired_at IS NULL
  `) as unknown as FactRow[];
}

/** Delete a stream's speaker entities (cascades to facts/memory_entities/
 *  stream_participants) plus any leftover participant rows. Best-effort. */
async function cleanupStream(streamId: string, extraEntityIds: string[] = []): Promise<void> {
  try {
    await testDb`
      DELETE FROM public.entities
      WHERE id IN (SELECT entity_id FROM public.stream_participants WHERE stream_id = ${streamId})`;
    if (extraEntityIds.length > 0) {
      await testDb`DELETE FROM public.entities WHERE id = ANY(${extraEntityIds}::uuid[])`;
    }
    await testDb`DELETE FROM public.stream_participants WHERE stream_id = ${streamId}`;
  } catch {
    // teardown is best-effort; never fail the run on cleanup
  }
}

function streamId(tag: string): string {
  return `3f9.5-${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

// ---------------------------------------------------------------------------
// (a) First-person, NO proper name -> fact anchored to the stream USER speaker
// ---------------------------------------------------------------------------
describe('(a) first-person self-fact anchors to the stream USER speaker', () => {
  const STREAM = streamId('a');
  let userId: string;
  let createdEntityIds: string[] = [];

  beforeAll(async (ctx) => {
    if (!(await isMLServiceAvailable()) || !(await isQdrantAvailable())) {
      skipCtx(ctx);
      return;
    }
    // Deterministic up-front resolution; ingest() reuses the same id (idempotent).
    userId = (await findOrCreateSpeaker(STREAM, 'user', 'user')).id;
    // No proper name, no role labels: a bare first-person statement. The only
    // anchor available is the resolved USER speaker.
    const res = await ingest('I work as a data scientist and I live in Berlin.', {
      source: '3f9.5-a',
      contentType: 'conversational',
      streamId: STREAM,
    });
    createdEntityIds = res.entities.map((e) => e.id);
  }, AGENT_TIMEOUT_MS);

  afterAll(() => cleanupStream(STREAM, createdEntityIds));

  // nmemo-hms: the conversational addendum now OVERRIDES the narrative
  // narrator-inference + proper-noun gate, so Haiku anchors the unnamed-narrator
  // self-fact to the resolved USER entity. Verified on the real Haiku agent.
  it('produces at least one fact whose subject is the resolved USER entity', async () => {
    const userFacts = await factsForSubjects([userId]);
    if (userFacts.length === 0) {
      console.error('[3f9.5-a] no facts on USER. all facts =',
        JSON.stringify(await factsForSubjects([userId, ...createdEntityIds]), null, 2));
    }
    expect(userFacts.length, 'a self-fact anchored to the USER speaker').toBeGreaterThan(0);
    // Anchored to the ANONYMOUS speaker — its name is the synthetic stream label,
    // NOT a person's proper name parsed from the text (no name exists to parse).
    const f = userFacts[0]!;
    expect(f.subject_entity_id).toBe(userId);
    expect(String(f.subject_name)).toContain('stream');
    console.log(`[3f9.5-a] PASS userFacts=${userFacts.length} e.g. "${f.predicate}" -> "${f.object_value ?? f.object_entity_id}"`);
  });
});

// ---------------------------------------------------------------------------
// (b) Multi-speaker -> user vs assistant facts on DISTINCT subject entities
//     (assistant entity_type='assistant')
// ---------------------------------------------------------------------------
describe('(b) multi-speaker facts land on distinct user vs assistant subjects', () => {
  const STREAM = streamId('b');
  let userId: string;
  let assistantId: string;
  let createdEntityIds: string[] = [];

  beforeAll(async (ctx) => {
    if (!(await isMLServiceAvailable()) || !(await isQdrantAvailable())) {
      skipCtx(ctx);
      return;
    }
    userId = (await findOrCreateSpeaker(STREAM, 'user', 'user')).id;
    assistantId = (await findOrCreateSpeaker(STREAM, 'assistant', 'assistant')).id;
    // A user self-fact and an assistant self-fact in the same chunk. The
    // assistant self-statement is deliberately a CONCRETE self-property (a name)
    // rather than a pure opinion, so the agent has a reason to anchor a fact to
    // the assistant entity (pure opinions are dropped per the addendum — that is
    // (c)'s territory). The invariant under test is that whatever lands does NOT
    // collapse the two speakers onto one subject.
    const res = await ingest(
      'USER: I studied marine biology at university.\n' +
        'ASSISTANT: I am an AI assistant named Aria built to help you.',
      { source: '3f9.5-b', contentType: 'conversational', streamId: STREAM },
    );
    createdEntityIds = res.entities.map((e) => e.id);
  }, AGENT_TIMEOUT_MS);

  afterAll(() => cleanupStream(STREAM, createdEntityIds));

  it('the assistant speaker entity has entity_type=assistant', async () => {
    const rows = await testDb`SELECT entity_type FROM public.entities WHERE id = ${assistantId}`;
    expect(rows[0]?.entity_type).toBe('assistant');
  });

  // nmemo-hms: with the override the agent anchors the user self-fact to the
  // USER (not an assistant self-profile) and keeps user vs assistant subjects
  // distinct. Verified on the real Haiku agent.
  it('user facts and assistant facts never share a subject entity', async () => {
    const userFacts = await factsForSubjects([userId]);
    const assistantFacts = await factsForSubjects([assistantId]);
    console.log(
      `[3f9.5-b] userFacts=${userFacts.length} assistantFacts=${assistantFacts.length}`,
    );
    // The user studied-marine-biology fact MUST be on the user, never the
    // assistant — that is the no-mis-anchoring guarantee.
    expect(userFacts.length, 'the user self-fact anchors to the USER').toBeGreaterThan(0);
    // DISTINCT subjects: the user's facts and the assistant's facts are on
    // different entities. (We do not require the assistant to have a fact — the
    // NO-SELF-PROFILE policy may legitimately drop the assistant statement; the
    // invariant is only that nothing user-shaped landed on the assistant and
    // vice-versa.)
    expect(userId).not.toBe(assistantId);
    for (const uf of userFacts) expect(uf.subject_entity_id).toBe(userId);
    for (const af of assistantFacts) expect(af.subject_entity_id).toBe(assistantId);
    // No user life-fact (marine biology) leaked onto the assistant.
    const bioOnAssistant = assistantFacts.some((f) =>
      /marine|biology/i.test(`${f.predicate} ${f.object_value ?? ''} ${f.source_text ?? ''}`),
    );
    expect(bioOnAssistant, 'the user study fact must NOT anchor to the assistant').toBe(false);
  });
});

// ---------------------------------------------------------------------------
// (c) Subject-anchoring (Decision 2): assistant utterance ABOUT the user
//     anchors to the USER; pure assistant self-opinion is NOT anchored to user.
// ---------------------------------------------------------------------------
describe('(c) subject-anchoring: about-user -> user; assistant self-opinion -> not user', () => {
  const STREAM = streamId('c');
  let userId: string;
  let assistantId: string;
  let createdEntityIds: string[] = [];

  beforeAll(async (ctx) => {
    if (!(await isMLServiceAvailable()) || !(await isQdrantAvailable())) {
      skipCtx(ctx);
      return;
    }
    userId = (await findOrCreateSpeaker(STREAM, 'user', 'user')).id;
    assistantId = (await findOrCreateSpeaker(STREAM, 'assistant', 'assistant')).id;
    // The user states nothing about the degree themselves; the ASSISTANT
    // corroborates a fact ABOUT the user ("you graduated...") AND voices a pure
    // self-opinion ("I find..."). Subject-anchoring must send the corroboration
    // to the USER and drop / not-user-anchor the opinion.
    const res = await ingest(
      'USER: Can you remind me what we discussed last week?\n' +
        'ASSISTANT: Sure. You graduated with a degree in Business Administration. ' +
        'Personally, I find that field fascinating and elegant.',
      { source: '3f9.5-c', contentType: 'conversational', streamId: STREAM },
    );
    createdEntityIds = res.entities.map((e) => e.id);
  }, AGENT_TIMEOUT_MS);

  afterAll(() => cleanupStream(STREAM, createdEntityIds));

  // nmemo-hms: with the override the agent resolves "you" to the addressee
  // (the user) and subject-anchors the assistant's "you graduated…"
  // corroboration to the USER. Verified on the real Haiku agent.
  it('the about-user corroboration anchors to the USER entity', async () => {
    const userFacts = await factsForSubjects([userId]);
    const degreeOnUser = userFacts.filter((f) =>
      /business|administration|graduat|degree/i.test(
        `${f.predicate} ${f.object_value ?? ''} ${f.source_text ?? ''}`,
      ),
    );
    if (degreeOnUser.length === 0) {
      console.error('[3f9.5-c] no degree fact on USER. user facts =',
        JSON.stringify(userFacts.map((r) => ({ p: r.predicate, o: r.object_value })), null, 2));
    }
    expect(degreeOnUser.length, 'the "you graduated" corroboration anchors to the USER').toBeGreaterThan(0);
    console.log(`[3f9.5-c] about-user PASS "${degreeOnUser[0]!.predicate}" -> "${degreeOnUser[0]!.object_value}"`);
  });

  it('the pure assistant self-opinion is NOT anchored to the user', async () => {
    const userFacts = await factsForSubjects([userId]);
    const assistantFacts = await factsForSubjects([assistantId]);
    const opinionRe = /fascinat|elegant|i find|personally|opinion/i;
    // No opinion-shaped fact may sit on the USER — that would be mis-anchoring
    // the assistant's self-opinion to the user (the failure mode (c) guards).
    const opinionOnUser = userFacts.filter((f) =>
      opinionRe.test(`${f.predicate} ${f.object_value ?? ''} ${f.source_text ?? ''}`),
    );
    if (opinionOnUser.length > 0) {
      console.error('[3f9.5-c] LEAK: assistant opinion anchored to user =',
        JSON.stringify(opinionOnUser.map((r) => ({ p: r.predicate, o: r.object_value, s: r.source_text })), null, 2));
    }
    expect(opinionOnUser.length, 'assistant self-opinion must NOT anchor to the user').toBe(0);
    // Belt-and-braces: the degree corroboration about the user must not have
    // mis-anchored to the assistant either (it is a fact ABOUT the user).
    const degreeOnAssistant = assistantFacts.filter((f) =>
      /business|administration|graduat|degree/i.test(
        `${f.predicate} ${f.object_value ?? ''} ${f.source_text ?? ''}`,
      ),
    );
    expect(degreeOnAssistant.length, 'the user degree fact must NOT anchor to the assistant').toBe(0);
  });
});

// ---------------------------------------------------------------------------
// (d) Prose / narrative regression: the prose path is UNCHANGED — a small
//     third-person narrative still extracts named entities + facts as before.
// ---------------------------------------------------------------------------
describe('(d) prose narrative regression (content_type=prose) still extracts', () => {
  const STREAM = streamId('d');
  let createdEntityIds: string[] = [];

  beforeAll(async (ctx) => {
    if (!(await isMLServiceAvailable()) || !(await isQdrantAvailable())) {
      skipCtx(ctx);
      return;
    }
    // Frankenstein-shaped third-person narrative, content_type=prose (the
    // DEFAULT path the conversational addendum must not touch). The agent should
    // resolve named characters and a relationship fact between them, exactly as
    // on the pre-3f9 narrative corpus.
    const res = await ingest(
      'Victor Frankenstein assembled the creature in his laboratory at Ingolstadt. ' +
        'Elizabeth Lavenza, his adopted sister, awaited his return at Geneva.',
      { source: '3f9.5-d', contentType: 'prose', streamId: STREAM },
    );
    createdEntityIds = res.entities.map((e) => e.id);
  }, AGENT_TIMEOUT_MS);

  afterAll(async () => {
    // No speaker is anchored on the prose path, but stream-default USER may have
    // been seeded by resolveStreamParticipants; clean both the stream and the
    // named entities this chunk created.
    if (createdEntityIds.length > 0) {
      try {
        await testDb`DELETE FROM public.entities WHERE id = ANY(${createdEntityIds}::uuid[])`;
      } catch { /* best-effort */ }
    }
    await cleanupStream(STREAM);
  });

  it('extracts named narrative entities (Victor / the creature / Elizabeth)', async () => {
    expect(createdEntityIds.length, 'prose extraction produced entities').toBeGreaterThan(0);
    const rows = (await testDb`
      SELECT canonical_name, entity_type FROM public.entities
      WHERE id = ANY(${createdEntityIds}::uuid[])`) as unknown as Array<{ canonical_name: string; entity_type: string }>;
    const names = rows.map((r) => r.canonical_name.toLowerCase()).join(' | ');
    console.log(`[3f9.5-d] prose entities = ${names}`);
    // Victor is the anchor character; tolerant — accept Frankenstein or Victor.
    const hasVictor = rows.some((r) => /victor|frankenstein/i.test(r.canonical_name));
    expect(hasVictor, 'the narrative protagonist was extracted').toBe(true);
    // The prose path must NOT have anchored anything to an anonymous USER speaker
    // (no first-person content -> the conversational anchoring never fires).
    const anonUser = rows.some((r) => /\(stream /i.test(r.canonical_name));
    expect(anonUser, 'no anonymous speaker entity is created on the prose path').toBe(false);
  });

  it('extracts at least one narrative relationship fact', async () => {
    const rows = (await testDb`
      SELECT f.id FROM public.facts f
      WHERE f.subject_entity_id = ANY(${createdEntityIds}::uuid[])
        AND f.expired_at IS NULL`) as unknown as Array<{ id: string }>;
    console.log(`[3f9.5-d] prose facts = ${rows.length}`);
    expect(rows.length, 'prose narrative still yields facts (path unchanged)').toBeGreaterThan(0);
  });
});
