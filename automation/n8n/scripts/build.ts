/** Writes the importable workflow JSON (automation/n8n/workflows/) from src/workflows.ts. */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildWorkflows, fileName } from '../src/workflows';

const dir = join(import.meta.dirname, '..', 'workflows');
mkdirSync(dir, { recursive: true });
const written = new Set<string>();
for (const w of buildWorkflows()) {
  const file = fileName(w);
  writeFileSync(join(dir, file), `${JSON.stringify(w, null, 2)}\n`);
  written.add(file);
}
for (const f of readdirSync(dir)) if (!written.has(f)) rmSync(join(dir, f));
// eslint-disable-next-line no-console -- build script output
console.log(`wrote ${[...written].sort().join(', ')}`);
