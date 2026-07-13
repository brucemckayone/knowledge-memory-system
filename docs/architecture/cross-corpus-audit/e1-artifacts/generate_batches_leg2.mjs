import { readFileSync, writeFileSync } from 'node:fs';
const OUT = 'C:/Users/bruce.mckay/.claude/jobs/fe6c6616/tmp';
const rules = JSON.parse(readFileSync(`${OUT}/leg2_rule_set.json`, 'utf8'));
const els = JSON.parse(readFileSync(`${OUT}/leg2_elements.json`, 'utf8'));
const ruleBlock = rules.map(r => `  - ${r.id}: ${r.text}`).join('\n');
const N = 5;
const batches = Array.from({ length: N }, () => []);
els.forEach((e, i) => batches[i % N].push(e));
const header = (elemsJson) => `You are auditing individual C++ code elements against a FIXED set of C++ Core Guidelines.
For each element, decide whether the code AT THE MARKED LINE (marked with ">") violates any of these guidelines:

${ruleBlock}

TASK RULES:
- Consider ONLY these guidelines. Ignore everything else (naming, includes, formatting, style, tests).
- Judge the specific element at the marked ">" line; use the window only as context.
- Do NOT assume, invoke, or imagine a linter/tool. Reason directly from the code.
- Do not force a finding. Many elements violate none — for those, answer "none".
- If it is a real violation, name the SINGLE most specific guideline id above.

Return ONLY a JSON array, no prose, no fences:
[{"id":"E001","finding":"none","why":"..."}, {"id":"E002","finding":"Type.1","why":"..."}]
"finding" is either "none" or one guideline id. "why" is <= 20 words.

ELEMENTS:
${elemsJson}`;
batches.forEach((b, i) => {
  const elemsJson = b.map(e => `\n### ${e.id}  (${e.file})\n${e.code}`).join('\n');
  writeFileSync(`${OUT}/leg2_batch_${i + 1}.txt`, header(elemsJson));
});
console.log(`wrote ${N} batches:`, batches.map((b, i) => `b${i + 1}=${b.length}`).join(', '), ` total=${els.length}`);
