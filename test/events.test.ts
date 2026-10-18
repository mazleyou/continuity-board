import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seedProject } from './helpers.ts';

/** Reads server-sent events until `until` returns true or the timeout passes. */
async function collect(url: string, until: (events: { event: string; data: any }[]) => boolean, ms = 5000) {
  const ctrl = new AbortController();
  const res = await fetch(url, { signal: ctrl.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream; charset=utf-8');
  const reader = res.body!.getReader();
  const events: { event: string; data: any }[] = [];
  let buf = '';
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline && !until(events)) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (event && data) events.push({ event, data: JSON.parse(data) });
      }
    }
  } finally {
    ctrl.abort();
  }
  return events;
}

test('이벤트 스트림: 다른 탭에서 시작한 작업도 변경·진행률 이벤트로 받는다', async () => {
  const app = await startApp(undefined, 300);
  try {
    const p = await seedProject(app);
    // "Tab B" subscribes; "tab A" starts the work through the API.
    const pending = collect(`${app.base}/api/projects/${p.id}/events`, (ev) => ev.some((e) => e.event === 'project' && e.data.cuts[0].candidates.length === 1));
    await new Promise((r) => setTimeout(r, 100));
    await app.call('POST', `/api/projects/${p.id}/cuts/${p.cuts[0].id}/generate`, {});
    const events = await pending;
    assert.equal(events[0].event, 'project', 'starts with the current project');
    assert.ok(events.some((e) => e.event === 'project' && e.data.jobs.some((j: { status: string }) => j.status === 'running')));
    const live = events.filter((e) => e.event === 'live' && Object.keys(e.data.live).length);
    assert.ok(live.length >= 1, 'progress arrives as live events');
    assert.ok(live.length <= 6, 'progress is throttled');
    assert.ok(events.at(-1)!.data.cuts[0].candidates.length === 1);
  } finally {
    await app.close();
  }
});

test('UI용 응답에는 그래프 대신 hasGraph만 담고, 그래프는 후보별로 받는다', async () => {
  const app = await startApp();
  try {
    let p = await seedProject(app);
    await app.call('POST', `/api/projects/${p.id}/cuts/${p.cuts[0].id}/generate`, {});
    await app.runner.idle();
    const graph = { 1: { class_type: 'UNETLoader', inputs: {} } };
    await app.store.update(p.id, (q) => { q.cuts[0].candidates[0].generation.graph = graph; });
    p = await app.call('GET', `/api/projects/${p.id}`);
    const g = p.cuts[0].candidates[0].generation as typeof p.cuts[0]['candidates'][0]['generation'] & { hasGraph: boolean };
    assert.equal(g.graph, null);
    assert.equal(g.hasGraph, true);
    const res = await fetch(`${app.base}/api/projects/${p.id}/cuts/${p.cuts[0].id}/candidates/${p.cuts[0].candidates[0].id}/graph.json`);
    assert.deepEqual(await res.json(), graph);
    // Exports keep the full graph.
    const stored = await app.store.load(p.id);
    assert.deepEqual(stored.cuts[0].candidates[0].generation.graph, graph);
  } finally {
    await app.close();
  }
});

test('이벤트 스트림: 다른 곳에서 프로젝트를 지우면 deleted 이벤트를 보내고 스트림을 닫는다', async () => {
  const app = await startApp();
  try {
    const p = await seedProject(app);
    const pending = collect(`${app.base}/api/projects/${p.id}/events`, (ev) => ev.some((e) => e.event === 'deleted'));
    await new Promise((r) => setTimeout(r, 100));
    await app.call('DELETE', `/api/projects/${p.id}`);
    const events = await pending;
    assert.deepEqual(events.at(-1), { event: 'deleted', data: { id: p.id } });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(app.store.events.listenerCount('change'), 0, 'listeners released');
    await assert.rejects(app.call('GET', `/api/projects/${p.id}`), /404 .*삭제되었을 수 있습니다/);
  } finally {
    await app.close();
  }
});
