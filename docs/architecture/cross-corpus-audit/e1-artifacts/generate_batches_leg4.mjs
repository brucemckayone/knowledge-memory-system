import { readFileSync, writeFileSync } from 'node:fs';
const OUT = 'C:/Users/bruce.mckay/.claude/jobs/fe6c6616/tmp';
const rules = JSON.parse(readFileSync(`${OUT}/leg4_rule_set.json`, 'utf8'));
const els = JSON.parse(readFileSync(`${OUT}/leg4_elements.json`, 'utf8'));
const ruleBlock = rules.map(r => `  - ${r.id}: ${r.text}`).join('\n');
const N = 7;
const batches = Array.from({ length: N }, () => []);
els.forEach((e, i) => batches[i % N].push(e));
const header = (body) => `You are a C++ code reviewer auditing real production functions against this set of C++ Core Guidelines:

${ruleBlock}

For EACH function, list every guideline above that it genuinely violates.

RULES OF THE TASK:
- Consider ONLY the guidelines listed above. Ignore anything else (naming, includes, formatting, comments, error handling style, thread-safety unless it maps to a rule above).
- Judge the actual code shown. Reason directly from it; do NOT assume a linter.
- Report a violation ONLY if you are confident the code really violates that specific guideline. Most real, reviewed production code is compliant — when in doubt, do not flag.
- A function may violate zero, one, or several guidelines. Flag each real one; if none, return an empty list.
- Be specific and correct about WHICH guideline: e.g. a std::unique_ptr member is NOT R.3; a range-for is not ES.75; a static_cast is not Type.1/ES.48 unless it is genuinely unsafe; an accessor that enforces an invariant is not C.131.

Return ONLY a JSON array, no prose, no fences:
[{"id":"E001","findings":[]}, {"id":"E002","findings":[{"rule":"R.3","why":"owns via raw pointer, new/delete"}]}]
Each element MUST appear exactly once. "findings" is a (possibly empty) list of {"rule":"<id>","why":"<=15 words"}.

FUNCTIONS:
${body}`;
batches.forEach((b, i) => {
  const body = b.map(e => `\n### ${e.id}\n\`\`\`cpp\n${e.code}\n\`\`\``).join('\n');
  writeFileSync(`${OUT}/leg4_batch_${i + 1}.txt`, header(body));
});
console.log(`wrote ${N} batches:`, batches.map((b, i) => `b${i + 1}=${b.length}`).join(', '), `total=${els.length}`);
