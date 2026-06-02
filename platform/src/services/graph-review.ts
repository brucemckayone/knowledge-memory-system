/**
 * Agent review of the graph + reports — LLM-as-judge (doc 39 §2.D, nmemo-hm4.7).
 *
 * The deterministic invariants ({@link InvariantReport}, graph-invariants.ts)
 * catch the MECHANICAL errors (Elena's 5 coexisting titles, Helix's dual HQ,
 * self-loops, dangling FKs). This module feeds a STRONG judge model the corpus +
 * the extracted graph (facts with valid_at/expired_at, causal edges with
 * reasoning + source refs, contradictions) + those same invariant findings + the
 * reports, and asks it to rule on the SEMANTIC dimensions the invariants cannot:
 * faithfulness, current-state correctness, supersession, causal justification
 * (does the reasoning match the source?), hallucinations, predicate consistency.
 * The model returns a STRUCTURED issue list per arm.
 *
 * IMPORTANT — import-clean by design. This module is unit-tested under
 * vitest.unit.config.ts (no DB, no infra), so it must have NO db/LLM side effects
 * at import time:
 *   - {@link RichGraph} / {@link InvariantReport} are imported TYPE-ONLY (erased
 *     at runtime);
 *   - the default judge-invoke does a DYNAMIC `await import('../config.js')`
 *     INSIDE the function body (config runs dotenv + process.exit on bad env), so
 *     nothing infra-bearing loads just by importing this file.
 * The two assembly/parse functions ({@link buildReviewPrompt} /
 * {@link parseReviewResponse}) are pure.
 */

import type { RichGraph } from './graph-canonical-query.js';
import type { InvariantReport } from './graph-invariants.js';

// ============================================
// Result shapes
// ============================================

/** The semantic dimensions the judge rules on (doc 39 §2.D). */
export type ReviewCategory =
  | 'faithfulness'
  | 'current_state'
  | 'supersession'
  | 'causal_justification'
  | 'hallucination'
  | 'predicate_consistency';

export type ReviewSeverity = 'low' | 'medium' | 'high';

/** Overall judge verdict; `uncertain` also covers a malformed/unparseable reply. */
export type ReviewVerdict = 'pass' | 'issues' | 'fail' | 'uncertain';

/** One structured issue the judge raised. */
export interface ReviewIssue {
  category: ReviewCategory;
  severity: ReviewSeverity;
  /** The entity/fact the issue is about (e.g. "Elena Vasquez", "Helix"). */
  subject?: string;
  detail: string;
  /** Verbatim source/graph snippet backing the issue, when the judge gives one. */
  evidence?: string;
}

export interface GraphReview {
  verdict: ReviewVerdict;
  issues: ReviewIssue[];
  /** The raw model text — retained on a parse failure for debugging. */
  raw?: string;
  /** Set (with verdict='uncertain') when {@link parseReviewResponse} could not parse the reply. */
  parseError?: string;
}

/** Inputs the judge sees: the corpus, the rich graph, the invariant findings, and (optionally) the reports. */
export interface ReviewInput {
  /** The authored source chunks. Omitted when only the graph is under review. */
  corpus?: string[];
  graph: RichGraph;
  invariants: InvariantReport;
  /** Any extra report material (extraction/reasoning/gardening) — rendered as JSON when present. */
  reports?: unknown;
}

export interface ReviewOptions {
  /** `provider/model` (e.g. "anthropic/claude-opus-4-8"); falls back to JUDGE_MODEL then {@link DEFAULT_JUDGE_MODEL}. */
  model?: string;
  /** Pi thinking/effort level: "off"|"minimal"|"low"|"medium"|"high"; falls back to JUDGE_THINKING then {@link DEFAULT_JUDGE_THINKING}. */
  thinking?: string;
  /** Override the model call — the unit-test seam (inject a fake; the real default hits the Pi bridge). */
  invoke?: (prompt: string, model: string, thinking: string) => Promise<string>;
}

/**
 * Default judge model. The STRONGEST model available, NOT the Haiku/GLM the
 * pipeline runs under: Haiku-first is a *pipeline* rule, and a judge must be less
 * noisy than what it grades (doc 39 §6 #2). `provider/model` form so a single
 * JUDGE_MODEL env var carries both; routes to Anthropic Opus 4.8 via the Pi bridge.
 */
export const DEFAULT_JUDGE_MODEL = 'anthropic/claude-opus-4-8';

/**
 * Default thinking/effort for the judge: "high" — the Pi bridge's MAX level
 * (the ladder is "off"|"minimal"|"low"|"medium"|"high"). A judge grading the
 * pipeline reasons at maximum effort. Override via JUDGE_THINKING or
 * {@link ReviewOptions.thinking}.
 */
export const DEFAULT_JUDGE_THINKING = 'high';

// ============================================
// Prompt assembly (pure)
// ============================================

/** Caps so a large graph can't blow the judge's context (doc 39 §2.D "cap very large graphs sensibly"). */
const MAX_ENTITIES = 120;
const MAX_FACTS = 400;
const MAX_EDGES = 120;
const MAX_CONTRADICTIONS = 80;
const MAX_INVARIANT_VIOLATIONS = 60;
const MAX_CORPUS_CHARS = 24_000;

const JUDGE_INSTRUCTIONS = `You are a strict knowledge-graph reviewer (an LLM judge). You are given the SOURCE TEXT a graph was built from, the EXTRACTED GRAPH (entities; active and expired facts; causal edges with their reasoning and source references; contradictions), and a set of DETERMINISTIC INVARIANT FINDINGS that already caught the mechanical errors. Your job is to judge the SEMANTIC quality the mechanical checks cannot.

Rule on these categories:
- faithfulness — does the graph faithfully represent the source (no invented or distorted claims)?
- current_state — for each exclusive attribute (a person's title/role, a company's HQ), is there exactly ONE correct active fact? Flag a subject that holds several conflicting active facts at once.
- supersession — when the source says a fact changed, is the old fact expired (expired_at / expire_reason set) and only the new one active?
- causal_justification — does each causal edge's reasoning actually match its source references and the source text?
- hallucination — entities/facts/edges with no support in the source.
- predicate_consistency — one logical relation expressed through many predicates (e.g. job_title vs title vs role_at vs cto_at all naming the same role) that defeats supersession.

Return STRICT JSON ONLY — no prose, no markdown, no code fences. Shape:
{
  "verdict": "pass" | "issues" | "fail" | "uncertain",
  "issues": [
    {
      "category": "faithfulness" | "current_state" | "supersession" | "causal_justification" | "hallucination" | "predicate_consistency",
      "severity": "low" | "medium" | "high",
      "subject": "<the entity/fact the issue is about, optional>",
      "detail": "<what is wrong>",
      "evidence": "<verbatim graph/source snippet, optional>"
    }
  ]
}
Use verdict "pass" when the graph is faithful and current-state-correct, "issues" for minor/moderate problems, "fail" for severe ones (e.g. mutually-exclusive facts held active at once), "uncertain" only when you cannot judge.`;

/** Stable, readable id stub so the judge can refer to a row without dumping full UUIDs. */
const shortId = (id: string): string => id.slice(0, 8);

const formatDate = (d: Date | null): string => {
  if (d == null) return '-';
  const t = d instanceof Date ? d : new Date(d as unknown as string);
  return Number.isNaN(t.getTime()) ? String(d) : t.toISOString().slice(0, 10);
};

/** `name (type)` for an entity id, falling back to the short id when unknown. */
function entityLabel(graph: RichGraph, id: string | null): string {
  if (id == null) return '-';
  const e = graph.entities.find((x) => x.id === id);
  return e ? `${e.name} (${e.type})` : shortId(id);
}

/** Render one fact as `subject :: predicate :: object` with its temporal window. */
function factLine(graph: RichGraph, f: RichGraph['facts'][number]): string {
  const subj = entityLabel(graph, f.subjectEntityId);
  const obj = f.objectEntityId != null ? entityLabel(graph, f.objectEntityId) : `"${f.objectValue ?? ''}"`;
  const valid = `valid_at=${formatDate(f.validAt)}`;
  const expired = f.expiredAt != null
    ? ` expired_at=${formatDate(f.expiredAt)} reason=${f.expireReason ?? '?'}`
    : '';
  return `${subj} :: ${f.predicate} :: ${obj} (${valid}${expired})`;
}

/** Summarise a single invariant report's failures (the mechanical findings the judge gets to see). */
function invariantSummary(invariants: InvariantReport): string[] {
  const lines: string[] = [];
  const { summary } = invariants;
  lines.push(`Invariants: ${summary.passed}/${summary.total} pass, ${summary.errorViolations} error rows.`);
  let shown = 0;
  for (const r of invariants.results) {
    if (r.pass) continue;
    lines.push(`- [${r.severity}] ${r.name}: ${r.description}`);
    for (const v of r.violations) {
      if (shown >= MAX_INVARIANT_VIOLATIONS) {
        lines.push('  - … (more violations omitted)');
        break;
      }
      lines.push(`  - ${v.detail}`);
      shown += 1;
    }
    if (shown >= MAX_INVARIANT_VIOLATIONS) break;
  }
  return lines;
}

/**
 * Assemble the judge prompt (pure). Summarises entities; ACTIVE and EXPIRED facts
 * (with valid_at/expired_at/expire_reason so supersession is visible); causal
 * edges with reasoning + source refs; contradictions; AND the deterministic
 * invariant findings. The offending facts are rendered VERBATIM so the judge can
 * see Elena holding multiple active titles and Helix having two active HQs. Then
 * instructs the judge to return the strict JSON issue list. Large graphs are
 * capped so the prompt stays bounded.
 */
export function buildReviewPrompt(input: ReviewInput): string {
  const { corpus, graph, invariants, reports } = input;
  const lines: string[] = [];

  lines.push(JUDGE_INSTRUCTIONS);
  lines.push('');

  // Source text (capped).
  if (corpus && corpus.length > 0) {
    lines.push('=== SOURCE TEXT ===');
    let used = 0;
    for (let i = 0; i < corpus.length; i += 1) {
      const chunk = corpus[i]!;
      if (used + chunk.length > MAX_CORPUS_CHARS) {
        lines.push(`[chunk ${i + 1}] (omitted — corpus truncated for length)`);
        break;
      }
      lines.push(`[chunk ${i + 1}] ${chunk}`);
      used += chunk.length;
    }
    lines.push('');
  }

  // Entities.
  lines.push(`=== ENTITIES (${graph.entities.length}) ===`);
  for (const e of graph.entities.slice(0, MAX_ENTITIES)) {
    const summary = e.summary ?? e.description ?? '';
    lines.push(`- ${e.name} [${e.type}]${summary ? ` — ${summary}` : ''}`);
  }
  if (graph.entities.length > MAX_ENTITIES) lines.push(`… and ${graph.entities.length - MAX_ENTITIES} more entities`);
  lines.push('');

  // Facts — split active vs expired so supersession is legible. Active facts are
  // the ones a current-state-correctness judgement turns on, so they go first and
  // verbatim (this is where Elena's 5 titles / Helix's 2 HQs surface).
  const active = graph.facts.filter((f) => f.expiredAt == null);
  const expired = graph.facts.filter((f) => f.expiredAt != null);
  lines.push(`=== ACTIVE FACTS (${active.length}) ===`);
  for (const f of active.slice(0, MAX_FACTS)) lines.push(`- ${factLine(graph, f)}`);
  if (active.length > MAX_FACTS) lines.push(`… and ${active.length - MAX_FACTS} more active facts`);
  lines.push('');

  lines.push(`=== EXPIRED / SUPERSEDED FACTS (${expired.length}) ===`);
  for (const f of expired.slice(0, MAX_FACTS)) lines.push(`- ${factLine(graph, f)}`);
  if (expired.length > MAX_FACTS) lines.push(`… and ${expired.length - MAX_FACTS} more expired facts`);
  lines.push('');

  // Causal edges with reasoning + source references (the causal-justification axis).
  lines.push(`=== CAUSAL EDGES (${graph.edges.length}) ===`);
  const eventLabel = (eventId: string): string => {
    const ev = graph.events.find((x) => x.id === eventId);
    if (!ev) return shortId(eventId);
    const subj = entityLabel(graph, ev.subjectEntityId);
    return `${subj}/${ev.predicate ?? ev.transitionType}`;
  };
  for (const edge of graph.edges.slice(0, MAX_EDGES)) {
    const refs = JSON.stringify(edge.sourceReferences);
    const status = edge.expiredAt != null ? ' [expired]' : '';
    lines.push(`- ${eventLabel(edge.causeEventId)} -> ${eventLabel(edge.effectEventId)}${status}`);
    lines.push(`    reasoning: ${edge.reasoning}`);
    lines.push(`    source_references: ${refs}`);
  }
  if (graph.edges.length > MAX_EDGES) lines.push(`… and ${graph.edges.length - MAX_EDGES} more edges`);
  lines.push('');

  // Contradictions (detection + resolution metadata).
  lines.push(`=== CONTRADICTIONS (${graph.contradictions.length}) ===`);
  for (const c of graph.contradictions.slice(0, MAX_CONTRADICTIONS)) {
    const resolved = c.resolvedAt != null ? `resolved(${c.resolutionType ?? '?'})` : 'unresolved';
    lines.push(`- [${c.contradictionType}] ${resolved} — ${c.detectionReasoning}`);
  }
  if (graph.contradictions.length > MAX_CONTRADICTIONS) {
    lines.push(`… and ${graph.contradictions.length - MAX_CONTRADICTIONS} more contradictions`);
  }
  lines.push('');

  // Deterministic invariant findings — the mechanical errors, so the judge can
  // focus on the semantic ones (doc 39 §2.D pairing with §2.C).
  lines.push('=== DETERMINISTIC INVARIANT FINDINGS ===');
  lines.push(...invariantSummary(invariants));
  lines.push('');

  // Optional extra report material.
  if (reports !== undefined) {
    lines.push('=== AGENT REPORTS ===');
    let json: string;
    try {
      json = JSON.stringify(reports, null, 2);
    } catch {
      json = String(reports);
    }
    lines.push(json.length > MAX_CORPUS_CHARS ? `${json.slice(0, MAX_CORPUS_CHARS)}\n… (reports truncated)` : json);
    lines.push('');
  }

  lines.push('Now return the strict JSON verdict + issue list.');
  return lines.join('\n');
}

// ============================================
// Response parsing (pure, tolerant)
// ============================================

const VALID_CATEGORIES = new Set<ReviewCategory>([
  'faithfulness',
  'current_state',
  'supersession',
  'causal_justification',
  'hallucination',
  'predicate_consistency',
]);
const VALID_SEVERITIES = new Set<ReviewSeverity>(['low', 'medium', 'high']);
const VALID_VERDICTS = new Set<ReviewVerdict>(['pass', 'issues', 'fail', 'uncertain']);

/**
 * Extract the first balanced top-level JSON object from a string, tolerating
 * surrounding prose and ```json fences. Brace-counts so a `{...}` nested inside
 * the object doesn't end the scan early; ignores braces inside double-quoted
 * strings (respecting backslash escapes). Returns null when no object is found.
 */
function extractFirstJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

/** Coerce one raw issue object into a {@link ReviewIssue}, or null when it isn't shaped like one. */
function coerceIssue(value: unknown): ReviewIssue | null {
  if (value == null || typeof value !== 'object') return null;
  const o = value as Record<string, unknown>;
  const category = o.category;
  const severity = o.severity;
  const detail = o.detail;
  if (typeof category !== 'string' || !VALID_CATEGORIES.has(category as ReviewCategory)) return null;
  if (typeof detail !== 'string' || detail.trim() === '') return null;
  const sev: ReviewSeverity = typeof severity === 'string' && VALID_SEVERITIES.has(severity as ReviewSeverity)
    ? (severity as ReviewSeverity)
    : 'medium';
  const issue: ReviewIssue = { category: category as ReviewCategory, severity: sev, detail };
  if (typeof o.subject === 'string' && o.subject.trim() !== '') issue.subject = o.subject;
  if (typeof o.evidence === 'string' && o.evidence.trim() !== '') issue.evidence = o.evidence;
  return issue;
}

/**
 * Tolerant parse of a judge reply (pure). Extracts the first JSON object (handles
 * code fences / surrounding prose), validates the shape, and keeps only
 * well-formed issues. On any failure (no JSON, bad JSON, wrong shape) returns
 * `{ verdict: 'uncertain', issues: [], raw, parseError }` — never throws. An
 * out-of-range/absent verdict with valid issues degrades to 'issues' (or 'pass'
 * when there are none) rather than discarding the parse.
 */
export function parseReviewResponse(raw: string): GraphReview {
  const json = extractFirstJsonObject(raw);
  if (json == null) {
    return { verdict: 'uncertain', issues: [], raw, parseError: 'no JSON object found in response' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    return {
      verdict: 'uncertain',
      issues: [],
      raw,
      parseError: `JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (parsed == null || typeof parsed !== 'object') {
    return { verdict: 'uncertain', issues: [], raw, parseError: 'parsed value is not an object' };
  }
  const obj = parsed as Record<string, unknown>;

  const rawIssues = Array.isArray(obj.issues) ? obj.issues : [];
  const issues = rawIssues.map(coerceIssue).filter((x): x is ReviewIssue => x != null);

  let verdict: ReviewVerdict;
  if (typeof obj.verdict === 'string' && VALID_VERDICTS.has(obj.verdict as ReviewVerdict)) {
    verdict = obj.verdict as ReviewVerdict;
  } else {
    // No usable verdict, but the issue list parsed — infer rather than discard.
    verdict = issues.length > 0 ? 'issues' : 'pass';
  }
  return { verdict, issues };
}

// ============================================
// Infra entry point
// ============================================

/**
 * Default model invocation: POST the prompt to the Pi agent bridge `/run`
 * endpoint (the codebase's path to a SELECTABLE provider/model — the
 * `mlJudge` seed's `/chat` is fixed-model). Mirrors the `mlJudge` shape: send a
 * system prompt + the assembled user prompt, read the model's text out of the
 * JSON response. The LLM client (config) is loaded via DYNAMIC import here so the
 * module stays import-clean for the unit tests.
 *
 * `model` is `provider/model`; the leading `provider/` selects the Pi provider
 * and the remainder is the model id. A bare model (no `/`) defaults to provider
 * `anthropic`.
 */
async function defaultInvoke(prompt: string, model: string, thinking: string): Promise<string> {
  const { config } = await import('../config.js');
  const slash = model.indexOf('/');
  const provider = slash > 0 ? model.slice(0, slash) : 'anthropic';
  const modelId = slash > 0 ? model.slice(slash + 1) : model;
  const bridgeUrl = process.env.PI_BRIDGE_URL ?? 'http://localhost:3099';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.REASONING_AGENT_TIMEOUT_MS);
  try {
    const res = await fetch(`${bridgeUrl}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        system_prompt: 'You are a strict knowledge-graph reviewer. Return strict JSON only.',
        provider,
        model: modelId,
        thinking,
        actor: 'reasoning_agent',
        timeout: Math.floor(config.REASONING_AGENT_TIMEOUT_MS / 1000),
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`graph-review judge call failed (${res.status}): ${detail}`);
    }
    const data = (await res.json()) as { result?: string; error?: string };
    if (data.error) throw new Error(`graph-review judge error: ${data.error}`);
    return data.result ?? '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the agent review over a graph + invariants (+ optional corpus/reports).
 * Resolves the judge model (opts.model → JUDGE_MODEL env → {@link DEFAULT_JUDGE_MODEL},
 * Opus 4.8) and thinking level (opts.thinking → JUDGE_THINKING env →
 * {@link DEFAULT_JUDGE_THINKING}, "high") and the invoker (opts.invoke →
 * {@link defaultInvoke}), then returns the parsed verdict + issue list. Inject
 * `opts.invoke` to test without a live judge.
 */
export async function reviewGraph(input: ReviewInput, opts: ReviewOptions = {}): Promise<GraphReview> {
  const model = opts.model ?? process.env.JUDGE_MODEL ?? DEFAULT_JUDGE_MODEL;
  const thinking = opts.thinking ?? process.env.JUDGE_THINKING ?? DEFAULT_JUDGE_THINKING;
  const invoke = opts.invoke ?? defaultInvoke;
  const raw = await invoke(buildReviewPrompt(input), model, thinking);
  return parseReviewResponse(raw);
}
