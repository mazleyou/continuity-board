import sharp, { type OverlayOptions } from 'sharp';
import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { SCHEMA_VERSION, approvedCandidate, currentVersion, isStale, type CharacterVersion, type Cut, type Project } from './model.ts';
import { BadRequestError, now, referencedShas, sha256, type Store } from './store.ts';
import { validateProject } from './validate.ts';
import { FRAME, WORKFLOW_VERSION, buildGraph, toUiWorkflow } from './workflow.ts';
import { REFERENCE_MEGAPIXELS, editPrompt, generationPrompt, generationRefs } from './prompt.ts';

const SHOT_KO: Record<string, string> = {
  'extreme-wide': '익스트림 와이드', wide: '와이드', full: '풀샷', medium: '미디엄', 'close-up': '클로즈업', 'extreme-close-up': '익스트림 클로즈업',
};
const FONT = `'Apple SD Gothic Neo', 'Noto Sans CJK KR', 'Noto Sans KR', 'Malgun Gothic', sans-serif`;

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}
function clip(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** 3×2 board of the approved cuts with scene captions. Unapproved cuts are drawn as empty slots. */
export async function renderBoard(store: Store, p: Project): Promise<Buffer> {
  const cellW = 640, cellH = Math.round(cellW * FRAME.height / FRAME.width), capH = 92, gap = 24, pad = 40, headH = 96;
  const W = pad * 2 + cellW * 3 + gap * 2;
  const H = headH + pad + (cellH + capH) * 2 + gap + pad;
  const v = currentVersion(p);
  const layers: OverlayOptions[] = [];
  let svg = `<text x="${pad}" y="58" font-size="34" font-weight="700" fill="#1b1b1f">${esc(p.title)}</text>`;
  if (v) {
    svg += `<text x="${W - pad}" y="58" font-size="20" text-anchor="end" fill="#55555c">${esc(clip(`${v.traits.name || '캐릭터'} · 기준 v${v.number}`, 60))}</text>`;
  }
  for (const cut of p.cuts) {
    const col = cut.index % 3, row = Math.floor(cut.index / 3);
    const x = pad + col * (cellW + gap);
    const y = headH + row * (cellH + capH + gap);
    const approved = approvedCandidate(cut);
    if (approved) {
      const img = await sharp(await store.readAsset(p.id, approved.image)).resize(cellW, cellH, { fit: 'cover' }).png().toBuffer();
      layers.push({ input: img, left: x, top: y });
    } else {
      svg += `<rect x="${x}" y="${y}" width="${cellW}" height="${cellH}" fill="#ececef" stroke="#c9c9cf" stroke-dasharray="8 6"/>`;
      svg += `<text x="${x + cellW / 2}" y="${y + cellH / 2 + 8}" font-size="24" text-anchor="middle" fill="#8a8a92">미승인</text>`;
    }
    const s = cut.scene;
    const stale = isStale(p, cut) ? '  ⚠ 이전 기준' : '';
    const head = `#${cut.index + 1}  ${SHOT_KO[s.shot] ?? s.shot}${s.expression ? `  ·  ${clip(s.expression, 24)}` : ''}${stale}`;
    svg += `<text x="${x}" y="${y + cellH + 30}" font-size="20" font-weight="700" fill="#1b1b1f">${esc(head)}</text>`;
    if (s.location) svg += `<text x="${x}" y="${y + cellH + 57}" font-size="17" fill="#33333a">${esc(clip(s.location, 56))}</text>`;
    if (s.action) svg += `<text x="${x}" y="${y + cellH + 81}" font-size="16" fill="#6b6b73">${esc(clip(s.action, 60))}</text>`;
  }
  layers.push({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><g font-family="${FONT}">${svg}</g></svg>`), left: 0, top: 0 });
  return sharp({ create: { width: W, height: H, channels: 3, background: '#fafafa' } }).composite(layers).png().toBuffer();
}

/** Template workflows (placeholder references) in both API and UI formats, using the app's own prompt builders. */
export function templateWorkflows(): Record<string, unknown> {
  const asset = (n: string) => ({ sha256: n.padEnd(64, '0'), ext: 'png' as const, width: FRAME.width, height: FRAME.height });
  const version: CharacterVersion = {
    id: 'v', number: 1, createdAt: '', faceRef: asset('f'), bodyRef: asset('b'),
    traits: { name: 'Mina', hair: 'short straight black hair', outfit: 'a bright yellow jacket, white t-shirt and dark blue jeans', props: 'a small red shoulder bag', notes: '' },
  };
  const cut: Cut = {
    id: 'c', index: 0, candidates: [], approvedCandidateId: null, approvals: [],
    scene: { location: 'a busy city bus stop in the morning', action: 'waiting and checking her phone', expression: 'sleepy', shot: 'wide', lighting: 'soft morning light' },
  };
  const project = { style: 'clean storyboard illustration, soft flat colors, clear line art' } as Project;
  const instruction = 'change the bag to a small green backpack';
  const refs = (names: string[], roles: (keyof typeof REFERENCE_MEGAPIXELS)[]) =>
    names.map((image, i) => ({ image, megapixels: REFERENCE_MEGAPIXELS[roles[i]] }));
  const generate = buildGraph({
    prompt: generationPrompt(project, version, cut, generationRefs(version, cut)),
    references: refs(['face.png', 'body.png'], ['face', 'body']), seed: 0,
  });
  const edit = buildGraph({
    prompt: editPrompt(version, instruction),
    references: refs(['cut.png', 'face.png', 'body.png'], ['cut', 'face', 'body']), seed: 0,
  });
  const editMasked = buildGraph({
    prompt: editPrompt(version, instruction),
    references: refs(['cut.png', 'face.png', 'body.png'], ['cut', 'face', 'body']), seed: 0, inpaintMask: 'mask.png',
  });
  return {
    'generate.api.json': generate,
    'generate.ui.json': toUiWorkflow(generate, 'Continuity Board — A. 참조 기반 컷 생성'),
    'edit.api.json': edit,
    'edit.ui.json': toUiWorkflow(edit, 'Continuity Board — B. 기존 컷 수정'),
    'edit-masked.api.json': editMasked,
    'edit-masked.ui.json': toUiWorkflow(editMasked, 'Continuity Board — C. 영역 지정 수정'),
  };
}

export function evaluationCsv(p: Project): string {
  const rows: unknown[][] = [['cut', 'candidate', 'kind', 'character_version', 'approved', 'reviewer', 'face', 'hair', 'outfit', 'props', 'scene', 'instruction', 'note', 'duration_ms', 'cold_start', 'prepare_ms', 'sample_ms', 'finish_ms', 'seed']];
  const yn = (b?: boolean) => (b === undefined ? '' : b ? 'pass' : 'fail');
  for (const cut of p.cuts) {
    for (const c of cut.candidates) {
      const ver = p.versions.find((v) => v.id === c.characterVersionId)?.number ?? '';
      const base = [cut.index + 1, c.id, c.kind, `v${ver}`, c.id === cut.approvedCandidateId ? 'yes' : 'no'];
      const ph = c.generation.phases ?? {};
      const tail = [c.generation.durationMs, c.generation.coldStart, ph.prepareMs ?? '', ph.sampleMs ?? '', ph.finishMs ?? '', c.generation.seed];
      if (!c.reviews.length) rows.push([...base, '', '', '', '', '', '', '', '', ...tail]);
      for (const r of c.reviews) {
        const k = r.checklist;
        rows.push([...base, r.reviewer, yn(k.face), yn(k.hair), yn(k.outfit), yn(k.props), yn(k.scene), yn(k.instruction), r.note, ...tail]);
      }
    }
  }
  return rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n') + '\n';
}

/** A self-contained, re-importable package: project.json + assets + human-friendly board/cuts/workflows. */
export async function exportZip(store: Store, p: Project): Promise<Uint8Array> {
  const files: Zippable = {};
  // Everything the project refers to - including masks and the inputs recorded with each generation - so an
  // imported copy is complete and passes import validation.
  const assets: Zippable = {};
  for (const sha of referencedShas(p)) {
    const file = await store.findAsset(p.id, sha);
    if (file) assets[`${file.sha256}.${file.ext}`] = new Uint8Array(await store.readAsset(p.id, file));
  }
  files['project.json'] = strToU8(JSON.stringify(p, null, 2));
  files['assets'] = assets;

  files['board.png'] = new Uint8Array(await renderBoard(store, p));
  const cuts: Zippable = {};
  const workflows: Zippable = {};
  for (const cut of p.cuts) {
    const a = approvedCandidate(cut);
    if (!a) continue;
    const n = String(cut.index + 1).padStart(2, '0');
    cuts[`cut-${n}.${a.image.ext}`] = new Uint8Array(await store.readAsset(p.id, a.image));
    if (a.generation.graph) workflows[`cut-${n}.${a.kind}.api.json`] = strToU8(JSON.stringify(a.generation.graph, null, 2));
  }
  files['cuts'] = cuts;
  for (const [name, wf] of Object.entries(templateWorkflows())) workflows[`template/${name}`] = strToU8(JSON.stringify(wf, null, 2));
  files['workflows'] = workflows;
  files['evaluation.csv'] = strToU8(evaluationCsv(p));

  const v = currentVersion(p);
  const manifest = {
    format: 'continuity-board-project',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: now(),
    workflowVersion: WORKFLOW_VERSION,
    project: { id: p.id, title: p.title },
    characterVersion: v ? { number: v.number, traits: v.traits } : null,
    cuts: p.cuts.map((cut) => {
      const a = approvedCandidate(cut);
      return {
        cut: cut.index + 1,
        scene: cut.scene,
        approved: a ? {
          candidate: a.id, sha256: a.image.sha256, kind: a.kind,
          characterVersion: p.versions.find((x) => x.id === a.characterVersionId)?.number,
          stale: isStale(p, cut),
          backend: a.generation.backend, model: a.generation.model, seed: a.generation.seed, prompt: a.generation.prompt,
          references: a.generation.references,
        } : null,
        candidates: cut.candidates.length,
      };
    }),
    note: 'Re-running a graph with the same seed may not reproduce identical pixels on different hardware or software versions.',
  };
  files['manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  return zipSync(files, { level: 6 });
}

const IMPORT_MAX_ENTRY = 256 * 1024 * 1024;
const IMPORT_MAX_TOTAL = 3 * 1024 * 1024 * 1024;

/**
 * Imports an exported package as a new project (new id). Sizes are checked from the zip directory before anything
 * is inflated (zip bombs), only project.json and assets/ are extracted, the project structure is validated, and
 * every referenced asset must be present with a matching hash. Nothing is created unless all checks pass.
 */
export async function importZip(store: Store, zip: Uint8Array): Promise<Project> {
  let total = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip, {
      filter: (f) => {
        const wanted = f.name === 'project.json' || /^assets\/[a-f0-9]{64}\.(png|jpg|webp)$/.test(f.name);
        if (!wanted) return false;
        total += f.originalSize;
        if (f.originalSize > IMPORT_MAX_ENTRY || total > IMPORT_MAX_TOTAL) {
          throw new BadRequestError(`압축을 풀면 너무 큰 파일입니다: ${f.name}`);
        }
        return true;
      },
    });
  } catch (e) {
    if (e instanceof BadRequestError) throw e;
    throw new BadRequestError('ZIP 파일을 읽을 수 없습니다');
  }
  const raw = entries['project.json'];
  if (!raw) throw new BadRequestError('project.json이 없는 파일입니다');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new BadRequestError('project.json을 읽을 수 없습니다');
  }
  const { project: p, assets } = validateProject(parsed);
  for (const file of assets) {
    const bytes = entries[`assets/${file}`];
    if (!bytes) throw new BadRequestError(`프로젝트가 가리키는 파일이 없습니다: assets/${file}`);
    if (sha256(bytes) !== file.split('.')[0]) throw new BadRequestError(`손상된 파일: assets/${file}`);
  }

  const created = await store.create(p.title);
  for (const file of assets) await store.putAsset(created.id, Buffer.from(entries[`assets/${file}`]));
  return store.update(created.id, (np) => {
    Object.assign(np, p, { id: created.id, createdAt: created.createdAt });
    // Work that was in flight when exported cannot be resumed elsewhere.
    np.jobs = p.jobs.filter((j) => j.status !== 'queued' && j.status !== 'running');
    np.title = p.title.endsWith('(가져옴)') ? p.title : `${p.title} (가져옴)`;
    return structuredClone(np);
  });
}
