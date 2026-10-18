import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildGraph, toUiWorkflow } from '../server/workflow.ts';

test('참조 N장마다 VAEEncode 1개와 ReferenceLatent 2개(긍정·부정)가 연결된다', () => {
  const g = buildGraph({ prompt: 'p', references: ['a.png', 'b.png', 'c.png'].map((image) => ({ image, megapixels: 1 })), seed: 7 });
  const count = (t: string) => Object.values(g).filter((n) => n.class_type === t).length;
  assert.equal(count('LoadImage'), 3);
  assert.equal(count('VAEEncode'), 3);
  assert.equal(count('ReferenceLatent'), 6);
  // The guider receives the end of both chains.
  assert.deepEqual(g['10'].inputs.positive, ['123', 0]);
  assert.deepEqual(g['10'].inputs.negative, ['124', 0]);
  assert.equal(g['13'].inputs.noise_seed, 7);
  // Every link points at an existing node.
  for (const n of Object.values(g)) for (const v of Object.values(n.inputs)) if (Array.isArray(v)) assert.ok(g[v[0]], `dangling ${v[0]}`);
});

test('UI 형식 변환은 API 그래프의 모든 연결을 보존한다', () => {
  const g = buildGraph({ prompt: 'p', references: ['a.png', 'b.png'].map((image) => ({ image, megapixels: 1 })), seed: 1 });
  const ui = toUiWorkflow(g, 't');
  const apiLinks = Object.values(g).flatMap((n) => Object.values(n.inputs).filter(Array.isArray)).length;
  assert.equal(ui.links.length, apiLinks);
  assert.equal(ui.nodes.length, Object.keys(g).length);
  const save = ui.nodes.find((n) => n.type === 'SaveImage')!;
  assert.ok(save.inputs[0].link);
});

test('영역 수정 그래프는 원본 latent에 마스크를 씌워 샘플링하고, 빈 latent를 쓰지 않는다', () => {
  const g = buildGraph({
    prompt: 'p', references: ['cut.png', 'f.png', 'b.png'].map((image) => ({ image, megapixels: 1 })), seed: 1, inpaintMask: 'm.png',
  });
  const types = Object.values(g).map((n) => n.class_type);
  assert.ok(types.includes('SetLatentNoiseMask'));
  assert.ok(!types.includes('EmptyFlux2LatentImage'));
  assert.deepEqual(g['20'].inputs.pixels, ['100', 0], 'source latent must come from the unscaled cut');
  assert.deepEqual(g['15'].inputs.latent_image, ['23', 0]);
  assert.equal(g['22'].inputs.channel, 'red');
  const ui = toUiWorkflow(g, 'masked');
  assert.equal(ui.nodes.length, Object.keys(g).length);
});

test('참조마다 역할별 해상도가 적용된다', () => {
  const g = buildGraph({ prompt: 'p', references: [{ image: 'a.png', megapixels: 1 }, { image: 'bg.png', megapixels: 0.5 }], seed: 1 });
  assert.equal(g['101'].inputs.megapixels, 1);
  assert.equal(g['111'].inputs.megapixels, 0.5);
});
