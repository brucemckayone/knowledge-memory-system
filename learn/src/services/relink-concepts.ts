import { eq } from 'drizzle-orm';
import { db, sections, questions } from '../db/index.js';
import { listEntities } from './nmemo-client.js';

export interface RelinkSectionResult {
  sectionId: string;
  title: string;
  before: number;
  after: number;
  matched: Array<{ id: string; label: string; hits: number }>;
  questionsBefore: number;
  questionsAfter: number;
}

export interface RelinkResult {
  courseId: string;
  graphNodes: number;
  sections: RelinkSectionResult[];
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with',
  'as', 'is', 'are', 'be', 'by', 'at', 'from', 'this', 'that', 'it',
  'its', 'into', 'how', 'what', 'why', 'when', 'where', 'which', 'who',
]);

const normalize = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();

const tokenize = (s: string) =>
  normalize(s).split(' ').filter(t => t.length >= 3 && !STOPWORDS.has(t));

// Word-boundary substring match on the normalised haystack. Cheap, surprisingly
// effective for concept labels that are 1-3 word noun phrases.
function labelHits(labelLC: string, haystackLC: string): number {
  if (!labelLC) return 0;
  const re = new RegExp(`(^|[^a-z0-9])${labelLC.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}([^a-z0-9]|$)`, 'g');
  return (haystackLC.match(re) ?? []).length;
}

// Fallback for very short labels (1 word) or when no substring hit: count
// token overlap. Helps catch labels like "embedding" inside "embedding-based
// reconciliation" already covered by substring, but also "valid time" vs
// "valid-time axis" where normalisation strips the hyphen on one side.
function tokenOverlapHits(labelTokens: Set<string>, haystackTokens: string[]): number {
  if (labelTokens.size === 0) return 0;
  let hit = 0;
  for (const t of haystackTokens) if (labelTokens.has(t)) hit++;
  // Require every label token to appear at least once for credit.
  return hit >= labelTokens.size ? 1 : 0;
}

const MAX_CONCEPTS_PER_SECTION = 12;
const MIN_LABEL_LEN = 3;

export async function relinkCourseConcepts(courseId: string): Promise<RelinkResult> {
  const secRows = await db.select().from(sections).where(eq(sections.courseId, courseId));

  const ents = await listEntities();
  const nodes = ents
    .filter(e => e.canonicalName && e.canonicalName.length >= MIN_LABEL_LEN)
    .map(e => {
      const labelLC = normalize(e.canonicalName);
      return { id: e.id, label: e.canonicalName, labelLC, tokens: new Set(tokenize(e.canonicalName)) };
    });

  const perSection: RelinkSectionResult[] = [];

  for (const sec of secRows) {
    let objectives: string[] = [];
    let takeaways: string[] = [];
    try { objectives = JSON.parse(sec.learningObjectives) as string[]; } catch { /* ignore */ }
    try { takeaways = sec.lessonKeyTakeaways ? JSON.parse(sec.lessonKeyTakeaways) as string[] : []; } catch { /* ignore */ }

    const haystackRaw = [
      sec.title,
      sec.description ?? '',
      objectives.join(' '),
      takeaways.join(' '),
      sec.lessonContent ?? '',
    ].join(' ');

    const haystackLC = normalize(haystackRaw);
    const haystackTokens = tokenize(haystackRaw);

    const scored = nodes.map(n => {
      const subHits = labelHits(n.labelLC, haystackLC);
      const tokHits = subHits > 0 ? 0 : tokenOverlapHits(n.tokens, haystackTokens);
      const hits = subHits + tokHits;
      return { id: n.id, label: n.label, labelLC: n.labelLC, hits };
    }).filter(x => x.hits > 0);

    // Prefer longer (more specific) labels when hit counts tie; suppress
    // shorter labels that are strictly contained in a longer one we also
    // matched (e.g. "graph" when we matched "graph s" too).
    scored.sort((a, b) => b.hits - a.hits || b.labelLC.length - a.labelLC.length);
    const kept: typeof scored = [];
    for (const cand of scored) {
      if (kept.some(k => k.labelLC.includes(cand.labelLC) && k.labelLC !== cand.labelLC)) continue;
      kept.push(cand);
      if (kept.length >= MAX_CONCEPTS_PER_SECTION) break;
    }

    let before: string[] = [];
    try { before = JSON.parse(sec.conceptEntityIds) as string[]; } catch { /* ignore */ }

    const after = kept.map(k => k.id);
    await db.update(sections)
      .set({ conceptEntityIds: JSON.stringify(after) })
      .where(eq(sections.id, sec.id));

    // Per-question concept resolution. Questions store a single
    // conceptEntityId; pick the best-matching node against the question
    // text, falling back to the section's top concept when nothing
    // specific scores. Only overwrites existing IDs when the question
    // row is null; preserves previously-resolved links.
    const qRows = await db.select().from(questions).where(eq(questions.sectionId, sec.id));
    const sectionFallbackId = kept[0]?.id ?? null;
    let questionsBefore = 0;
    let questionsAfter = 0;
    for (const q of qRows) {
      if (q.conceptEntityId) { questionsBefore++; questionsAfter++; continue; }
      const qHaystackRaw = [q.questionText, q.expectedAnswer ?? '', q.explanation ?? ''].join(' ');
      const qHaystackLC = normalize(qHaystackRaw);
      const qHaystackTokens = tokenize(qHaystackRaw);
      let best: { id: string; hits: number; labelLC: string } | null = null;
      for (const n of nodes) {
        const subHits = labelHits(n.labelLC, qHaystackLC);
        const tokHits = subHits > 0 ? 0 : tokenOverlapHits(n.tokens, qHaystackTokens);
        const hits = subHits + tokHits;
        if (hits === 0) continue;
        if (!best || hits > best.hits || (hits === best.hits && n.labelLC.length > best.labelLC.length)) {
          best = { id: n.id, hits, labelLC: n.labelLC };
        }
      }
      const chosen = best?.id ?? sectionFallbackId;
      if (chosen) {
        await db.update(questions).set({ conceptEntityId: chosen }).where(eq(questions.id, q.id));
        questionsAfter++;
      }
    }

    perSection.push({
      sectionId: sec.id,
      title: sec.title,
      before: before.length,
      after: after.length,
      matched: kept.map(k => ({ id: k.id, label: k.label, hits: k.hits })),
      questionsBefore,
      questionsAfter,
    });
  }

  return { courseId, graphNodes: nodes.length, sections: perSection };
}
