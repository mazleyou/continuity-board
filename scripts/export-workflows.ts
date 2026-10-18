// Writes the two template workflows (API + UI formats) to workflows/ so they can be opened in ComfyUI directly.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { templateWorkflows } from '../server/export.ts';

const dir = resolve(import.meta.dirname, '../workflows');
await mkdir(dir, { recursive: true });
for (const [name, wf] of Object.entries(templateWorkflows())) {
  await writeFile(resolve(dir, name), JSON.stringify(wf, null, 2) + '\n');
}
