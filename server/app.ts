import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { BadRequestError, ConflictError, NotFoundError, newId, normalizeUpload, now, type Store } from './store.ts';
import { JobRunner } from './jobs.ts';
import { exportZip, importZip, renderBoard, templateWorkflows } from './export.ts';
import { currentVersion, needsRefresh, approvedCandidate, type Asset, type Checklist, type Cut, type Job, type Project, type Scene, type ShotSize, type Traits } from './model.ts';
import { normalizeMask } from './inpaint.ts';
import { REFRESH_INSTRUCTION } from './prompt.ts';
import { FRAME } from './workflow.ts';
import type { Backend } from './backends/types.ts';

const MAX_BODY = 40 * 1024 * 1024;
const MAX_IMPORT = 2 * 1024 * 1024 * 1024;
// Content types a browser may send cross-site without a CORS preflight. JSON APIs must never accept them.
const SIMPLE_TYPES = ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data'];
const SHOTS: ShotSize[] = ['extreme-wide', 'wide', 'full', 'medium', 'close-up', 'extreme-close-up'];
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json',
};

class BadRequest extends BadRequestError {}

type Params = Record<string, string>;
type Handler = (req: IncomingMessage, params: Params, body: (limit?: number) => Promise<Buffer>) => Promise<unknown>;
interface Raw { raw: Buffer | Uint8Array; type: string; filename?: string; cache?: boolean }

export interface AppOptions {
  /** Extra host names (besides localhost) the app may be reached by, e.g. a LAN name. */
  allowedHosts?: string[];
}

export function createApp(store: Store, backend: Backend, webRoot: string, opts: AppOptions = {}) {
  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', ...(opts.allowedHosts ?? [])].map((h) => h.toLowerCase()));
  const runner = new JobRunner(store, backend);
  const routes: { method: string; pattern: RegExp; keys: string[]; handler: Handler }[] = [];
  const route = (method: string, path: string, handler: Handler) => {
    const keys: string[] = [];
    const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`);
    routes.push({ method, pattern, keys, handler });
  };
  const json = async (body: (limit?: number) => Promise<Buffer>) => {
    const b = await body();
    try {
      return b.length ? JSON.parse(b.toString('utf8')) : {};
    } catch {
      throw new BadRequest('JSON 형식이 올바르지 않습니다');
    }
  };
  const findCut = (p: Project, cutId: string): Cut => {
    const cut = p.cuts.find((c) => c.id === cutId);
    if (!cut) throw new NotFoundError('컷을 찾을 수 없습니다');
    return cut;
  };
  const str = (v: unknown, max = 500) => (typeof v === 'string' ? v.slice(0, max) : '');
  const seedOf = (v: unknown) => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : undefined);
  const newJob = (cut: Cut, p: Project, extra: Partial<Job>): Job => ({
    id: newId(), cutId: cut.id, kind: 'generate', characterVersionId: currentVersion(p)!.id,
    status: 'queued', attempts: 0, createdAt: now(), ...extra,
  });

  // ---- system ----
  route('GET', '/api/health', async () => backend.health());
  route('GET', '/api/workflows/:name', async (_r, { name }) => {
    const wf = templateWorkflows()[name];
    if (!wf) throw new NotFoundError('워크플로를 찾을 수 없습니다');
    return { raw: Buffer.from(JSON.stringify(wf, null, 2)), type: 'application/json', filename: name } satisfies Raw;
  });

  // ---- projects ----
  route('GET', '/api/projects', async () => store.list());
  route('POST', '/api/projects', async (_r, _p, body) => store.create(str((await json(body)).title, 120)));
  route('POST', '/api/projects/import', async (_r, _p, body) => importZip(store, new Uint8Array(await body(MAX_IMPORT))));
  route('GET', '/api/projects/:id', async (_r, { id }) => {
    const p = await store.load(id);
    const live = Object.fromEntries(p.jobs.filter((j) => j.status === 'running')
      .map((j) => [j.id, runner.progressOf(j.id)]).filter(([, v]) => v));
    return { ...p, live };
  });
  route('PATCH', '/api/projects/:id', async (_r, { id }, body) => {
    const b = await json(body);
    return store.update(id, (p) => {
      if (typeof b.title === 'string') p.title = str(b.title, 120) || p.title;
      if (typeof b.style === 'string') p.style = str(b.style, 300);
      return p;
    });
  });
  route('DELETE', '/api/projects/:id', async (_r, { id }) => {
    await store.load(id);
    await store.delete(id);
    return { ok: true };
  });

  // ---- character baseline ----
  route('PUT', '/api/projects/:id/draft/traits', async (_r, { id }, body) => {
    const t = (await json(body)).traits ?? {};
    return store.update(id, (p) => {
      const traits: Traits = { name: str(t.name, 80), hair: str(t.hair), outfit: str(t.outfit), props: str(t.props), notes: str(t.notes) };
      p.draft.traits = traits;
      return p;
    });
  });
  route('PUT', '/api/projects/:id/draft/:slot', async (_r, { id, slot }, body) => {
    if (slot !== 'face' && slot !== 'body') throw new NotFoundError('알 수 없는 참조 슬롯');
    const asset = await store.putAsset(id, await normalizeUpload(await body()));
    return store.update(id, (p) => {
      p.draft[slot === 'face' ? 'faceRef' : 'bodyRef'] = asset;
      return p;
    });
  });
  route('POST', '/api/projects/:id/versions', async (_r, { id }) => store.update(id, (p) => {
    const d = p.draft;
    if (!d.faceRef || !d.bodyRef) throw new BadRequest('얼굴 참조와 전신 참조가 모두 필요합니다');
    if (!d.traits.hair && !d.traits.outfit && !d.traits.props) throw new BadRequest('유지할 특징을 하나 이상 입력하세요 (머리·의상·소품)');
    const cur = currentVersion(p);
    if (cur && JSON.stringify([cur.traits, cur.faceRef.sha256, cur.bodyRef.sha256]) === JSON.stringify([d.traits, d.faceRef.sha256, d.bodyRef.sha256])) {
      throw new ConflictError('현재 기준과 바뀐 내용이 없습니다');
    }
    p.versions.push({
      id: newId(), number: (cur?.number ?? 0) + 1, createdAt: now(),
      traits: structuredClone(d.traits), faceRef: d.faceRef, bodyRef: d.bodyRef,
    });
    return p;
  }));

  // ---- cuts ----
  route('PATCH', '/api/projects/:id/cuts/:cutId', async (_r, { id, cutId }, body) => {
    const s = (await json(body)).scene ?? {};
    return store.update(id, (p) => {
      const cut = findCut(p, cutId);
      const scene: Scene = {
        location: str(s.location), action: str(s.action), expression: str(s.expression),
        shot: SHOTS.includes(s.shot) ? s.shot : cut.scene.shot,
        lighting: str(s.lighting),
      };
      cut.scene = scene;
      return p;
    });
  });
  route('PUT', '/api/projects/:id/cuts/:cutId/ref/:slot', async (_r, { id, cutId, slot }, body) => {
    if (slot !== 'background' && slot !== 'prop') throw new NotFoundError('알 수 없는 참조 슬롯');
    const asset = await store.putAsset(id, await normalizeUpload(await body()));
    return store.update(id, (p) => {
      findCut(p, cutId)[slot === 'background' ? 'backgroundRef' : 'propRef'] = asset;
      return p;
    });
  });
  route('DELETE', '/api/projects/:id/cuts/:cutId/ref/:slot', async (_r, { id, cutId, slot }) => store.update(id, (p) => {
    const cut = findCut(p, cutId);
    if (slot === 'background') delete cut.backgroundRef;
    else if (slot === 'prop') delete cut.propRef;
    else throw new NotFoundError('알 수 없는 참조 슬롯');
    return p;
  }));

  const queueGenerate = (p: Project, cut: Cut, count: number, seed?: number) => {
    if (!currentVersion(p)) throw new BadRequest('먼저 캐릭터 기준을 승인하세요');
    if (!cut.scene.location && !cut.scene.action) throw new BadRequest(`컷 ${cut.index + 1}: 장소나 행동을 입력하세요`);
    const jobs = Array.from({ length: count }, (_, i) => newJob(cut, p, { seed: seed === undefined ? undefined : seed + i }));
    p.jobs.push(...jobs);
    return jobs;
  };
  const enqueueAll = (id: string, jobs: Job[]) => jobs.forEach((j) => runner.enqueue(id, j.id));

  route('POST', '/api/projects/:id/cuts/:cutId/generate', async (_r, { id, cutId }, body) => {
    const b = await json(body);
    const count = Math.min(3, Math.max(1, Number(b.count) || 1));
    const { p, jobs } = await store.update(id, (p) => ({ p, jobs: queueGenerate(p, findCut(p, cutId), count, seedOf(b.seed)) }));
    enqueueAll(id, jobs);
    return p;
  });
  route('POST', '/api/projects/:id/generate-missing', async (_r, { id }, body) => {
    const count = Math.min(3, Math.max(1, Number((await json(body)).count) || 1));
    const { p, jobs } = await store.update(id, (p) => {
      const busy = new Set(p.jobs.filter((j) => j.status === 'queued' || j.status === 'running').map((j) => j.cutId));
      const targets = p.cuts.filter((c) => !c.approvedCandidateId && !busy.has(c.id));
      return { p, jobs: targets.flatMap((c) => queueGenerate(p, c, count)) };
    });
    enqueueAll(id, jobs);
    return p;
  });
  route('POST', '/api/projects/:id/cuts/:cutId/candidates/:cid/edit', async (_r, { id, cutId, cid }, body) => {
    const b = await json(body);
    const instruction = str(b.instruction, 600).trim();
    if (!instruction) throw new BadRequest('수정 지시를 입력하세요');
    let mask: Asset | undefined;
    if (typeof b.mask === 'string' && b.mask) {
      const source = findCut(await store.load(id), cutId).candidates.find((c) => c.id === cid);
      if (!source) throw new NotFoundError('후보를 찾을 수 없습니다');
      if (source.image.width !== FRAME.width || source.image.height !== FRAME.height) {
        throw new BadRequest(`영역 수정은 ${FRAME.width}×${FRAME.height} 컷에서만 할 수 있습니다`);
      }
      const png = Buffer.from(b.mask.replace(/^data:image\/png;base64,/, ''), 'base64');
      try {
        mask = await store.putAsset(id, await normalizeMask(png, FRAME.width, FRAME.height));
      } catch (e) {
        throw new BadRequest((e as Error).message);
      }
    }
    const { p, job } = await store.update(id, (p) => {
      const cut = findCut(p, cutId);
      if (!cut.candidates.some((c) => c.id === cid)) throw new NotFoundError('후보를 찾을 수 없습니다');
      if (!currentVersion(p)) throw new BadRequest('먼저 캐릭터 기준을 승인하세요');
      const job = newJob(cut, p, { kind: 'edit', sourceCandidateId: cid, instruction, seed: seedOf(b.seed), mask });
      p.jobs.push(job);
      return { p, job };
    });
    runner.enqueue(id, job.id);
    return p;
  });
  route('POST', '/api/projects/:id/refresh-stale', async (_r, { id }) => {
    const { p, jobs } = await store.update(id, (p) => {
      const busy = new Set(p.jobs.filter((j) => j.status === 'queued' || j.status === 'running').map((j) => j.cutId));
      const jobs = p.cuts.filter((c) => needsRefresh(p, c, REFRESH_INSTRUCTION) && !busy.has(c.id)).map((c) => newJob(c, p, {
        kind: 'edit', sourceCandidateId: approvedCandidate(c)!.id, instruction: REFRESH_INSTRUCTION,
      }));
      p.jobs.push(...jobs);
      return { p, jobs };
    });
    enqueueAll(id, jobs);
    return p;
  });
  route('POST', '/api/projects/:id/cuts/:cutId/approve', async (_r, { id, cutId }, body) => {
    const b = await json(body);
    const candidateId: string | null = typeof b.candidateId === 'string' ? b.candidateId : null;
    return store.update(id, (p) => {
      const cut = findCut(p, cutId);
      if (candidateId && !cut.candidates.some((c) => c.id === candidateId)) throw new NotFoundError('후보를 찾을 수 없습니다');
      if (candidateId === cut.approvedCandidateId) return p;
      const action = candidateId === null ? 'unapprove' : cut.approvals.some((e) => e.candidateId === candidateId) ? 'restore' : 'approve';
      cut.approvedCandidateId = candidateId;
      cut.approvals.push({ at: now(), candidateId, action });
      return p;
    });
  });
  route('POST', '/api/projects/:id/cuts/:cutId/candidates/:cid/reviews', async (_r, { id, cutId, cid }, body) => {
    const b = await json(body);
    const reviewer = str(b.reviewer, 60).trim();
    if (!reviewer) throw new BadRequest('평가자 이름을 입력하세요');
    const k = b.checklist ?? {};
    const checklist: Checklist = {};
    for (const key of ['face', 'hair', 'outfit', 'props', 'scene'] as const) if (typeof k[key] === 'boolean') checklist[key] = k[key];
    return store.update(id, (p) => {
      const c = findCut(p, cutId).candidates.find((x) => x.id === cid);
      if (!c) throw new NotFoundError('후보를 찾을 수 없습니다');
      c.reviews = c.reviews.filter((r) => r.reviewer !== reviewer);
      c.reviews.push({ reviewer, at: now(), checklist, note: str(b.note) });
      return p;
    });
  });

  // ---- jobs ----
  route('POST', '/api/projects/:id/jobs/:jobId/retry', async (_r, { id, jobId }) => {
    const p = await store.update(id, (p) => {
      const job = p.jobs.find((j) => j.id === jobId);
      if (!job) throw new NotFoundError('작업을 찾을 수 없습니다');
      if (job.status !== 'failed' && job.status !== 'cancelled') throw new ConflictError('실패하거나 취소한 작업만 다시 시도할 수 있습니다');
      job.status = 'queued';
      job.error = undefined;
      return p;
    });
    runner.enqueue(id, jobId);
    return p;
  });
  // Active jobs are cancelled (and kept as "cancelled"); finished records are dismissed.
  route('DELETE', '/api/projects/:id/jobs/:jobId', async (_r, { id, jobId }) => {
    const job = (await store.load(id)).jobs.find((j) => j.id === jobId);
    if (!job) throw new NotFoundError('작업을 찾을 수 없습니다');
    if (job.status === 'running') {
      await runner.cancel(id, jobId);
      return store.load(id);
    }
    if (job.status === 'queued') await runner.cancel(id, jobId);
    return store.update(id, (p) => {
      const j = p.jobs.find((x) => x.id === jobId);
      if (j?.status === 'queued') {
        j.status = 'cancelled';
        j.finishedAt = now();
      } else if (j?.status !== 'running') {
        p.jobs = p.jobs.filter((x) => x.id !== jobId);
      }
      return p;
    });
  });

  // ---- files ----
  route('GET', '/api/projects/:id/assets/:file', async (_r, { id, file }) => {
    const m = /^([a-f0-9]{64})\.(png|jpg|webp)$/.exec(file);
    if (!m) throw new NotFoundError('파일을 찾을 수 없습니다');
    const ext = m[2] as 'png' | 'jpg' | 'webp';
    return { raw: await store.readAsset(id, { sha256: m[1], ext }), type: MIME[`.${ext}`], cache: true } satisfies Raw;
  });
  route('GET', '/api/projects/:id/board.png', async (_r, { id }) =>
    ({ raw: await renderBoard(store, await store.load(id)), type: 'image/png' }) satisfies Raw);
  route('GET', '/api/projects/:id/export.zip', async (_r, { id }) => {
    const p = await store.load(id);
    const safe = p.title.replace(/[^\p{L}\p{N}_-]+/gu, '_').slice(0, 60) || 'project';
    return { raw: await exportZip(store, p), type: 'application/zip', filename: `${safe}.continuity-board.zip` } satisfies Raw;
  });
  route('GET', '/api/projects/:id/verify', async (_r, { id }) => store.verify(id));
  route('GET', '/api/projects/:id/cuts/:cutId/candidates/:cid/graph.json', async (_r, { id, cutId, cid }) => {
    const p = await store.load(id);
    const cut = findCut(p, cutId);
    const c = cut.candidates.find((x) => x.id === cid);
    if (!c?.generation.graph) throw new NotFoundError('저장된 ComfyUI 그래프가 없습니다');
    return { raw: Buffer.from(JSON.stringify(c.generation.graph, null, 2)), type: 'application/json', filename: `cut${cut.index + 1}-${c.id}.api.json` } satisfies Raw;
  });

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    try {
      checkRequestOrigin(req, allowedHosts);
      if (path.startsWith('/api/')) {
        for (const r of routes) {
          if (r.method !== req.method) continue;
          const m = r.pattern.exec(path);
          if (!m) continue;
          const params: Params = {};
          r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
          const out = await r.handler(req, params, (limit = MAX_BODY) => readBody(req, limit));
          if (out && typeof out === 'object' && 'raw' in out) {
            const o = out as Raw;
            const headers: Record<string, string> = { 'content-type': o.type };
            if (o.filename) headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(o.filename)}`;
            headers['cache-control'] = o.cache ? 'public, max-age=31536000, immutable' : 'no-store';
            res.writeHead(200, headers).end(o.raw);
          } else {
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(out));
          }
          return;
        }
        throw new NotFoundError(`없는 API: ${req.method} ${path}`);
      }
      await serveStatic(webRoot, path, res);
    } catch (e) {
      const status = e instanceof Forbidden ? 403 : e instanceof BadRequestError ? 400 : e instanceof NotFoundError ? 404 : e instanceof ConflictError ? 409 : 500;
      if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (e as Error).message }));
    }
  }

  return { server: createServer(handle), runner };
}

class Forbidden extends Error {}

const hostOf = (value: string) => value.toLowerCase().replace(/:\d+$/, '');

/**
 * The app has no login, so it must not be drivable by other web pages the user visits:
 * - Host must be a known name (defeats DNS rebinding, where a foreign domain resolves to 127.0.0.1);
 * - a browser-sent Origin must be this app itself;
 * - writes must not use a content type that skips the CORS preflight.
 */
function checkRequestOrigin(req: IncomingMessage, allowedHosts: Set<string>) {
  const host = req.headers.host ? hostOf(req.headers.host) : '';
  if (!allowedHosts.has(host)) throw new Forbidden(`허용되지 않은 호스트입니다: ${host}`);
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let originHost = '';
    try { originHost = new URL(origin).host.toLowerCase(); } catch {}
    if (originHost !== req.headers.host?.toLowerCase()) throw new Forbidden('다른 사이트에서 보낸 요청은 받지 않습니다');
  } else if (origin === 'null') {
    throw new Forbidden('출처가 없는 요청은 받지 않습니다');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const type = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
    if (SIMPLE_TYPES.includes(type)) throw new Forbidden(`이 형식의 요청은 받지 않습니다: ${type}`);
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (tooBig) return; // keep draining so the client still receives the 400 below
      if (size > limit) {
        tooBig = true;
        chunks.length = 0;
        reject(new BadRequest(`파일이 너무 큽니다 (최대 ${Math.round(limit / 1024 / 1024)}MB)`));
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function serveStatic(root: string, path: string, res: ServerResponse) {
  const rel = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '');
  const file = join(root, rel);
  if (!file.startsWith(root)) throw new NotFoundError('not found');
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' }).end(data);
  } catch {
    throw new NotFoundError('not found');
  }
}
