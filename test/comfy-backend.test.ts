import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import sharp from 'sharp';
import { ComfyBackend } from '../server/backends/comfy.ts';
import { CancelledError, type Progress, type RunRequest } from '../server/backends/types.ts';
import { MODELS } from '../server/workflow.ts';

/** Minimal stand-in for ComfyUI's HTTP + websocket API, enough to exercise ComfyBackend end to end. */
async function fakeComfy(opts: { mode?: 'ok' | 'invalid' | 'error' | 'slow'; websocket?: boolean; models?: string[] } = {}) {
  const mode = opts.mode ?? 'ok';
  const image = await sharp({ create: { width: 64, height: 36, channels: 3, background: '#3a6' } }).png().toBuffer();
  const sockets: Duplex[] = [];
  const history: Record<string, unknown> = {};
  const known = new Set<string>();
  const posted: { prompt_id: string; prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }> }[] = [];
  const uploads: string[] = [];
  const timers: NodeJS.Timeout[] = [];

  const send = (type: string, data: unknown) => {
    const payload = Buffer.from(JSON.stringify({ type, data }));
    const head = payload.length < 126 ? Buffer.from([0x81, payload.length]) : Buffer.from([0x81, 126, payload.length >> 8, payload.length & 255]);
    for (const s of sockets) s.write(Buffer.concat([head, payload]));
  };
  const finish = (id: string, status: object, outputs = {}) => (history[id] = { status, outputs });
  const json = (res: ServerResponse, code: number, body: unknown) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  const readAll = (req: IncomingMessage) => new Promise<Buffer>((r) => { const c: Buffer[] = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c))); });

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://x');
    const p = url.pathname;
    if (p === '/system_stats') return json(res, 200, { system: { comfyui_version: 'fake' } });
    if (p.startsWith('/object_info/')) {
      const node = p.split('/').pop()!;
      const field = node === 'VAELoader' ? 'vae_name' : node.startsWith('CLIP') ? 'clip_name' : 'unet_name';
      return json(res, 200, { [node]: { input: { required: { [field]: [opts.models ?? Object.values(MODELS)] } } } });
    }
    if (p === '/upload/image') {
      const name = /filename="([^"]+)"/.exec((await readAll(req)).toString('latin1'))![1];
      uploads.push(name);
      return json(res, 200, { name, subfolder: '' });
    }
    if (p === '/prompt') {
      const body = JSON.parse((await readAll(req)).toString());
      if (mode === 'invalid') {
        return json(res, 400, { error: { message: 'Prompt outputs failed validation' }, node_errors: { 1: { class_type: 'UNETLoader', errors: [{ message: 'Value not in list', details: 'unet_name: missing.safetensors' }] } } });
      }
      posted.push(body);
      const id = body.prompt_id;
      known.add(id);
      const step = mode === 'slow' ? 300 : 20;
      const plan: [number, () => void][] = [
        [1, () => send('executing', { node: '1', prompt_id: id })],
        [2, () => send('executing', { node: '15', prompt_id: id })],
        ...[1, 2, 3, 4].map((v) => [2 + v, () => send('progress', { value: v, max: 4, prompt_id: id, node: '15' })] as [number, () => void]),
        [7, () => {
          if (mode === 'error') {
            send('execution_error', { prompt_id: id, node_type: 'VAEDecode', exception_message: 'MPS out of memory' });
            finish(id, { status_str: 'error', completed: false, messages: [['execution_error', { node_type: 'VAEDecode', exception_message: 'MPS out of memory' }]] });
          } else {
            finish(id, { status_str: 'success', completed: true, messages: [] }, { 17: { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } });
            send('execution_success', { prompt_id: id });
          }
        }],
      ];
      for (const [n, fn] of plan) timers.push(setTimeout(() => { if (!history[id]) fn(); }, n * step));
      return json(res, 200, { prompt_id: id, number: 1 });
    }
    if (p.startsWith('/history/')) {
      const id = p.split('/').pop()!;
      return json(res, 200, history[id] ? { [id]: history[id] } : {});
    }
    const cancel = /^\/api\/jobs\/([^/]+)\/cancel$/.exec(p);
    if (cancel) {
      const id = cancel[1];
      if (known.has(id) && !history[id]) {
        finish(id, { status_str: 'error', completed: false, messages: [['execution_interrupted', {}]] });
        send('execution_interrupted', { prompt_id: id });
      }
      return json(res, 200, { cancelled: true });
    }
    const job = /^\/api\/jobs\/([^/]+)$/.exec(p);
    if (job) return known.has(job[1]) ? json(res, 200, { id: job[1] }) : json(res, 404, { error: 'not found' });
    if (p === '/view') return res.writeHead(200, { 'content-type': 'image/png' }).end(image);
    json(res, 404, {});
  });
  server.on('upgrade', (req, socket) => {
    if (opts.websocket === false) return socket.destroy();
    const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    socket.on('error', () => {});
    socket.on('data', (d: Buffer) => { if ((d[0] & 0x0f) === 0x8) socket.end(); });
    sockets.push(socket);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    image, posted, uploads, known, finish,
    close: () => new Promise((r) => { timers.forEach(clearTimeout); sockets.forEach((s) => s.destroy()); server.close(r); }),
  };
}

async function request(extra: Partial<RunRequest> = {}): Promise<RunRequest> {
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).png().toBuffer();
  return {
    kind: 'generate', prompt: 'p', seed: 1, width: 1344, height: 768, label: 't',
    references: [{ role: 'face', sha256: 'a'.repeat(64), bytes: png, megapixels: 1 }, { role: 'body', sha256: 'b'.repeat(64), bytes: png, megapixels: 1 }],
    ...extra,
  };
}

test('ComfyUI 백엔드: 업로드 → 제출(우리 prompt_id) → 웹소켓 진행률 → 결과 이미지', async () => {
  const comfy = await fakeComfy();
  try {
    const progress: Progress[] = [];
    let submitted = '';
    const backend = new ComfyBackend(comfy.url);
    const r = await backend.run(await request({ onSubmit: async (id) => { submitted = id; }, onProgress: (p) => progress.push(p) }));
    assert.deepEqual(r.image, comfy.image);
    assert.equal(comfy.posted.length, 1);
    assert.equal(comfy.posted[0].prompt_id, submitted, 'the id saved before submission is the one ComfyUI runs');
    assert.deepEqual(comfy.uploads, [`cb_${'a'.repeat(24)}.png`, `cb_${'b'.repeat(24)}.png`]);
    assert.equal(comfy.posted[0].prompt['100'].inputs.image, comfy.uploads[0]);
    assert.ok(progress.some((p) => p.phase === '그리는 중 4/4'), JSON.stringify(progress));
    const fractions = progress.map((p) => p.fraction);
    assert.deepEqual(fractions, [...fractions].sort((a, b) => a - b), 'progress never goes backwards');
    assert.ok(r.coldStart);
  } finally {
    await comfy.close();
  }
});

test('ComfyUI 백엔드: 워크플로 검증 실패는 노드 오류를 사람이 읽을 수 있게 전달한다', async () => {
  const comfy = await fakeComfy({ mode: 'invalid' });
  try {
    await assert.rejects(new ComfyBackend(comfy.url).run(await request()), /UNETLoader#1: Value not in list unet_name: missing\.safetensors/);
  } finally {
    await comfy.close();
  }
});

test('ComfyUI 백엔드: 실행 오류를 노드 종류와 함께 전달한다', async () => {
  const comfy = await fakeComfy({ mode: 'error' });
  try {
    await assert.rejects(new ComfyBackend(comfy.url).run(await request()), /VAEDecode.*MPS out of memory/);
  } finally {
    await comfy.close();
  }
});

test('ComfyUI 백엔드: 실행 중 취소하면 CancelledError로 끝난다', async () => {
  const comfy = await fakeComfy({ mode: 'slow' });
  try {
    const backend = new ComfyBackend(comfy.url);
    let id = '';
    const outcome = assert.rejects(backend.run(await request({ onSubmit: async (x) => { id = x; } })), (e) => e instanceof CancelledError);
    await new Promise((r) => setTimeout(r, 400));
    await backend.cancel(id);
    await outcome;
  } finally {
    await comfy.close();
  }
});

test('ComfyUI 백엔드: 재시작 후 이어받기 — 이미 제출된 작업은 다시 제출하지 않고 결과만 받는다', async () => {
  const comfy = await fakeComfy();
  try {
    const id = crypto.randomUUID();
    comfy.known.add(id);
    comfy.finish(id, { status_str: 'success', completed: true }, { 17: { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } });
    let submitted = false;
    const r = await new ComfyBackend(comfy.url).run(await request({ resumeId: id, onSubmit: async () => { submitted = true; } }));
    assert.deepEqual(r.image, comfy.image);
    assert.equal(comfy.posted.length, 0);
    assert.equal(submitted, false);

    // Unknown to ComfyUI (it restarted too): submitted again.
    await new ComfyBackend(comfy.url).run(await request({ resumeId: crypto.randomUUID() }));
    assert.equal(comfy.posted.length, 1);
  } finally {
    await comfy.close();
  }
});

test('ComfyUI 백엔드: 웹소켓이 없어도 /history 폴링으로 결과를 받는다', async () => {
  const comfy = await fakeComfy({ websocket: false });
  try {
    const r = await new ComfyBackend(comfy.url).run(await request());
    assert.deepEqual(r.image, comfy.image);
  } finally {
    await comfy.close();
  }
});

test('ComfyUI 백엔드: 상태 확인이 없는 모델 파일을 알려 준다', async () => {
  const comfy = await fakeComfy({ models: ['flux2-vae.safetensors'] });
  try {
    const h = await new ComfyBackend(comfy.url).health();
    assert.equal(h.ok, false);
    assert.deepEqual(h.missingModels, [MODELS.diffusion, MODELS.textEncoder]);
  } finally {
    await comfy.close();
  }
});
