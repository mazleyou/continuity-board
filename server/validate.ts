import { CUT_COUNT, SCHEMA_VERSION, type Project } from './model.ts';
import { BadRequestError } from './store.ts';

// Structural check for an imported project.json. Imports come from files people pass around, so everything the
// app later dereferences (cuts, versions, candidates, assets) is checked up front instead of failing at render time.

const SHOTS = ['extreme-wide', 'wide', 'full', 'medium', 'close-up', 'extreme-close-up'];
const JOB_STATUSES = ['queued', 'running', 'done', 'failed', 'cancelled'];

class Checker {
  readonly assets = new Set<string>();

  fail(path: string, what: string): never {
    throw new BadRequestError(`프로젝트 파일이 올바르지 않습니다: ${path} ${what}`);
  }
  obj(v: unknown, path: string): Record<string, unknown> {
    if (!v || typeof v !== 'object' || Array.isArray(v)) this.fail(path, '객체가 아닙니다');
    return v as Record<string, unknown>;
  }
  arr(v: unknown, path: string): unknown[] {
    if (!Array.isArray(v)) this.fail(path, '배열이 아닙니다');
    return v;
  }
  str(v: unknown, path: string) {
    if (typeof v !== 'string') this.fail(path, '문자열이 아닙니다');
    return v;
  }
  optStr(v: unknown, path: string) {
    if (v !== undefined) this.str(v, path);
  }
  num(v: unknown, path: string) {
    if (typeof v !== 'number' || !Number.isFinite(v)) this.fail(path, '숫자가 아닙니다');
    return v;
  }
  oneOf(v: unknown, options: string[], path: string) {
    if (typeof v !== 'string' || !options.includes(v)) this.fail(path, `값이 허용되지 않습니다 (${String(v).slice(0, 40)})`);
  }
  asset(v: unknown, path: string) {
    const a = this.obj(v, path);
    if (typeof a.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(a.sha256)) this.fail(`${path}.sha256`, '형식이 아닙니다');
    this.oneOf(a.ext, ['png', 'jpg', 'webp'], `${path}.ext`);
    if (!Number.isInteger(a.width) || !Number.isInteger(a.height) || (a.width as number) < 1 || (a.height as number) < 1) {
      this.fail(path, '크기가 올바르지 않습니다');
    }
    this.assets.add(`${a.sha256}.${a.ext}`);
  }
  optAsset(v: unknown, path: string) {
    if (v !== undefined) this.asset(v, path);
  }
  traits(v: unknown, path: string) {
    const t = this.obj(v, path);
    for (const k of ['name', 'hair', 'outfit', 'props', 'notes']) this.str(t[k], `${path}.${k}`);
  }
}

/** Validates and returns the project plus the asset files ("<sha>.<ext>") it references. */
export function validateProject(raw: unknown): { project: Project; assets: Set<string> } {
  const c = new Checker();
  const p = c.obj(raw, 'project');
  if (p.schemaVersion !== SCHEMA_VERSION) c.fail('schemaVersion', `지원하지 않는 버전입니다 (${String(p.schemaVersion)})`);
  c.str(p.title, 'title');
  c.str(p.style, 'style');

  const draft = c.obj(p.draft, 'draft');
  c.traits(draft.traits, 'draft.traits');
  c.optAsset(draft.faceRef, 'draft.faceRef');
  c.optAsset(draft.bodyRef, 'draft.bodyRef');

  const versionIds = new Set<string>();
  c.arr(p.versions, 'versions').forEach((v, i) => {
    const path = `versions[${i}]`;
    const o = c.obj(v, path);
    versionIds.add(c.str(o.id, `${path}.id`));
    c.num(o.number, `${path}.number`);
    c.traits(o.traits, `${path}.traits`);
    c.asset(o.faceRef, `${path}.faceRef`);
    c.asset(o.bodyRef, `${path}.bodyRef`);
  });

  const cuts = c.arr(p.cuts, 'cuts');
  if (cuts.length !== CUT_COUNT) c.fail('cuts', `컷이 ${CUT_COUNT}개가 아닙니다`);
  cuts.forEach((cutRaw, i) => {
    const path = `cuts[${i}]`;
    const cut = c.obj(cutRaw, path);
    c.str(cut.id, `${path}.id`);
    if (cut.index !== i) c.fail(`${path}.index`, '순서가 맞지 않습니다');
    const s = c.obj(cut.scene, `${path}.scene`);
    for (const k of ['location', 'action', 'expression']) c.str(s[k], `${path}.scene.${k}`);
    c.oneOf(s.shot, SHOTS, `${path}.scene.shot`);
    c.optStr(s.lighting, `${path}.scene.lighting`);
    c.optAsset(cut.backgroundRef, `${path}.backgroundRef`);
    c.optAsset(cut.propRef, `${path}.propRef`);
    const candidateIds = new Set<string>();
    c.arr(cut.candidates, `${path}.candidates`).forEach((candRaw, j) => {
      const cp = `${path}.candidates[${j}]`;
      const cand = c.obj(candRaw, cp);
      candidateIds.add(c.str(cand.id, `${cp}.id`));
      c.oneOf(cand.kind, ['generate', 'edit'], `${cp}.kind`);
      if (!versionIds.has(cand.characterVersionId as string)) c.fail(`${cp}.characterVersionId`, '없는 기준을 가리킵니다');
      c.asset(cand.image, `${cp}.image`);
      c.optAsset(cand.mask, `${cp}.mask`);
      const g = c.obj(cand.generation, `${cp}.generation`);
      c.str(g.prompt, `${cp}.generation.prompt`);
      c.num(g.seed, `${cp}.generation.seed`);
      c.arr(g.references, `${cp}.generation.references`);
      c.arr(cand.reviews, `${cp}.reviews`);
    });
    if (cut.approvedCandidateId !== null && !candidateIds.has(cut.approvedCandidateId as string)) {
      c.fail(`${path}.approvedCandidateId`, '없는 후보를 가리킵니다');
    }
    c.arr(cut.approvals, `${path}.approvals`);
  });

  c.arr(p.jobs, 'jobs').forEach((j, i) => c.oneOf(c.obj(j, `jobs[${i}]`).status, JOB_STATUSES, `jobs[${i}].status`));
  return { project: raw as Project, assets: c.assets };
}
