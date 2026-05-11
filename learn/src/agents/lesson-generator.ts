/**
 * Lesson Generator — multi-agent orchestrator.
 *
 * Pipeline:
 *   1. Outliner (Sonnet 4.6 max)        — one call, designs structure +
 *                                          tags every artifact moment.
 *   2. Prose writers (Sonnet 4.6 high)  — one call per prose item, in
 *                                          parallel.
 *   3. Artifact builders (Opus 4.7 max) — one per artifact, in bounded
 *                                          parallel batches. Reuses the
 *                                          existing artifact-generator and
 *                                          component-generator agents.
 *   4. Composer (pure code)             — interleaves outputs in outline
 *                                          order; assembles LessonBlock[].
 *
 * Quality of the resulting lesson is the priority — cost and wall-clock
 * are secondary. Typical wall-clock per section: outline (1-3 min) +
 * max(prose 1-3 min in parallel, artifacts 2-8 min in parallel) ≈ 4-12 min.
 *
 * Legacy path (single-shot Haiku) is preserved behind env
 * LEARN_LESSON_GENERATOR_LEGACY=1 for fallback during validation.
 */

import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import { runAgent } from '../services/agent.js';
import { ingestContent } from '../services/nmemo-client.js';
import { db, courses, sections } from '../db/index.js';
import {
  generateLessonOutline,
  type LessonOutline,
  type OutlineItem,
  type ProseItem,
  type ArtifactItem,
  type OutlineFixedKind,
  type OutlineArtifactIntent,
} from './lesson-outliner.js';
import { writeProseBlock, type ProseWriterResult } from './lesson-prose.js';
import { generateArtifact, type ArtifactSpec } from './artifact-generator.js';
import { generateComponent, type ComponentKindName } from './component-generator.js';
import {
  loadLearnerLessonContext,
  withPrioritisedGap,
  type LearnerLessonContext,
  type PrioritisedGap,
} from './learner-lesson-context.js';
import { withPresentationMode } from './presentation-mode.js';

// ---------------------------------------------------------------------------
// Public types — preserved from v0.2 so route layer doesn't change.
// ---------------------------------------------------------------------------

export interface GeneratedLesson {
  content: string;
  estimatedReadMinutes: number;
  keyTakeaways: string[];
}

export type { LessonCitation } from './lesson-types.js';
import type { LessonCitation } from './lesson-types.js';

export type LessonBlock =
  | { type: 'markdown'; content: string; citations?: LessonCitation[] }
  | { type: 'component'; kind: string; props: Record<string, unknown>; children?: string; citations?: LessonCitation[] };

export interface GeneratedLessonStructured {
  blocks: LessonBlock[];
  estimatedReadMinutes: number;
  keyTakeaways: string[];
}

export type GenerateLessonResult =
  | ({ format: 'markdown' } & GeneratedLesson)
  | ({ format: 'structured' } & GeneratedLessonStructured);

export type LessonStage = 'outlining' | 'writing_prose' | 'building_artifacts' | 'composing';

export interface GenerateLessonOpts {
  /** Called whenever the pipeline transitions to a new stage. Best-effort —
      callback failures must not abort generation. */
  onStage?: (stage: LessonStage) => void | Promise<void>;
  /** Optional gap-bias hint (nmemo-7b3). When set, the loaded learner
   *  context is augmented with this gap and `coldStart` is forced to false
   *  so the outliner / prose writers emit a remedial slant targeting the
   *  root-cause concept. Used by the "fix this gap" CTA. */
  prioritisedGap?: PrioritisedGap;
}

const ALLOWED_KINDS = new Set([
  'Callout', 'Mermaid', 'SvgFigure', 'CodeRunner',
  'StepThrough', 'FlashcardDeck', 'ConceptMap', 'Highlight', 'Artifact',
]);

// ---------------------------------------------------------------------------
// Web-search configuration. Read once per lesson so a flipped env flag at
// runtime takes effect on the next generation. All flags default ON; setting
// any to '0' / 'false' / 'no' disables that surface.
// ---------------------------------------------------------------------------

function envFlag(name: string, defaultOn: boolean): boolean {
  const v = process.env[name];
  if (v === undefined || v === '') return defaultOn;
  if (v === '0' || v.toLowerCase() === 'false' || v.toLowerCase() === 'no') return false;
  if (v === '1' || v.toLowerCase() === 'true' || v.toLowerCase() === 'yes') return true;
  return defaultOn;
}

function envInt(name: string, defaultValue: number): number {
  const v = process.env[name];
  if (!v) return defaultValue;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : defaultValue;
}

interface WebSearchPolicy {
  /** Master switch — when false, no stage runs WebSearch. */
  enabled: boolean;
  outliner: boolean;
  prose: boolean;
  artifact: boolean;
  /** Maximum unique citations the composer will ingest back into the graph. */
  maxIngestUrls: number;
  /** Cross-stage cap on number of agent invocations that may opt in to
   *  WebSearch within a single lesson. Outliner counts as 1 stage when web
   *  is enabled for it; each prose writer counts as 1; each freeform-intent
   *  artifact builder counts as 1. Fixed-kind components never opt in. */
  maxStages: number;
}

function loadWebSearchPolicy(): WebSearchPolicy {
  const enabled = envFlag('LEARN_LESSON_WEBSEARCH', true);
  return {
    enabled,
    outliner: enabled && envFlag('LEARN_OUTLINER_WEBSEARCH', true),
    prose: enabled && envFlag('LEARN_PROSE_WEBSEARCH', true),
    artifact: enabled && envFlag('LEARN_ARTIFACT_WEBSEARCH', true),
    maxIngestUrls: envInt('LEARN_LESSON_WEBSEARCH_MAX_INGEST_URLS', 3),
    maxStages: envInt('LEARN_LESSON_WEBSEARCH_MAX', 5),
  };
}

// ---------------------------------------------------------------------------
// Cross-stage WebSearch budget allocator (nmemo-ble).
//
// Per-stage `enableWebSearch` is opt-in, but the orchestrator runs the
// outliner + N prose writers (parallel) + M freeform artifact builders. Each
// agent's --max-turns caps tool calls *within* a single agent run, but the
// global cap (3-5 web searches per lesson) is unenforced across stages.
//
// The allocator is the orchestrator-level gate. It is pure logic — no LLM
// calls, no I/O — so it is unit-tested directly and re-used at both Stage 1
// (outliner) and Stage 2/3 (prose + freeform artifacts) opt-in sites.
// ---------------------------------------------------------------------------

export type WebSearchStageKind = 'outliner' | 'prose' | 'freeform_artifact';

export interface WebSearchStageRequest {
  /** Stable id used to look the decision back up at opt-in time. The
   *  orchestrator uses 'outliner' for the outliner and the outline-item id
   *  for prose / freeform artifacts. */
  id: string;
  kind: WebSearchStageKind;
  /** Whether the stage is willing to opt in (per-stage policy flag AND'd
   *  with any agent-side intent gate already applied by the caller). When
   *  false the allocator never charges a slot for this stage. */
  wantsWeb: boolean;
}

export interface WebSearchAllocation {
  /** Set of stage ids granted a slot. Keyed by `WebSearchStageRequest.id`. */
  granted: Set<string>;
  /** Number of slots consumed. Equal to granted.size. */
  used: number;
  /** Total slots available at the start of allocation. */
  max: number;
  /** Per-kind counts of granted slots — used for the telemetry log line. */
  byKind: Record<WebSearchStageKind, number>;
}

/**
 * Allocate up to `max` web-search slots across `stages` in the order they
 * appear. Stages with `wantsWeb=false` are never granted (and never charged).
 * The first `max` stages with `wantsWeb=true` are granted; the rest are
 * denied. Order matters — callers must pass stages in the order the
 * orchestrator fires them so the budget mirrors execution.
 */
export function allocateWebSearchBudget(
  stages: WebSearchStageRequest[],
  max: number,
): WebSearchAllocation {
  const granted = new Set<string>();
  const byKind: Record<WebSearchStageKind, number> = {
    outliner: 0,
    prose: 0,
    freeform_artifact: 0,
  };
  if (!Number.isFinite(max) || max <= 0) {
    return { granted, used: 0, max: Math.max(0, max | 0), byKind };
  }
  let remaining = max;
  for (const s of stages) {
    if (!s.wantsWeb) continue;
    if (remaining <= 0) break;
    granted.add(s.id);
    byKind[s.kind] += 1;
    remaining -= 1;
  }
  return { granted, used: granted.size, max, byKind };
}

// ---------------------------------------------------------------------------
// Context loading — section + course + neighbour titles.
// ---------------------------------------------------------------------------

interface LessonContext {
  courseTitle: string;
  courseDescription: string | null;
  sectionTitle: string;
  sectionDescription: string | null;
  learningObjectives: string[];
  /** Nmemo entity IDs attached to this section by the course generator.
   *  Empty array when the section has no graph-aware concepts. */
  conceptEntityIds: string[];
  orderIndex: number;
  nextSectionTitle: string | null;
  prevSectionTitle: string | null;
  /** True when the parent course is flagged as part of a live demo —
   *  outliner / prose writer / artifact builders bias their register
   *  toward audience-aware explanation with light meta self-reference. */
  presentationMode: boolean;
}

async function buildContext(sectionId: string): Promise<LessonContext> {
  const [section] = await db.select().from(sections).where(eq(sections.id, sectionId));
  if (!section) throw new Error(`Section ${sectionId} not found`);

  const [course] = await db.select().from(courses).where(eq(courses.id, section.courseId));
  if (!course) throw new Error(`Course ${section.courseId} not found`);

  const allSections = await db.select().from(sections)
    .where(eq(sections.courseId, section.courseId))
    .orderBy(sections.orderIndex);

  const idx = allSections.findIndex((s) => s.id === sectionId);
  const next = idx >= 0 && idx < allSections.length - 1 ? allSections[idx + 1] : null;
  const prev = idx > 0 ? allSections[idx - 1] : null;

  let conceptEntityIds: string[] = [];
  try {
    const parsed = JSON.parse(section.conceptEntityIds ?? '[]');
    if (Array.isArray(parsed)) {
      conceptEntityIds = parsed.filter((x): x is string => typeof x === 'string' && x.length > 0);
    }
  } catch (err) {
    console.warn(`[lesson-generator] could not parse conceptEntityIds for section ${sectionId}:`, err);
  }

  return {
    courseTitle: course.title,
    courseDescription: course.description,
    sectionTitle: section.title,
    sectionDescription: section.description,
    learningObjectives: JSON.parse(section.learningObjectives) as string[],
    conceptEntityIds,
    orderIndex: section.orderIndex,
    nextSectionTitle: next?.title ?? null,
    prevSectionTitle: prev?.title ?? null,
    presentationMode: Boolean(course.presentationMode),
  };
}

// ---------------------------------------------------------------------------
// Stage 3 — artifact builders. Each artifact item maps to either the
// component-generator (fixed kinds) or the artifact-generator (freeform).
// ---------------------------------------------------------------------------

const FIXED_TO_COMPONENT: Record<OutlineFixedKind, ComponentKindName> = {
  Mermaid: 'Mermaid',
  Callout: 'Callout',
  FlashcardDeck: 'FlashcardDeck',
  ConceptMap: 'ConceptMap',
  StepThrough: 'StepThrough',
  CodeRunner: 'CodeRunner',
  SvgFigure: 'SvgFigure',
};

interface ArtifactSuccess {
  ok: true;
  block: LessonBlock;
}
interface ArtifactFail {
  ok: false;
  reason: string;
}

function neighbourProseDigest(outline: LessonOutline, item: ArtifactItem): string {
  // Surrounding prose intents make a useful grounding payload for the
  // builder agent — it can't see the prose text (parallelism), but the
  // intents tell it where in the lesson the widget sits.
  const idx = outline.items.findIndex((it) => it.id === item.id);
  const window = (start: number, end: number) =>
    outline.items.slice(Math.max(0, start), end)
      .filter((it) => it.kind === 'prose')
      .map((it) => `- ${(it as ProseItem).intent}`).join('\n');
  const before = window(idx - 2, idx);
  const after = window(idx + 1, idx + 3);
  const parts = [
    `Lesson title: ${outline.title}`,
    `Intro: ${outline.intro}`,
  ];
  if (before) parts.push('Prose just before this artifact:', before);
  if (after) parts.push('Prose just after this artifact:', after);
  return parts.join('\n');
}

/** Project a `LearnerLessonContext` onto the artifact-builder's `learnerState`
 *  shape. Cold-start (or undefined) collapses to a minimal payload that does
 *  not surface any personalisation cue in downstream prompts. */
function projectLearnerStateForArtifact(
  ctx: LessonContext,
  learner: LearnerLessonContext | undefined,
): {
  conceptName: string;
  forgottenConcepts?: string[];
  confusions?: Array<{ concept: string; misconception: string }>;
  missingPrereqs?: string[];
} {
  const base = { conceptName: ctx.sectionTitle };
  if (!learner || learner.coldStart === true) return base;
  const forgottenConcepts = learner.forgottenConcepts.map((f) => f.name);
  const confusions = learner.confusions.map((c) => ({ concept: c.concept, misconception: c.misconception }));
  const missingPrereqs = learner.missingPrereqs.map((p) => p.concept);
  return {
    ...base,
    ...(forgottenConcepts.length > 0 ? { forgottenConcepts } : {}),
    ...(confusions.length > 0 ? { confusions } : {}),
    ...(missingPrereqs.length > 0 ? { missingPrereqs } : {}),
  };
}

async function buildOneArtifact(
  outline: LessonOutline,
  item: ArtifactItem,
  ctx: LessonContext,
  learner: LearnerLessonContext | undefined,
  policy: WebSearchPolicy,
  webBudget: Set<string>,
): Promise<ArtifactSuccess | ArtifactFail> {
  if (item.type === 'fixed') {
    const kind = FIXED_TO_COMPONENT[item.fixedKind!];
    const result = await generateComponent({
      kind,
      context: item.spec,
      learnerState: projectLearnerStateForArtifact(ctx, learner),
    });
    if (result.kind === 'markdown') {
      return { ok: false, reason: `fixed-kind ${item.fixedKind} fell back to markdown` };
    }
    const block: LessonBlock = {
      type: 'component',
      kind: result.kind,
      props: result.props,
    };
    if (result.children) block.children = result.children;
    return { ok: true, block };
  }
  // freeform
  const intent: OutlineArtifactIntent = item.intent ?? 'free';
  const lessonContext = neighbourProseDigest(outline, item);
  // Per design: artifact agent gets WebSearch only when intent === 'free'.
  // generateArtifact double-checks this internally, but we gate at the
  // orchestrator too so the policy switch is visible here.
  // Cross-stage budget: only items in `webBudget` get web tools.
  const enableWebSearch = policy.artifact && intent === 'free' && webBudget.has(item.id);
  const result = await generateArtifact({
    intent,
    context: item.spec,
    lessonContext,
    learnerState: projectLearnerStateForArtifact(ctx, learner),
    enableWebSearch,
  });
  if (!result.ok) {
    return { ok: false, reason: `artifact agent: ${result.errorText}` };
  }
  const spec: ArtifactSpec = result.spec;
  const block: LessonBlock = {
    type: 'component',
    kind: 'Artifact',
    props: {
      title: spec.title,
      html: spec.html,
      libraries: spec.libraries,
      height: spec.height,
    },
  };
  return { ok: true, block };
}

/**
 * Run artifact builders with bounded parallelism. Anthropic per-key rate
 * limits start to bite past ~4 simultaneous Opus-max calls; we cap at 3
 * so the lesson pipeline can co-exist with other generators.
 */
async function buildArtifactsBounded(
  outline: LessonOutline,
  artifacts: ArtifactItem[],
  ctx: LessonContext,
  learner: LearnerLessonContext | undefined,
  policy: WebSearchPolicy,
  webBudget: Set<string>,
  concurrency = 3,
): Promise<Map<string, ArtifactSuccess | ArtifactFail>> {
  const out = new Map<string, ArtifactSuccess | ArtifactFail>();
  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < Math.min(concurrency, artifacts.length); w += 1) {
    workers.push((async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= artifacts.length) return;
        const item = artifacts[idx]!;
        try {
          const r = await buildOneArtifact(outline, item, ctx, learner, policy, webBudget);
          out.set(item.id, r);
          if (!r.ok) {
            console.warn(`[lesson-generator] artifact ${item.id} failed: ${r.reason}`);
          } else {
            console.log(`[lesson-generator] artifact ${item.id} built (${item.type === 'fixed' ? item.fixedKind : `Artifact:${item.intent}`})`);
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[lesson-generator] artifact ${item.id} threw: ${msg}`);
          out.set(item.id, { ok: false, reason: msg });
        }
      }
    })());
  }
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------------------
// Stage 4 — composer. Pure code, no LLM.
// ---------------------------------------------------------------------------

function isAllowedKind(k: string): boolean {
  return ALLOWED_KINDS.has(k);
}

function fallbackBlock(item: ArtifactItem, reason: string): LessonBlock {
  const tag = item.type === 'fixed' ? item.fixedKind : `Artifact:${item.intent}`;
  return {
    type: 'markdown',
    content: `_[Artifact generation failed for ${tag}: ${reason}]_`,
  };
}

function compose(
  outline: LessonOutline,
  proseById: Map<string, string>,
  artifactById: Map<string, ArtifactSuccess | ArtifactFail>,
  citationsById: Map<string, LessonCitation[]>,
): LessonBlock[] {
  const blocks: LessonBlock[] = [];
  blocks.push({ type: 'markdown', content: outline.intro });
  for (const item of outline.items) {
    if (item.kind === 'prose') {
      const md = proseById.get(item.id);
      if (md && md.trim().length > 0) {
        const cites = citationsById.get(item.id);
        const block: LessonBlock = { type: 'markdown', content: md };
        if (cites && cites.length > 0) block.citations = cites;
        blocks.push(block);
      } else {
        blocks.push({
          type: 'markdown',
          content: `_[Prose block ${item.id} failed to generate. Intent: ${item.intent}]_`,
        });
      }
      continue;
    }
    // artifact
    const got = artifactById.get(item.id);
    if (got && got.ok && isAllowedKind(got.block.type === 'component' ? got.block.kind : '')) {
      blocks.push(got.block);
    } else {
      const reason = got && !got.ok ? got.reason : 'no result';
      blocks.push(fallbackBlock(item, reason));
    }
  }
  blocks.push({ type: 'markdown', content: outline.outro });
  return blocks;
}

// ---------------------------------------------------------------------------
// Citation collection + ingest-back. Runs at the composer stage: collect every
// unique URL from `LessonBlock.citations[]` and POST each to /ingest exactly
// once. Failures are logged + skipped — the lesson still ships with its
// citations intact.
// ---------------------------------------------------------------------------

function shortUrlHash(url: string): string {
  return createHash('sha1').update(url).digest('hex').slice(0, 12);
}

/**
 * Collect unique URLs from all `citations[]` arrays across the supplied blocks.
 * Returns URLs in first-seen order so logs / tests are deterministic.
 */
export function collectCitationUrls(blocks: LessonBlock[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const b of blocks) {
    const cites = b.citations;
    if (!cites || cites.length === 0) continue;
    for (const c of cites) {
      if (!c || typeof c.url !== 'string') continue;
      const u = c.url.trim();
      if (!u || seen.has(u)) continue;
      seen.add(u);
      out.push(u);
    }
  }
  return out;
}

interface IngestSourcesDeps {
  /** Override for the platform call — used in tests so unit tests don't hit the network. */
  ingest?: (text: string, source: string) => Promise<{ memoryId: string; entities?: unknown[]; facts?: unknown[] }>;
  /** Override for the URL fetcher — used in tests. The default uses fetch(). */
  fetchUrl?: (url: string) => Promise<string>;
}

async function defaultFetchUrl(url: string): Promise<string> {
  const r = await fetch(url, { redirect: 'follow' });
  if (!r.ok) throw new Error(`fetch ${url} → ${r.status}`);
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    return JSON.stringify(await r.json());
  }
  return await r.text();
}

/**
 * Collect unique citation URLs from `blocks`, fetch each, and POST to /ingest.
 * Caps at `policy.maxIngestUrls`. Per-URL failures are logged and skipped —
 * the lesson must still ship even when ingest fails.
 */
export async function ingestLessonSources(
  sectionId: string,
  blocks: LessonBlock[],
  policy: WebSearchPolicy,
  deps: IngestSourcesDeps = {},
): Promise<{ ingested: string[]; failed: Array<{ url: string; reason: string }> }> {
  const ingest = deps.ingest ?? ingestContent;
  const fetcher = deps.fetchUrl ?? defaultFetchUrl;
  const urls = collectCitationUrls(blocks);
  if (urls.length === 0) return { ingested: [], failed: [] };
  const limited = urls.slice(0, Math.max(0, policy.maxIngestUrls));
  if (limited.length < urls.length) {
    console.warn(`[lesson-ingest] capped ingest to first ${limited.length}/${urls.length} citation URLs (LEARN_LESSON_WEBSEARCH_MAX_INGEST_URLS=${policy.maxIngestUrls})`);
  }
  const ingested: string[] = [];
  const failed: Array<{ url: string; reason: string }> = [];
  for (const url of limited) {
    try {
      const text = await fetcher(url);
      if (!text || !text.trim()) {
        failed.push({ url, reason: 'empty content' });
        continue;
      }
      const source = `learn:lesson:${sectionId}:websearch:${shortUrlHash(url)}`;
      const result = await ingest(text, source);
      console.log(`[lesson-ingest] ingested ${url} → memoryId ${result.memoryId}`);
      ingested.push(url);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[lesson-ingest] failed to ingest ${url}: ${msg}`);
      failed.push({ url, reason: msg });
    }
  }
  return { ingested, failed };
}

// ---------------------------------------------------------------------------
// Estimated read minutes + key takeaways.
// ---------------------------------------------------------------------------

function estimateReadMinutes(blocks: LessonBlock[]): number {
  // ~200 wpm reading speed for technical material. Components add ~30s each.
  let words = 0;
  let components = 0;
  for (const b of blocks) {
    if (b.type === 'markdown') {
      words += b.content.split(/\s+/).filter(Boolean).length;
    } else {
      components += 1;
      if (b.children) words += b.children.split(/\s+/).filter(Boolean).length;
    }
  }
  const minutes = Math.round(words / 200 + components * 0.5);
  return Math.max(2, Math.min(20, minutes));
}

interface TakeawaysInput {
  outline: LessonOutline;
  proseSample: string;
}

const TAKEAWAYS_SYSTEM_PROMPT = `You read a lesson outline and excerpt and extract 3-6 short, concrete key takeaways the learner should leave with.

Output ONLY a JSON object: { "takeaways": ["...", "..."] }. First char '{', last char '}'. No prose, no fences.

Each takeaway: 5-20 words, concrete, learner-oriented. No vague platitudes ("understand the basics"). State a specific fact, mechanism, or rule of thumb the lesson teaches.`;

async function generateTakeaways(input: TakeawaysInput): Promise<string[]> {
  const userPrompt = [
    `Lesson title: ${input.outline.title}`,
    `Intro: ${input.outline.intro}`,
    '',
    `Prose excerpts:`,
    input.proseSample.slice(0, 4000),
    '',
    `Outro: ${input.outline.outro}`,
    '',
    'Output the JSON.',
  ].join('\n');
  try {
    const result = await runAgent(userPrompt, {
      model: 'haiku',
      effort: 'low',
      systemPrompt: TAKEAWAYS_SYSTEM_PROMPT,
      tools: 'none',
      maxTurns: 1,
      timeoutMs: 60_000,
    });
    const raw = (result.result ?? '').trim();
    const obj = raw.match(/\{[\s\S]*\}/);
    if (!obj) return [];
    const parsed = JSON.parse(obj[0]) as { takeaways?: unknown };
    if (!Array.isArray(parsed.takeaways)) return [];
    return parsed.takeaways.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
      .map((t) => t.trim()).slice(0, 6);
  } catch (err) {
    console.warn('[lesson-generator] takeaways extraction failed:', err);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Orchestrator entry point.
// ---------------------------------------------------------------------------

async function generateLessonStructuredV3(
  sectionId: string,
  opts: GenerateLessonOpts = {},
): Promise<GeneratedLessonStructured> {
  const emit = async (stage: LessonStage): Promise<void> => {
    if (!opts.onStage) return;
    try { await opts.onStage(stage); } catch (err) {
      console.warn(`[lesson-generator] onStage(${stage}) callback threw:`, err);
    }
  };

  const ctx = await buildContext(sectionId);
  const policy = loadWebSearchPolicy();
  console.log(`[lesson-generator] starting pipeline for section ${sectionId} ("${ctx.sectionTitle}")`);
  console.log(
    `[lesson-generator] websearch policy: enabled=${policy.enabled} ` +
    `outliner=${policy.outliner} prose=${policy.prose} artifact=${policy.artifact} ` +
    `maxIngest=${policy.maxIngestUrls} maxStages=${policy.maxStages}`,
  );

  // Cross-stage WebSearch budget. The outliner runs first (one stage), so
  // we allocate its slot up-front; prose + freeform artifacts share the
  // remainder once the outline reveals how many of each there are.
  const outlinerWantsWeb = policy.outliner;
  const outlinerAlloc = allocateWebSearchBudget(
    [{ id: 'outliner', kind: 'outliner', wantsWeb: outlinerWantsWeb }],
    policy.enabled ? policy.maxStages : 0,
  );
  const outlinerGotWeb = outlinerAlloc.granted.has('outliner');
  const remainingAfterOutliner = Math.max(0, outlinerAlloc.max - outlinerAlloc.used);

  // Single platform fetch for learner state. Degrades to cold-start on any
  // failure / timeout — pipeline must never abort because of a flaky platform
  // call. The same snapshot is threaded through every parallel stage.
  const baseLearnerContext = await loadLearnerLessonContext(ctx.conceptEntityIds);
  // Apply gap-bias if the caller passed a `prioritisedGap`. The helper
  // forces coldStart=false because the gap is itself the personalisation
  // signal — even a learner with no relevant facts on this section's
  // concepts gets a remedial slant when explicitly steered here.
  const learnerContext: LearnerLessonContext = opts.prioritisedGap
    ? withPrioritisedGap(baseLearnerContext, opts.prioritisedGap)
    : baseLearnerContext;
  // Pass the typed context downstream only when we're personalising. For
  // cold-start lessons we pass `undefined`, which makes outliner / prose /
  // artifact prompts byte-identical to the v0.3 baseline.
  const personalised: LearnerLessonContext | undefined =
    learnerContext.coldStart === false ? learnerContext : undefined;
  console.log(
    `[lesson-generator] learner-state: coldStart=${learnerContext.coldStart} ` +
    `facts=${learnerContext.relevantFacts.length} ` +
    `confusions=${learnerContext.confusions.length} ` +
    `forgotten=${learnerContext.forgottenConcepts.length} ` +
    `missingPrereqs=${learnerContext.missingPrereqs.length} ` +
    `(fetchedAt=${learnerContext.fetchedAt})`,
  );

  // Stage 1 — outline.
  await emit('outlining');
  const outline = await generateLessonOutline({
    courseTitle: ctx.courseTitle,
    courseDescription: ctx.courseDescription,
    sectionTitle: ctx.sectionTitle,
    sectionDescription: ctx.sectionDescription,
    learningObjectives: ctx.learningObjectives,
    orderIndex: ctx.orderIndex,
    prevSectionTitle: ctx.prevSectionTitle,
    nextSectionTitle: ctx.nextSectionTitle,
    learnerContext: personalised,
    enableWebSearch: outlinerGotWeb,
    presentationMode: ctx.presentationMode,
  });
  const proseItems = outline.items.filter((it): it is ProseItem => it.kind === 'prose');
  const artifactItems = outline.items.filter((it): it is ArtifactItem => it.kind === 'artifact');
  console.log(`[lesson-generator] outline has ${proseItems.length} prose, ${artifactItems.length} artifacts`);

  // Allocate remaining budget across prose writers (in outline order) then
  // freeform artifact builders (in outline order). Fixed-kind components
  // never opt in to web tools, so they're absent from the request list.
  const stageRequests: WebSearchStageRequest[] = [];
  for (const p of proseItems) {
    stageRequests.push({ id: p.id, kind: 'prose', wantsWeb: policy.prose });
  }
  for (const a of artifactItems) {
    if (a.type === 'freeform' && (a.intent ?? 'free') === 'free') {
      stageRequests.push({ id: a.id, kind: 'freeform_artifact', wantsWeb: policy.artifact });
    }
  }
  const downstreamAlloc = allocateWebSearchBudget(stageRequests, remainingAfterOutliner);
  const totalUsed = outlinerAlloc.used + downstreamAlloc.used;
  console.log(
    `[lesson-websearch] used ${totalUsed}/${policy.maxStages} slots across ` +
    `{outliner: ${outlinerGotWeb}, prose: ${downstreamAlloc.byKind.prose}, ` +
    `freeform_artifacts: ${downstreamAlloc.byKind.freeform_artifact}}`,
  );

  // Stages 2 + 3 — prose writers and artifact builders run concurrently.
  // We label the stage by what's still outstanding: start with writing_prose
  // (artifacts run alongside), and transition to building_artifacts once the
  // prose writers finish — artifacts are typically the long tail.
  await emit('writing_prose');
  const proseProm = Promise.all(proseItems.map(async (item) => {
    try {
      const result = await writeProseBlock({
        outline,
        item,
        courseTitle: ctx.courseTitle,
        sectionTitle: ctx.sectionTitle,
        sectionDescription: ctx.sectionDescription,
        learningObjectives: ctx.learningObjectives,
        learnerContext: personalised,
        enableWebSearch: policy.prose && downstreamAlloc.granted.has(item.id),
        presentationMode: ctx.presentationMode,
      });
      const citeCount = result.citations?.length ?? 0;
      console.log(`[lesson-generator] prose ${item.id} written (${result.markdown.length} chars, ${citeCount} citations)`);
      return [item.id, result] as const;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[lesson-generator] prose ${item.id} failed: ${msg}`);
      return [item.id, { markdown: '' } as ProseWriterResult] as const;
    }
  }));

  const artifactProm = buildArtifactsBounded(outline, artifactItems, ctx, personalised, policy, downstreamAlloc.granted, 3);

  // Track prose finishing independently so we can flip the stage label to
  // building_artifacts when only artifacts remain.
  const proseEntries = await proseProm;
  if (artifactItems.length > 0) {
    await emit('building_artifacts');
  }
  const artifactById = await artifactProm;
  const proseById = new Map<string, string>();
  const citationsById = new Map<string, LessonCitation[]>();
  for (const [id, result] of proseEntries) {
    proseById.set(id, result.markdown);
    if (result.citations && result.citations.length > 0) {
      citationsById.set(id, result.citations);
    }
  }

  // Stage 4 — compose.
  await emit('composing');
  const blocks = compose(outline, proseById, artifactById, citationsById);

  // Validate every emitted block. Anything that fails the validator is
  // dropped and replaced with a placeholder to keep the lesson complete.
  const validated: LessonBlock[] = [];
  for (const b of blocks) {
    if (b.type === 'markdown' && typeof b.content === 'string') {
      validated.push(b);
      continue;
    }
    if (b.type === 'component' && typeof b.kind === 'string' && isAllowedKind(b.kind)) {
      validated.push(b);
      continue;
    }
    validated.push({ type: 'markdown', content: '_[Block dropped: failed validation]_' });
  }

  // Ingest-back: collect cited URLs from final blocks and feed them into
  // /ingest. Failures are logged but do NOT block the lesson — the learner
  // still receives every citation in the rendered lesson regardless of
  // whether the URL made it into the graph.
  if (policy.enabled && policy.maxIngestUrls > 0) {
    try {
      const { ingested, failed } = await ingestLessonSources(sectionId, validated, policy);
      const total = ingested.length + failed.length;
      if (total > 0) {
        console.log(`[lesson-generator] ingest-back: ${ingested.length}/${total} URL(s) ingested into graph`);
      }
    } catch (err) {
      // Belt-and-suspenders — ingestLessonSources already swallows per-URL
      // errors, but if the whole call throws, swallow here too.
      console.warn('[lesson-generator] ingest-back phase threw (lesson still ships):', err);
    }
  }

  // Takeaways from a prose sample.
  const proseSample = Array.from(proseById.values()).filter(Boolean).join('\n\n');
  const keyTakeaways = await generateTakeaways({ outline, proseSample });

  console.log(`[lesson-generator] composed lesson: ${validated.length} blocks, ${keyTakeaways.length} takeaways`);

  return {
    blocks: validated,
    estimatedReadMinutes: estimateReadMinutes(validated),
    keyTakeaways,
  };
}

// ---------------------------------------------------------------------------
// Legacy single-shot path (env-gated).
// ---------------------------------------------------------------------------

const LEGACY_SYSTEM_PROMPT = `You are an expert educator and technical writer. Your job is to write a single section of a course as a focused, engaging markdown lesson.

## Output

Output ONLY a JSON object — no surrounding text, no markdown fences, no commentary. The JSON must match exactly this schema:

{
  "content": "string — markdown lesson body",
  "estimatedReadMinutes": number — integer between 2 and 20,
  "keyTakeaways": ["string", "..."]
}

## Lesson structure

The "content" field MUST be markdown with these parts in order, separated by '##' headings:
1. ## Why this matters
2. ## Core ideas (with code examples in fenced blocks where technical)
3. ## Things to watch out for
4. ## What's next

## Style

- Direct, second-person voice. Short paragraphs. No padding.

## Hard rules

- Output JSON ONLY. No fences. Escape newlines inside the content string as \\n.`;

function buildLegacyPrompt(ctx: LessonContext): string {
  const objectives = ctx.learningObjectives.length > 0
    ? ctx.learningObjectives.map((o, i) => `${i + 1}. ${o}`).join('\n')
    : '(none specified)';
  return `Write the lesson body for the following section.

## Course
- Title: ${ctx.courseTitle}
${ctx.courseDescription ? `- Description: ${ctx.courseDescription}` : ''}

## Section
- Title: ${ctx.sectionTitle}
${ctx.sectionDescription ? `- Description: ${ctx.sectionDescription}` : ''}
- Position: ${ctx.orderIndex + 1}${ctx.prevSectionTitle ? ` (previous: "${ctx.prevSectionTitle}")` : ' (first)'}
${ctx.nextSectionTitle ? `- Next: "${ctx.nextSectionTitle}"` : '- Final section.'}

## Learning objectives
${objectives}

Output the JSON only.`;
}

async function generateLessonLegacy(sectionId: string): Promise<GeneratedLesson> {
  const ctx = await buildContext(sectionId);
  const result = await runAgent(buildLegacyPrompt(ctx), {
    model: 'haiku',
    effort: 'low',
    systemPrompt: withPresentationMode(LEGACY_SYSTEM_PROMPT, ctx.presentationMode),
    maxTurns: 3,
    timeoutMs: 300_000,
  });
  const raw = (result.result ?? '').trim();
  const tryJson = (s: string): GeneratedLesson | null => {
    try {
      const p = JSON.parse(s) as Partial<GeneratedLesson>;
      if (typeof p.content !== 'string' || typeof p.estimatedReadMinutes !== 'number'
        || !Array.isArray(p.keyTakeaways)) return null;
      return {
        content: p.content,
        estimatedReadMinutes: p.estimatedReadMinutes,
        keyTakeaways: p.keyTakeaways.map(String),
      };
    } catch { return null; }
  };
  const direct = tryJson(raw);
  if (direct) return direct;
  const obj = raw.match(/\{[\s\S]*\}/);
  if (obj) {
    const fenced = tryJson(obj[0]);
    if (fenced) return fenced;
  }
  throw new Error(`Legacy lesson generator produced invalid JSON. First 300 chars: ${raw.slice(0, 300)}`);
}

function isLegacyEnabled(): boolean {
  const v = process.env.LEARN_LESSON_GENERATOR_LEGACY;
  return v === '1' || v === 'true' || v === 'yes';
}

// ---------------------------------------------------------------------------
// Public entry point — preserved signature.
// ---------------------------------------------------------------------------

export async function generateLessonAuto(
  sectionId: string,
  opts: GenerateLessonOpts = {},
): Promise<GenerateLessonResult> {
  if (isLegacyEnabled()) {
    // Legacy path is single-shot — emit a single 'composing' transition so
    // the UI gets one signal even on the legacy path.
    if (opts.onStage) { try { await opts.onStage('composing'); } catch { /* ignore */ } }
    const r = await generateLessonLegacy(sectionId);
    return { format: 'markdown', ...r };
  }
  const r = await generateLessonStructuredV3(sectionId, opts);
  return { format: 'structured', ...r };
}

// Re-exports for backwards compatibility with v0.2 callers (none in-tree
// today, but documented as public API in the original module).
export const generateLesson = generateLessonLegacy;
export const generateLessonStructured = generateLessonStructuredV3;

// Test-only exports — env-gated configuration and pure helpers.
export const __test = {
  loadWebSearchPolicy,
  envFlag,
  envInt,
  collectCitationUrls,
  shortUrlHash,
  allocateWebSearchBudget,
};
