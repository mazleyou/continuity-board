import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  CUT_COUNT, SCHEMA_VERSION, emptyTraits,
  type Asset, type Project, type ShotSize,
} from './model.ts';

export const newId = () => randomUUID().slice(0, 8);
export const now = () => new Date().toISOString();

const DEFAULT_SHOTS: ShotSize[] = ['wide', 'medium', 'close-up', 'full', 'medium', 'wide'];

export class NotFoundError extends Error {}
export class ConflictError extends Error {}
export class BadRequestError extends Error {}

const UPLOAD_MAX_SIDE = 4096;
const UPLOAD_MAX_PIXELS = 64_000_000;

/**
 * Re-encodes a user upload before it is stored: applies the EXIF orientation, drops all metadata
 * (GPS position, camera, timestamps would otherwise travel into exports and to the GPU server),
 * caps the size and stores lossless PNG so references do not degrade.
 */
export async function normalizeUpload(bytes: Buffer): Promise<Buffer> {
  try {
    return await sharp(bytes, { limitInputPixels: UPLOAD_MAX_PIXELS })
      .rotate()
      .resize({ width: UPLOAD_MAX_SIDE, height: UPLOAD_MAX_SIDE, fit: 'inside', withoutEnlargement: true })
      .png()
      .toBuffer();
  } catch {
    throw new BadRequestError(`읽을 수 없는 이미지입니다 (PNG·JPEG·WebP, 최대 ${UPLOAD_MAX_PIXELS / 1e6}MP)`);
  }
}

/** File-backed project store. All writes for one project are serialized and written atomically (tmp + rename). */
export class Store {
  readonly root: string;
  /** Emits ('change', projectId, project) after every successful write. */
  readonly events = new EventEmitter().setMaxListeners(0);
  private locks = new Map<string, Promise<unknown>>();

  /** Unreferenced files younger than this are kept, so a just-uploaded file is never collected before it is linked. */
  private readonly gcMinAgeMs: number;

  constructor(root: string, opts: { gcMinAgeMs?: number } = {}) {
    this.root = root;
    this.gcMinAgeMs = opts.gcMinAgeMs ?? 10 * 60_000;
  }

  projectDir(id: string) {
    if (!/^[a-z0-9-]+$/.test(id)) throw new NotFoundError(`invalid project id: ${id}`);
    return join(this.root, 'projects', id);
  }

  assetPath(projectId: string, asset: Pick<Asset, 'sha256' | 'ext'>) {
    if (!/^[a-f0-9]{64}$/.test(asset.sha256)) throw new NotFoundError('invalid asset');
    return join(this.projectDir(projectId), 'assets', `${asset.sha256}.${asset.ext}`);
  }

  async list(): Promise<Pick<Project, 'id' | 'title' | 'updatedAt'>[]> {
    const dir = join(this.root, 'projects');
    await mkdir(dir, { recursive: true });
    const out = [];
    for (const id of await readdir(dir)) {
      try {
        const p = await this.load(id);
        out.push({ id: p.id, title: p.title, updatedAt: p.updatedAt });
      } catch {
        // not a project directory
      }
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async create(title: string): Promise<Project> {
    const t = now();
    const p: Project = {
      schemaVersion: SCHEMA_VERSION,
      id: newId(),
      title: title || '새 스토리보드',
      style: 'clean storyboard illustration, soft flat colors, clear line art',
      aspect: '16:9',
      createdAt: t,
      updatedAt: t,
      draft: { traits: emptyTraits() },
      versions: [],
      cuts: Array.from({ length: CUT_COUNT }, (_, index) => ({
        id: newId(),
        index,
        scene: { location: '', action: '', expression: '', shot: DEFAULT_SHOTS[index] },
        candidates: [],
        approvedCandidateId: null,
        approvals: [],
      })),
      jobs: [],
    };
    await mkdir(join(this.projectDir(p.id), 'assets'), { recursive: true });
    await this.write(p);
    return p;
  }

  async load(id: string): Promise<Project> {
    try {
      return JSON.parse(await readFile(join(this.projectDir(id), 'project.json'), 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundError(`project not found: ${id}`);
      throw e;
    }
  }

  /** Read-modify-write under a per-project lock. The mutator may throw to abort without writing. */
  update<T>(id: string, mutate: (p: Project) => T | Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(async () => {
      const p = await this.load(id);
      const result = await mutate(p);
      p.updatedAt = now();
      await this.write(p);
      this.events.emit('change', id, p);
      return result;
    });
    this.locks.set(id, run);
    return run;
  }

  async delete(id: string) {
    await rm(this.projectDir(id), { recursive: true, force: true });
  }

  private async write(p: Project) {
    const file = join(this.projectDir(p.id), 'project.json');
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify(p, null, 2));
    await rename(tmp, file);
  }

  /** Stores bytes content-addressed. Existing files are never rewritten, so approved images cannot change. */
  async putAsset(projectId: string, bytes: Buffer): Promise<Asset> {
    const meta = await sharp(bytes).metadata().catch(() => {
      throw new BadRequestError('지원하지 않는 이미지 형식입니다 (PNG, JPEG, WebP).');
    });
    const ext = meta.format === 'jpeg' ? 'jpg' : meta.format === 'webp' ? 'webp' : meta.format === 'png' ? 'png' : null;
    if (!ext || !meta.width || !meta.height) throw new BadRequestError('지원하지 않는 이미지 형식입니다 (PNG, JPEG, WebP).');
    const asset: Asset = { sha256: sha256(bytes), ext, width: meta.width, height: meta.height };
    const file = this.assetPath(projectId, asset);
    try {
      await stat(file);
    } catch {
      await mkdir(join(this.projectDir(projectId), 'assets'), { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, bytes, { flag: 'wx' });
      await rename(tmp, file);
    }
    return asset;
  }

  /** Locates a stored asset by hash (generation records keep only the hash). */
  async findAsset(projectId: string, sha: string): Promise<Pick<Asset, 'sha256' | 'ext'> | null> {
    for (const ext of ['png', 'jpg', 'webp'] as const) {
      try {
        await stat(this.assetPath(projectId, { sha256: sha, ext }));
        return { sha256: sha, ext };
      } catch {
        // try the next extension
      }
    }
    return null;
  }

  readAsset(projectId: string, asset: Pick<Asset, 'sha256' | 'ext'>) {
    return readFile(this.assetPath(projectId, asset));
  }

  /**
   * Deletes asset files nothing in the project points to (e.g. reference photos that were replaced before use).
   * Anything a version, draft, cut, candidate, queued job or generation record mentions is kept.
   */
  async gc(projectId: string): Promise<{ deleted: string[]; freedBytes: number }> {
    const referenced = referencedShas(await this.load(projectId));
    const dir = join(this.projectDir(projectId), 'assets');
    const deleted: string[] = [];
    let freedBytes = 0;
    for (const file of await readdir(dir).catch(() => [] as string[])) {
      const m = /^([a-f0-9]{64})\.(png|jpg|webp)$/.exec(file);
      if (!m || referenced.has(m[1])) continue;
      const info = await stat(join(dir, file));
      if (Date.now() - info.mtimeMs < this.gcMinAgeMs) continue;
      // Re-check against the latest project right before deleting.
      if (referencedShas(await this.load(projectId)).has(m[1])) continue;
      await unlink(join(dir, file));
      deleted.push(file);
      freedBytes += info.size;
    }
    return { deleted, freedBytes };
  }

  /** Re-hashes every image the project references and reports any file whose content no longer matches. */
  async verify(projectId: string) {
    const p = await this.load(projectId);
    const assets: { label: string; asset: Asset }[] = [];
    for (const v of p.versions) {
      assets.push({ label: `v${v.number} face`, asset: v.faceRef }, { label: `v${v.number} body`, asset: v.bodyRef });
    }
    for (const cut of p.cuts) {
      for (const c of cut.candidates) assets.push({ label: `cut ${cut.index + 1} / ${c.id}`, asset: c.image });
    }
    const problems: string[] = [];
    for (const { label, asset } of assets) {
      try {
        if (sha256(await this.readAsset(projectId, asset)) !== asset.sha256) problems.push(`${label}: hash mismatch`);
      } catch {
        problems.push(`${label}: missing file`);
      }
    }
    const approved = p.cuts
      .map((c) => ({ cut: c.index + 1, sha256: c.candidates.find((x) => x.id === c.approvedCandidateId)?.image.sha256 ?? null }));
    return { ok: problems.length === 0, checked: assets.length, problems, approved };
  }
}

export function sha256(bytes: Buffer | Uint8Array) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Every asset hash the project refers to, including the inputs recorded with each generation. */
export function referencedShas(p: Project): Set<string> {
  const out = new Set<string>();
  const add = (a?: { sha256: string }) => a && out.add(a.sha256);
  add(p.draft.faceRef);
  add(p.draft.bodyRef);
  for (const v of p.versions) { add(v.faceRef); add(v.bodyRef); }
  for (const cut of p.cuts) {
    add(cut.backgroundRef);
    add(cut.propRef);
    for (const c of cut.candidates) {
      add(c.image);
      add(c.mask);
      for (const r of c.generation.references) out.add(r.sha256);
    }
  }
  for (const j of p.jobs) add(j.mask);
  return out;
}
