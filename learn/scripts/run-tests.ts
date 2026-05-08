import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(import.meta.dirname, '..', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}

const files = walk(root);
if (files.length === 0) {
  console.log('No test files found.');
  process.exit(0);
}

const child = spawn(
  process.execPath,
  ['--import', 'tsx', '--test', ...files],
  { stdio: 'inherit' },
);
child.on('exit', (code) => process.exit(code ?? 1));
