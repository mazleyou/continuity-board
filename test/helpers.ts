import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { Store } from '../server/store.ts';
import { createApp } from '../server/app.ts';
import { MockBackend } from '../server/backends/mock.ts';
import type { Project } from '../server/model.ts';

export async function startApp(dataDir?: string, delayMs = 5) {
  const dir = dataDir ?? await mkdtemp(join(tmpdir(), 'cb-test-'));
  const store = new Store(dir);
  const { server, runner } = createApp(store, new MockBackend(delayMs), resolve(import.meta.dirname, '../web'));
  await runner.recover();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async <T = Project>(method: string, path: string, body?: unknown, raw?: Buffer | Uint8Array): Promise<T> => {
    const res = await fetch(base + path, {
      method,
      headers: raw ? { 'content-type': 'application/octet-stream' } : body === undefined ? {} : { 'content-type': 'application/json' },
      body: raw ? new Uint8Array(raw) : body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`${method} ${path} → ${res.status} ${text}`), { status: res.status });
    return JSON.parse(text);
  };
  const bytes = async (path: string) => Buffer.from(await (await fetch(base + path)).arrayBuffer());
  return {
    dir, store, runner, base, call, bytes,
    close: async (keep = false) => {
      await runner.idle();
      await new Promise((r) => server.close(r));
      if (!keep) await rm(dir, { recursive: true, force: true });
    },
  };
}

export function solid(color: string, w = 512, h = 640) {
  return sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();
}

/** Registers a character, approves the baseline and fills all six scenes. */
export async function seedProject(app: Awaited<ReturnType<typeof startApp>>) {
  let p = await app.call('POST', '/api/projects', { title: '테스트 보드' });
  await app.call('PUT', `/api/projects/${p.id}/draft/face`, undefined, await solid('#d2a07a'));
  await app.call('PUT', `/api/projects/${p.id}/draft/body`, undefined, await solid('#f2c230'));
  await app.call('PUT', `/api/projects/${p.id}/draft/traits`, {
    traits: { name: '민지', hair: '짧은 검은 머리', outfit: '노란 재킷', props: '빨간 가방', notes: '' },
  });
  p = await app.call('POST', `/api/projects/${p.id}/versions`);
  const scenes = ['아침 버스 정류장', '사무실 복도', '카페 창가', '비 오는 거리', '공원 벤치', '집 현관'];
  for (const [i, cut] of p.cuts.entries()) {
    p = await app.call('PATCH', `/api/projects/${p.id}/cuts/${cut.id}`, {
      scene: { location: scenes[i], action: '걷는다', expression: '미소', shot: 'medium' },
    });
  }
  return p;
}
