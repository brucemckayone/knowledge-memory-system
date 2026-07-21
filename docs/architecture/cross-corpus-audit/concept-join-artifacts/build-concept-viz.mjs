/**
 * Build a self-contained interactive view of the concept-JOIN graph (nmemo-uhp.24).
 * Joins cj-graph.json (nodes + exhibits/addresses bridges, from the live DB) with the
 * frozen oracle (cj-results.json) and emits cj-graph-viz.html — no external assets.
 *   node build-concept-viz.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const g = JSON.parse(readFileSync(join(HERE, 'cj-graph.json'), 'utf8'));
const res = JSON.parse(readFileSync(join(HERE, 'cj-results.json'), 'utf8'));
const oracle = res.oracleKey; // { E001: 'ES.42', ... }
const per = res.perElement;    // { E001: { joinRank, cosRank, subLexical, ... } }

// short ids
const short = new Map(); let n = 0;
const sid = (u) => { if (!short.has(u)) short.set(u, 'n' + n++); return short.get(u); };

const exhibitedBy = new Map(); // conceptUuid -> [code uuid]
const addressedBy = new Map(); // conceptUuid -> [rule uuid]
const codeExhibits = new Map(); // code uuid -> Set(concept uuid)
const ruleAddresses = new Map(); // rule uuid -> Set(concept uuid)
for (const e of g.bridges) {
  if (e.relation === 'exhibits') {
    (exhibitedBy.get(e.b) ?? exhibitedBy.set(e.b, []).get(e.b)).push(e.a);
    (codeExhibits.get(e.a) ?? codeExhibits.set(e.a, new Set()).get(e.a)).add(e.b);
  } else {
    (addressedBy.get(e.b) ?? addressedBy.set(e.b, []).get(e.b)).push(e.a);
    (ruleAddresses.get(e.a) ?? ruleAddresses.set(e.a, new Set()).get(e.a)).add(e.b);
  }
}
const conceptName = new Map(g.concepts.map((c) => [c.id, c.name]));
const ruleByName = new Map(g.rules.map((r) => [r.name, r.id]));

const codes = g.code.map((c) => {
  const trueRule = oracle[c.name] ?? '?';
  const trUuid = ruleByName.get(trueRule);
  const myConcepts = codeExhibits.get(c.id) ?? new Set();
  const trConcepts = ruleAddresses.get(trUuid) ?? new Set();
  const sharedWithTrue = [...myConcepts].filter((x) => trConcepts.has(x)).map((x) => conceptName.get(x));
  return {
    id: sid(c.id), name: c.name, guideline: trueRule,
    connected: sharedWithTrue.length > 0, shared: sharedWithTrue,
    subLexical: !!per[c.name]?.subLexical,
    joinRank: per[c.name]?.joinRank ?? 0, cosRank: per[c.name]?.cosRank ?? 0,
  };
});
const rules = g.rules.map((r) => ({ id: sid(r.id), name: r.name, isTrue: Object.values(oracle).includes(r.name) }));
const concepts = g.concepts.map((c) => {
  const inC = exhibitedBy.has(c.id), inR = addressedBy.has(c.id);
  return { id: sid(c.id), name: c.name, side: inC && inR ? 'shared' : inC ? 'code' : 'rule' };
});
const edges = g.bridges.map((e) => ({ from: sid(e.a), to: sid(e.b), rel: e.relation }));

const model = {
  codes, rules, concepts, edges,
  stats: {
    code: codes.length, rules: rules.length, concepts: concepts.length,
    shared: concepts.filter((c) => c.side === 'shared').length,
    connectedElements: codes.filter((c) => c.connected).length,
  },
};

const HTML = String.raw`<title>Concept-JOIN graph — nmemo-uhp.24</title>
<style>
:root{
  --bg:#0d1017; --panel:#141925; --panel-2:#1b2130; --ink:#e6ebf2; --ink-dim:#8793a7;
  --line:#252c3b; --code:#38bdf8; --rule:#c084fc; --shared:#f5b942; --island:#5a677e;
  --hit:#4ade80; --miss:#fb7185;
  --code-dim:#1f4a5e; --rule-dim:#4a3560;
  --mono:ui-monospace,"Cascadia Code","SF Mono",Menlo,Consolas,monospace;
  --sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
}
@media(prefers-color-scheme:light){:root{
  --bg:#f5f7fa; --panel:#ffffff; --panel-2:#eef1f6; --ink:#141925; --ink-dim:#5a677e;
  --line:#dde3ec; --code:#0284c7; --rule:#9333ea; --shared:#c77d0a; --island:#94a3b8;
  --hit:#16a34a; --miss:#e11d48; --code-dim:#bae6fd; --rule-dim:#e9d5ff;
}}
:root[data-theme="dark"]{
  --bg:#0d1017; --panel:#141925; --panel-2:#1b2130; --ink:#e6ebf2; --ink-dim:#8793a7;
  --line:#252c3b; --code:#38bdf8; --rule:#c084fc; --shared:#f5b942; --island:#5a677e;
  --hit:#4ade80; --miss:#fb7185; --code-dim:#1f4a5e; --rule-dim:#4a3560;
}
:root[data-theme="light"]{
  --bg:#f5f7fa; --panel:#ffffff; --panel-2:#eef1f6; --ink:#141925; --ink-dim:#5a677e;
  --line:#dde3ec; --code:#0284c7; --rule:#9333ea; --shared:#c77d0a; --island:#94a3b8;
  --hit:#16a34a; --miss:#e11d48; --code-dim:#bae6fd; --rule-dim:#e9d5ff;
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);line-height:1.5}
.wrap{max-width:1200px;margin:0 auto;padding:28px 20px 60px}
header h1{font-size:1.5rem;margin:0 0 4px;font-weight:650;letter-spacing:-.01em;text-wrap:balance}
header p{margin:0;color:var(--ink-dim);font-size:.92rem;max-width:70ch}
.statbar{display:flex;flex-wrap:wrap;gap:10px;margin:20px 0}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 14px;min-width:96px}
.stat .n{font-family:var(--mono);font-size:1.5rem;font-weight:600;font-variant-numeric:tabular-nums;line-height:1}
.stat.key .n{color:var(--shared)}
.stat .l{font-size:.72rem;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-dim);margin-top:5px}
.controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:6px 0 14px}
.controls .lab{font-size:.75rem;text-transform:uppercase;letter-spacing:.06em;color:var(--ink-dim);margin-right:2px}
.chip{font-family:var(--mono);font-size:.78rem;padding:4px 9px;border-radius:999px;border:1px solid var(--line);
  background:var(--panel);color:var(--ink);cursor:pointer;transition:.12s}
.chip:hover{border-color:var(--code)}
.chip[aria-pressed="true"]{background:var(--code);border-color:var(--code);color:#04121a}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:.8rem;color:var(--ink-dim);margin:2px 0 12px}
.legend span{display:inline-flex;align-items:center;gap:6px}
.dot{width:11px;height:11px;border-radius:50%;display:inline-block}
.line-swatch{width:20px;height:0;border-top:2px solid;display:inline-block}
.stage{background:var(--panel);border:1px solid var(--line);border-radius:14px;overflow:auto;position:relative}
svg{display:block;font-family:var(--mono)}
.node-label{font-size:11px;fill:var(--ink)}
.node-label.dim{fill:var(--ink-dim)}
.col-head{font-size:12px;fill:var(--ink-dim);text-transform:uppercase;letter-spacing:.08em;font-family:var(--sans);font-weight:600}
.edge{fill:none;stroke-width:1;opacity:.16}
.edge.exhibits{stroke:var(--code)}
.edge.addresses{stroke:var(--rule)}
.edge.hot{opacity:.95;stroke-width:1.8}
.faded{opacity:.07}
.card{position:fixed;pointer-events:none;background:var(--panel-2);border:1px solid var(--line);
  border-radius:10px;padding:11px 13px;font-size:.82rem;max-width:300px;box-shadow:0 8px 30px rgba(0,0,0,.35);z-index:9;opacity:0;transition:opacity .1s}
.card .t{font-family:var(--mono);font-weight:600;margin-bottom:5px}
.card .row{color:var(--ink-dim);margin:2px 0}
.card b{color:var(--ink)}
.badge{display:inline-block;padding:1px 7px;border-radius:999px;font-size:.72rem;font-weight:600;font-family:var(--mono)}
.badge.hit{background:color-mix(in srgb,var(--hit) 22%,transparent);color:var(--hit)}
.badge.miss{background:color-mix(in srgb,var(--miss) 22%,transparent);color:var(--miss)}
.note{color:var(--ink-dim);font-size:.82rem;margin-top:14px;max-width:78ch}
.note b{color:var(--ink)}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
</style>

<div class="wrap">
  <header>
    <h1>Concept-JOIN graph — the recall substrate that failed the gate</h1>
    <p>Every node is an <span style="color:var(--code)">code element</span> or a
    <span style="color:var(--rule)">rule</span>, each linked to the <b>concepts</b> it exhibits/addresses.
    The JOIN can only recall a code→rule pair through a concept touched by <em>both</em> sides
    (<span style="color:var(--shared)">amber</span>). Hover a code element to trace its path and see whether it reaches its true rule.</p>
  </header>

  <div class="statbar" id="statbar"></div>

  <div class="controls" id="filters"><span class="lab">Guideline</span></div>

  <div class="legend">
    <span><i class="dot" style="background:var(--code)"></i> code element</span>
    <span><i class="dot" style="background:var(--rule)"></i> rule</span>
    <span><i class="dot" style="background:var(--shared)"></i> shared concept (a bridge)</span>
    <span><i class="dot" style="background:var(--island)"></i> island concept (one side only)</span>
    <span><i class="line-swatch" style="border-color:var(--code)"></i> exhibits</span>
    <span><i class="line-swatch" style="border-color:var(--rule)"></i> addresses</span>
  </div>

  <div class="stage"><svg id="svg"></svg></div>

  <p class="note"><b>What you're looking at:</b> 104 concept nodes, only <b>4</b> shared across the two corpora —
  the concept space is almost entirely islands. The 4 bridges carry the JOIN's entire recall (8 of 29 elements).
  The islands are the failure: code says <span class="mono" style="font-family:var(--mono)">reinterpret-cast</span>, the rule says
  <span style="font-family:var(--mono)">unsafe-cast</span> — same mechanism, different word, no edge between them.
  A concept→concept <span style="font-family:var(--mono)">is-a</span> ontology would connect exactly those island pairs.</p>
</div>

<div class="card" id="card"></div>

<script>
const M = ${JSON.stringify(model)};
const svg = document.getElementById('svg');
const NS = 'http://www.w3.org/2000/svg';
const el = (t, a) => { const e = document.createElementNS(NS, t); for (const k in a) e.setAttribute(k, a[k]); return e; };

// ---- statbar ----
const S = M.stats;
const stats = [
  ['code', S.code, 'code elements'], ['rules', S.rules, 'rules'],
  ['concepts', S.concepts, 'concept nodes'], ['shared', S.shared, 'shared (bridges)', true],
  ['connected', S.connectedElements + '/' + S.code, 'elements reach a rule', true],
];
document.getElementById('statbar').innerHTML = stats.map(([,n,l,key]) =>
  '<div class="stat' + (key ? ' key' : '') + '"><div class="n">' + n + '</div><div class="l">' + l + '</div></div>').join('');

// ---- layout ----
const NODE_H = 20, PAD_TOP = 44, colGap = 40;
const guidelines = [...new Set(M.codes.map(c => c.guideline))].sort();
let activeGuideline = null;

// concept ordering: shared first, then code-islands, then rule-islands
const shared = M.concepts.filter(c => c.side === 'shared');
const codeIsl = M.concepts.filter(c => c.side === 'code');
const ruleIsl = M.concepts.filter(c => c.side === 'rule');
const conceptOrder = [...shared, ...codeIsl, ...ruleIsl];

function layout() {
  const W = Math.max(980, svg.clientWidth || 980);
  const colW = (W - 2 * colGap) / 3;
  const xCode = colW * 0.5, xConc = colW * 1.5 + colGap, xRule = colW * 2.5 + 2 * colGap;
  const codes = activeGuideline ? M.codes.filter(c => c.guideline === activeGuideline) : M.codes;
  const rules = M.rules;
  const rows = Math.max(codes.length, conceptOrder.length, rules.length);
  const H = PAD_TOP + rows * NODE_H + 30;
  const pos = {};
  const place = (arr, x, count) => {
    const gapY = (H - PAD_TOP - 20) / Math.max(count, arr.length);
    arr.forEach((nd, i) => pos[nd.id] = { x, y: PAD_TOP + i * gapY + gapY / 2 });
  };
  place(codes, xCode, codes.length);
  place(conceptOrder, xConc, conceptOrder.length);
  place(rules, xRule, rules.length);
  return { W, H, xCode, xConc, xRule, pos, codes, rules };
}

let LO;
function render() {
  svg.innerHTML = '';
  LO = layout();
  svg.setAttribute('viewBox', '0 0 ' + LO.W + ' ' + LO.H);
  svg.setAttribute('width', '100%');
  svg.setAttribute('height', LO.H);

  // column heads
  const heads = [['CODE', LO.xCode], ['CONCEPTS', LO.xConc], ['RULES', LO.xRule]];
  for (const [t, x] of heads) { const h = el('text', { x, y: 22, 'text-anchor': 'middle', class: 'col-head' }); h.textContent = t; svg.appendChild(h); }

  const gEdges = el('g', {}), gNodes = el('g', {});
  svg.appendChild(gEdges); svg.appendChild(gNodes);

  // edges (only those whose endpoints are placed)
  const edgeEls = {};
  for (const e of M.edges) {
    const a = LO.pos[e.from], b = LO.pos[e.to];
    if (!a || !b) continue;
    const mx = (a.x + b.x) / 2;
    const p = el('path', { class: 'edge ' + e.rel, d: 'M' + a.x + ',' + a.y + ' C' + mx + ',' + a.y + ' ' + mx + ',' + b.y + ' ' + b.x + ',' + b.y });
    p.dataset.from = e.from; p.dataset.to = e.to;
    gEdges.appendChild(p);
    (edgeEls[e.from] ??= []).push(p); (edgeEls[e.to] ??= []).push(p);
  }

  const nodeEls = {};
  function drawNode(nd, kind) {
    const p = LO.pos[nd.id]; if (!p) return;
    const g = el('g', { transform: 'translate(' + p.x + ',' + p.y + ')', style: 'cursor:pointer' });
    let fill, r = 5, anchor, dx;
    if (kind === 'code') { fill = 'var(--code)'; anchor = 'end'; dx = -9; }
    else if (kind === 'rule') { fill = nd.isTrue ? 'var(--rule)' : 'var(--island)'; anchor = 'start'; dx = 9; }
    else { // concept
      fill = nd.side === 'shared' ? 'var(--shared)' : (nd.side === 'code' ? 'var(--code-dim)' : 'var(--rule-dim)');
      r = nd.side === 'shared' ? 7 : 3.2; anchor = 'middle';
    }
    g.appendChild(el('circle', { r, fill, stroke: nd.side === 'shared' ? 'var(--shared)' : 'none', 'stroke-width': nd.side === 'shared' ? 2 : 0, 'fill-opacity': (kind === 'concept' && nd.side !== 'shared') ? .8 : 1 }));
    if (kind !== 'concept' || nd.side === 'shared') {
      const t = el('text', { class: 'node-label' + (kind === 'concept' ? '' : ''), 'text-anchor': anchor, x: kind === 'concept' ? 0 : dx, y: kind === 'concept' ? -10 : 3.5 });
      t.textContent = nd.name; g.appendChild(t);
    }
    g.addEventListener('mouseenter', (ev) => focus(nd, kind, ev));
    g.addEventListener('mousemove', moveCard);
    g.addEventListener('mouseleave', unfocus);
    gNodes.appendChild(g);
    nodeEls[nd.id] = g;
  }
  LO.codes.forEach(c => drawNode(c, 'code'));
  conceptOrder.forEach(c => drawNode(c, 'concept'));
  LO.rules.forEach(r => drawNode(r, 'rule'));

  svg._edgeEls = edgeEls; svg._nodeEls = nodeEls;
}

// ---- focus / hover ----
const card = document.getElementById('card');
const byId = {}; [...M.codes, ...M.rules, ...M.concepts].forEach(x => byId[x.id] = x);
const ruleNameById = {}; M.rules.forEach(r => ruleNameById[r.id] = r.name);

function neighborsOf(id) {
  const ns = new Set([id]); const es = new Set();
  (svg._edgeEls[id] || []).forEach(p => { es.add(p); ns.add(p.dataset.from); ns.add(p.dataset.to); });
  // second hop through shared concepts: from a code node, reach rules via shared concepts
  return { ns, es };
}
function focus(nd, kind, ev) {
  const { ns, es } = neighborsOf(nd.id);
  // for code/rule, extend one hop: highlight edges of its concepts too (to reach the other side)
  if (kind !== 'concept') {
    [...ns].forEach(cid => { if (byId[cid] && byId[cid].side) (svg._edgeEls[cid] || []).forEach(p => { es.add(p); ns.add(p.dataset.from); ns.add(p.dataset.to); }); });
  }
  document.querySelectorAll('.edge').forEach(p => { p.classList.toggle('hot', es.has(p)); p.classList.toggle('faded', !es.has(p)); });
  Object.entries(svg._nodeEls).forEach(([id, g]) => g.classList.toggle('faded', !ns.has(id)));
  showCard(nd, kind, ev);
}
function unfocus() {
  document.querySelectorAll('.edge').forEach(p => { p.classList.remove('hot'); p.classList.remove('faded'); });
  Object.values(svg._nodeEls).forEach(g => g.classList.remove('faded'));
  card.style.opacity = 0;
}
function showCard(nd, kind, ev) {
  let html = '';
  if (kind === 'code') {
    const hit = nd.joinRank > 0 && nd.joinRank <= 5;
    html = '<div class="t" style="color:var(--code)">' + nd.name + '</div>' +
      '<div class="row">true rule: <b>' + nd.guideline + '</b>' + (nd.subLexical ? ' · <b>sub-lexical</b>' : '') + '</div>' +
      '<div class="row">JOIN: <span class="badge ' + (hit ? 'hit' : 'miss') + '">' + (hit ? 'reaches @' + nd.joinRank : 'miss (rank ' + nd.joinRank + ')') + '</span></div>' +
      '<div class="row">via shared concept: <b>' + (nd.shared.length ? nd.shared.join(', ') : '— none —') + '</b></div>' +
      '<div class="row" style="color:var(--ink-dim)">cosine rank: ' + nd.cosRank + '</div>';
  } else if (kind === 'rule') {
    html = '<div class="t" style="color:var(--rule)">' + nd.name + '</div><div class="row">' + (nd.isTrue ? 'a true target for some code' : 'distractor rule') + '</div>';
  } else {
    const sideL = nd.side === 'shared' ? 'SHARED — a bridge' : (nd.side === 'code' ? 'code-side island' : 'rule-side island');
    html = '<div class="t" style="color:' + (nd.side === 'shared' ? 'var(--shared)' : 'var(--island)') + '">' + nd.name + '</div><div class="row">' + sideL + '</div>';
  }
  card.innerHTML = html; card.style.opacity = 1; moveCard(ev);
}
function moveCard(ev) {
  const pad = 16, w = card.offsetWidth, h = card.offsetHeight;
  let x = ev.clientX + pad, y = ev.clientY + pad;
  if (x + w > innerWidth) x = ev.clientX - w - pad;
  if (y + h > innerHeight) y = ev.clientY - h - pad;
  card.style.left = x + 'px'; card.style.top = y + 'px';
}

// ---- guideline filter ----
const fbox = document.getElementById('filters');
function mkChip(label, val) {
  const b = document.createElement('button'); b.className = 'chip'; b.textContent = label;
  b.setAttribute('aria-pressed', val === activeGuideline);
  b.onclick = () => { activeGuideline = (activeGuideline === val ? null : val); [...fbox.querySelectorAll('.chip')].forEach(c => c.setAttribute('aria-pressed', c === b && activeGuideline === val)); render(); };
  return b;
}
fbox.appendChild(mkChip('all', null));
guidelines.forEach(gd => fbox.appendChild(mkChip(gd, gd)));

render();
addEventListener('resize', () => { clearTimeout(window._rt); window._rt = setTimeout(render, 150); });
</script>`;

writeFileSync(join(HERE, 'cj-graph-viz.html'), HTML);
console.log('wrote cj-graph-viz.html (' + HTML.length + ' bytes)');
