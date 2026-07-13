import { readFileSync, writeFileSync } from 'node:fs';
const OUT = 'C:/Users/bruce.mckay/.claude/jobs/fe6c6616/tmp';
const rules = JSON.parse(readFileSync(`${OUT}/leg3_rule_set.json`, 'utf8'));
const els = JSON.parse(readFileSync(`${OUT}/leg3_elements.json`, 'utf8'));
const ruleBlock = rules.map(r => `  - ${r.id}: ${r.text}`).join('\n');
const N = 5;
const batches = Array.from({ length: N }, () => []);
els.forEach((e, i) => batches[i % N].push(e));
const header = (body) => `You are reviewing individual C++ code snippets against a FIXED set of C++ Core Guidelines.
For each snippet, decide whether the code violates any of these guidelines:

${ruleBlock}

TASK RULES:
- Consider ONLY these guidelines. Ignore everything else (naming, formatting, includes, error handling, style).
- Judge the snippet as a whole unit (a function or small class).
- Reason directly from the code — do NOT assume or invoke any linter/tool.
- Do not force a finding. Many snippets are correct and violate none — for those, answer "none".
- If it is a real violation, name the SINGLE most specific guideline id above.

Return ONLY a JSON array, no prose, no fences:
[{"id":"E001","finding":"none","why":"..."}, {"id":"E002","finding":"R.3","why":"..."}]
"finding" is "none" or one guideline id. "why" is <= 20 words.

SNIPPETS:
${body}`;
batches.forEach((b, i) => {
  const body = b.map(e => `\n### ${e.id}\n\`\`\`cpp\n${e.code}\n\`\`\``).join('\n');
  writeFileSync(`${OUT}/leg3_batch_${i + 1}.txt`, header(body));
});
console.log(`wrote ${N} batches:`, batches.map((b, i) => `b${i + 1}=${b.length}`).join(', '), `total=${els.length}`);
