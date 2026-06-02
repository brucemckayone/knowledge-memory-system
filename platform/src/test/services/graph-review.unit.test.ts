/**
 * Unit tests for the agent-review LLM-judge module (doc 39 §2.D, nmemo-hm4.7).
 *
 * PURE — runs under vitest.unit.config.ts (NO DB, NO globalSetup, NO live LLM).
 * The infra path (the model call) is injected via `opts.invoke`, so nothing here
 * touches the network. Fixtures are hand-built partial {@link RichGraph}s
 * (cast `as RichGraph`) carrying the headline failure: Elena holding 5 active
 * title facts (job_title / title / role / cto_at) and Helix `headquartered_in`
 * BOTH boston AND austin — the same semantic errors the live judge is meant to
 * catch. These tests prove the assembly + parse + surfacing mechanism; the LIVE
 * judge is what actually generates the issue list at benchmark time.
 */

import { describe, it, expect } from 'vitest';
import type { RichGraph } from '../../services/graph-canonical-query.js';
import type { InvariantReport } from '../../services/graph-invariants.js';
import {
  buildReviewPrompt,
  parseReviewResponse,
  reviewGraph,
  DEFAULT_JUDGE_MODEL,
} from '../../services/graph-review.js';

// ---- fixture builders ---------------------------------------------------

type Fact = RichGraph['facts'][number];

let seq = 0;
const id = (p: string): string => `${p}-${(seq += 1).toString().padStart(4, '0')}`;

function fact(partial: Partial<Fact> & Pick<Fact, 'subjectEntityId' | 'predicate'>): Fact {
  return {
    id: id('fact'),
    objectEntityId: null,
    objectValue: null,
    confidence: 0.9,
    validAt: null,
    invalidAt: null,
    createdAt: new Date('2026-01-01'),
    expiredAt: null,
    expireReason: null,
    sourceMemoryId: null,
    ...partial,
  } as Fact;
}

function entity(eid: string, name = eid, type = 'person'): RichGraph['entities'][number] {
  return {
    id: eid,
    name,
    type,
    description: null,
    summary: null,
    mergedFrom: null,
    confidence: 0.9,
    createdAt: new Date('2026-01-01'),
  };
}

/** Assemble a RichGraph from parts; unspecified collections default to empty. */
function graph(parts: Partial<RichGraph>): RichGraph {
  return {
    entities: [],
    facts: [],
    events: [],
    edges: [],
    sameAs: [],
    contradictions: [],
    reports: { extraction: [], gardening: [], reasoning: [] },
    counts: {} as RichGraph['counts'],
    ...parts,
  } as RichGraph;
}

const PASS_INVARIANTS: InvariantReport = {
  results: [],
  summary: { total: 5, passed: 5, failed: 0, errorViolations: 0 },
};

/**
 * The headline-bug graph: Elena holds 5 active role/title facts and Helix is
 * headquartered in both Boston and Austin (the active-conflict the judge must
 * see verbatim).
 */
function brokenGraph(): RichGraph {
  const elena = 'elena';
  const helix = 'helix';
  const titles: Array<[string, string]> = [
    ['job_title', 'junior software engineer'],
    ['title', 'senior engineer'],
    ['role', 'engineering lead'],
    ['cto_at', 'chief technology officer'],
    ['title', 'cto'],
  ];
  const titleFacts = titles.map(([pred, val]) =>
    fact({ subjectEntityId: elena, predicate: pred, objectValue: val }),
  );
  const hqFacts = [
    fact({ subjectEntityId: helix, predicate: 'headquartered_in', objectValue: 'Boston' }),
    fact({ subjectEntityId: helix, predicate: 'headquartered_in', objectValue: 'Austin' }),
  ];
  return graph({
    entities: [entity(elena, 'Elena Vasquez'), entity(helix, 'Helix', 'company')],
    facts: [...titleFacts, ...hqFacts],
  });
}

// ---- buildReviewPrompt --------------------------------------------------

describe('buildReviewPrompt', () => {
  const prompt = buildReviewPrompt({
    corpus: ['Elena was promoted over the years.', 'Helix moved from Boston to Austin.'],
    graph: brokenGraph(),
    invariants: PASS_INVARIANTS,
  });

  it('includes the offending active facts verbatim (Elena titles + Helix HQs)', () => {
    // Elena's conflicting titles must appear so a judge can see the conflict.
    expect(prompt).toContain('chief technology officer');
    expect(prompt).toContain('junior software engineer');
    expect(prompt).toContain('senior engineer');
    // Helix's two active HQs.
    expect(prompt).toContain('Boston');
    expect(prompt).toContain('Austin');
    // subjects named.
    expect(prompt).toContain('Elena Vasquez');
    expect(prompt).toContain('Helix');
  });

  it('asks for the strict JSON verdict + issue schema with all six categories', () => {
    expect(prompt).toContain('STRICT JSON');
    expect(prompt).toMatch(/"verdict"/);
    expect(prompt).toMatch(/"issues"/);
    for (const cat of [
      'faithfulness',
      'current_state',
      'supersession',
      'causal_justification',
      'hallucination',
      'predicate_consistency',
    ]) {
      expect(prompt).toContain(cat);
    }
  });

  it('shows the deterministic invariant findings so the judge focuses on semantics', () => {
    expect(prompt).toContain('DETERMINISTIC INVARIANT FINDINGS');
    expect(prompt).toContain('5/5 pass');
  });

  it('renders the source text and active-vs-expired fact split', () => {
    expect(prompt).toContain('SOURCE TEXT');
    expect(prompt).toContain('Helix moved from Boston to Austin.');
    expect(prompt).toContain('ACTIVE FACTS');
    expect(prompt).toContain('EXPIRED / SUPERSEDED FACTS');
  });
});

// ---- parseReviewResponse ------------------------------------------------

/** A representative judge reply: fenced JSON naming Elena's titles + Helix's HQ. */
const JUDGE_REPLY = `Here is my assessment.

\`\`\`json
{
  "verdict": "fail",
  "issues": [
    {
      "category": "current_state",
      "severity": "high",
      "subject": "Elena Vasquez",
      "detail": "Elena holds 5 active title facts at once (junior software engineer, senior engineer, engineering lead, chief technology officer, cto) — only one can be current.",
      "evidence": "job_title=junior software engineer; title=cto"
    },
    {
      "category": "supersession",
      "severity": "high",
      "subject": "Helix",
      "detail": "Helix is headquartered_in both Boston and Austin simultaneously; the Boston fact should be expired after the move.",
      "evidence": "headquartered_in Boston / headquartered_in Austin"
    },
    {
      "category": "predicate_consistency",
      "severity": "medium",
      "subject": "Elena Vasquez",
      "detail": "job_title, title, role and cto_at all express the same logical role."
    }
  ]
}
\`\`\`

That concludes the review.`;

describe('parseReviewResponse', () => {
  it('parses a fenced JSON reply with the correct verdict, categories and subjects', () => {
    const review = parseReviewResponse(JUDGE_REPLY);
    expect(review.verdict).toBe('fail');
    expect(review.parseError).toBeUndefined();
    expect(review.issues).toHaveLength(3);

    const currentState = review.issues.find((i) => i.category === 'current_state');
    expect(currentState).toBeDefined();
    expect(currentState!.subject).toBe('Elena Vasquez');
    expect(currentState!.severity).toBe('high');
    expect(currentState!.detail).toContain('chief technology officer');

    const supersession = review.issues.find((i) => i.category === 'supersession');
    expect(supersession).toBeDefined();
    expect(supersession!.subject).toBe('Helix');
    expect(supersession!.detail).toMatch(/Boston/);
    expect(supersession!.detail).toMatch(/Austin/);

    expect(review.issues.some((i) => i.category === 'predicate_consistency')).toBe(true);
  });

  it('parses a bare (unfenced) JSON object embedded in prose', () => {
    const raw = 'verdict below {"verdict":"issues","issues":[{"category":"hallucination","severity":"low","detail":"minor"}]} done';
    const review = parseReviewResponse(raw);
    expect(review.verdict).toBe('issues');
    expect(review.issues).toHaveLength(1);
    expect(review.issues[0]!.category).toBe('hallucination');
  });

  it('drops malformed issues but keeps well-formed ones', () => {
    const raw = JSON.stringify({
      verdict: 'issues',
      issues: [
        { category: 'not_a_category', severity: 'high', detail: 'bogus' }, // bad category → dropped
        { category: 'faithfulness', detail: 'no severity → defaults to medium' },
        { category: 'hallucination', severity: 'high' }, // missing detail → dropped
      ],
    });
    const review = parseReviewResponse(raw);
    expect(review.issues).toHaveLength(1);
    expect(review.issues[0]!.category).toBe('faithfulness');
    expect(review.issues[0]!.severity).toBe('medium');
  });

  it('returns verdict=uncertain + parseError on a malformed (non-JSON) reply, without throwing', () => {
    const review = parseReviewResponse('the judge is thinking out loud and never emits JSON');
    expect(review.verdict).toBe('uncertain');
    expect(review.issues).toEqual([]);
    expect(review.parseError).toBeTruthy();
    expect(review.raw).toContain('thinking out loud');
  });

  it('returns verdict=uncertain + parseError on broken JSON syntax', () => {
    const review = parseReviewResponse('{ "verdict": "fail", "issues": [ { "category": ');
    expect(review.verdict).toBe('uncertain');
    expect(review.parseError).toBeTruthy();
  });
});

// ---- reviewGraph (injected fake invoke) ---------------------------------

describe('reviewGraph', () => {
  it('surfaces the Elena/HQ issues end-to-end via an injected fake invoke', async () => {
    // The injected invoke stands in for the live judge. The live judge GENERATES
    // this reply from the prompt; here we assert the assemble→invoke→parse→surface
    // wiring carries the Elena/HQ semantic issues through to the GraphReview.
    let seenPrompt = '';
    const fakeInvoke = async (prompt: string): Promise<string> => {
      seenPrompt = prompt;
      return JUDGE_REPLY;
    };

    const review = await reviewGraph(
      { corpus: ['Elena timeline', 'Helix HQ move'], graph: brokenGraph(), invariants: PASS_INVARIANTS },
      { invoke: fakeInvoke },
    );

    // The prompt the fake saw carried the offending facts (so a real judge could see them too).
    expect(seenPrompt).toContain('chief technology officer');
    expect(seenPrompt).toContain('Boston');
    expect(seenPrompt).toContain('Austin');

    // The review carries the Elena current-state + Helix supersession issues.
    expect(review.verdict).toBe('fail');
    const elenaIssue = review.issues.find((i) => i.subject === 'Elena Vasquez' && i.category === 'current_state');
    const helixIssue = review.issues.find((i) => i.subject === 'Helix' && i.category === 'supersession');
    expect(elenaIssue).toBeDefined();
    expect(helixIssue).toBeDefined();
  });

  it('passes the resolved model (opts.model) through to invoke', async () => {
    let seenModel = '';
    const fakeInvoke = async (_prompt: string, model: string): Promise<string> => {
      seenModel = model;
      return '{"verdict":"pass","issues":[]}';
    };
    const review = await reviewGraph(
      { graph: brokenGraph(), invariants: PASS_INVARIANTS },
      { model: 'anthropic/claude-opus-4', invoke: fakeInvoke },
    );
    expect(seenModel).toBe('anthropic/claude-opus-4');
    expect(review.verdict).toBe('pass');
  });

  it('defaults to a STRONG judge model when none is given', async () => {
    let seenModel = '';
    const prevEnv = process.env.JUDGE_MODEL;
    delete process.env.JUDGE_MODEL;
    try {
      const fakeInvoke = async (_prompt: string, model: string): Promise<string> => {
        seenModel = model;
        return '{"verdict":"pass","issues":[]}';
      };
      await reviewGraph({ graph: brokenGraph(), invariants: PASS_INVARIANTS }, { invoke: fakeInvoke });
      expect(seenModel).toBe(DEFAULT_JUDGE_MODEL);
      // The default must be a strong model, not Haiku/GLM (doc 39 §6 #2).
      expect(seenModel.toLowerCase()).not.toContain('haiku');
      expect(seenModel.toLowerCase()).not.toContain('glm');
    } finally {
      if (prevEnv !== undefined) process.env.JUDGE_MODEL = prevEnv;
    }
  });

  it('a malformed judge reply yields verdict=uncertain (no throw)', async () => {
    const fakeInvoke = async (): Promise<string> => 'not json at all';
    const review = await reviewGraph({ graph: brokenGraph(), invariants: PASS_INVARIANTS }, { invoke: fakeInvoke });
    expect(review.verdict).toBe('uncertain');
    expect(review.parseError).toBeTruthy();
  });
});
