import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { BackendUnavailableError, CancelledError, type Backend, type Health, type RunRequest, type RunResult } from './types.ts';

/**
 * Deterministic stand-in for the model, for UI work, tests and demos without a GPU.
 * Output is a function of (prompt, seed, references), so the same request yields the same bytes.
 * A prompt containing "[[fail]]" fails on purpose to exercise retry handling.
 */
export class MockBackend implements Backend {
  readonly name = 'mock';
  private readonly delayMs: number;
  private readonly cancelled = new Set<string>();
  private warm = false;
  /** Simulates ComfyUI being down (tests, demos of the waiting banner). */
  offline = false;

  constructor(delayMs = 600) {
    this.delayMs = delayMs;
  }

  async health(): Promise<Health> {
    if (this.offline) return { ok: false, backend: this.name, detail: 'Mock 백엔드: 오프라인으로 설정됨' };
    return { ok: true, backend: this.name, detail: 'Mock 백엔드 — 실제 모델 없이 흐름만 검증합니다' };
  }

  async cancel(id: string) {
    this.cancelled.add(id);
  }

  async release() {}

  async run(req: RunRequest): Promise<RunResult> {
    if (this.offline) throw new BackendUnavailableError('mock: 오프라인');
    const id = req.resumeId ?? crypto.randomUUID();
    if (!req.resumeId) await req.onSubmit?.(id);
    const steps = 4;
    for (let i = 0; i < steps; i++) {
      await new Promise((r) => setTimeout(r, this.delayMs / steps));
      if (this.cancelled.delete(id)) throw new CancelledError();
      req.onProgress?.({ fraction: (i + 1) / steps * 0.9, phase: `그리는 중 ${i + 1}/${steps}` });
    }
    if (req.prompt.includes('[[fail]]')) throw new Error('mock: 의도된 실패 ([[fail]])');

    const h = createHash('sha256').update(`${req.prompt}|${req.seed}|${req.references.map((r) => r.sha256).join(',')}`).digest();
    const hue = h[0] / 255 * 360;
    const { width, height } = req;

    let base: sharp.Sharp;
    if (req.kind === 'edit') {
      base = sharp(req.references[0].bytes).resize(width, height, { fit: 'cover' })
        .modulate({ hue: Math.round((h[1] / 255) * 40 - 20), saturation: 1.1 });
    } else {
      base = sharp({ create: { width, height, channels: 3, background: hsl(hue, 35, 82) } });
    }

    const layers: sharp.OverlayOptions[] = [];
    const refs = req.kind === 'edit' ? req.references.slice(1) : req.references;
    const thumb = Math.round(height * 0.42);
    let x = Math.round(width * 0.06);
    for (const ref of refs) {
      const t = await sharp(ref.bytes).resize(thumb, thumb, { fit: 'cover' }).png().toBuffer();
      layers.push({ input: t, left: x, top: Math.round(height * 0.22) });
      x += thumb + 16;
    }
    layers.push({ input: Buffer.from(captionSvg(width, height, req, hue)), left: 0, top: 0 });

    const image = await base.composite(layers).png().toBuffer();
    const coldStart = !this.warm;
    this.warm = true;
    return { image, graph: null, coldStart };
  }
}

function hsl(h: number, s: number, l: number) {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return { r: f(0), g: f(8), b: f(4) };
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function captionSvg(w: number, h: number, req: RunRequest, hue: number) {
  const words = req.prompt.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).length > 92) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  const text = lines.slice(0, 7).map((l, i) => `<text x="40" y="${h - 210 + i * 26}">${esc(l)}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect x="0" y="0" width="${w}" height="64" fill="hsl(${hue},30%,25%)"/>
    <text x="40" y="42" font-family="Helvetica, Arial, sans-serif" font-size="26" font-weight="700" fill="#fff">MOCK · ${req.kind.toUpperCase()} · seed ${req.seed}</text>
    <rect x="0" y="${h - 240}" width="${w}" height="240" fill="rgba(255,255,255,0.82)"/>
    <g font-family="Helvetica, Arial, sans-serif" font-size="20" fill="#222">${text}</g>
  </svg>`;
}
