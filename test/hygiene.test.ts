import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { unzipSync } from 'fflate';
import { startApp, seedProject, solid } from './helpers.ts';
import { buildGraph } from '../server/workflow.ts';
import { templateWorkflows } from '../server/export.ts';

test('영역 수정 후보가 있는 프로젝트도 내보내고 다시 가져올 수 있다 (마스크·생성 입력 포함)', async () => {
  const app = await startApp();
  try {
    let p = await seedProject(app);
    await app.call('PUT', `/api/projects/${p.id}/cuts/${p.cuts[0].id}/ref/background`, undefined, await solid('#3a5', 640, 360));
    await app.call('POST', `/api/projects/${p.id}/cuts/${p.cuts[0].id}/generate`, {});
    await app.runner.idle();
    p = await app.call('GET', `/api/projects/${p.id}`);
    const mask = await sharp({ create: { width: 1344, height: 768, channels: 3, background: '#000' } })
      .composite([{ input: { create: { width: 100, height: 100, channels: 3, background: '#fff' } }, left: 10, top: 10 }]).png().toBuffer();
    await app.call('POST', `/api/projects/${p.id}/cuts/${p.cuts[0].id}/candidates/${p.cuts[0].candidates[0].id}/edit`, { instruction: 'x', mask: mask.toString('base64') });
    await app.runner.idle();
    // Replace the background after it was used: the old one is still an input of candidate 1.
    await app.call('PUT', `/api/projects/${p.id}/cuts/${p.cuts[0].id}/ref/background`, undefined, await solid('#a35', 640, 360));
    p = await app.call('GET', `/api/projects/${p.id}`);
    const usedBg = p.cuts[0].candidates[0].generation.references.find((r) => r.role === 'background')!.sha256;
    assert.notEqual(usedBg, p.cuts[0].backgroundRef!.sha256);

    const zip = unzipSync(new Uint8Array(await app.bytes(`/api/projects/${p.id}/export.zip`)));
    const names = Object.keys(zip);
    assert.ok(names.includes(`assets/${p.cuts[0].candidates[1].mask!.sha256}.png`), 'mask exported');
    assert.ok(names.some((n) => n.startsWith(`assets/${usedBg}.`)), 'replaced-but-used background exported');

    const imported = await app.call('POST', '/api/projects/import', undefined, await app.bytes(`/api/projects/${p.id}/export.zip`));
    assert.equal(imported.cuts[0].candidates.length, 2);
  } finally {
    await app.close();
  }
});

test('정리(GC): 아무도 가리키지 않는 파일만 지우고, 생성에 쓰인 참조는 남긴다', async () => {
  const app = await startApp();
  try {
    let p = await seedProject(app);
    const dir = join(app.dir, 'projects', p.id, 'assets');
    // Try three more face photos; only the last stays in the draft. Baseline v1 keeps the original face.
    for (const c of ['#111', '#222', '#333']) await app.call('PUT', `/api/projects/${p.id}/draft/face`, undefined, await solid(c));
    await app.call('PUT', `/api/projects/${p.id}/cuts/${p.cuts[0].id}/ref/background`, undefined, await solid('#3a5'));
    await app.call('POST', `/api/projects/${p.id}/cuts/${p.cuts[0].id}/generate`, {});
    await app.runner.idle();
    await app.call('PUT', `/api/projects/${p.id}/cuts/${p.cuts[0].id}/ref/background`, undefined, await solid('#a35'));
    await app.call('POST', `/api/projects/${p.id}/gc`, {});
    p = await app.call('GET', `/api/projects/${p.id}`);
    const left = (await readdir(dir)).sort();
    const usedBg = p.cuts[0].candidates[0].generation.references.find((x) => x.role === 'background')!.sha256;
    const expected = [
      p.versions[0].faceRef.sha256, p.versions[0].bodyRef.sha256, p.draft.faceRef!.sha256,
      usedBg, p.cuts[0].backgroundRef!.sha256, p.cuts[0].candidates[0].image.sha256,
    ].map((sha) => `${sha}.png`).sort();
    assert.deepEqual(left, expected, 'exactly the referenced files remain; the #111/#222 tries are gone');
    const v = await app.call<{ ok: boolean }>('GET', `/api/projects/${p.id}/verify`);
    assert.ok(v.ok);
  } finally {
    await app.close();
  }
});

test('앱이 ComfyUI에 보내는 그래프는 임시 미리보기로 끝나고, 공개 템플릿은 저장으로 끝난다', () => {
  const runtime = buildGraph({ prompt: 'p', references: [], seed: 1, output: 'preview' });
  assert.equal(runtime['17'].class_type, 'PreviewImage');
  const tpl = templateWorkflows()['generate.api.json'] as Record<string, { class_type: string }>;
  assert.equal(tpl['17'].class_type, 'SaveImage');
});

test('프로젝트 삭제: 실행 중인 작업을 멈추고, 지운 뒤에 폴더가 다시 생기지 않는다', async () => {
  const app = await startApp(undefined, 400);
  try {
    const p = await seedProject(app);
    await app.call('POST', `/api/projects/${p.id}/generate-missing`, { count: 1 });
    await new Promise((r) => setTimeout(r, 150));
    await app.call('DELETE', `/api/projects/${p.id}`);
    await app.runner.idle();
    assert.deepEqual(await readdir(join(app.dir, 'projects')), []);
    assert.equal(app.runner.pending, 0);
    await assert.rejects(app.call('GET', `/api/projects/${p.id}`), /404/);
  } finally {
    await app.close();
  }
});
