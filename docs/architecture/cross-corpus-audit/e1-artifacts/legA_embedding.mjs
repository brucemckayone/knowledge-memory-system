// E1 proxy — Leg A: honest embedding baseline ("the vague skill").
// Embed each code element's neutral behaviour summary, search vs a pool of
// C++ Core Guidelines, measure recall@5 (is the governing rule in the top 5).
// Runs prefixed (nomic search_query/search_document) and unprefixed.

const OLLAMA = 'http://localhost:11434';
const MODEL = 'nomic-embed-text';

// ~55 C++ Core Guidelines (faithful short statements). The 12 governing rules
// plus realistic near-neighbour distractors (incl. dropped I.11/R.5 as decoys).
const RULES = [
  ['ES.20', 'Always initialize an object. Avoid uninitialized variables; give every object a value before it is used.'],
  ['C.48',  'Prefer in-class member initializers to member initialization in the constructor; initialize all data members, never leave them uninitialized.'],
  ['R.3',   'A raw pointer (a T*) is non-owning. Raw pointers must not own the objects they point to; use them only as non-owning references.'],
  ['C.4',   'Make a function a member only if it needs direct access to the representation of a class; a function that does not touch the object need not be a member.'],
  ['F.21',  'To return multiple out values, prefer returning a struct or tuple rather than using many output parameters passed by reference.'],
  ['C.131', 'Avoid trivial getters and setters; a getter or setter that merely returns or assigns a member adds no value.'],
  ['ES.71', 'Prefer a range-for statement to a plain for-statement; iterate over a container directly instead of using an integer index.'],
  ['C.132', 'Do not make a function virtual without reason; unnecessary virtual functions add cost and complexity.'],
  ['P.1',   'Express ideas directly in code. State intent in code rather than encoding it indirectly in ad-hoc computations.'],
  ['P.3',   'Express intent. Make the purpose of code clear through names and structure, not through comments explaining obscure code.'],
  ['ES.1',  'Prefer the standard library to other libraries and to handcrafted code; reuse standard algorithms and containers instead of reinventing them.'],
  ['P.11',  'Encapsulate messy constructs rather than spreading them through the code; wrap low-level or error-prone operations behind a clean interface.'],
  // distractors
  ['P.2',   'Write in ISO Standard C++.'],
  ['P.4',   'Ideally, a program should be statically type safe.'],
  ['P.5',   'Prefer compile-time checking to run-time checking.'],
  ['P.9',   'Do not waste time or space.'],
  ['I.2',   'Avoid non-const global variables.'],
  ['I.4',   'Make interfaces precisely and strongly typed.'],
  ['I.11',  'Never transfer ownership by a raw pointer or reference.'],
  ['I.13',  'Do not pass an array as a single pointer.'],
  ['I.23',  'Keep the number of function arguments low.'],
  ['F.1',   'Package meaningful operations as carefully named functions.'],
  ['F.2',   'A function should perform a single logical operation.'],
  ['F.6',   'If your function must not throw, declare it noexcept.'],
  ['F.15',  'Prefer simple and conventional ways of passing information.'],
  ['F.16',  'For in parameters, pass cheaply-copied types by value and others by reference to const.'],
  ['F.17',  'For in-out parameters, pass by reference to non-const.'],
  ['F.20',  'For out output values, prefer return values to output parameters.'],
  ['F.43',  'Never directly or indirectly return a pointer or reference to a local object.'],
  ['C.2',   'Use class if the type has an invariant; use struct if the data members can vary independently.'],
  ['C.9',   'Minimize exposure of members.'],
  ['C.12',  'Do not make data members const or references in a copyable or movable type.'],
  ['C.20',  'If you can avoid defining default operations, do.'],
  ['C.21',  'If you define or delete any copy, move, or destructor function, define or delete them all.'],
  ['C.35',  'A base class destructor should be either public and virtual, or protected and non-virtual.'],
  ['C.45',  'Do not define a default constructor that only initializes data members; use in-class member initializers instead.'],
  ['C.46',  'By default, declare single-argument constructors explicit.'],
  ['C.128', 'Virtual functions should specify exactly one of virtual, override, or final.'],
  ['Con.1', 'By default, make objects immutable.'],
  ['Con.2', 'By default, make member functions const.'],
  ['R.1',   'Manage resources automatically using resource handles and RAII.'],
  ['R.5',   'Prefer scoped objects; do not heap-allocate unnecessarily.'],
  ['R.10',  'Avoid malloc and free.'],
  ['R.11',  'Avoid calling new and delete explicitly.'],
  ['R.20',  'Use unique_ptr or shared_ptr to represent ownership.'],
  ['ES.5',  'Keep scopes small.'],
  ['ES.10', 'Declare one name only per declaration.'],
  ['ES.21', 'Do not introduce a variable or constant before you need to use it.'],
  ['ES.23', 'Prefer the braced initializer syntax.'],
  ['ES.45', 'Avoid magic constants; use symbolic constants.'],
  ['ES.50', 'Do not cast away const.'],
  ['ES.78', 'Do not rely on implicit fallthrough in switch statements.'],
  ['Enum.3','Prefer enum classes over plain enums.'],
  ['T.1',   'Use templates to raise the level of abstraction of code.'],
  ['CP.1',  'Assume that your code will run as part of a multi-threaded program.'],
];

// 12 elements — neutral behaviour summaries (do NOT name the rule).
const ELEMENTS = [
  { pair: 1,  tier: 1, gid: 'ES.20', summary: 'Inside a function, a numeric local variable is declared and given an initial value at the point of declaration before it is used.' },
  { pair: 2,  tier: 1, gid: 'C.48',  summary: 'A small struct groups two floating-point data members; it has no constructor and no default values for the members.' },
  { pair: 3,  tier: 2, gid: 'R.3',   summary: 'A class holds a bare pointer member that refers to data belonging to another object; it reads through the pointer and never allocates or frees it.' },
  { pair: 4,  tier: 2, gid: 'C.4',   summary: 'A class member function computes its result purely from its argument and a constant, using none of the object’s own data.' },
  { pair: 5,  tier: 2, gid: 'F.21',  summary: 'A function returns a boolean and writes many separate results back to the caller through a long list of reference parameters.' },
  { pair: 6,  tier: 2, gid: 'C.131', summary: 'A class method’s entire body is a single statement that returns one private data member unchanged.' },
  { pair: 7,  tier: 2, gid: 'ES.71', summary: 'A loop walks the elements of a container using an integer index that runs from zero up to the container’s size.' },
  { pair: 8,  tier: 2, gid: 'C.132', summary: 'A base class declares a member function that derived classes can override.' },
  { pair: 9,  tier: 3, gid: 'P.1',   summary: 'A physical model’s seasonal variation is computed as a long inline arithmetic expression combining several coefficients and trigonometric terms.' },
  { pair: 10, tier: 3, gid: 'P.3',   summary: 'Several local variables hold intermediate trigonometric quantities under short, abbreviated names whose meaning is not obvious.' },
  { pair: 11, tier: 3, gid: 'ES.1',  summary: 'Code fills a fixed-size byte buffer by looping over indices and assigning each element one value at a time.' },
  { pair: 12, tier: 3, gid: 'P.11',  summary: 'A helper performs a bitwise left rotation by shifting and OR-ing the bits of an unsigned integer.' },
];

async function embed(text, prefix) {
  const res = await fetch(`${OLLAMA}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, prompt: prefix + text }),
  });
  if (!res.ok) throw new Error(`ollama ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return j.embedding;
}
function cosine(a, b) {
  let d = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { d += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return d / (Math.sqrt(na)*Math.sqrt(nb));
}

async function run(usePrefix) {
  const qp = usePrefix ? 'search_query: ' : '';
  const dp = usePrefix ? 'search_document: ' : '';
  const ruleVecs = [];
  for (const [id, text] of RULES) ruleVecs.push({ id, v: await embed(text, dp) });

  const tiers = { 1: { hit: 0, n: 0 }, 2: { hit: 0, n: 0 }, 3: { hit: 0, n: 0 } };
  const lines = [];
  for (const e of ELEMENTS) {
    const qv = await embed(e.summary, qp);
    const scored = ruleVecs.map(r => ({ id: r.id, s: cosine(qv, r.v) })).sort((a, b) => b.s - a.s);
    const top5 = scored.slice(0, 5).map(x => x.id);
    const rank = scored.findIndex(x => x.id === e.gid) + 1;
    const hit = top5.includes(e.gid);
    tiers[e.tier].n++; if (hit) tiers[e.tier].hit++;
    lines.push(`  pair ${String(e.pair).padStart(2)} T${e.tier} ${e.gid.padEnd(6)} ${hit ? 'HIT ' : 'miss'} rank=${String(rank).padStart(2)}  top5=[${top5.join(', ')}]`);
  }
  const r = t => `${tiers[t].hit}/${tiers[t].n} (${(tiers[t].hit/tiers[t].n).toFixed(2)})`;
  const overallHit = tiers[1].hit + tiers[2].hit + tiers[3].hit;
  console.log(`\n===== ${usePrefix ? 'PREFIXED (search_query/search_document)' : 'UNPREFIXED (symmetric, ~original E1)'} =====`);
  console.log(lines.join('\n'));
  console.log(`  ---`);
  console.log(`  Tier 1 recall@5: ${r(1)}   Tier 2: ${r(2)}   Tier 3: ${r(3)}   OVERALL: ${overallHit}/12 (${(overallHit/12).toFixed(2)})`);
}

try {
  await run(true);
  await run(false);
} catch (err) {
  console.error('FAILED:', err.message);
  process.exit(1);
}
