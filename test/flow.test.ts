import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { startApp, seedProject, solid } from './helpers.ts';
import { isStale, type Project } from '../server/model.ts';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

test('6컷 생성 → 승인 → 한 컷 수정 시 다른 승인 컷 파일이 그대로 유지된다', async () => {
  const app = await startApp();
  try {
    let p = await seedProject(app);
    p = await app.call('POST', `/api/projects/${p.id}/generate-missing`, { count: 2 });
    assert.equal(p.jobs.length, 12);
    await app.runner.idle();
    p = await app.call('GET', `/api/projects/${p.id}`);
    assert.ok(p.jobs.every((j) => j.status === 'done'), JSON.stringify(p.jobs.map((j) => j.error)));
    for (const cut of p.cuts) {
      assert.equal(cut.candidates.length, 2);
      p = await app.call('POST', `/api/projects/${p.id}/cuts/${cut.id}/approve`, { candidateId: cut.candidates[0].id });
    }

    const before = new Map<string, string>();
    for (const cut of p.cuts) {
      const a = cut.candidates.find((c) => c.id === cut.approvedCandidateId)!;
      before.set(cut.id, sha(await app.bytes(`/api/projects/${p.id}/assets/${a.image.sha256}.${a.image.ext}`)));
    }

    // Edit cut 3 twice and regenerate cut 5: approvals must not move until the user approves.
    const target = p.cuts[2];
    p = await app.call('POST', `/api/projects/${p.id}/cuts/${target.id}/candidates/${target.approvedCandidateId}/edit`, { instruction: '가방 색을 빨간색으로 수정' });
    p = await app.call('POST', `/api/projects/${p.id}/cuts/${p.cuts[4].id}/generate`, { count: 1 });
    await app.runner.idle();
    p = await app.call('GET', `/api/projects/${p.id}`);
    for (const cut of p.cuts) {
      const a = cut.candidates.find((c) => c.id === cut.approvedCandidateId)!;
      assert.equal(a.image.sha256, before.get(cut.id), `cut ${cut.index + 1} approval changed without user action`);
    }

    const edited = p.cuts[2].candidates.at(-1)!;
    assert.equal(edited.kind, 'edit');
    assert.equal(edited.parentId, target.approvedCandidateId);
    assert.equal(edited.generation.references[0].role, 'cut');
    p = await app.call('POST', `/api/projects/${p.id}/cuts/${target.id}/approve`, { candidateId: edited.id });

    for (const cut of p.cuts) {
      if (cut.id === target.id) continue;
      const a = cut.candidates.find((c) => c.id === cut.approvedCandidateId)!;
      const now = sha(await app.bytes(`/api/projects/${p.id}/assets/${a.image.sha256}.${a.image.ext}`));
      assert.equal(now, before.get(cut.id), `cut ${cut.index + 1} file hash changed`);
    }

    // Restore the previous result.
    p = await app.call('POST', `/api/projects/${p.id}/cuts/${target.id}/approve`, { candidateId: target.approvedCandidateId });
    assert.deepEqual(p.cuts[2].approvals.map((e) => e.action), ['approve', 'approve', 'restore']);

    const v = await app.call<{ ok: boolean; problems: string[] }>('GET', `/api/projects/${p.id}/verify`);
    assert.ok(v.ok, v.problems.join('\n'));
  } finally {
    await app.close();
  }
});

test('기준을 새 버전으로 바꾸면 기존 승인 컷은 유지되고 “이전 기준”으로 표시된다', async () => {
  const app = await startApp();
  try {
    let p = await seedProject(app);
    p = await app.call('POST', `/api/projects/${p.id}/cuts/${p.cuts[0].id}/generate`, {});
    await app.runner.idle();
    p = await app.call('GET', `/api/projects/${p.id}`);
    p = await app.call('POST', `/api/projects/${p.id}/cuts/${p.cuts[0].id}/approve`, { candidateId: p.cuts[0].candidates[0].id });
    assert.equal(isStale(p, p.cuts[0]), false);

    await assert.rejects(app.call('POST', `/api/projects/${p.id}/versions`), /바뀐 내용이 없습니다/);
    p = await app.call('PUT', `/api/projects/${p.id}/draft/traits`, { traits: { ...p.draft.traits, outfit: '초록 재킷' } });
    p = await app.call('POST', `/api/projects/${p.id}/versions`);
    assert.equal(p.versions.length, 2);
    assert.ok(p.cuts[0].approvedCandidateId);
    assert.equal(isStale(p, p.cuts[0]), true);
  } finally {
    await app.close();
  }
});

test('실패한 작업은 기록되고 다시 시도할 수 있다', async () => {
  const app = await startApp();
  try {
    let p = await seedProject(app);
    const cut = p.cuts[1];
    p = await app.call('PATCH', `/api/projects/${p.id}/cuts/${cut.id}`, { scene: { ...cut.scene, action: '[[fail]]' } });
    p = await app.call('POST', `/api/projects/${p.id}/cuts/${cut.id}/generate`, {});
    await app.runner.idle();
    p = await app.call('GET', `/api/projects/${p.id}`);
    const job = p.jobs[0];
    assert.equal(job.status, 'failed');
    assert.match(job.error!, /의도된 실패/);

    p = await app.call('PATCH', `/api/projects/${p.id}/cuts/${cut.id}`, { scene: { ...cut.scene, action: '뛴다' } });
    p = await app.call('POST', `/api/projects/${p.id}/jobs/${job.id}/retry`);
    await app.runner.idle();
    p = await app.call('GET', `/api/projects/${p.id}`);
    assert.equal(p.jobs[0].status, 'done');
    assert.equal(p.jobs[0].attempts, 2);
    assert.equal(p.cuts[1].candidates.length, 1);
  } finally {
    await app.close();
  }
});

test('앱 재시작: 실행 중이던 작업과 대기 작업이 모두 이어서 실행되고 승인 결과는 보존된다', async () => {
  const app = await startApp();
  let p = await seedProject(app);
  p = await app.call('POST', `/api/projects/${p.id}/cuts/${p.cuts[0].id}/generate`, {});
  await app.runner.idle();
  p = await app.call('GET', `/api/projects/${p.id}`);
  p = await app.call('POST', `/api/projects/${p.id}/cuts/${p.cuts[0].id}/approve`, { candidateId: p.cuts[0].candidates[0].id });
  const approved = p.cuts[0].approvedCandidateId;
  await app.close(true);

  // Simulate a crash mid-run: one job "running", one "queued".
  await app.store.update(p.id, (q: Project) => {
    const base = { cutId: q.cuts[1].id, kind: 'generate' as const, characterVersionId: q.versions[0].id, attempts: 0, createdAt: new Date().toISOString() };
    q.jobs.push({ ...base, id: 'crashed1', status: 'running' }, { ...base, id: 'pending1', status: 'queued' });
  });

  const app2 = await startApp(app.dir);
  try {
    await app2.runner.idle();
    p = await app2.call('GET', `/api/projects/${p.id}`);
    const crashed = p.jobs.find((j) => j.id === 'crashed1')!;
    assert.equal(crashed.status, 'done');
    assert.equal(crashed.attempts, 1);
    assert.equal(p.jobs.find((j) => j.id === 'pending1')!.status, 'done');
    assert.equal(p.cuts[0].approvedCandidateId, approved);
  } finally {
    await app2.close();
  }
});

test('내보내기 ZIP에 보드·컷·워크플로·매니페스트가 들어 있고, 다시 가져올 수 있다', async () => {
  const app = await startApp();
  try {
    let p = await seedProject(app);
    p = await app.call('POST', `/api/projects/${p.id}/generate-missing`, {});
    await app.runner.idle();
    p = await app.call('GET', `/api/projects/${p.id}`);
    for (const cut of p.cuts.slice(0, 4)) {
      p = await app.call('POST', `/api/projects/${p.id}/cuts/${cut.id}/approve`, { candidateId: cut.candidates[0].id });
    }
    const zip = await app.bytes(`/api/projects/${p.id}/export.zip`);
    const files = unzipSync(new Uint8Array(zip));
    const names = Object.keys(files);
    for (const n of ['board.png', 'project.json', 'manifest.json', 'evaluation.csv', 'cuts/cut-01.png', 'cuts/cut-04.png',
      'workflows/template/generate.api.json', 'workflows/template/generate.ui.json', 'workflows/template/edit.api.json', 'workflows/template/edit.ui.json']) {
      assert.ok(names.includes(n), `missing ${n}`);
    }
    assert.ok(!names.includes('cuts/cut-05.png'), 'unapproved cut must not be exported as final');
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
    assert.equal(manifest.cuts[0].approved.sha256, sha(files['cuts/cut-01.png']));

    const imported = await app.call('POST', '/api/projects/import', undefined, zip);
    assert.notEqual(imported.id, p.id);
    assert.deepEqual(imported.cuts.map((c) => c.approvedCandidateId), p.cuts.map((c) => c.approvedCandidateId));
    const v = await app.call<{ ok: boolean }>('GET', `/api/projects/${imported.id}/verify`);
    assert.ok(v.ok);
  } finally {
    await app.close();
  }
});

test('입력 검증: 기준 없이 생성 불가, 빈 수정 지시 거부', async () => {
  const app = await startApp();
  try {
    const p = await app.call('POST', '/api/projects', { title: 'x' });
    await assert.rejects(app.call('POST', `/api/projects/${p.id}/versions`), /참조/);
    await app.call('PATCH', `/api/projects/${p.id}/cuts/${p.cuts[0].id}`, { scene: { location: 'a', action: 'b', expression: '', shot: 'wide' } });
    await assert.rejects(app.call('POST', `/api/projects/${p.id}/cuts/${p.cuts[0].id}/generate`, {}), /캐릭터 기준/);
    await assert.rejects(app.call('GET', '/api/projects/..%2F..%2Fetc'), /404/);
  } finally {
    await app.close();
  }
});

test('기준 되돌리기: 이전 기준을 불러와 다시 승인하면, 그 기준으로 만든 컷은 다시 최신이 된다', async () => {
  const app = await startApp();
  try {
    let p = await seedProject(app);
    await app.call('POST', `/api/projects/${p.id}/cuts/${p.cuts[0].id}/generate`, {});
    await app.runner.idle();
    p = await app.call('GET', `/api/projects/${p.id}`);
    p = await app.call('POST', `/api/projects/${p.id}/cuts/${p.cuts[0].id}/approve`, { candidateId: p.cuts[0].candidates[0].id });
    const v1 = p.versions[0];

    // v2 by mistake: different outfit and face photo.
    await app.call('PUT', `/api/projects/${p.id}/draft/traits`, { traits: { ...p.draft.traits, outfit: '초록 재킷' } });
    await app.call('PUT', `/api/projects/${p.id}/draft/face`, undefined, await solid('#123'));
    p = await app.call('POST', `/api/projects/${p.id}/versions`);
    assert.equal(isStale(p, p.cuts[0]), true);
    p = await app.call('POST', `/api/projects/${p.id}/refresh-stale`);
    assert.equal(p.jobs.filter((j) => j.kind === 'edit').length, 1);
    await app.runner.idle();

    // Restore v1 into the draft and approve it as v3.
    p = await app.call('POST', `/api/projects/${p.id}/draft/from-version/${v1.id}`, {});
    assert.deepEqual([p.draft.faceRef!.sha256, p.draft.traits], [v1.faceRef.sha256, v1.traits]);
    p = await app.call('POST', `/api/projects/${p.id}/versions`);
    assert.equal(p.versions.length, 3);
    assert.equal(isStale(p, p.cuts[0]), false, 'cuts made from v1 are current under the identical v3');
    p = await app.call('POST', `/api/projects/${p.id}/refresh-stale`);
    assert.equal(p.jobs.filter((j) => j.kind === 'edit').length, 1, 'nothing to refresh');
    await assert.rejects(app.call('POST', `/api/projects/${p.id}/draft/from-version/nope`, {}), /404/);
  } finally {
    await app.close();
  }
});

test('컷 순서 바꾸기: 장면·후보·승인·작업이 컷과 함께 옮겨지고, 보드와 내보내기가 새 순서를 따른다', async () => {
  const app = await startApp(undefined, 200);
  try {
    let p = await seedProject(app);
    await app.call('POST', `/api/projects/${p.id}/cuts/${p.cuts[1].id}/generate`, {});
    await app.runner.idle();
    p = await app.call('GET', `/api/projects/${p.id}`);
    const moving = p.cuts[1];
    p = await app.call('POST', `/api/projects/${p.id}/cuts/${moving.id}/approve`, { candidateId: moving.candidates[0].id });
    // A job queued for the cut keeps working after the move.
    await app.call('POST', `/api/projects/${p.id}/cuts/${moving.id}/generate`, {});
    p = await app.call('POST', `/api/projects/${p.id}/cuts/${moving.id}/move`, { to: 4 });
    assert.deepEqual(p.cuts.map((c) => c.index), [0, 1, 2, 3, 4, 5]);
    assert.equal(p.cuts[4].id, moving.id);
    assert.equal(p.cuts[4].scene.location, '사무실 복도');
    assert.equal(p.cuts[4].approvedCandidateId, moving.candidates[0].id);
    assert.equal(p.cuts[1].scene.location, '카페 창가', 'the others shift up');
    await app.runner.idle();
    p = await app.call('GET', `/api/projects/${p.id}`);
    assert.equal(p.cuts[4].candidates.length, 2);

    const { unzipSync } = await import('fflate');
    const zip = unzipSync(new Uint8Array(await app.bytes(`/api/projects/${p.id}/export.zip`)));
    const manifest = JSON.parse(new TextDecoder().decode(zip['manifest.json']));
    assert.equal(manifest.cuts[4].approved.sha256, p.cuts[4].candidates[0].image.sha256);
    assert.ok(zip['cuts/cut-05.png']);
    // Reordered projects still pass import validation.
    await app.call('POST', '/api/projects/import', undefined, await app.bytes(`/api/projects/${p.id}/export.zip`));
    await assert.rejects(app.call('POST', `/api/projects/${p.id}/cuts/${moving.id}/move`, { to: 6 }), /400/);
  } finally {
    await app.close();
  }
});
