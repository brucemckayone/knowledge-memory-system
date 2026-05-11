/**
 * Artifact Generator Agent
 *
 * Produces a single, self-contained interactive widget — HTML + inline
 * <style> + inline <script> — that renders inside the frontend's sandboxed
 * iframe (viz/components/Artifact.js). The agent picks the right library
 * (d3 for custom viz, mermaid for diagrams, mathjax/katex for equations,
 * plotly for plots, p5 for canvas animation, three for 3D) and writes the
 * code that draws and animates exactly what's needed.
 *
 * Unlike component-generator.ts, this agent is NOT bounded by a fixed set
 * of kinds. It can produce algorithm visualisers, equation graphers with
 * sliders, recursion trees, custom games, anything that fits inside an
 * iframe with the allowlisted libraries.
 *
 * Model: Opus 4.7 high effort (generation of nontrivial JS+SVG+animation
 * is well outside Haiku/Sonnet's reliable range; cost is acceptable per
 * project preference). Single LLM turn, no MCP, no tool calls. 15 min
 * budget — Opus 4.7 high on a complex artifact (3D scene, parameterised
 * grapher, animated algorithm) routinely runs past 3 minutes; we'd rather
 * wait than time out a working generation.
 */
import { runAgent } from '../services/agent.js';

// Must match viz/components/Artifact.js LIBRARY_ALLOWLIST. Any library
// the agent picks must come from this set.
export const ARTIFACT_LIBRARIES = [
  'd3', 'mermaid', 'mathjax', 'katex', 'plotly', 'p5', 'three',
] as const;
export type ArtifactLibrary = typeof ARTIFACT_LIBRARIES[number];

export type ArtifactIntent =
  | 'diagram'
  | 'animate'
  | 'plot'
  | 'walkthrough'
  | 'free';

export interface ArtifactGenInput {
  /** What kind of widget the learner asked for. 'free' = agent picks freely. */
  intent: ArtifactIntent;
  /** The lesson excerpt or selected text the artifact should illustrate. */
  context: string;
  /** Optional learner state for difficulty calibration. */
  learnerState?: {
    confidence?: number;
    courseId?: string;
    sectionId?: string;
    conceptName?: string;
  };
  /** Optional surrounding lesson text for grounding (passed verbatim to the prompt). */
  lessonContext?: string;
}

export interface ArtifactSpec {
  title: string;
  html: string;
  libraries: ArtifactLibrary[];
  height: number;
  // The render block is exactly what LessonRenderer expects — splice
  // straight into a LessonBlock[]: { type: 'component', kind: 'Artifact', props }.
}

export interface ArtifactGenResult {
  ok: true;
  spec: ArtifactSpec;
  /** The agent's raw response, kept for debugging when the artifact fails to render. */
  raw?: string;
}

export interface ArtifactGenFailure {
  ok: false;
  errorText: string;
  raw?: string;
}

const INTENT_GUIDANCE: Record<ArtifactIntent, string> = {
  diagram:
    'A static or interactive diagram — flowchart, structure, mechanism. Mermaid is usually the right tool unless the diagram needs custom interactivity, in which case use d3 or raw SVG.',
  animate:
    'An animation that shows a process unfolding over time. Use d3 or p5 for full control of timing and easing. Provide play/pause/restart controls.',
  plot:
    'A plot of a function, dataset, or mathematical relationship. Use plotly for general 2D/3D plots, or d3 if the plot needs unusual interactivity. Include axis labels and a tight, learner-relevant range.',
  walkthrough:
    'An interactive step-by-step walkthrough where the learner advances through stages. Use d3 + a step controller, or plain HTML with buttons. Each step should reveal one mechanism.',
  free:
    'Pick whatever shape best teaches the concept — diagram, animation, plot, walkthrough, custom widget. Use the library that fits.',
};

const SYSTEM_PROMPT = `You are a master educator who designs and codes small, beautiful, interactive widgets to teach a single concept. Your output is a self-contained HTML+JS artifact that renders inside a sandboxed iframe.

# Output format

Output ONLY a single JSON object. No prose, no markdown fences, no chain-of-thought. The first character must be '{', the last must be '}'.

Schema:
{
  "title": string (short, <= 60 chars; describes the artifact),
  "libraries": string[] (subset of: ${ARTIFACT_LIBRARIES.join(', ')}),
  "height": number (recommended pixel height — 240 minimum, 720 maximum),
  "html": string (the body content — see "HTML body" below)
}

Escape newlines inside JSON string values as \\n. Escape any double quotes as \\".

# HTML body

The "html" string is inserted verbatim into a <div id="root"></div>. You can include:
- Markup
- Inline <style>...</style>
- Inline <script>...</script>

It runs inside an iframe with sandbox="allow-scripts" only. Constraints:
- NO fetch, XHR, or websockets. The only network requests allowed are the libraries you list (loaded by the runtime before your code runs).
- NO access to the parent document — window.parent is unreachable, no access to cookies, localStorage of the host, or any host APIs.
- NO top-level await. Wrap async code in IIFE if you need async/await.
- NO external image/audio/video URLs unless absolutely essential — prefer SVG/canvas drawing.
- The runtime loads requested libraries BEFORE your script runs and exposes them as globals (d3 → window.d3, plotly → window.Plotly, mermaid → window.mermaid, katex → window.katex, MathJax → window.MathJax, p5 → window.p5, three → window.THREE).
- Render into the existing #root element (or one of its descendants you create). Don't replace document.body.
- Inline <script> blocks must be PLAIN ES5/ES2017 JavaScript. Specifically:
  - NO JSX or React-like syntax (no \`<div>...</div>\` literals inside JS).
  - NO TypeScript syntax (no type annotations like \`x: number\`).
  - NO Vue/Angular/Svelte templates inside scripts.
  - NO HTML-style comments (\`<!-- ... -->\`) inside scripts.
  - NO ES module syntax (no \`import\`, no \`export\`). The runtime uses sequential <script> loads, not modules.
  - Any \`</script>\` literal that appears INSIDE a JavaScript string must be written as \`<\\/script>\` to avoid prematurely closing the script tag.
- A \`<\` character inside an inline <script> MUST only appear as a less-than comparison operator (with surrounding whitespace, e.g. \`if (i < n)\`) or inside a string literal. Never as the start of a tag.

The iframe has a dark background by default (#0f1117 / light text); style your widget to match.

# Library guidance

- d3: custom data-driven viz, animation, layout. Power tool when nothing else fits.
- mermaid: quick diagrams from text syntax. Call mermaid.initialize({startOnLoad:false, theme:'dark'}) then mermaid.run({nodes:[el]}).
- mathjax: rendered LaTeX. After loading, call MathJax.typeset() on your element. Use $...$ or $$...$$ for math.
- katex: faster math rendering. Use katex.render(tex, el) or auto-render via renderMathInElement.
- plotly: scientific plots, interactive 3D, contour, surface. Use Plotly.newPlot(el, data, layout, {displayModeBar:false}).
- p5: instance mode, generative graphics. \`new p5((p) => { p.setup = ()=>{...}; p.draw = ()=>{...}; }, el)\`.
- three: 3D scenes. Render into a canvas you append to #root.

# Quality bar

- The widget must teach the concept clearly. No filler, no decoration.
- Interactivity should reveal something — not just "click a button to see the same thing".
- Animations should have play/pause if they run > 3 seconds, so the learner controls the pace.
- Sliders, buttons, drag handles all welcome. Label them.
- Code must run on first load. Do not assume any external state.
- Inline error handling: if a numeric input is invalid, show a hint inside the widget — don't throw.

# Examples (do NOT copy verbatim — produce something appropriate to the requested context)

Example 1 — animated linked list traversal (d3):
{"title":"Linked list traversal","libraries":["d3"],"height":280,"html":"<div id=\\"vis\\" style=\\"width:100%;height:200px\\"></div><div style=\\"text-align:center;margin-top:8px\\"><button id=\\"step\\" style=\\"padding:6px 14px;background:#6366f1;color:#fff;border:none;border-radius:6px;cursor:pointer\\">Step</button> <button id=\\"reset\\" style=\\"padding:6px 14px;background:transparent;color:#e2e8f0;border:1px solid #2e3248;border-radius:6px;cursor:pointer;margin-left:8px\\">Reset</button></div><script>(function(){const data=[5,12,18,3];const w=560,h=120,nodeW=80,gap=40;const svg=d3.select('#vis').append('svg').attr('viewBox','0 0 '+w+' '+h).attr('width','100%').attr('height','100%');const startX=(w-(data.length*nodeW+(data.length-1)*gap))/2;const g=svg.append('g').attr('transform','translate('+startX+',30)');data.forEach((d,i)=>{const x=i*(nodeW+gap);const node=g.append('g').attr('transform','translate('+x+',0)');node.append('rect').attr('width',nodeW).attr('height',50).attr('rx',6).attr('fill','#1a1d27').attr('stroke','#2e3248');node.append('text').attr('x',nodeW/2).attr('y',30).attr('text-anchor','middle').attr('fill','#e2e8f0').attr('font-size','16').text(d);if(i<data.length-1){g.append('line').attr('x1',x+nodeW).attr('x2',x+nodeW+gap).attr('y1',25).attr('y2',25).attr('stroke','#6366f1').attr('stroke-width',2).attr('marker-end','url(#arrow)');}});svg.append('defs').append('marker').attr('id','arrow').attr('viewBox','0 -5 10 10').attr('refX',8).attr('refY',0).attr('markerWidth',6).attr('markerHeight',6).attr('orient','auto').append('path').attr('d','M0,-5L10,0L0,5').attr('fill','#6366f1');let cur=-1;const cursor=svg.append('circle').attr('r',6).attr('fill','#22c55e').attr('cx',-20).attr('cy',-20);function highlight(){cursor.transition().duration(300).attr('cx',startX+cur*(nodeW+gap)+nodeW/2).attr('cy',60);}document.getElementById('step').onclick=()=>{cur=(cur+1)%data.length;highlight();};document.getElementById('reset').onclick=()=>{cur=-1;cursor.attr('cx',-20).attr('cy',-20);};})();</script>"}

Example 2 — equation grapher with sliders (plotly):
{"title":"y = a·sin(b·x) — drag the sliders","libraries":["plotly"],"height":420,"html":"<div id=\\"plot\\" style=\\"width:100%;height:300px\\"></div><div style=\\"display:flex;gap:16px;margin-top:12px;flex-wrap:wrap\\"><label style=\\"flex:1;min-width:120px\\">a: <span id=\\"av\\">1</span><input id=\\"a\\" type=\\"range\\" min=\\"-3\\" max=\\"3\\" step=\\"0.1\\" value=\\"1\\" style=\\"width:100%\\"></label><label style=\\"flex:1;min-width:120px\\">b: <span id=\\"bv\\">1</span><input id=\\"b\\" type=\\"range\\" min=\\"0.1\\" max=\\"5\\" step=\\"0.1\\" value=\\"1\\" style=\\"width:100%\\"></label></div><script>(function(){const xs=[];for(let x=-6.28;x<=6.28;x+=0.05)xs.push(x);const layout={paper_bgcolor:'#0f1117',plot_bgcolor:'#0f1117',font:{color:'#e2e8f0'},margin:{t:20,b:40,l:40,r:20},xaxis:{gridcolor:'#2e3248',zerolinecolor:'#444'},yaxis:{gridcolor:'#2e3248',zerolinecolor:'#444',range:[-3.5,3.5]}};function update(){const a=parseFloat(document.getElementById('a').value);const b=parseFloat(document.getElementById('b').value);document.getElementById('av').textContent=a.toFixed(1);document.getElementById('bv').textContent=b.toFixed(1);const ys=xs.map(x=>a*Math.sin(b*x));Plotly.react('plot',[{x:xs,y:ys,type:'scatter',mode:'lines',line:{color:'#6366f1',width:2}}],layout,{displayModeBar:false});}['a','b'].forEach(id=>document.getElementById(id).oninput=update);update();})();</script>"}

# Now produce the artifact

For the requested concept, choose the library and design that teaches it best. Output the JSON object only.`;

function buildUserPrompt(input: ArtifactGenInput): string {
  const parts: string[] = [];
  parts.push(`Intent: ${input.intent}`);
  parts.push(INTENT_GUIDANCE[input.intent]);
  parts.push('');
  parts.push(`Concept / context to illustrate:`);
  parts.push(input.context.trim() || '(no context — pick a sensible illustrative example)');

  if (input.lessonContext && input.lessonContext.trim()) {
    const trimmed = input.lessonContext.trim();
    const excerpt = trimmed.length > 1500 ? trimmed.slice(0, 1500) + '…' : trimmed;
    parts.push('');
    parts.push('Surrounding lesson text (for grounding — do not paraphrase, build a widget that complements it):');
    parts.push(excerpt);
  }

  if (input.learnerState) {
    const ls = input.learnerState;
    const bits: string[] = [];
    if (typeof ls.confidence === 'number') bits.push(`confidence ${ls.confidence.toFixed(2)} (0=novice, 1=expert)`);
    if (ls.conceptName) bits.push(`concept "${ls.conceptName}"`);
    if (bits.length > 0) {
      parts.push('');
      parts.push(`Learner state: ${bits.join(', ')}. Calibrate complexity accordingly.`);
    }
  }

  parts.push('');
  parts.push('Output the JSON object only — no prose, no fences.');
  return parts.join('\n');
}

function tryParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return null; }
}

function parseLoose(raw: string): unknown | null {
  const trimmed = raw.trim();
  const direct = tryParse(trimmed);
  if (direct) return direct;
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) {
    const fenced = tryParse(fence[1].trim());
    if (fenced) return fenced;
  }
  const obj = raw.match(/\{[\s\S]*\}/);
  if (obj) {
    const parsed = tryParse(obj[0]);
    if (parsed) return parsed;
  }
  return null;
}

function isObj(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

function nonEmptyString(x: unknown): x is string {
  return typeof x === 'string' && x.trim().length > 0;
}

function pickLibraries(value: unknown): ArtifactLibrary[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<string>(ARTIFACT_LIBRARIES);
  const out: ArtifactLibrary[] = [];
  const seen = new Set<string>();
  for (const v of value) {
    if (typeof v !== 'string') continue;
    const k = v.trim().toLowerCase();
    if (allowed.has(k) && !seen.has(k)) {
      seen.add(k);
      out.push(k as ArtifactLibrary);
    }
  }
  return out;
}

function clampHeight(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return 360;
  return Math.max(240, Math.min(720, Math.round(n)));
}

function validate(parsed: unknown): ArtifactSpec | null {
  if (!isObj(parsed)) return null;
  if (!nonEmptyString(parsed.html)) return null;
  // Heuristic safety: must contain something more than empty markup. We don't
  // try to parse the HTML — the iframe sandbox is the trust boundary.
  if (parsed.html.length < 30) return null;
  const libraries = pickLibraries(parsed.libraries);
  const height = clampHeight(parsed.height);
  const title = nonEmptyString(parsed.title) ? parsed.title.trim().slice(0, 80) : 'Artifact';
  return { title, html: parsed.html, libraries, height };
}

/**
 * Pull each inline `<script>` (no type / type=text/javascript / type=application/javascript)
 * out of the artifact's HTML and parse-check it via `new Function()`. Returns
 * a list of error messages, one per offending script. Empty array = clean.
 *
 * Module scripts (type="module") aren't valid `new Function` input, so we
 * skip them rather than report a false positive — the iframe runtime catches
 * those via its parse-check.
 */
export function parseCheckInlineScripts(html: string): string[] {
  const errors: string[] = [];
  // Match <script ... >...</script>. Non-greedy body. Captures the tag attrs
  // (group 1) and the body (group 2).
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  let idx = 0;
  while ((m = re.exec(html)) !== null) {
    idx += 1;
    const attrs = m[1] || '';
    const body = m[2] || '';
    // Skip non-JS scripts (templates, JSON, etc.).
    const typeMatch = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
    const type = (typeMatch?.[1] || '').toLowerCase();
    if (type && type !== 'text/javascript' && type !== 'application/javascript') {
      // module scripts can't be `new Function`-checked; skip.
      continue;
    }
    if (!body.trim()) continue;
    try {
      // eslint-disable-next-line no-new-func
      new Function(body);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`script #${idx}: ${msg}`);
    }
  }
  return errors;
}

const VERIFY_SYSTEM_PROMPT = `You are reviewing a learning-platform artifact (a small interactive widget) before it ships to a learner. The artifact runs inside a sandboxed iframe with sandbox="allow-scripts" and no allow-same-origin. The runtime pre-loads any libraries listed under "libraries" before the script runs (d3 → window.d3, plotly → window.Plotly, mermaid → window.mermaid, mathjax → window.MathJax, katex → window.katex, p5 → window.p5, three → window.THREE).

# Your job

Find ALL bugs in the artifact, then output a CORRECTED version. Common failure modes to check:

1. **Missing element references** — every getElementById / querySelector must point to an element that exists in the html.
2. **Library-API misuse** — wrong d3 v7 syntax, missing Plotly.newPlot/react args, mermaid.initialize before mermaid.run, katex.render without a target element.
3. **Race conditions** — code referencing a library global before its <script> tag has loaded (the runtime injects libs before user code runs, but inline event handlers may fire before assets resolve).
4. **CSS sizing** — widget that disappears because parent has 0 height. Use explicit pixel/percentage heights on container divs.
5. **Hard-coded white / black colors** that vanish on the dark iframe background. Use light text + accent colors.
6. **No visible content** on first paint — the widget should render something within the first 200ms; animations should have a visible starting frame.
7. **Single-shot animations with no replay** — anything > 3s must have play/pause/reset controls.
8. **Numeric input edge cases** — sliders that produce NaN, division by zero, log of negative.
9. **Forbidden APIs** — fetch, XHR, websockets, DOM access outside #root. Strip them.
10. **Style leakage** — global * or body selectors that change the iframe's chrome.
11. **Inline event handler scoping** — onclick="foo()" works only if foo is on window.
12. **Three.js / canvas resize** — widgets that don't resize when the iframe resizes are usually fine for now (skip).
13. **Errors thrown synchronously at top level** — wrap risky init in try/catch so the rest of the widget still renders.
14. **Syntax errors in inline scripts** — every <script>...</script> body must be plain JavaScript that parses cleanly. Forbidden patterns: JSX (\`<div>\` inside JS), TypeScript annotations, ES module \`import\`/\`export\`, HTML comments \`<!-- -->\` inside scripts, raw \`</script>\` inside JS strings (must be \`<\\/script>\`), bare \`<\` outside of comparisons or strings.
15. **Empty / placeholder content** — the artifact must teach a specific concept. If the input description is too vague to render something concrete, fail gracefully by rendering a short message inside #root explaining what would help — do NOT emit a stub like "Insert content here".

# Output format

Output ONLY a JSON object with the SAME schema as the input:
{
  "title": string,
  "libraries": string[],
  "height": number,
  "html": string
}

If the original artifact is correct as-is, return it unchanged. If it has bugs, return the FIXED version. Do not add comments, do not narrate the fix, do not explain. Just emit corrected JSON.

The first character of your response must be '{', the last must be '}'. No markdown fences. Escape newlines inside strings as \\n.`;

/**
 * Run a verification + fix pass on a generated artifact spec. Used after the
 * initial Opus generation to catch the common failure modes (missing
 * element refs, wrong library syntax, invisible widgets, etc). Cheaper than
 * a full re-generation and the model gets to look at concrete code.
 *
 * `parseErrors` carries any concrete syntax errors discovered server-side via
 * `new Function()`; passing them lets the verifier focus its fix on real
 * problems instead of speculating.
 *
 * Returns the corrected spec on success, or null when verification fails
 * (caller falls back to the original spec).
 */
export async function verifyArtifact(
  spec: ArtifactSpec,
  intent: ArtifactIntent,
  context: string,
  parseErrors: string[] = [],
): Promise<ArtifactSpec | null> {
  const errSection = parseErrors.length > 0
    ? `\n\nServer-side parse-check failed for these scripts (must be fixed):\n${parseErrors.map((e) => `  - ${e}`).join('\n')}`
    : '';
  const reviewPrompt = `Original intent: ${intent}\nOriginal context: ${context.slice(0, 600)}${errSection}\n\nArtifact to review (JSON):\n${JSON.stringify(spec)}\n\nReturn corrected JSON.`;
  let raw = '';
  try {
    const result = await runAgent(reviewPrompt, {
      model: 'opus',
      effort: 'high',
      systemPrompt: VERIFY_SYSTEM_PROMPT,
      tools: 'none',
      maxTurns: 1,
      timeoutMs: 900_000,
    });
    raw = result.result ?? '';
  } catch (err) {
    console.warn('[artifact-generator] verify pass runAgent failed:', err);
    return null;
  }
  const parsed = parseLoose(raw);
  const fixed = validate(parsed);
  if (!fixed) {
    console.warn(`[artifact-generator] verify pass produced invalid JSON; first 200 chars: ${raw.slice(0, 200)}`);
    return null;
  }
  return fixed;
}

/**
 * Produce a single Artifact spec for the given intent and context.
 *
 * Pipeline: generate (Opus 4.7 max) → verify+fix (Opus 4.7 high) → return.
 * Both passes are bounded at 15 min; total worst-case ~30 min though typical
 * is 1-3 min per pass. Returns { ok: true, spec } on success, { ok: false,
 * errorText } on failure.
 *
 * Verification can be skipped via env LEARN_ARTIFACT_VERIFY=0.
 */
export async function generateArtifact(input: ArtifactGenInput): Promise<ArtifactGenResult | ArtifactGenFailure> {
  let raw = '';
  try {
    const result = await runAgent(buildUserPrompt(input), {
      model: 'opus',
      effort: 'max',
      systemPrompt: SYSTEM_PROMPT,
      tools: 'none',
      maxTurns: 1,
      timeoutMs: 900_000, // 15 min — see file header for rationale
    });
    raw = result.result ?? '';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[artifact-generator] runAgent failed: ${msg}`);
    return { ok: false, errorText: `agent run failed: ${msg}` };
  }

  const parsed = parseLoose(raw);
  const initial = validate(parsed);
  if (!initial) {
    console.warn(`[artifact-generator] invalid output; first 200 chars: ${raw.slice(0, 200)}`);
    return { ok: false, errorText: 'agent produced invalid artifact JSON', raw };
  }

  // Verification + fix pass. Disabled when LEARN_ARTIFACT_VERIFY is "0" / "false".
  const verifyEnv = process.env.LEARN_ARTIFACT_VERIFY;
  const verifyOff = verifyEnv === '0' || verifyEnv === 'false' || verifyEnv === 'no';
  if (verifyOff) {
    return { ok: true, spec: initial, raw };
  }

  // First verification pass — feed any server-side parse errors as concrete
  // failures the verifier must fix, in addition to the general bug-checklist.
  const initialErrors = parseCheckInlineScripts(initial.html);
  if (initialErrors.length > 0) {
    console.warn(`[artifact-generator] initial output has ${initialErrors.length} script parse error(s):`, initialErrors);
  }
  let current = initial;
  let fixed = await verifyArtifact(current, input.intent, input.context, initialErrors);
  if (fixed) current = fixed;

  // Re-check after the first fix pass. If it still has parse errors, run one
  // more fix pass (capped at 2 fix passes total to bound wall-clock).
  let postFixErrors = parseCheckInlineScripts(current.html);
  if (postFixErrors.length > 0) {
    console.warn(`[artifact-generator] still ${postFixErrors.length} parse error(s) after first fix; running second fix pass`);
    fixed = await verifyArtifact(current, input.intent, input.context, postFixErrors);
    if (fixed) current = fixed;
    postFixErrors = parseCheckInlineScripts(current.html);
  }

  if (postFixErrors.length > 0) {
    // Still broken after two fix passes. Surface as a hard failure so the
    // learner doesn't see a silently-broken artifact land in their lesson.
    console.warn(`[artifact-generator] gave up after 2 fix passes; ${postFixErrors.length} script(s) still have parse errors`);
    return {
      ok: false,
      errorText: `agent could not produce valid JS after 2 fix passes: ${postFixErrors.join('; ')}`,
      raw,
    };
  }

  console.log(`[artifact-generator] artifact verified clean (${current.html.length} bytes html, libs: ${current.libraries.join(',') || '(none)'})`);
  return { ok: true, spec: current, raw };
}

// Internal helpers exposed for unit-style testing.
export const __test = { parseLoose, validate, pickLibraries, clampHeight };
