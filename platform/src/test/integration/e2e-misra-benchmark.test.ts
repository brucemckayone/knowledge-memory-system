/**
 * E2E MISRA Benchmark — bead nmemo-klv.7
 *
 * Acceptance (from .klv.7 description):
 *   - Benchmark queries JSON
 *   - Expected rule citations documented
 *   - Semantic similarity scoring functional
 *
 * What this test wires:
 *   (1) Loads platform/src/test/data/e2e-misra/queries.json, validates schema
 *       invariants on every query entry.
 *   (2) Unit-exercises the scoring scaffold end-to-end against a deterministic
 *       stub answerer + stub embedder — this is the "scoring functional"
 *       acceptance bullet, independent of live infra.
 *   (3) A skipped-by-default "live run" describe block that, when enabled, runs
 *       the curated queries through the platform's ingest → reasoning path
 *       (ml-services /reasoning-agent over the live cognitive DB carrying the
 *       MISRA/AUTOSAR/C++ technical-standards corpus) and scores against
 *       ground truth. The block self-skips when ml-services is not reachable,
 *       and the file's header documents the protocol for re-running it live.
 *
 * Deferred-runnable protocol (mirrors nmemo-2yv.108's pattern):
 *   When ml-services is up and the live cognitive DB carries the MISRA corpus,
 *   set MISRA_BENCHMARK_LIVE=1 and re-run this file. The live block writes a
 *   dated benchmark report under
 *   platform/src/test/data/e2e-misra/benchmark-reports/ capturing per-query
 *   rule-hit + answer-cosine + aggregate verdict. See
 *   platform/src/test/data/e2e-misra/benchmark-reports/2026-05-27-klv7-closure.md
 *   for the closure report + protocol details.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { isMLServiceAvailable, ML_SERVICES_URL } from '../setup.js';
import {
  type BenchmarkCorpus,
  type BenchmarkQuery,
  detectRuleCitations,
  detectAnyChapter22Citation,
  scoreQuery,
  runBenchmark,
} from '../data/e2e-misra/scoring.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CORPUS_PATH = resolve(
  __dirname,
  '..',
  'data',
  'e2e-misra',
  'queries.json',
);

function loadCorpus(): BenchmarkCorpus {
  const raw = readFileSync(CORPUS_PATH, 'utf-8');
  return JSON.parse(raw) as BenchmarkCorpus;
}

describe('E2E MISRA benchmark — queries corpus schema (klv.7 acceptance)', () => {
  let corpus: BenchmarkCorpus;

  beforeAll(() => {
    corpus = loadCorpus();
  });

  it('corpus loads + carries required top-level fields', () => {
    expect(corpus.name).toBe('e2e-misra-benchmark');
    expect(corpus.version).toBeTruthy();
    expect(corpus.purpose).toMatch(/MISRA/i);
    expect(corpus.corpus_anchor.fixture).toMatch(/misra-chapter-impact\.sql/);
    expect(corpus.queries.length).toBeGreaterThanOrEqual(6);
  });

  it('scoring protocol thresholds are sane', () => {
    const a = corpus.scoring_protocol.aggregate;
    expect(a.rule_hit_rate_pass).toBeGreaterThan(0);
    expect(a.rule_hit_rate_pass).toBeLessThanOrEqual(1);
    expect(a.rule_hit_rate_target).toBeGreaterThanOrEqual(a.rule_hit_rate_pass);
    expect(a.answer_mean_cosine_pass).toBeGreaterThan(0);
    expect(a.answer_mean_cosine_pass).toBeLessThan(1);
    expect(corpus.scoring_protocol.answer_semantic.dimensions).toBe(768);
  });

  it('every query has the required fields', () => {
    for (const q of corpus.queries) {
      expect(q.id, `query ${q.id} missing id`).toBeTruthy();
      expect(q.category, `query ${q.id} missing category`).toBeTruthy();
      expect(q.snippet, `query ${q.id} missing snippet`).toBeTruthy();
      expect(q.question, `query ${q.id} missing question`).toBeTruthy();
      expect(
        Array.isArray(q.expected_rule_citations),
        `query ${q.id} expected_rule_citations must be array`,
      ).toBe(true);
      expect(
        Array.isArray(q.expected_rule_topics),
        `query ${q.id} expected_rule_topics must be array`,
      ).toBe(true);
      expect(
        q.ground_truth_answer.length,
        `query ${q.id} ground_truth_answer too short`,
      ).toBeGreaterThan(40);
    }
  });

  it('at least one negative-control query exists', () => {
    const neg = corpus.queries.filter(q => q.expected_rule_citations.length === 0);
    expect(neg.length).toBeGreaterThanOrEqual(1);
  });

  it('positive queries cite rules that exist in the L3 chapter-22 fixture', () => {
    // The L3 fixture carries 10 rules R22.1..R22.10 (see
    // misra-chapter-impact.sql). Positive queries should cite from this set
    // so that, when the live cognitive DB is not loaded, the chapter-22
    // fixture alone is sufficient seed for the agent to reason from.
    const fixtureRules = new Set(
      Array.from({ length: 10 }, (_, i) => `MISRA-CPP-2023-Rule-22.${i + 1}`),
    );
    for (const q of corpus.queries) {
      if (q.expected_rule_citations.length === 0) continue;
      for (const cite of q.expected_rule_citations) {
        expect(
          fixtureRules.has(cite),
          `query ${q.id} cites ${cite} which is not in the L3 chapter-22 fixture`,
        ).toBe(true);
      }
    }
  });
});

describe('E2E MISRA benchmark — scoring scaffold (klv.7 acceptance: scoring functional)', () => {
  const STUB_DIM = 8;

  /** Deterministic embedder: hash the text into a fixed-length vector.
   *  Same text → same vector; similar text → similar vector. */
  function stubEmbedder(): (text: string) => Promise<number[]> {
    return async (text: string) => {
      const vec = new Array(STUB_DIM).fill(0);
      for (let i = 0; i < text.length; i++) {
        vec[i % STUB_DIM] += text.charCodeAt(i);
      }
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
      return norm === 0 ? vec : vec.map(v => v / norm);
    };
  }

  it('detectRuleCitations matches canonical id + Rule N.M + R22.X forms', () => {
    const expected = ['MISRA-CPP-2023-Rule-22.3'];
    expect(detectRuleCitations('Rule 22.3 forbids raw pointers', expected)).toEqual(expected);
    expect(detectRuleCitations('See R22.3 in the chapter', expected)).toEqual(expected);
    expect(detectRuleCitations('MISRA-CPP-2023-Rule-22.3 applies', expected)).toEqual(expected);
    expect(detectRuleCitations('Rule 22.99 unrelated', expected)).toEqual([]);
  });

  it('detectAnyChapter22Citation catches any Rule 22.X mention (negative control)', () => {
    expect(detectAnyChapter22Citation('Rule 22.6 forbids pointer arith')).toContain(
      'MISRA-CPP-2023-Rule-22.6',
    );
    expect(detectAnyChapter22Citation('Generic warning, no rule')).toEqual([]);
    expect(detectAnyChapter22Citation('See Rule 18.4 elsewhere')).toEqual([]);
  });

  it('scoreQuery returns rule_citation_hit + answer_cosine for a positive query', async () => {
    const q: BenchmarkQuery = {
      id: 'unit-Q',
      category: 'unit',
      snippet: 'new int(42); // leak',
      question: 'which rule?',
      expected_rule_citations: ['MISRA-CPP-2023-Rule-22.3'],
      expected_rule_topics: ['smart_pointer_usage'],
      ground_truth_answer: 'Use std::unique_ptr to satisfy Rule 22.3.',
    };
    const answer = 'This violates MISRA-CPP-2023-Rule-22.3; use std::unique_ptr instead.';
    const s = await scoreQuery(q, answer, stubEmbedder());
    expect(s.rule_citation_hit).toBe(true);
    expect(s.matched_rules).toEqual(['MISRA-CPP-2023-Rule-22.3']);
    expect(s.answer_cosine).toBeGreaterThan(0.5);
    expect(s.passed).toBe(true);
  });

  it('scoreQuery fails a positive query when answer cites the wrong rule', async () => {
    const q: BenchmarkQuery = {
      id: 'unit-Q-miss',
      category: 'unit',
      snippet: 'snippet',
      question: 'which rule?',
      expected_rule_citations: ['MISRA-CPP-2023-Rule-22.3'],
      expected_rule_topics: ['smart_pointer_usage'],
      ground_truth_answer: 'Rule 22.3 says use smart pointers.',
    };
    const s = await scoreQuery(q, 'This is about Rule 5.0 (unrelated).', stubEmbedder());
    expect(s.rule_citation_hit).toBe(false);
    expect(s.passed).toBe(false);
  });

  it('scoreQuery passes a negative-control query when no Chapter 22 rule is cited', async () => {
    const q: BenchmarkQuery = {
      id: 'unit-Q-neg',
      category: 'unit-neg',
      snippet: 'int x;',
      question: 'is this chapter 22?',
      expected_rule_citations: [],
      expected_rule_topics: [],
      ground_truth_answer: 'No, this is an uninitialised-variable concern, not Chapter 22.',
    };
    const ans = 'This is about an uninitialised local; it is outside Chapter 22 Resource Management.';
    const s = await scoreQuery(q, ans, stubEmbedder());
    expect(s.passed).toBe(true);
  });

  it('scoreQuery fails a negative-control query when the agent falsely cites Chapter 22', async () => {
    const q: BenchmarkQuery = {
      id: 'unit-Q-neg-false',
      category: 'unit-neg',
      snippet: 'int x;',
      question: 'is this chapter 22?',
      expected_rule_citations: [],
      expected_rule_topics: [],
      ground_truth_answer: 'No.',
    };
    const s = await scoreQuery(
      q,
      'This violates MISRA C++ Rule 22.5 (dangling pointer).',
      stubEmbedder(),
    );
    expect(s.passed).toBe(false);
  });

  it('runBenchmark aggregates rule-hit rate + mean cosine + verdict', async () => {
    const corpus = loadCorpus();
    // Stub answerer: for positive queries, echo the canonical rule + ground
    // truth (perfect score). For negative queries, return a non-chapter-22
    // explanation.
    const answerer = async (q: BenchmarkQuery): Promise<string> => {
      if (q.expected_rule_citations.length === 0) {
        return 'This is not a Chapter 22 concern. The relevant rule lives elsewhere in MISRA.';
      }
      return `Violates ${q.expected_rule_citations[0]}. ${q.ground_truth_answer}`;
    };
    const result = await runBenchmark(corpus, answerer, stubEmbedder());
    expect(result.total_queries).toBe(corpus.queries.length);
    expect(result.rule_hit_rate).toBe(1); // every positive query hits
    expect(result.answer_mean_cosine).not.toBeNull();
    expect(result.passed).toBe(true);
  });

  it('runBenchmark verdict flips to fail when the answerer always returns junk', async () => {
    const corpus = loadCorpus();
    const answerer = async (): Promise<string> => 'I do not know.';
    const result = await runBenchmark(corpus, answerer, stubEmbedder());
    expect(result.rule_hit_rate).toBe(0);
    expect(result.passed).toBe(false);
  });
});

/**
 * Live block — runs the actual platform reasoning path against the live
 * cognitive DB. Skipped by default; opt in with MISRA_BENCHMARK_LIVE=1.
 *
 * When enabled, the block:
 *   - Verifies ml-services + reasoning-agent reachable.
 *   - For each query, calls invokeReasoningAgent({ mode: 'query', question }).
 *   - Scores against ground truth with real nomic-embed-text vectors via
 *     the platform's ml.embed.
 *   - Asserts the aggregate verdict.
 *
 * If MISRA_BENCHMARK_LIVE is unset, the block self-skips and the deferred-
 * runnable protocol applies (see file header + 2026-05-27-klv7-closure.md).
 */
describe('E2E MISRA benchmark — live run (gated by MISRA_BENCHMARK_LIVE=1)', () => {
  const liveOptIn = process.env.MISRA_BENCHMARK_LIVE === '1';
  let mlAvailable = false;

  beforeAll(async () => {
    if (!liveOptIn) return;
    mlAvailable = await isMLServiceAvailable();
    if (!mlAvailable) {
      // eslint-disable-next-line no-console
      console.warn(
        `[e2e-misra-benchmark] MISRA_BENCHMARK_LIVE=1 set but ml-services unreachable at ${ML_SERVICES_URL}. Block will be skipped. Bring up ml-services (cd ml-services && make ml) and re-run.`,
      );
    }
  });

  it('runs benchmark end-to-end against ml-services /reasoning-agent', async (ctx) => {
    if (!liveOptIn) {
      ctx.skip();
      return;
    }
    if (!mlAvailable) {
      ctx.skip();
      return;
    }
    const corpus = loadCorpus();
    const { invokeReasoningAgent } = await import('../../services/reasoning-agent.js');
    const { ml } = await import('../../services/ml-client.js');
    const embedder = async (text: string): Promise<number[]> => {
      const { vector } = await ml.embed(text);
      return vector;
    };
    const answerer = async (q: BenchmarkQuery): Promise<string> => {
      const prompt = `Source C++ snippet:\n\`\`\`cpp\n${q.snippet}\n\`\`\`\n\n${q.question}`;
      const result = await invokeReasoningAgent({ mode: 'query', question: prompt });
      return result.result;
    };
    const benchmark = await runBenchmark(corpus, answerer, embedder);
    // eslint-disable-next-line no-console
    console.log('[e2e-misra-benchmark] live result:', JSON.stringify(benchmark, null, 2));
    expect(benchmark.rule_hit_rate).toBeGreaterThanOrEqual(
      benchmark.thresholds.rule_hit_rate_pass,
    );
    if (benchmark.answer_mean_cosine !== null) {
      expect(benchmark.answer_mean_cosine).toBeGreaterThanOrEqual(
        benchmark.thresholds.answer_mean_cosine_pass,
      );
    }
  }, 600_000);
});
