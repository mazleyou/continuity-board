// End-to-end check against a real ComfyUI: makes two reference images with text-only generation,
// then drives the full app flow (baseline → 6 cuts → approve → edit one cut → verify → export) through the HTTP API.
//
//   COMFY_URL=http://127.0.0.1:8188 node scripts/smoke-comfy.ts [outDir]
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { ComfyBackend } from '../server/backends/comfy.ts';
import { blendAlpha } from '../server/inpaint.ts';
import { MODELS, PRESET_NAME } from '../server/workflow.ts';
import { Store } from '../server/store.ts';
import { createApp } from '../server/app.ts';
import type { Project } from '../server/model.ts';

const out = resolve(process.argv[2] ?? 'data/smoke');
await mkdir(out, { recursive: true });
const backend = new ComfyBackend(process.env.COMFY_URL ?? 'http://127.0.0.1:8188');
const health = await backend.health();
if (!health.ok) throw new Error(health.detail + (health.missingModels ? `: ${health.missingModels.join(', ')}` : ''));

const timings: Record<string, number | string> = {};
async function t2i(name: string, prompt: string, width: number, height: number) {
  const existing = await readFile(join(out, `${name}.png`)).catch(() => null);
  if (existing) return existing;
  const t0 = Date.now();
  const r = await backend.run({ kind: 'generate', prompt, references: [], seed: 20261012, width, height, label: `smoke_${name}` });
  timings[`ref:${name}${r.coldStart ? ' (cold)' : ''}`] = Date.now() - t0;
  await writeFile(join(out, `${name}.png`), r.image);
  return r.image;
}

const look = 'a woman in her late 20s with short straight black hair, wearing a bright yellow jacket over a white t-shirt, dark blue jeans, white sneakers, carrying a small red shoulder bag';
const face = await t2i('ref-face', `Character reference photo: head and shoulders portrait, facing the camera, neutral expression, ${look}. Plain light grey studio background, soft even lighting.`, 768, 768);
const body = await t2i('ref-body', `Character reference photo: full body, standing straight, facing the camera, head to toe visible, ${look}. Plain light grey studio background.`, 640, 1024);

const store = new Store(await mkdtemp(join(tmpdir(), 'cb-smoke-')));
const { server, runner } = createApp(store, backend, resolve(import.meta.dirname, '../web'));
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
const call = async (method: string, path: string, body?: unknown, raw?: Buffer): Promise<Project> => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': raw ? 'application/octet-stream' : 'application/json' },
    body: raw ? new Uint8Array(raw) : body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${await res.text()}`);
  return res.json();
};

let p = await call('POST', '/api/projects', { title: '스모크 테스트 — 출근길' });
await call('PUT', `/api/projects/${p.id}/draft/face`, undefined, face);
await call('PUT', `/api/projects/${p.id}/draft/body`, undefined, body);
await call('PUT', `/api/projects/${p.id}/draft/traits`, {
  traits: { name: 'Mina', hair: 'short straight black hair', outfit: 'bright yellow jacket, white t-shirt, dark blue jeans, white sneakers', props: 'small red shoulder bag', notes: '' },
});
p = await call('POST', `/api/projects/${p.id}/versions`);
const scenes = [
  { location: 'a busy city bus stop in the morning', action: 'waiting and checking her phone', expression: 'sleepy', shot: 'wide' },
  { location: 'inside a crowded bus', action: 'holding the hand strap', expression: 'tired', shot: 'medium' },
  { location: 'a coffee shop counter', action: 'ordering coffee', expression: 'smiling', shot: 'medium' },
  { location: 'a crosswalk in light rain', action: 'running across the street', expression: 'surprised', shot: 'full' },
  { location: 'an office lobby', action: 'swiping her badge at the gate', expression: 'relieved', shot: 'medium' },
  { location: 'her office desk by a window', action: 'sitting down and opening a laptop', expression: 'confident', shot: 'close-up' },
];
for (const [i, cut] of p.cuts.entries()) p = await call('PATCH', `/api/projects/${p.id}/cuts/${cut.id}`, { scene: scenes[i] });

await call('POST', `/api/projects/${p.id}/generate-missing`, { count: 1 });
await runner.idle();
p = await call('GET', `/api/projects/${p.id}`);
const failed = p.jobs.filter((j) => j.status === 'failed');
if (failed.length) throw new Error(failed.map((j) => j.error).join('\n'));
for (const cut of p.cuts) p = await call('POST', `/api/projects/${p.id}/cuts/${cut.id}/approve`, { candidateId: cut.candidates[0].id });

const before = p.cuts.map((c) => c.candidates[0].image.sha256);
const target = p.cuts[3];
await call('POST', `/api/projects/${p.id}/cuts/${target.id}/candidates/${target.approvedCandidateId}/edit`, {
  instruction: 'Change her bag to a small green backpack',
});
await runner.idle();
p = await call('GET', `/api/projects/${p.id}`);
const edit = p.cuts[3].candidates.at(-1)!;
if (edit.kind !== 'edit') throw new Error(`edit failed: ${p.jobs.at(-1)?.error}`);
p = await call('POST', `/api/projects/${p.id}/cuts/${target.id}/approve`, { candidateId: edit.id });
const after = p.cuts.map((c) => c.candidates.find((x) => x.id === c.approvedCandidateId)!.image.sha256);
const preserved = after.every((h, i) => i === 3 || h === before[i]);

// Masked edit on cut 3: only the lower-right quarter may change; everything else must stay byte-identical.
const maskCut = p.cuts[2];
const maskSource = maskCut.candidates.find((c) => c.id === maskCut.approvedCandidateId)!;
const mask = await sharp({ create: { width: 1344, height: 768, channels: 3, background: '#000' } })
  .composite([{ input: { create: { width: 560, height: 360, channels: 3, background: '#fff' } }, left: 700, top: 360 }]).png().toBuffer();
await call('POST', `/api/projects/${p.id}/cuts/${maskCut.id}/candidates/${maskSource.id}/edit`, {
  instruction: 'Place a small potted green plant on the counter', mask: mask.toString('base64'),
});
await runner.idle();
p = await call('GET', `/api/projects/${p.id}`);
const masked = p.cuts[2].candidates.at(-1)!;
if (!masked.mask) throw new Error(`masked edit failed: ${p.jobs.at(-1)?.error}`);
const rawOf = async (sha: string, ext: string) => sharp(await store.readAsset(p.id, { sha256: sha, ext: ext as 'png' })).removeAlpha().raw().toBuffer();
const [before3, after3] = await Promise.all([rawOf(maskSource.image.sha256, maskSource.image.ext), rawOf(masked.image.sha256, masked.image.ext)]);
const alpha = await blendAlpha(mask, 1344, 768);
let outsideChanged = 0, insideChanged = 0;
for (let px = 0; px < alpha.length; px++) {
  const same = before3[px * 3] === after3[px * 3] && before3[px * 3 + 1] === after3[px * 3 + 1] && before3[px * 3 + 2] === after3[px * 3 + 2];
  if (!same && alpha[px] === 0) outsideChanged++;
  if (!same && alpha[px] === 255) insideChanged++;
}

const verify = await (await fetch(`${base}/api/projects/${p.id}/verify`)).json();
await writeFile(join(out, 'board.png'), Buffer.from(await (await fetch(`${base}/api/projects/${p.id}/board.png`)).arrayBuffer()));
await writeFile(join(out, 'export.zip'), Buffer.from(await (await fetch(`${base}/api/projects/${p.id}/export.zip`)).arrayBuffer()));
for (const cut of p.cuts) {
  for (const c of cut.candidates) {
    await writeFile(join(out, `cut${cut.index + 1}-${c.kind}-${c.id}.png`), await store.readAsset(p.id, c.image));
    const ph = c.generation.phases ?? {};
    timings[`cut${cut.index + 1}:${c.kind}${c.mask ? '-masked' : ''}${c.generation.coldStart ? ' (cold)' : ''}`] =
      `${c.generation.durationMs}ms (prepare ${ph.prepareMs ?? '?'} / sample ${ph.sampleMs ?? '?'} / finish ${ph.finishMs ?? '?'})`;
  }
}
const report = {
  comfy: health.detail, preset: PRESET_NAME, models: MODELS, timingsMs: timings, otherApprovedCutsPreserved: preserved,
  maskedEdit: { pixelsChangedOutsideMask: outsideChanged, pixelsChangedInsideMask: insideChanged },
  integrity: verify.ok, projectData: store.root,
};
await writeFile(join(out, 'report.json'), JSON.stringify(report, null, 2));
server.close();
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
