// Aggregates every project in the data directory into an evaluation report (Markdown + JSON).
//
//   npm run report [-- dataDir [outDir]]      (defaults: $CB_DATA or ./data, and the data directory)
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Store } from '../server/store.ts';
import { buildReport, renderMarkdown } from '../server/report.ts';

const dataDir = resolve(process.argv[2] ?? process.env.CB_DATA ?? 'data');
const outDir = resolve(process.argv[3] ?? dataDir);
const store = new Store(dataDir);
const list = await store.list();
const projects = await Promise.all(list.map((p) => store.load(p.id)));
const report = buildReport(projects);
report.integrity = await Promise.all(projects.map(async (p) => {
  const v = await store.verify(p.id);
  return { project: p.title, ok: v.ok, problems: v.problems };
}));
await writeFile(join(outDir, 'evaluation-report.md'), renderMarkdown(report));
await writeFile(join(outDir, 'evaluation-report.json'), JSON.stringify(report, null, 2));
process.stdout.write(`${join(outDir, 'evaluation-report.md')}\n`);
