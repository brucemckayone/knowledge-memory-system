/**
 * Diagnostic: invoke claude directly with our agent helper and dump the raw output.
 */
import { runAgent } from './services/agent.js';

async function main() {
  console.log('--- Test 1: with system prompt, no MCP ---');
  try {
    const r1 = await runAgent('Generate a 2-section mini-course on the Pythagorean theorem.', {
      model: 'haiku',
      effort: 'low',
      maxTurns: 1,
      systemPrompt: `You are a curriculum designer. Output ONLY this JSON (no surrounding text or markdown):
{
  "title": "string",
  "sections": [
    {"title": "string", "concepts": ["string"]}
  ]
}`,
    });
    console.log('result:', JSON.stringify(r1.result).slice(0, 500));
    console.log('cost:', r1.cost);
  } catch (e) {
    console.error('test1 failed:', e instanceof Error ? e.message : e);
  }

  console.log('\n--- Test 2: with stripped MCP tool surface, sonnet ---');
  try {
    const r2 = await runAgent('Output the JSON: {"status": "alive"}', {
      model: 'sonnet',
      effort: 'low',
      maxTurns: 1,
      systemPrompt: 'You are a JSON output bot. Output exactly what the user asks for, in valid JSON, with nothing else.',
    });
    console.log('result:', JSON.stringify(r2.result).slice(0, 500));
  } catch (e) {
    console.error('test2 failed:', e instanceof Error ? e.message : e);
  }
}

main().catch(console.error);
