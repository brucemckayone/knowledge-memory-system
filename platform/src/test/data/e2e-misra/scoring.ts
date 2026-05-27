/**
 * E2E MISRA Benchmark — Scoring scaffold
 *
 * Loaded by `platform/src/test/integration/e2e-misra-benchmark.test.ts`.
 *
 * Two scoring surfaces:
 *   1. Rule-citation hit (string-level) — fuzzy substring match on canonical
 *      rule ids (e.g. "MISRA-CPP-2023-Rule-22.3", "Rule 22.3", "R22.3") OR
 *      embedded forms of the rule topic against the agent answer text.
 *   2. Answer semantic similarity (vector-level) — cosine over nomic-embed
 *      vectors of expected vs actual answer text.
 *
 * Both surfaces are pure: they take strings + optional embedder, return a
 * deterministic number. The test wires real embeddings when ml-services is
 * available; when not, the scoring scaffold can still be unit-tested with
 * a stub embedder injected directly.
 *
 * Bead: nmemo-klv.7
 */

import { cosineSimilarity } from '../../setup.js';

/** A single curated query entry from queries.json. */
export interface BenchmarkQuery {
  id: string;
  category: string;
  snippet: string;
  question: string;
  expected_rule_citations: string[];
  expected_rule_topics: string[];
  ground_truth_answer: string;
}

/** Full corpus envelope, mirrors queries.json shape. */
export interface BenchmarkCorpus {
  name: string;
  version: string;
  purpose: string;
  corpus_anchor: {
    live_db: string;
    fixture: string;
  };
  scoring_protocol: {
    rule_citation: {
      kind: string;
      exact_threshold: number;
      fuzzy_threshold: number;
      semantic_threshold: number;
      fallback: string;
    };
    answer_semantic: {
      kind: string;
      model: string;
      dimensions: number;
      pass_threshold: number;
      rationale: string;
    };
    aggregate: {
      rule_hit_rate_pass: number;
      rule_hit_rate_target: number;
      answer_mean_cosine_pass: number;
      rationale: string;
    };
  };
  queries: BenchmarkQuery[];
}

/** Per-query result row. */
export interface QueryScore {
  id: string;
  category: string;
  /** Whether the agent answer cites at least one of the expected rules. */
  rule_citation_hit: boolean;
  /** Which expected rule citations were detected in the answer (canonical id form). */
  matched_rules: string[];
  /** Cosine similarity between expected and actual answer embeddings (null if no embedder). */
  answer_cosine: number | null;
  /** Per-query pass: rule hit OR (no expected rules AND no false-positive citation). */
  passed: boolean;
  /** Free-form notes (skip reason, embedder unavailable, etc). */
  notes?: string;
}

/** Aggregate report. */
export interface BenchmarkResult {
  total_queries: number;
  scored_queries: number;
  rule_hit_rate: number;
  answer_mean_cosine: number | null;
  passed: boolean;
  per_query: QueryScore[];
  thresholds: BenchmarkCorpus['scoring_protocol']['aggregate'];
  notes: string[];
}

/**
 * Embedder shape: any function (text) → Promise<number[]>. Lets us inject
 * the real ml-client.embed when live infra is available, or a stub for
 * scaffold tests.
 */
export type Embedder = (text: string) => Promise<number[]>;

/** Variants the agent might cite — all map to the same canonical id. */
function ruleAliases(canonicalId: string): string[] {
  // canonicalId is shaped "MISRA-CPP-2023-Rule-22.3"
  const m = /Rule[-_ ]?(\d+\.\d+)/i.exec(canonicalId);
  if (!m || !m[1]) return [canonicalId];
  const num: string = m[1];
  return [
    canonicalId,
    `Rule ${num}`,
    `Rule-${num}`,
    `rule ${num}`,
    `R${num}`,
    `r${num}`,
    `MISRA Rule ${num}`,
    `MISRA-CPP Rule ${num}`,
    `MISRA C++ Rule ${num}`,
    `MISRA-CPP-2023 Rule ${num}`,
    num,
  ];
}

/**
 * Detect which expected canonical rule ids appear in `answer`. Substring
 * match against any alias form. Returns the canonical ids (not the alias).
 */
export function detectRuleCitations(
  answer: string,
  expectedCanonicalIds: string[],
): string[] {
  const lower = answer.toLowerCase();
  const hits: string[] = [];
  for (const canonical of expectedCanonicalIds) {
    const aliases = ruleAliases(canonical).map(a => a.toLowerCase());
    if (aliases.some(a => lower.includes(a))) {
      hits.push(canonical);
    }
  }
  return hits;
}

/**
 * Detect any Chapter-22 rule id in the answer text — used for negative-control
 * queries (the agent should NOT cite a Chapter 22 rule when the snippet is
 * not Chapter 22). Returns the set of "Rule 22.X" tokens it spotted.
 */
export function detectAnyChapter22Citation(answer: string): string[] {
  const re = /(?:MISRA[- ]?(?:C\+\+)?(?:[- ]?2023)?[- ]?)?(?:Rule[- ]?)?R?(22\.\d+)/gi;
  const found = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = re.exec(answer)) !== null) {
    found.add(`MISRA-CPP-2023-Rule-${match[1]}`);
  }
  return [...found];
}

/**
 * Score one query against the agent's answer. If `embedder` is provided, also
 * compute answer cosine similarity vs expected answer.
 */
export async function scoreQuery(
  query: BenchmarkQuery,
  agentAnswer: string,
  embedder?: Embedder,
): Promise<QueryScore> {
  const matched = detectRuleCitations(agentAnswer, query.expected_rule_citations);
  let answer_cosine: number | null = null;
  if (embedder) {
    const [vExpected, vActual] = await Promise.all([
      embedder(query.ground_truth_answer),
      embedder(agentAnswer),
    ]);
    answer_cosine = cosineSimilarity(vExpected, vActual);
  }
  // Pass rules:
  //  - Q has expected citations: must match at least one.
  //  - Q has NO expected citations (negative control): must NOT cite any
  //    Chapter 22 rule.
  let passed: boolean;
  if (query.expected_rule_citations.length > 0) {
    passed = matched.length > 0;
  } else {
    passed = detectAnyChapter22Citation(agentAnswer).length === 0;
  }
  return {
    id: query.id,
    category: query.category,
    rule_citation_hit: matched.length > 0,
    matched_rules: matched,
    answer_cosine,
    passed,
  };
}

/**
 * Score the full benchmark corpus given an answerer (text-in, text-out
 * callable that wraps the platform's ingest → reasoning path) and an
 * optional embedder.
 *
 * The answerer is injected (not hard-wired) so tests can:
 *   - Wire it to invokeGraphAgent / invokeReasoningAgent when live infra
 *     is available, OR
 *   - Skip the live path entirely and document the deferred-runnable protocol
 *     when not.
 */
export async function runBenchmark(
  corpus: BenchmarkCorpus,
  answerer: (q: BenchmarkQuery) => Promise<string>,
  embedder?: Embedder,
): Promise<BenchmarkResult> {
  const per_query: QueryScore[] = [];
  for (const q of corpus.queries) {
    try {
      const ans = await answerer(q);
      const score = await scoreQuery(q, ans, embedder);
      per_query.push(score);
    } catch (err) {
      per_query.push({
        id: q.id,
        category: q.category,
        rule_citation_hit: false,
        matched_rules: [],
        answer_cosine: null,
        passed: false,
        notes: `answerer error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  const scoredQueriesWithExpected = per_query.filter((_p, i) =>
    corpus.queries[i] !== undefined && corpus.queries[i]!.expected_rule_citations.length > 0,
  );
  const rule_hit_rate =
    scoredQueriesWithExpected.length === 0
      ? 0
      : scoredQueriesWithExpected.filter(s => s.rule_citation_hit).length /
        scoredQueriesWithExpected.length;
  const cosines = per_query
    .map(p => p.answer_cosine)
    .filter((c): c is number => c !== null);
  const answer_mean_cosine =
    cosines.length === 0 ? null : cosines.reduce((a, b) => a + b, 0) / cosines.length;
  const t = corpus.scoring_protocol.aggregate;
  const ruleOk = rule_hit_rate >= t.rule_hit_rate_pass;
  const cosineOk =
    answer_mean_cosine === null ? true : answer_mean_cosine >= t.answer_mean_cosine_pass;
  return {
    total_queries: corpus.queries.length,
    scored_queries: per_query.length,
    rule_hit_rate,
    answer_mean_cosine,
    passed: ruleOk && cosineOk,
    per_query,
    thresholds: t,
    notes: [],
  };
}
