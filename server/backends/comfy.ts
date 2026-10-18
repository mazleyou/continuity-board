import sharp from 'sharp';
import { LOADER, MODELS, buildGraph, type ApiGraph } from '../workflow.ts';
import { CancelledError, type Backend, type Health, type Progress, type RunRequest, type RunResult } from './types.ts';

type ImageRef = { filename: string; subfolder: string; type: string };

/**
 * Talks to a local (or remote) ComfyUI server through its native API:
 * POST /upload/image → POST /prompt (with our own prompt_id) → websocket progress → GET /view.
 * /history is polled as well, so a dropped websocket only costs progress updates, never the result.
 */
export class ComfyBackend implements Backend {
  readonly name = 'comfyui';
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly freeOnIdle: boolean;
  private readonly clientId = crypto.randomUUID();
  private readonly cancelled = new Set<string>();
  private warm = false;

  constructor(url: string, opts: { timeoutMs?: number; freeOnIdle?: boolean } = {}) {
    this.url = url.replace(/\/$/, '');
    this.timeoutMs = opts.timeoutMs ?? 15 * 60_000;
    this.freeOnIdle = opts.freeOnIdle ?? false;
  }

  async health(): Promise<Health> {
    try {
      const stats = await this.json('/system_stats');
      const missing: string[] = [];
      const check = async (node: string, field: string, file: string) => {
        const info = await this.json(`/object_info/${node}`);
        if (!info?.[node]) { missing.push(`${file} (${node} 노드 없음)`); return; }
        const spec = info[node].input?.required?.[field];
        const options: string[] = Array.isArray(spec?.[0]) ? spec[0] : spec?.[1]?.options ?? [];
        if (!options.includes(file)) missing.push(file);
      };
      await check(LOADER === 'gguf' ? 'UnetLoaderGGUF' : 'UNETLoader', 'unet_name', MODELS.diffusion);
      await check(LOADER === 'gguf' ? 'CLIPLoaderGGUF' : 'CLIPLoader', 'clip_name', MODELS.textEncoder);
      await check('VAELoader', 'vae_name', MODELS.vae);
      const version = stats?.system?.comfyui_version ?? 'unknown';
      return missing.length
        ? { ok: false, backend: this.name, detail: `ComfyUI ${version}: 모델 파일이 없습니다`, missingModels: missing }
        : { ok: true, backend: this.name, detail: `ComfyUI ${version} @ ${this.url}` };
    } catch (e) {
      return { ok: false, backend: this.name, detail: `ComfyUI에 연결할 수 없습니다 (${this.url}): ${(e as Error).message}` };
    }
  }

  async run(req: RunRequest): Promise<RunResult> {
    const refs = [];
    for (const ref of req.references) refs.push({ image: await this.upload(ref.sha256, ref.bytes), megapixels: ref.megapixels });
    const inpaintMask = req.inpaintMask ? await this.upload(req.inpaintMask.sha256, req.inpaintMask.bytes) : undefined;
    const graph = buildGraph({
      prompt: req.prompt, references: refs, seed: req.seed, width: req.width, height: req.height, inpaintMask,
      filenamePrefix: `continuity-board/${req.label}`,
    });
    const coldStart = !this.warm;

    let promptId = req.resumeId;
    const adopt = promptId ? await this.isKnown(promptId) : false;
    if (!adopt) promptId = crypto.randomUUID();
    const id = promptId!;
    const watch = this.watch(id, graph, req.onProgress);
    try {
      await watch.ready;
      if (!adopt) {
        await req.onSubmit?.(id);
        const queued = await this.json('/prompt', {
          method: 'POST', body: JSON.stringify({ prompt: graph, client_id: this.clientId, prompt_id: id }),
        });
        if (queued.error) throw new Error(formatComfyError(queued));
      }
      const image = await this.waitForImage(id, watch.done);
      this.warm = true;
      return { image, graph, coldStart };
    } finally {
      watch.close();
      this.cancelled.delete(id);
    }
  }

  async cancel(id: string) {
    this.cancelled.add(id);
    await fetch(`${this.url}/api/jobs/${id}/cancel`, { method: 'POST' }).catch(() => {});
  }

  async release() {
    if (!this.freeOnIdle) return;
    await fetch(`${this.url}/free`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ unload_models: true, free_memory: true }),
    }).catch(() => {});
  }

  private async isKnown(id: string) {
    const res = await fetch(`${this.url}/api/jobs/${id}`).catch(() => null);
    return !!res?.ok;
  }

  /** Websocket listener for one prompt: reports progress and settles on success, error or interruption. */
  private watch(id: string, graph: ApiGraph, onProgress?: (p: Progress) => void) {
    let settle!: (v: { error?: Error }) => void;
    const done = new Promise<{ error?: Error }>((r) => (settle = r));
    const total = Object.keys(graph).length;
    const seen = new Set<string>();
    let ws: WebSocket | null = null;
    let ready: Promise<void> = Promise.resolve();
    try {
      ws = new WebSocket(`${this.url.replace(/^http/, 'ws')}/ws?clientId=${this.clientId}`);
      const socket = ws;
      // Subscribe before submitting so early events are not missed; give up waiting after 2s.
      ready = new Promise<void>((r) => {
        socket.addEventListener('open', () => r(), { once: true });
        socket.addEventListener('error', () => r(), { once: true });
        setTimeout(r, 2000);
      });
      ws.addEventListener('message', (ev) => {
        if (typeof ev.data !== 'string') return; // binary preview frames
        let msg: { type: string; data: any };
        try { msg = JSON.parse(ev.data); } catch { return; }
        const d = msg.data ?? {};
        if (d.prompt_id !== id) return;
        if (msg.type === 'executing' && d.node) {
          seen.add(d.node);
          const cls = graph[d.node]?.class_type ?? '';
          const phase = /Loader/.test(cls) ? '모델 불러오는 중' : cls === 'SamplerCustomAdvanced' ? '그리는 중'
            : /VAEDecode|SaveImage/.test(cls) ? '마무리 중' : '참조 준비 중';
          onProgress?.({ fraction: cls === 'SamplerCustomAdvanced' ? 0.3 : /VAEDecode|SaveImage/.test(cls) ? 0.92 : Math.min(0.28, 0.28 * seen.size / total), phase });
        } else if (msg.type === 'progress' && d.max) {
          onProgress?.({ fraction: 0.3 + 0.6 * (d.value / d.max), phase: `그리는 중 ${d.value}/${d.max}` });
        } else if (msg.type === 'execution_success') {
          settle({});
        } else if (msg.type === 'execution_error') {
          settle({ error: new Error(`ComfyUI 실행 오류 (${d.node_type ?? '?'}): ${d.exception_message ?? ''}`.trim()) });
        } else if (msg.type === 'execution_interrupted') {
          settle({ error: new CancelledError() });
        }
      });
    } catch {
      // No websocket: the /history poll below still delivers the result.
    }
    return { done, ready, close: () => ws?.close() };
  }

  private async waitForImage(id: string, wsDone: Promise<{ error?: Error }>): Promise<Buffer> {
    const ws: { result?: { error?: Error } } = {};
    wsDone.then((r) => (ws.result = r));
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      if (ws.result?.error) throw this.cancelled.has(id) ? new CancelledError() : ws.result.error;
      const entry = (await this.json(`/history/${id}`))?.[id];
      if (entry) {
        const status = entry.status;
        if (status?.status_str === 'error') {
          if (this.cancelled.has(id) || status.messages?.some((m: [string]) => m[0] === 'execution_interrupted')) throw new CancelledError();
          const msg = status.messages?.find((m: [string, unknown]) => m[0] === 'execution_error')?.[1];
          throw new Error(`ComfyUI 실행 오류 (${msg?.node_type ?? '?'}): ${msg?.exception_message ?? JSON.stringify(status.messages)}`.trim());
        }
        if (status?.completed) {
          const img = Object.values<{ images?: ImageRef[] }>(entry.outputs ?? {}).flatMap((o) => o.images ?? [])[0];
          if (!img) throw new Error('ComfyUI가 이미지를 반환하지 않았습니다');
          const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder, type: img.type });
          const res = await fetch(`${this.url}/view?${q}`);
          if (!res.ok) throw new Error(`이미지 다운로드 실패: HTTP ${res.status}`);
          return Buffer.from(await res.arrayBuffer());
        }
      }
      if (this.cancelled.has(id) && !(await this.isKnown(id))) throw new CancelledError();
      await Promise.race([wsDone, new Promise((r) => setTimeout(r, 1000))]);
    }
    await this.cancel(id);
    throw new Error(`시간 초과 (${Math.round(this.timeoutMs / 1000)}초)`);
  }

  /** Uploads an image once; the name is derived from its hash so repeated cuts reuse it. */
  private async upload(sha: string, bytes: Buffer): Promise<string> {
    const name = `cb_${sha.slice(0, 24)}.png`;
    const png = await sharp(bytes).rotate().png().toBuffer();
    const form = new FormData();
    form.append('image', new Blob([new Uint8Array(png)], { type: 'image/png' }), name);
    form.append('overwrite', 'true');
    const res = await fetch(`${this.url}/upload/image`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`이미지 업로드 실패: HTTP ${res.status} ${await res.text()}`);
    const body = await res.json();
    return body.subfolder ? `${body.subfolder}/${body.name}` : body.name;
  }

  private async json(path: string, init?: RequestInit) {
    const res = await fetch(`${this.url}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let body: any;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    if (!res.ok && !body.error) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    return body;
  }
}

/** Turns a /prompt validation failure into something a user can act on (e.g. which model file is missing). */
export function formatComfyError(body: any): string {
  const nodeErrors = Object.entries<any>(body.node_errors ?? {})
    .map(([id, e]) => `${e.class_type}#${id}: ${e.errors?.map((x: any) => `${x.message} ${x.details ?? ''}`.trim()).join(', ')}`);
  return [`ComfyUI가 워크플로를 거부했습니다: ${body.error?.message ?? ''}`, ...nodeErrors].join(' / ');
}
