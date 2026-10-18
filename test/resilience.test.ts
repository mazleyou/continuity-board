import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seedProject } from './helpers.ts';
import { ComfyBackend } from '../server/backends/comfy.ts';
import { BackendUnavailableError } from '../server/backends/types.ts';
import type { Project } from '../server/model.ts';

type Live = Project & { backendWait: { message: string } | null };

test('ComfyUI가 꺼져 있으면 작업을 실패시키지 않고 기다렸다가, 다시 켜지면 이어서 실행한다', async () => {
  const app = await startApp();
  try {
    let p = await seedProject(app);
    app.backend.offline = true;
    await app.call('POST', `/api/projects/${p.id}/generate-missing`, { count: 2 });
    await new Promise((r) => setTimeout(r, 150));
    let live = await app.call<Live>('GET', `/api/projects/${p.id}`);
    assert.equal(live.jobs.length, 12);
    assert.ok(live.jobs.every((j) => j.status === 'queued'), JSON.stringify(live.jobs.map((j) => [j.status, j.error])));
    assert.match(live.backendWait!.message, /오프라인/);
    const health = await app.call<{ queue: { backendWait: unknown; pending: number } }>('GET', '/api/health');
    assert.ok(health.queue.backendWait);

    app.backend.offline = false;
    await app.call('POST', '/api/queue/retry-now', {});
    await app.runner.idle();
    live = await app.call<Live>('GET', `/api/projects/${p.id}`);
    assert.equal(live.backendWait, null);
    assert.ok(live.jobs.every((j) => j.status === 'done'));
    assert.ok(live.jobs.every((j) => j.attempts === 1), 'waiting does not use up attempts');
    assert.ok(live.cuts.every((c) => c.candidates.length === 2));
  } finally {
    await app.close();
  }
});

test('기다리는 동안 작업을 모두 취소하면 대기 상태도 풀린다', async () => {
  const app = await startApp();
  try {
    let p = await seedProject(app);
    app.backend.offline = true;
    p = await app.call('POST', `/api/projects/${p.id}/cuts/${p.cuts[0].id}/generate`, { count: 2 });
    await new Promise((r) => setTimeout(r, 80));
    for (const j of p.jobs) await app.call('DELETE', `/api/projects/${p.id}/jobs/${j.id}`);
    await app.runner.idle();
    const live = await app.call<Live>('GET', `/api/projects/${p.id}`);
    assert.deepEqual(live.jobs.map((j) => j.status), ['cancelled', 'cancelled']);
    assert.equal(live.backendWait, null);
  } finally {
    await app.close();
  }
});

test('ComfyUI 백엔드: 연결할 수 없으면 읽을 수 있는 BackendUnavailableError를 낸다', async () => {
  const backend = new ComfyBackend('http://127.0.0.1:9');
  await assert.rejects(
    backend.run({ kind: 'generate', prompt: 'p', seed: 1, width: 64, height: 64, label: 't', references: [] }),
    (e) => e instanceof BackendUnavailableError && /^ComfyUI에 연결할 수 없습니다 \(http:\/\/127\.0\.0\.1:9/.test((e as Error).message),
  );
  const h = await backend.health();
  assert.equal(h.ok, false);
  assert.match(h.detail, /연결할 수 없습니다/);
});
