/**
 * Demo seed script — orchestrates the pre-stage build of the self-referential
 * Nmemo demo:
 *
 *   pnpm tsx scripts/seed-demo.ts --stage=<stage>
 *
 * Stages (run in order, or pass --stage=all):
 *
 *   ingest    — walk the demo ingest scope (truth-graph docs, handoff docs,
 *               selected platform source, migrations, key tests), classify
 *               each file by extension, push to platform /ingest/queue with
 *               the correct contentType. Polls queue status until drained.
 *
 *   reasoning — runs the platform reasoning agent over the freshly built
 *               graph (causal edges, contradictions, patterns).
 *
 *   topology  — kicks the topology primitives (components, k-core,
 *               articulation points, community, centrality) so the demo viz
 *               overlay reads from cache, not cold compute.
 *
 *   courses   — generates the three pre-baked demo courses (Graph S, Graph C,
 *               Reasoning Layer) with presentation_mode=1. Course 4 (Quality
 *               & Self-Hardening) is left for live b2 generation on stage.
 *
 *   learner   — runs scripted "presenter" learner interactions: quiz attempts
 *               + chat-tutor exchanges. Real MCP writes, real fact creation.
 *               Pre-stage so the cross-course causal trace lands reliably.
 *
 *   all       — runs every stage in order.
 *
 * The script is idempotent — safe to re-run any stage. Stages are independent:
 * if a previous stage was already completed (graph already populated, courses
 * already exist) the stage logs "already done, skipping" and continues.
 *
 * Env:
 *   NMEMO_URL   — platform URL, default http://localhost:3001
 *   LEARN_URL   — learn URL,    default http://localhost:3002
 *   DEMO_REPO   — repo root,    default <this script>/../..
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyByFilename, type ContentType } from './lib/classify-content.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const NMEMO_URL = process.env.NMEMO_URL ?? 'http://localhost:3001';
const LEARN_URL = process.env.LEARN_URL ?? 'http://localhost:3002';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEMO_REPO = process.env.DEMO_REPO ?? path.resolve(SCRIPT_DIR, '..', '..');

// ---------------------------------------------------------------------------
// Ingest scope — explicit so the run is reproducible. Glob-free by design;
// the graph that comes out of this is the one the demo relies on.
// ---------------------------------------------------------------------------

interface IngestSpec {
  /** Path relative to DEMO_REPO. */
  rel: string;
  /** Recurse if rel is a directory. Otherwise treat as a single file. */
  recurse?: boolean;
  /** Optional include filter — only files whose name matches are ingested. */
  includeRegex?: RegExp;
  /** Optional exclude filter — files whose name matches are skipped. */
  excludeRegex?: RegExp;
}

const INGEST_SCOPE: IngestSpec[] = [
  // Tier-1 design docs and supporting truth-graph design.
  { rel: 'docs/architecture/truth-graph', recurse: true, includeRegex: /\.md$/i, excludeRegex: /^README\.md$/i },
  // Real bug-finding handoff docs — gold for the self-contradiction beat.
  { rel: 'docs/handoff', recurse: true, includeRegex: /\.md$/i },
  // Platform service code — the running mechanism.
  { rel: 'platform/src/services', recurse: true, includeRegex: /\.ts$/i },
  // Pipeline + index + config + harness for the system's central wiring.
  { rel: 'platform/src/pipeline.ts' },
  { rel: 'platform/src/index.ts' },
  { rel: 'platform/src/config.ts' },
  { rel: 'platform/src/harness.ts' },
  // Migrations — schema is the source of truth for what the system stores.
  { rel: 'platform/src/db', recurse: true, includeRegex: /\.sql$/i },
  // Selected tests — frankenstein encodes the regression contract.
  { rel: 'platform/src/test/harness', recurse: true, includeRegex: /frankenstein.*\.ts$/i },
];

// ---------------------------------------------------------------------------
// Demo course definitions. Topics mirror the four-sibling shape from the
// plan; descriptions are short — the course generator agent expands them.
// ---------------------------------------------------------------------------

interface DemoCourseSpec {
  /** Topic string passed to the course generator. The agent uses it as a
   *  seed; against the freshly-ingested graph it can call search_curriculum
   *  to find concrete concepts. */
  topic: string;
  /** Short label used in logs. */
  label: string;
}

const PREBAKED_COURSES: DemoCourseSpec[] = [
  {
    label: 'graph-s',
    topic: 'How Graph S works in this system: entities, bi-temporal facts, source provenance, the unified graph agent, and the temporal pipeline. Use the ingested truth-graph docs and platform service code to ground every claim.',
  },
  {
    label: 'graph-c',
    topic: 'How Graph C works in this system: causal events, causal edges with reasoning + source references, the audit-trail foundation, edge lifecycle, and how the causal MCP exposes the graph to agents. Use the ingested design docs (12 audit-trail, 13 edge-lifecycle, 14 source-reference-indexing) and the causal services as primary source material.',
  },
  {
    label: 'reasoning-layer',
    topic: 'How the reasoning layer works in this system: blast radius, contradiction detection, pattern lifecycle, the reasoning agent patrol loop, and how those primitives compose. Use the ingested design docs (15 blast-radius, 16 contradictions, 17 patterns) and the reasoning_agent code.',
  },
  {
    label: 'use-cases',
    topic: 'What this graph could power — a deep analysis of the system\'s primitives and a reasoned tour of use cases that fall out of them when you compose them well. Treat it as a strategy / R&D course, not a feature catalog.\n\nGround every claim in the ingested capability set: Graph S (entities + bi-temporal facts + source provenance), Graph C (causal events, causal edges with reasoning + source references, audit trail), the reasoning layer (blast radius, contradiction detection, pattern lifecycle, the reasoning agent patrol), graph topology (k-core, articulation points, communities, bridges), entity resolution + reconciliation + the gardener, confidence decay, and the MCP-first agent-write discipline. For each capability cite which ingested doc / service file establishes it.\n\nCourse shape:\n1. Open with a primitive map — what the graph stores, what it computes, and what it surfaces. Be precise. The "good" parts of the system go here.\n2. For each major use-case domain below, run the same pattern: (a) the user-facing problem in plain language, (b) which primitives compose to solve it, (c) what\'s already wired vs what would need to be built, (d) the breakthrough variant — what becomes possible if a specific missing piece existed.\n\nUse-case domains to cover (reason about each in a dedicated section):\n- Project management as a "project brain": ingest every communication stream, every git commit/merge/PR/comment, every meeting transcript; the graph maintains causal links from "decision was made in Slack" to "ticket got created" to "PR landed" to "incident". The agent autonomously plans Jira tickets, surfaces tasks falling through cracks, drafts implementation outlines BEFORE humans get to them, keeps planning + implementation in lockstep so nothing gets lost. Dig into: how blast-radius from a comment to downstream tickets works, how pattern lifecycle catches recurring planning failures, how contradiction detection flags conflicting commitments across channels.\n- Living personal knowledge graph for an individual: ingested email + chat + notes + reading; the graph reasons across them, surfaces forgotten threads, tracks evolving beliefs via bi-temporal facts and decay.\n- Engineering / codebase intelligence: ingested code + design docs + commits + incident postmortems; the graph reasons about WHY a service is the way it is, maps causal threads from incidents to architectural decisions, flags drift between docs and code.\n- Research / literature synthesis: ingested papers + lab notebooks + experiment logs; the graph maintains contradictions across papers, surfaces gaps the field hasn\'t filled, traces causal claims back to their evidence.\n- Compliance / audit / regulated industries: every fact has source provenance + bi-temporal validity; the graph IS the audit trail, contradiction detection IS the compliance check, blast radius IS the impact analysis.\n- Learning / adaptive education (the inversion — this very platform): the graph models the learner as a participant, root-cause traces produce remediation.\n\nFor each section: be specific about which existing primitives compose to deliver the use case, which gaps would block a real deployment, and the "incredible" version — what a 12-month investment in the missing piece would unlock. Don\'t hedge. Don\'t generalise. Name the services, name the docs, name the predicates.\n\nThe closing section should reason about which use cases share the most primitives — the unfair leverage of building this once and shipping into many domains.',
  },
];

// The fourth course generated live on stage. Left here so an operator can
// kick it manually via `pnpm tsx scripts/seed-demo.ts --stage=course-live`.
const LIVE_COURSE: DemoCourseSpec = {
  label: 'quality-self-hardening',
  topic: 'How this system hardens itself: graph quality issues, the test-harden recursive loop, snapshot/replay, structural embeddings, deep entity resolution, and cross-cluster bridging. Use the ingested docs (09, 18, 20-26) and the cross-cluster + graph-stats services.',
};

// ---------------------------------------------------------------------------
// HTTP helpers — minimal, single-purpose. Fail loudly on non-2xx so the
// operator sees what went wrong rather than a corrupt half-built graph.
// ---------------------------------------------------------------------------

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`POST ${url} → ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`GET ${url} → ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// File walk helpers
// ---------------------------------------------------------------------------

interface IngestEntry {
  abs: string;
  rel: string;
  contentType: ContentType;
}

async function pathExists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

async function walkSpec(spec: IngestSpec): Promise<IngestEntry[]> {
  const abs = path.resolve(DEMO_REPO, spec.rel);
  if (!(await pathExists(abs))) {
    console.warn(`[seed] scope item missing on disk: ${spec.rel} — skipping`);
    return [];
  }
  const st = await stat(abs);
  if (st.isFile()) {
    return [{ abs, rel: spec.rel, contentType: classifyByFilename(abs) }];
  }
  if (!st.isDirectory()) return [];
  if (!spec.recurse) {
    console.warn(`[seed] scope item is a directory but recurse=false: ${spec.rel} — skipping`);
    return [];
  }
  const out: IngestEntry[] = [];
  await walkDir(abs, abs, spec, out);
  return out;
}

async function walkDir(root: string, current: string, spec: IngestSpec, out: IngestEntry[]): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const abs = path.join(current, entry.name);
    if (entry.isDirectory()) {
      await walkDir(root, abs, spec, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (spec.includeRegex && !spec.includeRegex.test(entry.name)) continue;
    if (spec.excludeRegex && spec.excludeRegex.test(entry.name)) continue;
    const rel = path.relative(DEMO_REPO, abs).replace(/\\/g, '/');
    out.push({ abs, rel, contentType: classifyByFilename(abs) });
  }
}

// ---------------------------------------------------------------------------
// Stage: ingest
// ---------------------------------------------------------------------------

async function stageIngest(): Promise<void> {
  console.log('[seed:ingest] resolving scope…');
  const all: IngestEntry[] = [];
  for (const spec of INGEST_SCOPE) {
    const part = await walkSpec(spec);
    all.push(...part);
  }
  console.log(`[seed:ingest] ${all.length} files to ingest`);

  // Group by contentType for a quick visibility tally.
  const tally: Record<ContentType, number> = { 'prose': 0, 'code-ts': 0, 'code-sql': 0 };
  for (const e of all) tally[e.contentType] += 1;
  console.log(`[seed:ingest] tally: prose=${tally.prose} code-ts=${tally['code-ts']} code-sql=${tally['code-sql']}`);

  let queuedCount = 0;
  for (const entry of all) {
    let text: string;
    try {
      text = await readFile(entry.abs, 'utf-8');
    } catch (err) {
      console.warn(`[seed:ingest] failed to read ${entry.rel}:`, err instanceof Error ? err.message : err);
      continue;
    }
    if (!text.trim()) continue;
    try {
      const r = await postJson<{ position: number }>(`${NMEMO_URL}/ingest/queue`, {
        text,
        source: `demo:${entry.rel}`,
        contentType: entry.contentType,
      });
      queuedCount += 1;
      if (queuedCount % 10 === 0) {
        console.log(`[seed:ingest] queued ${queuedCount}/${all.length} (last: ${entry.rel} pos=${r.position})`);
      }
    } catch (err) {
      console.warn(`[seed:ingest] enqueue failed for ${entry.rel}:`, err instanceof Error ? err.message : err);
    }
  }
  console.log(`[seed:ingest] all ${queuedCount} files enqueued; waiting for drain…`);

  // Poll queue status. Each item runs the unified graph agent (~30-90s in
  // practice) so this can take a long time. Don't time out — operator can
  // ctrl-c and re-run safely.
  const startWait = Date.now();
  let lastReport = startWait;
  while (true) {
    const status = await getJson<{ queued: number; draining: boolean }>(`${NMEMO_URL}/ingest/queue/status`);
    if (status.queued === 0 && !status.draining) break;
    if (Date.now() - lastReport > 30_000) {
      const elapsed = Math.round((Date.now() - startWait) / 1000);
      console.log(`[seed:ingest] still draining: queued=${status.queued} draining=${status.draining} elapsed=${elapsed}s`);
      lastReport = Date.now();
    }
    await new Promise(r => setTimeout(r, 5_000));
  }
  console.log(`[seed:ingest] queue drained in ${Math.round((Date.now() - startWait) / 1000)}s`);
}

// ---------------------------------------------------------------------------
// Stage: reasoning
// ---------------------------------------------------------------------------

async function stageReasoning(): Promise<void> {
  console.log('[seed:reasoning] running reasoning patrol…');
  const result = await postJson<{ triggered: boolean; result?: string; durationMs?: number }>(`${NMEMO_URL}/api/reason`, {});
  console.log(`[seed:reasoning] triggered=${result.triggered} duration=${result.durationMs ?? 0}ms`);
  // Trigger contradiction detection explicitly (auto-trigger sometimes piggy-
  // backs on decay, which may not have fired during the demo seed).
  try {
    const contra = await postJson<{ detected?: number; byType?: unknown }>(`${NMEMO_URL}/api/contradictions/detect`, {});
    console.log(`[seed:reasoning] contradictions: ${JSON.stringify(contra)}`);
  } catch (err) {
    console.warn('[seed:reasoning] contradiction detection failed:', err instanceof Error ? err.message : err);
  }
  // Pattern detection + promotion.
  try {
    const det = await postJson<unknown>(`${NMEMO_URL}/api/patterns/detect`, {});
    console.log(`[seed:reasoning] pattern detect: ${JSON.stringify(det)}`);
    const prom = await postJson<unknown>(`${NMEMO_URL}/api/patterns/promote`, {});
    console.log(`[seed:reasoning] pattern promote: ${JSON.stringify(prom)}`);
  } catch (err) {
    console.warn('[seed:reasoning] pattern pipeline failed:', err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// Stage: topology
// ---------------------------------------------------------------------------

async function stageTopology(): Promise<void> {
  console.log('[seed:topology] computing graph stats + topology primitives…');
  // Graph stats first — required precondition for some topology computes.
  try {
    const stats = await postJson<{ ok: boolean }>(`${NMEMO_URL}/api/graph-stats/compute`, {});
    console.log(`[seed:topology] graph-stats ok=${stats.ok}`);
  } catch (err) {
    console.warn('[seed:topology] graph-stats compute failed:', err instanceof Error ? err.message : err);
  }
  try {
    const topo = await postJson<{ ok: boolean; durationMs?: number }>(`${NMEMO_URL}/api/topology/compute`, {});
    console.log(`[seed:topology] topology ok=${topo.ok} duration=${topo.durationMs ?? 0}ms`);
  } catch (err) {
    console.warn('[seed:topology] topology compute failed:', err instanceof Error ? err.message : err);
  }
  try {
    const cluster = await postJson<unknown>(`${NMEMO_URL}/api/clustering/compute`, {});
    console.log(`[seed:topology] clustering: ${JSON.stringify(cluster).slice(0, 200)}`);
  } catch (err) {
    console.warn('[seed:topology] clustering compute failed:', err instanceof Error ? err.message : err);
  }
}

// ---------------------------------------------------------------------------
// Stage: courses
// ---------------------------------------------------------------------------

async function stageCourses(opts: { includeLive?: boolean } = {}): Promise<void> {
  const targets = opts.includeLive ? [...PREBAKED_COURSES, LIVE_COURSE] : PREBAKED_COURSES;
  console.log(`[seed:courses] generating ${targets.length} course(s) with presentationMode=1…`);
  for (const spec of targets) {
    const start = Date.now();
    console.log(`[seed:courses] kicking off ${spec.label}…`);
    let courseId: string;
    try {
      const created = await postJson<{ courseId: string }>(`${LEARN_URL}/api/courses`, {
        topic: spec.topic,
        sourceType: 'generated',
        presentationMode: true,
      });
      courseId = created.courseId;
    } catch (err) {
      console.warn(`[seed:courses] ${spec.label} create failed:`, err instanceof Error ? err.message : err);
      continue;
    }
    console.log(`[seed:courses] ${spec.label} courseId=${courseId} — polling for ready…`);

    // Poll for course ready (course generator runs async with up to 15 min budget).
    const start2 = Date.now();
    while (true) {
      try {
        const course = await getJson<{ status: string }>(`${LEARN_URL}/api/courses/${courseId}`);
        if (course.status === 'ready') break;
        if (course.status === 'error') throw new Error(`course ${spec.label} entered error state`);
      } catch (err) {
        console.warn(`[seed:courses] poll error:`, err instanceof Error ? err.message : err);
      }
      if (Date.now() - start2 > 20 * 60_000) {
        console.warn(`[seed:courses] ${spec.label} did not become ready in 20 minutes — abandoning poll`);
        break;
      }
      await new Promise(r => setTimeout(r, 10_000));
    }
    console.log(`[seed:courses] ${spec.label} ready in ${Math.round((Date.now() - start) / 1000)}s`);

    // For each section, kick off lesson generation so the section pages are
    // pre-baked before the demo. Sections are returned by the GET /:id route.
    try {
      const full = await getJson<{ sections: Array<{ id: string; title: string }> }>(`${LEARN_URL}/api/courses/${courseId}`);
      for (const sec of full.sections) {
        try {
          await postJson<unknown>(`${LEARN_URL}/api/sections/${sec.id}/lesson`, {});
          console.log(`[seed:courses] kicked lesson for ${spec.label}/${sec.title}`);
        } catch (err) {
          console.warn(`[seed:courses] lesson kick failed for ${sec.id}:`, err instanceof Error ? err.message : err);
        }
      }
    } catch (err) {
      console.warn(`[seed:courses] failed to fetch sections for ${spec.label}:`, err instanceof Error ? err.message : err);
    }
  }
  console.log('[seed:courses] all kicked. Lesson generation runs async — poll status before the demo.');
}

// ---------------------------------------------------------------------------
// Stage: learner
//
// Scripted "presenter" learner interactions that build a real history. The
// pattern: deliberately wrong answers on a Reasoning-Layer concept (blast
// radius / contradictions) so the gap analyzer's causal trace lands on a
// Graph-C audit-trail concept — the cross-course wow moment.
//
// We don't fabricate quiz_attempts rows directly — we POST to the real
// /api/quiz/.../attempt route so the answer-evaluator runs and writes real
// MCP facts to the learner's graph state.
// ---------------------------------------------------------------------------

interface CourseSummary {
  id: string;
  title: string;
  status: string;
  sections: Array<{
    id: string;
    title: string;
    questions: Array<{ id: string; questionText: string }>;
  }>;
}

async function listCourses(): Promise<Array<{ id: string; title: string; status: string }>> {
  return getJson<Array<{ id: string; title: string; status: string }>>(`${LEARN_URL}/api/courses`);
}

async function loadCourseFull(courseId: string): Promise<CourseSummary> {
  return getJson<CourseSummary>(`${LEARN_URL}/api/courses/${courseId}`);
}

async function stageLearner(): Promise<void> {
  console.log('[seed:learner] resolving courses…');
  const all = await listCourses();
  const ready = all.filter(c => c.status === 'ready');
  if (ready.length === 0) {
    console.warn('[seed:learner] no ready courses — run --stage=courses first');
    return;
  }
  console.log(`[seed:learner] ${ready.length} ready course(s)`);

  // Strategy:
  //  - For the Reasoning-Layer course, answer the FIRST question of the
  //    FIRST section deliberately wrong (one-line vague answer). This seeds
  //    the gap. Then for the SECOND question, give a partially-correct answer.
  //  - For the Graph-S course, answer the first two questions correctly so
  //    the gap analyzer has signal that the learner has SOME foundations.
  //  - For the Graph-C course, ask one chat-tutor question that exercises
  //    audit-trail terminology so the tutor records understanding.
  for (const course of ready) {
    const full = await loadCourseFull(course.id);
    const isReasoning = /reasoning|blast|contradict|pattern/i.test(course.title);
    const isGraphS = /graph s|entities|facts|temporal/i.test(course.title);

    if (isReasoning && full.sections.length > 0) {
      const sec = full.sections[0]!;
      const qs = sec.questions ?? [];
      if (qs.length > 0) {
        await safeAttempt(qs[0]!.id, "I don't really remember — something about effects?");
      }
      if (qs.length > 1) {
        await safeAttempt(qs[1]!.id, "It's like a chain reaction in the graph but I'm not sure how it's traced.");
      }
    }

    if (isGraphS && full.sections.length > 0) {
      const sec = full.sections[0]!;
      const qs = sec.questions ?? [];
      if (qs.length > 0) {
        await safeAttempt(qs[0]!.id, "Entities are the named things — people, places, concepts. Each has a canonical name and a type.");
      }
      if (qs.length > 1) {
        await safeAttempt(qs[1]!.id, "Facts are bi-temporal: they have a valid_at and an invalid_at, and they reference the source memory they came from.");
      }
    }
  }

  // One chat exchange per ready course to give the chat-tutor real history
  // it can later build cross-course memory off.
  for (const course of ready) {
    try {
      await chatOnce(course.id, "Could you summarise what this course is about? I want to make sure I understand the scope.");
    } catch (err) {
      console.warn(`[seed:learner] chat-once failed for ${course.title}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log('[seed:learner] done. Run a gap-analysis to verify the cross-course trace lands.');
}

async function safeAttempt(questionId: string, answerText: string): Promise<void> {
  try {
    const r = await postJson<{ score: number; scoreLabel: string }>(
      `${LEARN_URL}/api/quiz/questions/${questionId}/attempt`,
      { answerText },
    );
    console.log(`[seed:learner] q=${questionId.slice(0, 8)} score=${r.score} (${r.scoreLabel})`);
  } catch (err) {
    console.warn(`[seed:learner] attempt failed:`, err instanceof Error ? err.message : err);
  }
}

async function chatOnce(courseId: string, message: string): Promise<void> {
  // Create or fetch a session, then post one message.
  const session = await postJson<{ id: string }>(`${LEARN_URL}/api/chat/sessions`, { courseId });
  await postJson<unknown>(`${LEARN_URL}/api/chat/sessions/${session.id}/messages`, { content: message });
  console.log(`[seed:learner] chat seeded for course=${courseId.slice(0, 8)}`);
}

// ---------------------------------------------------------------------------
// CLI dispatch
// ---------------------------------------------------------------------------

type Stage = 'ingest' | 'reasoning' | 'topology' | 'courses' | 'course-live' | 'learner' | 'all';

function parseArgs(): { stage: Stage } {
  const args = process.argv.slice(2);
  for (const a of args) {
    const m = a.match(/^--stage=(.+)$/);
    if (m) {
      const s = m[1] as Stage;
      const valid: Stage[] = ['ingest', 'reasoning', 'topology', 'courses', 'course-live', 'learner', 'all'];
      if (!valid.includes(s)) throw new Error(`unknown stage: ${s}. Valid: ${valid.join(', ')}`);
      return { stage: s };
    }
  }
  throw new Error('Usage: pnpm tsx scripts/seed-demo.ts --stage=<ingest|reasoning|topology|courses|course-live|learner|all>');
}

async function main(): Promise<void> {
  const { stage } = parseArgs();
  console.log(`[seed] NMEMO_URL=${NMEMO_URL} LEARN_URL=${LEARN_URL} DEMO_REPO=${DEMO_REPO} stage=${stage}`);
  switch (stage) {
    case 'ingest':      await stageIngest();    break;
    case 'reasoning':   await stageReasoning(); break;
    case 'topology':    await stageTopology();  break;
    case 'courses':     await stageCourses();   break;
    case 'course-live': await stageCourses({ includeLive: true }); break;
    case 'learner':     await stageLearner();   break;
    case 'all':
      await stageIngest();
      await stageReasoning();
      await stageTopology();
      await stageCourses();
      await stageLearner();
      break;
  }
  console.log('[seed] done.');
}

main().catch(err => {
  console.error('[seed] fatal:', err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
