import { test } from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import sharp from 'sharp';
import { startApp, seedProject } from './helpers.ts';
import { generationPrompt, editPrompt, generationRefs } from '../server/prompt.ts';
import { blendAlpha } from '../server/inpaint.ts';
import type { Project } from '../server/model.ts';

/** Raw request so Host/Origin headers can be forged (fetch does not allow setting Host). */
function rawRequest(base: string, method: string, path: string, headers: Record<string, string>, body = '') {
  const url = new URL(base + path);
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, method, path, headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode!, body: data }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('보안: 다른 사이트·DNS 리바인딩·preflight 없는 형식의 요청을 거부한다', async () => {
  const app = await startApp();
  try {
    const host = new URL(app.base).host;
    const json = { 'content-type': 'application/json' };
    const create = '{"title":"x"}';
    assert.equal((await rawRequest(app.base, 'POST', '/api/projects', { ...json, host, origin: 'https://evil.example' }, create)).status, 403);
    assert.equal((await rawRequest(app.base, 'POST', '/api/projects', { 'content-type': 'text/plain', host }, create)).status, 403);
    assert.equal((await rawRequest(app.base, 'GET', '/api/projects', { host: 'evil.example:80' })).status, 403);
    assert.equal((await rawRequest(app.base, 'GET', '/', { host: `rebind.example:${new URL(app.base).port}` })).status, 403);
    assert.equal((await rawRequest(app.base, 'POST', '/api/projects', { ...json, host, origin: 'null' }, create)).status, 403);
    // The app's own page (same origin) and non-browser clients still work.
    assert.equal((await rawRequest(app.base, 'POST', '/api/projects', { ...json, host, origin: app.base }, create)).status, 200);
    assert.equal((await rawRequest(app.base, 'POST', '/api/projects', { ...json, host: `localhost:${new URL(app.base).port}` }, create)).status, 200);
  } finally {
    await app.close();
  }
});

test('가져오기는 40MB를 넘는 파일도 받는다 (일반 요청은 40MB 제한)', async () => {
  const app = await startApp();
  try {
    const big = Buffer.alloc(41 * 1024 * 1024);
    const imp = await app.call('POST', '/api/projects/import', undefined, big).catch((e) => e);
    assert.doesNotMatch(String(imp.message), /너무 큽니다/);
    const p = await app.call('POST', '/api/projects', { title: 'x' });
    const up = await app.call('PUT', `/api/projects/${p.id}/draft/face`, undefined, big).catch((e) => e);
    assert.match(String(up.message), /너무 큽니다/);
  } finally {
    await app.close();
  }
});

test('실행 중·대기 중 작업을 취소하면 후보 없이 “취소됨”으로 남고, 다시 시도할 수 있다', async () => {
  const app = await startApp(undefined, 400);
  try {
    let p = await seedProject(app);
    const cut = p.cuts[0];
    p = await app.call('POST', `/api/projects/${p.id}/cuts/${cut.id}/generate`, { count: 2 });
    // Wait until the first job is running and has reported progress.
    let live: Record<string, unknown> = {};
    for (let i = 0; i < 50 && !Object.keys(live).length; i++) {
      await new Promise((r) => setTimeout(r, 40));
      live = (await app.call<Project & { live: Record<string, unknown> }>('GET', `/api/projects/${p.id}`)).live;
    }
    assert.equal(Object.keys(live).length, 1, 'running job exposes live progress');
    const [running, queued] = p.jobs;
    await app.call('DELETE', `/api/projects/${p.id}/jobs/${queued.id}`);
    await app.call('DELETE', `/api/projects/${p.id}/jobs/${running.id}`);
    await app.runner.idle();
    p = await app.call('GET', `/api/projects/${p.id}`);
    assert.deepEqual(p.jobs.map((j) => j.status), ['cancelled', 'cancelled']);
    assert.equal(p.cuts[0].candidates.length, 0);

    await app.call('POST', `/api/projects/${p.id}/jobs/${queued.id}/retry`);
    await app.runner.idle();
    p = await app.call('GET', `/api/projects/${p.id}`);
    assert.equal(p.jobs.find((j) => j.id === queued.id)!.status, 'done');
    // Dismissing a finished record removes it.
    p = await app.call('DELETE', `/api/projects/${p.id}/jobs/${running.id}`);
    assert.equal(p.jobs.length, 1);
  } finally {
    await app.close();
  }
});

test('이전 기준 컷 갱신: 이전 기준으로 승인된 컷에만 수정 작업을 만들고, 승인은 바꾸지 않는다', async () => {
  const app = await startApp();
  try {
    let p = await seedProject(app);
    for (const cut of p.cuts.slice(0, 2)) await app.call('POST', `/api/projects/${p.id}/cuts/${cut.id}/generate`, {});
    await app.runner.idle();
    p = await app.call('GET', `/api/projects/${p.id}`);
    for (const cut of p.cuts.slice(0, 2)) p = await app.call('POST', `/api/projects/${p.id}/cuts/${cut.id}/approve`, { candidateId: cut.candidates[0].id });
    const approvedBefore = p.cuts.map((c) => c.approvedCandidateId);
    await app.call('PUT', `/api/projects/${p.id}/draft/traits`, { traits: { ...p.draft.traits, outfit: 'green jacket' } });
    await app.call('POST', `/api/projects/${p.id}/versions`);

    p = await app.call('POST', `/api/projects/${p.id}/refresh-stale`);
    const edits = p.jobs.filter((j) => j.kind === 'edit');
    assert.equal(edits.length, 2);
    assert.ok(edits.every((j) => j.characterVersionId === p.versions[1].id));
    await app.runner.idle();
    p = await app.call('GET', `/api/projects/${p.id}`);
    assert.deepEqual(p.cuts.map((c) => c.approvedCandidateId), approvedBefore);
    assert.equal(p.cuts[0].candidates.at(-1)!.parentId, approvedBefore[0]);
    // Cuts that already have a refresh candidate from the current baseline are not redone.
    p = await app.call('POST', `/api/projects/${p.id}/refresh-stale`);
    assert.equal(p.jobs.filter((j) => j.kind === 'edit').length, 2);
  } finally {
    await app.close();
  }
});

test('영역 수정: 칠한 영역 밖의 픽셀은 원본과 바이트 단위로 같다', async () => {
  const app = await startApp();
  try {
    let p = await seedProject(app);
    const cut = p.cuts[2];
    await app.call('POST', `/api/projects/${p.id}/cuts/${cut.id}/generate`, {});
    await app.runner.idle();
    p = await app.call('GET', `/api/projects/${p.id}`);
    const source = p.cuts[2].candidates[0];

    // Mask: a 200×150 box in the middle.
    const mask = await sharp({ create: { width: 1344, height: 768, channels: 3, background: '#000' } })
      .composite([{ input: { create: { width: 200, height: 150, channels: 3, background: '#fff' } }, left: 600, top: 300 }])
      .png().toBuffer();
    p = await app.call('POST', `/api/projects/${p.id}/cuts/${cut.id}/candidates/${source.id}/edit`, {
      instruction: 'make the bag green', mask: `data:image/png;base64,${mask.toString('base64')}`,
    });
    await app.runner.idle();
    p = await app.call('GET', `/api/projects/${p.id}`);
    const edited = p.cuts[2].candidates.at(-1)!;
    assert.equal(p.jobs.at(-1)!.status, 'done', p.jobs.at(-1)!.error);
    assert.ok(edited.mask, 'mask is recorded on the candidate');
    assert.match(edited.generation.prompt, /^In image 1, make the bag green\./);

    const raw = async (sha: string) => sharp(await app.bytes(`/api/projects/${p.id}/assets/${sha}.png`)).removeAlpha().raw().toBuffer();
    const [a, b] = await Promise.all([raw(source.image.sha256), raw(edited.image.sha256)]);
    const alpha = await blendAlpha(mask, 1344, 768);
    let outsideDiff = 0, insideDiff = 0;
    for (let px = 0; px < alpha.length; px++) {
      const same = a[px * 3] === b[px * 3] && a[px * 3 + 1] === b[px * 3 + 1] && a[px * 3 + 2] === b[px * 3 + 2];
      if (alpha[px] === 0 && !same) outsideDiff++;
      if (alpha[px] === 255 && !same) insideDiff++;
    }
    assert.equal(outsideDiff, 0, 'pixels outside the grown mask must be untouched');
    assert.ok(insideDiff > 1000, 'pixels inside the mask should change');

    // Empty mask is rejected.
    const empty = await sharp({ create: { width: 1344, height: 768, channels: 3, background: '#000' } }).png().toBuffer();
    await assert.rejects(app.call('POST', `/api/projects/${p.id}/cuts/${cut.id}/candidates/${source.id}/edit`, {
      instruction: 'x', mask: empty.toString('base64'),
    }), /영역을 칠하세요/);
  } finally {
    await app.close();
  }
});

test('프롬프트: 패널 번호·부정문 없이 인물 먼저, 닮음 유지, 스타일로 끝난다', () => {
  const asset = { sha256: 'a'.repeat(64), ext: 'png' as const, width: 1, height: 1 };
  const version = {
    id: 'v', number: 1, createdAt: '', faceRef: asset, bodyRef: asset,
    traits: { name: 'Mina', hair: 'short black hair', outfit: 'a yellow jacket', props: 'a red bag', notes: '' },
  };
  const cut = {
    id: 'c', index: 2, candidates: [], approvedCandidateId: null, approvals: [],
    scene: { location: 'a coffee shop', action: 'ordering coffee', expression: 'smiling', shot: 'medium' as const },
  };
  const prompt = generationPrompt({ style: 'flat illustration' } as Project, version, cut, generationRefs(version, cut));
  assert.match(prompt, /^Mina, the person from image 1, maintaining exact likeness/);
  assert.doesNotMatch(prompt, /frame \d|of 6|Do not|don't|\bnot\b/i);
  assert.match(prompt, /Style: flat illustration\. Mood: smiling\.$/);
  assert.match(prompt, /Lighting: /);
  assert.match(prompt, /Mina appears exactly once in the frame/);
  const edit = editPrompt(version, 'Change the bag to green');
  assert.match(edit, /^In image 1, change the bag to green\./);
  assert.match(edit, /lighting/);
});

test('미승인 컷 모두 생성: 장면이 빈 컷은 건너뛰고 나머지는 생성한다', async () => {
  const app = await startApp();
  try {
    let p = await seedProject(app);
    for (const c of p.cuts.slice(4)) p = await app.call('PATCH', `/api/projects/${p.id}/cuts/${c.id}`, { scene: { location: '', action: '', expression: '', shot: 'wide' } });
    const r = await app.call<Project & { skipped: number[] }>('POST', `/api/projects/${p.id}/generate-missing`, { count: 1 });
    assert.equal(r.jobs.length, 4);
    assert.deepEqual(r.skipped, [5, 6]);
    await app.runner.idle();
    // With only empty cuts left, the request explains why nothing was queued.
    for (const c of r.cuts.slice(0, 4)) {
      const q = await app.call('GET', `/api/projects/${p.id}`);
      await app.call('POST', `/api/projects/${p.id}/cuts/${c.id}/approve`, { candidateId: q.cuts[c.index].candidates[0].id });
    }
    await assert.rejects(app.call('POST', `/api/projects/${p.id}/generate-missing`, {}), /400 .*컷 5, 6/);
  } finally {
    await app.close();
  }
});
