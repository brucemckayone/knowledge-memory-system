/**
 * Static-analysis guardrail (nmemo-2yv.35) — every state-mutating /api/*
 * handler in src/index.ts that invokes an audited mutation function MUST
 * pass an explicit `actor:` argument.
 *
 * Background:
 *   - audit.ts's recordFactChange / recordEdgeChange require `actor: Actor`
 *     at the TypeScript layer (the seven-actor union; no default).
 *   - Upstream services (applyConfidenceDecay, resolveContradiction,
 *     expireFact, invalidateFact, expireCausalEdge, reviseCausalEdge,
 *     createFact, createCausalEdge, updateFactConfidence, restoreFact)
 *     accept actor as a typed param; some default to 'system_trigger' or
 *     a similar fallback when omitted, which yields mis-attributed audit
 *     rows when the call originates from a manual REST trigger.
 *   - nmemo-2yv.33 caught the /api/decay case (actor was defaulting to
 *     'system_trigger'). This guardrail catches the same shape at the
 *     static-analysis level so new REST handlers don't ship without an
 *     explicit actor.
 *
 * What this test does:
 *   1. Read src/index.ts as text.
 *   2. Locate every `app.post|put|patch|delete('/api/...', async (c) => { ... })`
 *      handler body.
 *   3. Within each handler body, find every call to an audited mutation
 *      function from AUDITED_MUTATIONS.
 *   4. For each such call, scan the next ~30 lines (the call expression's
 *      argument block) for `actor:` followed by a string literal or the
 *      Actor type. If the literal `actor:` is missing, that's a violation.
 *
 * The check is intentionally token-level (not a full TS AST walk) so it
 * keeps a small, predictable surface area and doesn't pull in a parser
 * dependency. False positives are unlikely because audited mutation
 * function names are highly distinctive; false negatives (e.g., a handler
 * that builds an options object on a previous line) are bounded by the
 * paired-brace scan below.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_TS_PATH = join(__dirname, '..', '..', 'index.ts');

/**
 * Functions whose call chain ends in a fact_history / causal_edge_history
 * insert. Calls to these from inside an /api/* handler MUST pass an
 * explicit actor argument.
 *
 * Keep this list in sync with src/services/audit.ts (recordFactChange /
 * recordEdgeChange callsites) and src/services/{facts,causal,entities,
 * contradictions}.ts exports.
 */
const AUDITED_MUTATIONS = [
  'applyConfidenceDecay',
  'resolveContradiction',
  'expireFact',
  'invalidateFact',
  'updateFactConfidence',
  'restoreFact',
  'createFact',
  'expireCausalEdge',
  'reviseCausalEdge',
  'createCausalEdge',
  'recordFactChange',
  'recordEdgeChange',
] as const;

interface HandlerMatch {
  routeMethod: string;
  routePath: string;
  startLine: number;
  endLine: number;
  body: string;
}

/**
 * Extract every `app.<method>('<route>', async (c) => { ... })` handler in
 * the source. Brace-balanced scan starting at the opening `{` of the arrow
 * function body locates the matching closer.
 */
function extractHandlers(src: string): HandlerMatch[] {
  const lines = src.split('\n');
  const handlers: HandlerMatch[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = line.match(/^app\.(post|put|patch|delete)\(['"]([^'"]+)['"]/);
    if (!m) continue;
    // Only the /api/* surface is in scope for this sweep. /ingest, /store,
    // /extract are pipeline entry points covered by their own tests.
    if (!m[2]!.startsWith('/api/')) continue;

    // Walk forward to find the opening `{` of the handler body and then the
    // matching closer. The handler arrow always lives on the same or next
    // few lines as the route declaration.
    const startLine = i + 1;
    let braceLine = i;
    while (braceLine < lines.length && !lines[braceLine]!.includes('=> {')) braceLine++;
    if (braceLine >= lines.length) continue;
    // brace depth starts at 1 after we consume the opening `{`
    let depth = 1;
    let j = braceLine;
    // The opening { is the last `{` on braceLine. Start scanning chars
    // after the `=> {` marker so the depth count is correct.
    const arrowIdx = lines[j]!.indexOf('=> {');
    let charIdx = arrowIdx + 4;
    for (; j < lines.length && depth > 0; j++) {
      const text = lines[j]!;
      for (let k = j === braceLine ? charIdx : 0; k < text.length; k++) {
        if (text[k] === '{') depth++;
        else if (text[k] === '}') {
          depth--;
          if (depth === 0) {
            const endLine = j + 1;
            const body = lines.slice(i, endLine).join('\n');
            handlers.push({
              routeMethod: m[1]!.toUpperCase(),
              routePath: m[2]!,
              startLine,
              endLine,
              body,
            });
            break;
          }
        }
      }
      charIdx = 0;
    }
  }
  return handlers;
}

/**
 * For one audited-mutation call inside `body`, find the matching
 * argument-block close `)` (paren-balanced) and return the slice between
 * call name and that closer. The slice is then searched for `actor:`.
 *
 * Returns null when the call site can't be parsed (defensive — surfaces as
 * a test failure with the handler name so the underlying drift is
 * inspected manually).
 */
function findCallArgSlice(body: string, fnName: string, startIdx: number): string | null {
  // After the function name should come `(` (possibly with whitespace).
  const openSearchStart = startIdx + fnName.length;
  const openIdx = body.indexOf('(', openSearchStart);
  if (openIdx === -1 || openIdx - openSearchStart > 4) return null;

  let depth = 1;
  for (let k = openIdx + 1; k < body.length; k++) {
    const ch = body[k];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return body.slice(openIdx + 1, k);
    }
  }
  return null;
}

interface Finding {
  route: string;
  fn: string;
  callExcerpt: string;
}

function findMissingActorCalls(handler: HandlerMatch): Finding[] {
  const findings: Finding[] = [];
  for (const fn of AUDITED_MUTATIONS) {
    // Regex matches the function name as a fresh identifier (not a substring).
    // \b on the front + a non-letter on the back. Skip `import { X }` lines
    // by requiring at least one non-import-context character before the name
    // — the dynamic import pattern `const { fn } = await import(...)` ends
    // the destructure with a closing `}` before any call site, so import
    // lines simply don't match a `fn(` shape.
    const callRegex = new RegExp(`\\b${fn}\\s*\\(`, 'g');
    let match: RegExpExecArray | null;
    while ((match = callRegex.exec(handler.body)) !== null) {
      const callStart = match.index;
      const argSlice = findCallArgSlice(handler.body, fn, callStart);
      if (argSlice === null) {
        findings.push({
          route: handler.routePath,
          fn,
          callExcerpt: handler.body.slice(callStart, Math.min(callStart + 200, handler.body.length)),
        });
        continue;
      }
      // Permissive check: the literal token `actor:` (with optional
      // whitespace) must appear inside the argument block. Audit attribution
      // is always passed as a named option, never positionally, so this is
      // the canonical shape across every callsite the sweep verified.
      if (!/\bactor\s*:/.test(argSlice)) {
        findings.push({
          route: handler.routePath,
          fn,
          callExcerpt: handler.body.slice(callStart, callStart + Math.min(argSlice.length + fn.length + 4, 200)),
        });
      }
    }
  }
  return findings;
}

describe('api-actor-attribution guardrail (nmemo-2yv.35)', () => {
  const src = readFileSync(INDEX_TS_PATH, 'utf-8');
  const handlers = extractHandlers(src);

  it('finds the /api/* handler surface in src/index.ts (smoke check)', () => {
    // If the handler-extraction regex breaks (file moved, refactor changes
    // the `app.post('/api/...', ...)` shape), every other assertion below
    // would vacuously pass. The smoke check refuses to let that happen.
    expect(handlers.length, 'expected at least 10 /api/* handlers').toBeGreaterThanOrEqual(10);
    const routes = handlers.map((h) => h.routePath);
    // Spot-check a few canonical routes from the sweep.
    expect(routes).toContain('/api/decay');
    expect(routes).toContain('/api/contradictions/:id/resolve');
    expect(routes).toContain('/api/reconcile');
  });

  it('every audited mutation call in an /api/* handler passes an explicit actor argument', () => {
    const allFindings: Finding[] = [];
    for (const h of handlers) {
      allFindings.push(...findMissingActorCalls(h));
    }
    if (allFindings.length > 0) {
      const report = allFindings.map(
        (f) =>
          `  route=${f.route} fn=${f.fn}\n    excerpt: ${f.callExcerpt.replace(/\s+/g, ' ').slice(0, 180)}`,
      ).join('\n');
      throw new Error(
        `Found ${allFindings.length} audited-mutation call(s) in src/index.ts /api/* handlers that don't pass actor:\n${report}\n\n` +
          `Fix: pass an explicit actor in the call options, e.g. ` +
          `applyConfidenceDecay({ actor: 'user' }), resolveContradiction({ actor: 'user', ... }).`,
      );
    }
    expect(allFindings).toEqual([]);
  });

  it('AUDITED_MUTATIONS list matches the public service surface', () => {
    // Sanity: the audited-mutations list is the contract the guardrail
    // checks against. If a future bead adds a new mutation function (e.g.
    // an `archiveFact`) that writes fact_history, it MUST be added here so
    // the guardrail tracks it. This check just confirms the list is
    // non-empty and uses distinct names (typo guard).
    expect(AUDITED_MUTATIONS.length).toBeGreaterThan(0);
    expect(new Set(AUDITED_MUTATIONS).size).toBe(AUDITED_MUTATIONS.length);
  });
});
