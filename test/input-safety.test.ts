import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { startApp, seedProject } from './helpers.ts';

test('업로드한 참조에서 GPS·카메라 메타데이터를 지우고 회전을 반영한다', async () => {
  const app = await startApp();
  try {
    // 400×300 pixels stored sideways with "rotate 90°" (EXIF orientation 6), as phone cameras do.
    const jpg = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#a33' } })
      .jpeg().withExif({
        IFD0: { Make: 'PhoneCo', Model: 'X1' },
        IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '37/1 33/1 0/1', GPSLongitudeRef: 'E', GPSLongitude: '126/1 58/1 0/1' },
      }).withMetadata({ orientation: 6 }).toBuffer();
    assert.equal((await sharp(jpg).metadata()).orientation, 6);
    const p = await app.call('POST', '/api/projects', { title: 'x' });
    const q = await app.call('PUT', `/api/projects/${p.id}/draft/face`, undefined, jpg);
    const a = q.draft.faceRef!;
    const stored = await app.bytes(`/api/projects/${p.id}/assets/${a.sha256}.${a.ext}`);
    const meta = await sharp(stored).metadata();
    assert.equal(meta.exif, undefined);
    assert.ok(!stored.includes(Buffer.from('PhoneCo')));
    assert.equal(a.ext, 'png');
    assert.deepEqual([a.width, a.height], [300, 400], 'orientation is baked into the pixels');

    await assert.rejects(app.call('PUT', `/api/projects/${p.id}/draft/body`, undefined, Buffer.from('not an image')), /400 .*읽을 수 없는 이미지/);
  } finally {
    await app.close();
  }
});

test('가져오기: 압축을 풀기 전에 크기를 확인해 zip bomb을 거부한다', async () => {
  const app = await startApp();
  try {
    const zeros = new Uint8Array(300 * 1024 * 1024);
    const bomb = zipSync({ 'project.json': strToU8('{}'), [`assets/${'a'.repeat(64)}.png`]: zeros }, { level: 9 });
    const rss0 = process.memoryUsage().rss;
    await assert.rejects(app.call('POST', '/api/projects/import', undefined, bomb), /400 .*너무 큰 파일/);
    assert.ok(process.memoryUsage().rss - rss0 < 150e6, 'the bomb must not be inflated');
    assert.equal((await app.call<unknown[]>('GET', '/api/projects')).length, 0, 'nothing is created');
  } finally {
    await app.close();
  }
});

test('가져오기: 구조가 틀리거나 파일이 빠진 프로젝트는 아무것도 만들지 않고 거부한다', async () => {
  const app = await startApp();
  try {
    let p = await seedProject(app);
    await app.call('POST', `/api/projects/${p.id}/cuts/${p.cuts[0].id}/generate`, {});
    await app.runner.idle();
    p = await app.call('GET', `/api/projects/${p.id}`);
    p = await app.call('POST', `/api/projects/${p.id}/cuts/${p.cuts[0].id}/approve`, { candidateId: p.cuts[0].candidates[0].id });
    const good = unzipSync(new Uint8Array(await app.bytes(`/api/projects/${p.id}/export.zip`)));
    const project = JSON.parse(new TextDecoder().decode(good['project.json']));
    const repack = (mutate: (j: any, files: Record<string, Uint8Array>) => void) => {
      const j = structuredClone(project);
      const files: Record<string, Uint8Array> = Object.fromEntries(Object.entries(good).filter(([n]) => n.startsWith('assets/')));
      mutate(j, files);
      return zipSync({ ...files, 'project.json': strToU8(JSON.stringify(j)) });
    };
    const before = (await app.call<unknown[]>('GET', '/api/projects')).length;
    const cases: [string, (j: any, f: Record<string, Uint8Array>) => void, RegExp][] = [
      ['cuts not an array', (j) => { j.cuts = 'oops'; }, /cuts 배열이 아닙니다/],
      ['five cuts', (j) => { j.cuts.pop(); }, /컷이 6개가 아닙니다/],
      ['bad shot', (j) => { j.cuts[1].scene.shot = 'drone'; }, /scene\.shot/],
      ['dangling approval', (j) => { j.cuts[0].approvedCandidateId = 'nope'; }, /approvedCandidateId/],
      ['unknown baseline', (j) => { j.cuts[0].candidates[0].characterVersionId = 'v9'; }, /characterVersionId/],
      ['bad asset hash', (j) => { j.versions[0].faceRef.sha256 = '../../etc'; }, /sha256/],
      ['missing asset file', (j, f) => { delete f[`assets/${j.cuts[0].candidates[0].image.sha256}.png`]; }, /가리키는 파일이 없습니다/],
      ['tampered asset', (j, f) => { const k = `assets/${j.cuts[0].candidates[0].image.sha256}.png`; f[k] = f[k].slice(0, -1); }, /손상된 파일/],
    ];
    for (const [name, mutate, expected] of cases) {
      await assert.rejects(app.call('POST', '/api/projects/import', undefined, repack(mutate)), (e: Error) => {
        assert.match(e.message, /→ 400 /, name);
        assert.match(e.message, expected, name);
        return true;
      });
    }
    assert.equal((await app.call<unknown[]>('GET', '/api/projects')).length, before, 'no half-imported projects');
    await assert.rejects(app.call('POST', '/api/projects/import', undefined, Buffer.from('garbage')), /400 .*ZIP/);

    const ok = await app.call('POST', '/api/projects/import', undefined, repack(() => {}));
    assert.equal((await app.bytes(`/api/projects/${ok.id}/board.png`)).subarray(1, 4).toString(), 'PNG');
  } finally {
    await app.close();
  }
});
