import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, seedProject } from './helpers.ts';
import { buildReport, renderMarkdown } from '../server/report.ts';
import type { Checklist, Project } from '../server/model.ts';

const ID: Checklist = { face: true, hair: true, outfit: true };

test('평가 보고서: 기획서 목표(첫 3후보 안의 컷 통과, 수정 통과, 평가자 수·일치도)를 계산한다', async () => {
  const app = await startApp();
  try {
    let p = await seedProject(app);
    await app.call('POST', `/api/projects/${p.id}/generate-missing`, { count: 3 });
    await app.runner.idle();
    // One extra (4th) candidate on cut 6, which must not count toward "within 3 candidates".
    await app.call('POST', `/api/projects/${p.id}/cuts/${p.cuts[5].id}/generate`, {});
    await app.runner.idle();
    p = await app.call('GET', `/api/projects/${p.id}`);
    const review = (cut: number, cand: number, reviewer: string, checklist: Checklist) =>
      app.call('POST', `/api/projects/${p.id}/cuts/${p.cuts[cut].id}/candidates/${p.cuts[cut].candidates[cand].id}/reviews`, { reviewer, checklist, note: '' });

    // Cuts 1-4: second candidate passes for both reviewers.
    for (const cut of [0, 1, 2, 3]) {
      await review(cut, 0, 'A', { ...ID, outfit: false });
      await review(cut, 1, 'A', ID);
      await review(cut, 1, 'B', ID);
    }
    // Cut 5: reviewers disagree on candidate 1, the other two fail -> fail.
    await review(4, 0, 'A', ID);
    await review(4, 0, 'B', { ...ID, face: false });
    await review(4, 1, 'A', { ...ID, face: false });
    await review(4, 2, 'A', { ...ID, face: false });
    // Cut 6: only the 4th candidate passes -> fail (outside the first three).
    for (const i of [0, 1, 2]) await review(5, i, 'A', { ...ID, hair: false });
    await review(5, 3, 'A', ID);

    // Edits: one passes, one fails the instruction, one unreviewed.
    for (const cut of [0, 1, 2]) {
      await app.call('POST', `/api/projects/${p.id}/cuts/${p.cuts[cut].id}/candidates/${p.cuts[cut].candidates[0].id}/edit`, { instruction: 'make the bag green' });
    }
    await app.runner.idle();
    p = await app.call('GET', `/api/projects/${p.id}`);
    const edit = (cut: number) => p.cuts[cut].candidates.at(-1)!;
    await app.call('POST', `/api/projects/${p.id}/cuts/${p.cuts[0].id}/candidates/${edit(0).id}/reviews`, { reviewer: 'A', checklist: { ...ID, instruction: true }, note: '' });
    await app.call('POST', `/api/projects/${p.id}/cuts/${p.cuts[1].id}/candidates/${edit(1).id}/reviews`, { reviewer: 'A', checklist: { ...ID, instruction: false }, note: '' });

    const r = buildReport([await app.store.load(p.id) as Project]);
    assert.deepEqual([r.cuts.pass, r.cuts.fail, r.cuts.unreviewed], [4, 2, 0]);
    assert.equal(r.cuts.meetsTarget, false, '4/6 = 66.7% < 83.3%');
    assert.deepEqual([r.edits.pass, r.edits.fail, r.edits.unreviewed], [1, 1, 1]);
    assert.equal(r.edits.meetsTarget, false, '1/2 = 50% < 66.7%');
    assert.deepEqual(r.reviewers.names, ['A', 'B']);
    // Items judged by both A and B: cuts 1-4 candidate 2 (3 items each, all agree) + cut 5 (face disagrees).
    assert.equal(r.reviewers.itemsCompared, 15);
    assert.equal(r.reviewers.itemsAgreed, 14);
    assert.ok(r.timing.some((t) => t.kind === 'generate' && t.n >= 18));

    const md = renderMarkdown(r, 'T');
    assert.match(md, /\| 컷 .* \| 4\/6 = 66\.7% \| ❌ 목표 미달 \|/);
    assert.match(md, /2명 이상이 판정한 항목 15개 중 14개\(93\.3%\)/);
  } finally {
    await app.close();
  }
});

test('수정 지시 항목은 수정 후보에서만 저장된다 (API는 받되 생성 후보 판정에는 영향 없음)', async () => {
  const app = await startApp();
  try {
    let p = await seedProject(app);
    await app.call('POST', `/api/projects/${p.id}/cuts/${p.cuts[0].id}/generate`, {});
    await app.runner.idle();
    p = await app.call('GET', `/api/projects/${p.id}`);
    p = await app.call('POST', `/api/projects/${p.id}/cuts/${p.cuts[0].id}/candidates/${p.cuts[0].candidates[0].id}/reviews`, {
      reviewer: 'A', checklist: { ...ID, instruction: true, bogus: true }, note: '',
    });
    assert.deepEqual(p.cuts[0].candidates[0].reviews[0].checklist, { ...ID, instruction: true });
    const r = buildReport([p]);
    assert.equal(r.cuts.pass, 1, 'generation verdict uses face/hair/outfit only');
  } finally {
    await app.close();
  }
});
