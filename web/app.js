// Continuity Board — browser UI. No build step; talks to the JSON API in server/app.ts.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const SHOTS = [
  ['extreme-wide', '익스트림 와이드'], ['wide', '와이드'], ['full', '풀샷'],
  ['medium', '미디엄'], ['close-up', '클로즈업'], ['extreme-close-up', '익스트림 클로즈업'],
];
const CHECKS = ['face', 'hair', 'outfit', 'props', 'scene'];
const REFRESH_INSTRUCTION = 'redraw the person so the face, hair, outfit and props exactly match the current character baseline in image 2 and image 3';

const state = {
  project: null,
  cutEls: new Map(),
  dialogCutId: null,
  selectedCandidateId: null,
  compareMode: 'side',
  reviewDraft: {},
  pollTimer: null,
  mask: { on: false, dirty: false, canvas: null },
};

// ---------- helpers ----------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

async function api(method, path, body) {
  const init = { method };
  if (body instanceof Blob) {
    init.body = body;
    init.headers = { 'content-type': body.type || 'application/octet-stream' };
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  const res = await fetch(path, init);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = { error: text }; }
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data;
}

let toastTimer;
function toast(msg, kind = 'info') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), kind === 'error' ? 6000 : 2800);
}

async function guard(fn) {
  try { return await fn(); } catch (e) { toast(e.message, 'error'); }
}

const P = () => state.project;
const assetUrl = (a) => `/api/projects/${P().id}/assets/${a.sha256}.${a.ext}`;
const currentVersion = () => P().versions.at(-1);
const versionOf = (id) => P().versions.find((v) => v.id === id);
const approvedOf = (cut) => cut.candidates.find((c) => c.id === cut.approvedCandidateId);
const isStale = (cut) => { const a = approvedOf(cut); const v = currentVersion(); return !!a && !!v && a.characterVersionId !== v.id; };
const cutJobs = (cut) => P().jobs.filter((j) => j.cutId === cut.id);
const activeJobs = () => P().jobs.filter((j) => j.status === 'queued' || j.status === 'running');
const liveOf = (job) => P().live?.[job.id];
const pad2 = (n) => String(n).padStart(2, '0');
const fmtTime = (iso) => new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtSec = (ms) => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}초`;
const remember = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const recall = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

function setProject(p) {
  state.project = p;
  renderAll();
  schedulePoll();
}

// ---------- projects ----------

async function loadProjectList(selectId) {
  const list = await api('GET', '/api/projects');
  const sel = $('#project-select');
  sel.replaceChildren(...list.map((p) => h('option', { value: p.id }, p.title)));
  const id = selectId ?? recall('cb.project') ?? list[0]?.id;
  if (id && list.some((p) => p.id === id)) {
    sel.value = id;
    await openProject(id);
  } else if (list.length) {
    await openProject(list[0].id);
  } else {
    const p = await api('POST', '/api/projects', { title: '첫 스토리보드' });
    await loadProjectList(p.id);
  }
}

async function openProject(id) {
  remember('cb.project', id);
  state.cutEls.clear();
  $('#cuts').replaceChildren();
  setProject(await api('GET', `/api/projects/${id}`));
}

// ---------- rendering ----------

function renderAll() {
  const p = P();
  $('#project-select').value = p.id;
  if (document.activeElement !== $('#project-title')) $('#project-title').value = p.title;
  if (document.activeElement !== $('#style')) $('#style').value = p.style;
  $('#board-link').href = `/api/projects/${p.id}/board.png?t=${Date.parse(p.updatedAt)}`;
  $('#export-link').href = `/api/projects/${p.id}/export.zip`;
  renderBaseline();
  renderCuts();
  const busyCuts = new Set(activeJobs().map((j) => j.cutId));
  // Same rule as the server's needsRefresh(): stale, not busy, and no refresh candidate from the current baseline yet.
  const refreshed = (c) => c.candidates.some((x) => x.parentId === c.approvedCandidateId
    && x.characterVersionId === currentVersion()?.id && x.instruction === REFRESH_INSTRUCTION);
  const staleCount = p.cuts.filter((c) => isStale(c) && !busyCuts.has(c.id) && !refreshed(c)).length;
  const refresh = $('#refresh-stale');
  refresh.hidden = staleCount === 0;
  refresh.textContent = `이전 기준 컷 ${staleCount}개 갱신`;
  if ($('#cut-dialog').open) renderDialog();
}

function draftDiffers() {
  const p = P(), v = currentVersion(), d = p.draft;
  if (!v) return true;
  return JSON.stringify(v.traits) !== JSON.stringify(d.traits) || v.faceRef.sha256 !== d.faceRef?.sha256 || v.bodyRef.sha256 !== d.bodyRef?.sha256;
}

function renderBaseline() {
  const p = P(), v = currentVersion();
  for (const slot of ['face', 'body']) {
    const drop = $(`.drop[data-slot="${slot}"]`);
    const a = p.draft[slot === 'face' ? 'faceRef' : 'bodyRef'];
    const img = $('img', drop);
    if (a) { img.src = assetUrl(a); drop.classList.add('filled'); } else { img.removeAttribute('src'); drop.classList.remove('filled'); }
  }
  const form = $('#traits');
  for (const [k, val] of Object.entries(p.draft.traits)) {
    const input = form.elements[k];
    if (input && document.activeElement !== input) input.value = val;
  }
  const changed = draftDiffers();
  const badge = $('#version-badge');
  badge.textContent = v ? `v${v.number}${changed ? ' · 수정됨' : ''}` : '미승인';
  badge.className = `vbadge ${v && !changed ? 'ok' : 'pending'}`;
  const btn = $('#approve-baseline');
  btn.disabled = v && !changed;
  btn.textContent = v ? (changed ? `기준 v${v.number + 1}로 승인` : `기준 v${v.number} 승인됨`) : '기준 승인';
  $('#baseline-msg').textContent = v && changed
    ? '저장되지 않은 기준 변경이 있습니다. 승인하기 전까지 새 컷은 현재 기준으로 생성됩니다.' : '';

  $('#version-list').replaceChildren(...[...p.versions].reverse().map((ver) => {
    const used = p.cuts.filter((c) => approvedOf(c)?.characterVersionId === ver.id).length;
    return h('li', { class: ver === v ? 'current' : '' },
      h('div', { class: 'vthumbs' }, h('img', { src: assetUrl(ver.faceRef), alt: '' }), h('img', { src: assetUrl(ver.bodyRef), alt: '' })),
      h('div', {},
        h('div', { class: 'vline' }, h('b', {}, `v${ver.number}`), h('span', { class: 'mono small muted' }, fmtTime(ver.createdAt))),
        h('div', { class: 'small' }, [ver.traits.hair, ver.traits.outfit, ver.traits.props].filter(Boolean).join(' / ') || '—'),
        h('div', { class: 'small muted' }, `승인 컷 ${used}개`)));
  }));
}

function buildCutCard(cut) {
  const shotSel = h('select', { name: 'shot', 'aria-label': '샷 크기' }, SHOTS.map(([v, l]) => h('option', { value: v }, l)));
  const field = (name, label, ph) => h('label', { class: 'sf' }, h('span', {}, label), h('input', { name, placeholder: ph, maxlength: 500 }));
  const scene = h('form', { class: 'scene', autocomplete: 'off', onsubmit: (e) => e.preventDefault() },
    field('location', '장소', '아침 버스 정류장'),
    field('action', '행동', '휴대폰을 보며 버스를 기다린다'),
    field('expression', '표정', '졸린 얼굴'),
    h('label', { class: 'sf' }, h('span', {}, '샷'), shotSel),
    field('lighting', '조명·분위기', '부드러운 아침 햇살 (선택)'));
  scene.addEventListener('change', () => guard(async () => {
    const f = scene.elements;
    setProject(await api('PATCH', `/api/projects/${P().id}/cuts/${cut.id}`, {
      scene: { location: f.location.value, action: f.action.value, expression: f.expression.value, shot: f.shot.value, lighting: f.lighting.value },
    }));
  }));
  const el = h('article', { class: 'cut', dataset: { id: cut.id }, style: `--i:${cut.index}` },
    h('div', { class: 'frame', onclick: () => openDialog(cut.id), role: 'button', tabindex: 0, 'aria-label': `컷 ${cut.index + 1} 검토 열기` },
      h('span', { class: 'cutno mono' }, `CUT ${pad2(cut.index + 1)}`),
      h('img', { class: 'shot', alt: '' }),
      h('div', { class: 'empty' }, h('span', {}, '아직 후보가 없습니다')),
      h('span', { class: 'stamp' }, '승인'),
      h('span', { class: 'unapproved-tag' }, '미승인 후보'),
      h('span', { class: 'stale' }),
      h('div', { class: 'progress' })),
    scene,
    h('div', { class: 'cut-foot' },
      h('div', { class: 'jobs' }),
      h('div', { class: 'cut-actions' },
        h('button', { class: 'btn ghost sm', dataset: { act: 'gen' } }, '생성'),
        h('button', { class: 'btn ink sm', dataset: { act: 'open' } }, '검토·수정'))));
  $('.frame', el).addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDialog(cut.id); } });
  $('[data-act="gen"]', el).addEventListener('click', () => guard(async () => {
    setProject(await api('POST', `/api/projects/${P().id}/cuts/${cut.id}/generate`, { count: Number($('#gen-count').value) }));
    toast(`컷 ${cut.index + 1} 생성 작업을 대기열에 넣었습니다`);
  }));
  $('[data-act="open"]', el).addEventListener('click', () => openDialog(cut.id));
  return el;
}

function renderCuts() {
  const container = $('#cuts');
  for (const cut of P().cuts) {
    let el = state.cutEls.get(cut.id);
    if (!el) {
      el = buildCutCard(cut);
      state.cutEls.set(cut.id, el);
      container.append(el);
    }
    updateCutCard(el, cut);
  }
}

function updateCutCard(el, cut) {
  const f = $('.scene', el).elements;
  for (const k of ['location', 'action', 'expression', 'shot', 'lighting']) if (document.activeElement !== f[k]) f[k].value = cut.scene[k] ?? '';

  const approved = approvedOf(cut);
  const shown = approved ?? cut.candidates.at(-1);
  const img = $('.shot', el);
  if (shown) { const src = assetUrl(shown.image); if (img.getAttribute('src') !== src) img.src = src; } else img.removeAttribute('src');
  el.classList.toggle('has-image', !!shown);
  el.classList.toggle('approved', !!approved);
  el.classList.toggle('pending-only', !approved && !!shown);
  const stale = isStale(cut);
  el.classList.toggle('is-stale', stale);
  $('.stale', el).textContent = stale ? `이전 기준 v${versionOf(approved.characterVersionId)?.number}` : '';

  const jobs = cutJobs(cut);
  const running = jobs.find((j) => j.status === 'running');
  const queued = jobs.filter((j) => j.status === 'queued');
  const stopped = jobs.filter((j) => j.status === 'failed' || j.status === 'cancelled');
  el.classList.toggle('working', !!running || queued.length > 0);
  const live = running && liveOf(running);
  const bar = $('.progress', el);
  bar.style.setProperty('--p', live ? live.fraction.toFixed(3) : '0');
  bar.textContent = running
    ? `${running.kind === 'edit' ? '수정' : '생성'} · ${live ? `${live.phase} ${Math.round(live.fraction * 100)}%` : '시작하는 중'}${queued.length ? ` · 대기 ${queued.length}` : ''}`
    : queued.length ? `대기 ${queued.length}` : '';
  const chips = [];
  if (cut.candidates.length) chips.push(h('span', { class: 'chip' }, `후보 ${cut.candidates.length}`));
  if (running || queued.length) {
    chips.push(h('span', { class: 'chip' }, running ? '작업 중' : '대기 중',
      h('button', { class: 'linkish', onclick: () => cancelJobs([running, ...queued].filter(Boolean)) }, '취소')));
  }
  for (const j of stopped) {
    chips.push(h('span', { class: `chip ${j.status === 'failed' ? 'fail' : ''}`, title: j.error ?? '' },
      `${j.status === 'failed' ? '실패' : '취소됨'} · ${j.kind === 'edit' ? '수정' : '생성'}`,
      h('button', { class: 'linkish', onclick: () => retryJob(j.id) }, '재시도'),
      h('button', { class: 'linkish', onclick: () => dismissJob(j.id), 'aria-label': '기록 지우기' }, '×')));
  }
  $('.jobs', el).replaceChildren(...chips);
}

async function retryJob(id) {
  await guard(async () => { setProject(await api('POST', `/api/projects/${P().id}/jobs/${id}/retry`)); toast('다시 시도합니다'); });
}
async function dismissJob(id) {
  await guard(async () => setProject(await api('DELETE', `/api/projects/${P().id}/jobs/${id}`)));
}
async function cancelJobs(jobs) {
  await guard(async () => {
    // Queued ones first, so the worker does not pick them up after the running one stops.
    for (const j of [...jobs].sort((a, b) => (a.status === 'running') - (b.status === 'running'))) {
      setProject(await api('DELETE', `/api/projects/${P().id}/jobs/${j.id}`));
    }
    toast('작업을 취소했습니다');
  });
}

// ---------- cut dialog ----------

function dialogCut() { return P().cuts.find((c) => c.id === state.dialogCutId); }

function openDialog(cutId) {
  state.dialogCutId = cutId;
  const cut = dialogCut();
  state.selectedCandidateId = (approvedOf(cut) ?? cut.candidates.at(-1))?.id ?? null;
  $('#edit-instruction').value = '';
  $('#edit-seed').value = '';
  setMaskMode(false);
  loadReviewDraft();
  const dlg = $('#cut-dialog');
  if (!dlg.open) dlg.showModal();
  renderDialog();
}

function selectedCandidate(cut = dialogCut()) {
  return cut.candidates.find((c) => c.id === state.selectedCandidateId);
}

function renderDialog() {
  const cut = dialogCut();
  if (!cut) return;
  const s = cut.scene;
  $('#dlg-title').replaceChildren(
    h('span', { class: 'mono' }, `CUT ${pad2(cut.index + 1)}`),
    h('span', { class: 'dlg-scene' }, [s.location, s.action].filter(Boolean).join(' — ') || '장면이 비어 있습니다'));
  renderCompare(cut);
  renderStrip(cut);
  renderMeta(cut);
  renderReviews(cut);
  renderCutRefs(cut);
  $('#approval-log').replaceChildren(...[...cut.approvals].reverse().map((e) => {
    const idx = cut.candidates.findIndex((c) => c.id === e.candidateId);
    const label = { approve: '승인', restore: '복원', unapprove: '승인 해제' }[e.action];
    return h('li', {}, `${fmtTime(e.at)}  ${label}${idx >= 0 ? `  #${idx + 1}` : ''}`);
  }));
}

function figure(c, label, cut) {
  if (!c) return h('figure', { class: 'fig empty-fig' }, h('div', { class: 'ph' }, label === '승인본' ? '승인한 컷이 없습니다' : '후보가 없습니다'), h('figcaption', {}, label));
  const n = cut.candidates.indexOf(c) + 1;
  return h('figure', { class: 'fig' }, h('img', { src: assetUrl(c.image), alt: `${label} #${n}` }),
    h('figcaption', {}, h('b', {}, label), ` #${n} · ${c.kind === 'edit' ? '수정' : '생성'} · v${versionOf(c.characterVersionId)?.number ?? '?'}`));
}

function renderCompare(cut) {
  const box = $('#compare');
  const approved = approvedOf(cut);
  const sel = selectedCandidate(cut);
  let mode = state.mask.on ? 'single' : state.compareMode;
  if ((mode === 'side' || mode === 'swipe') && (!approved || !sel || approved === sel)) mode = 'single';
  $$('.seg button').forEach((b) => b.classList.toggle('on', b.dataset.mode === state.compareMode));
  box.className = `compare ${mode}`;
  const key = `${mode}|${approved?.id}|${sel?.id}|${state.mask.on}`;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  $('#cmp-caption').textContent = mode === 'single' && state.compareMode !== 'single' && sel && approved === sel ? '선택한 후보가 승인본입니다' : '';
  if (mode === 'side') {
    box.replaceChildren(figure(approved, '승인본', cut), figure(sel, '선택 후보', cut));
  } else if (mode === 'swipe') {
    const top = h('img', { src: assetUrl(sel.image), alt: '선택 후보', class: 'top' });
    const range = h('input', { type: 'range', min: 0, max: 100, value: 50, 'aria-label': '비교 위치' });
    const line = h('div', { class: 'swipe-line' });
    const apply = () => { top.style.clipPath = `inset(0 0 0 ${range.value}%)`; line.style.left = `${range.value}%`; };
    range.addEventListener('input', apply);
    box.replaceChildren(h('div', { class: 'swipe' },
      h('img', { src: assetUrl(approved.image), alt: '승인본' }), top, line,
      h('span', { class: 'sw-l' }, '승인본'), h('span', { class: 'sw-r' }, '선택 후보')), range);
    apply();
  } else {
    const fig = figure(sel, approved === sel ? '승인본' : '선택 후보', cut);
    if (state.mask.on && sel) {
      const img = $('img', fig);
      const stage = h('div', { class: 'mask-stage' });
      img.before(stage);
      stage.append(img, maskCanvas());
    }
    box.replaceChildren(fig);
  }
}

// ---------- mask painting (masked edit) ----------

const MASK_W = 1344, MASK_H = 768;

function maskCanvas() {
  if (state.mask.canvas) return state.mask.canvas;
  const c = h('canvas', { width: MASK_W, height: MASK_H, class: 'mask-canvas', 'aria-label': '수정할 영역을 칠하는 캔버스' });
  const ctx = c.getContext('2d');
  let last = null;
  const pos = (e) => {
    const r = c.getBoundingClientRect();
    return [(e.clientX - r.left) * MASK_W / r.width, (e.clientY - r.top) * MASK_H / r.height];
  };
  const paint = (a, b) => {
    ctx.strokeStyle = 'rgb(232, 60, 50)';
    ctx.lineWidth = Number($('#mask-brush').value);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(...a);
    ctx.lineTo(...b);
    ctx.stroke();
    state.mask.dirty = true;
    $('#edit-run').textContent = '영역 수정 후보 만들기';
  };
  c.addEventListener('pointerdown', (e) => { c.setPointerCapture(e.pointerId); last = pos(e); paint(last, last); });
  c.addEventListener('pointermove', (e) => { if (!last) return; const p = pos(e); paint(last, p); last = p; });
  const end = () => { last = null; };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
  state.mask.canvas = c;
  return c;
}

function clearMask() {
  if (state.mask.canvas) state.mask.canvas.getContext('2d').clearRect(0, 0, MASK_W, MASK_H);
  state.mask.dirty = false;
  $('#edit-run').textContent = '수정 후보 만들기';
}

function setMaskMode(on) {
  state.mask.on = on;
  clearMask();
  $('#mask-toggle').classList.toggle('on', on);
  $('#mask-toggle').setAttribute('aria-pressed', on);
  $('#mask-tools').hidden = !on;
  $('#compare').dataset.key = '';
  if (dialogCut()) renderCompare(dialogCut());
}

/** Painted strokes → black/white PNG (white = may change) at frame resolution. */
function maskDataUrl() {
  if (!state.mask.on || !state.mask.dirty) return null;
  const src = state.mask.canvas.getContext('2d').getImageData(0, 0, MASK_W, MASK_H);
  const out = new ImageData(MASK_W, MASK_H);
  for (let i = 0; i < src.data.length; i += 4) {
    const v = src.data[i + 3] > 0 ? 255 : 0;
    out.data[i] = out.data[i + 1] = out.data[i + 2] = v;
    out.data[i + 3] = 255;
  }
  const c = h('canvas', { width: MASK_W, height: MASK_H });
  c.getContext('2d').putImageData(out, 0, 0);
  return c.toDataURL('image/png');
}

function renderStrip(cut) {
  const jobs = cutJobs(cut).filter((j) => j.status !== 'done');
  const items = cut.candidates.map((c, i) => {
    const parentIdx = c.parentId ? cut.candidates.findIndex((x) => x.id === c.parentId) + 1 : 0;
    return h('button', {
      class: `cand ${c.id === state.selectedCandidateId ? 'sel' : ''} ${c.id === cut.approvedCandidateId ? 'appr' : ''}`,
      onclick: () => { state.selectedCandidateId = c.id; clearMask(); loadReviewDraft(); renderDialog(); },
      'aria-pressed': c.id === state.selectedCandidateId,
    },
    h('img', { src: assetUrl(c.image), alt: '', loading: 'lazy' }),
    h('span', { class: 'cand-label mono' }, `#${i + 1}`, c.kind === 'edit' ? ` ✎←#${parentIdx}` : ''),
    c.id === cut.approvedCandidateId ? h('span', { class: 'mini-stamp' }, '승인') : null,
    c.characterVersionId !== currentVersion()?.id ? h('span', { class: 'mini-stale' }, `v${versionOf(c.characterVersionId)?.number}`) : null);
  });
  for (const j of jobs) {
    const live = j.status === 'running' && liveOf(j);
    const label = j.status === 'running' ? (live ? `${live.phase} · ${Math.round(live.fraction * 100)}%` : (j.kind === 'edit' ? '수정 시작' : '생성 시작'))
      : j.status === 'queued' ? '대기 중' : j.status === 'cancelled' ? '취소됨' : '실패';
    const active = j.status === 'running' || j.status === 'queued';
    items.push(h('div', { class: `cand placeholder ${j.status}`, title: j.error ?? '', style: `--p:${live ? live.fraction : 0}` },
      h('span', {}, label),
      active ? h('button', { class: 'linkish', onclick: () => cancelJobs([j]) }, '취소')
        : h('button', { class: 'linkish', onclick: () => retryJob(j.id) }, '재시도')));
  }
  if (!items.length) items.push(h('div', { class: 'strip-empty small muted' }, '아직 후보가 없습니다. 보드에서 “생성”을 누르세요.'));
  $('#strip').replaceChildren(...items);
}

function renderMeta(cut) {
  const c = selectedCandidate(cut);
  const box = $('#cand-meta');
  $('#approve-cand').disabled = !c || c.id === cut.approvedCandidateId;
  $('#approve-cand').textContent = c && c.id === cut.approvedCandidateId ? '승인된 후보' :
    c && cut.approvals.some((e) => e.candidateId === c.id) ? '이 후보로 복원' : '이 후보 승인';
  $('#unapprove').disabled = !cut.approvedCandidateId;
  $('#edit-run').disabled = !c;
  if (!c) { box.replaceChildren(h('p', { class: 'small muted' }, '후보를 선택하세요.')); return; }
  const g = c.generation;
  const ver = versionOf(c.characterVersionId);
  const roleKo = { cut: '수정할 컷', face: '얼굴·머리', body: '의상·전신', background: '배경', prop: '소품' };
  box.replaceChildren(
    h('dl', {},
      h('dt', {}, '종류'), h('dd', {}, c.kind === 'edit' ? `수정 (#${cut.candidates.findIndex((x) => x.id === c.parentId) + 1}에서)` : '생성'),
      c.instruction ? [h('dt', {}, '지시'), h('dd', {}, c.instruction)] : null,
      h('dt', {}, '기준'), h('dd', {}, `v${ver?.number ?? '?'}`, ver && ver.id !== currentVersion()?.id ? h('span', { class: 'warn' }, ' · 이전 기준') : null),
      h('dt', {}, '시드'), h('dd', { class: 'mono' }, g.seed),
      h('dt', {}, '시간'), h('dd', {}, fmtSec(g.durationMs), g.coldStart ? h('span', { class: 'muted' }, ' · 첫 실행(모델 로딩 포함)') : null),
      h('dt', {}, '실행'), h('dd', { class: 'mono small' }, `${g.backend} · ${g.model.diffusion} · ${g.steps} steps · wf ${g.workflow.version}`)),
    h('div', { class: 'refs-used' }, g.references.map((r, i) => {
      const a = { sha256: r.sha256, ext: r.role === 'cut' ? cut.candidates.find((x) => x.image.sha256 === r.sha256)?.image.ext ?? 'png' : findExt(r.sha256) };
      return h('figure', {}, h('img', { src: assetUrl(a), alt: '' }), h('figcaption', {}, `image ${i + 1} · ${roleKo[r.role] ?? r.role}`));
    })),
    h('details', {}, h('summary', {}, '프롬프트'), h('p', { class: 'prompt mono small' }, g.prompt)),
    h('div', { class: 'row small' },
      h('a', { href: assetUrl(c.image), download: `cut${cut.index + 1}-${c.id}.${c.image.ext}` }, '이미지 받기'),
      g.graph ? h('a', { href: `/api/projects/${P().id}/cuts/${cut.id}/candidates/${c.id}/graph.json` }, 'ComfyUI 워크플로(API)') : null,
      h('button', { class: 'linkish', onclick: () => { $('#edit-seed').value = g.seed; } }, '이 시드 쓰기')));
}

function findExt(sha) {
  const p = P();
  const all = [p.draft.faceRef, p.draft.bodyRef, ...p.versions.flatMap((v) => [v.faceRef, v.bodyRef]),
    ...p.cuts.flatMap((c) => [c.backgroundRef, c.propRef, ...c.candidates.map((x) => x.image)])];
  return all.find((a) => a?.sha256 === sha)?.ext ?? 'png';
}

function loadReviewDraft() {
  const cut = dialogCut();
  const c = cut && selectedCandidate(cut);
  const reviewer = recall('cb.reviewer') ?? '';
  const form = $('#review');
  form.elements.reviewer.value = reviewer;
  const existing = c?.reviews.find((r) => r.reviewer === reviewer);
  state.reviewDraft = { ...(existing?.checklist ?? {}) };
  form.elements.note.value = existing?.note ?? '';
  renderChecks();
}

function renderChecks() {
  for (const k of CHECKS) {
    const cell = $(`.checks [data-k="${k}"]`);
    const v = state.reviewDraft[k];
    cell.replaceChildren(
      h('button', { type: 'button', class: `tri pass ${v === true ? 'on' : ''}`, onclick: () => { state.reviewDraft[k] = v === true ? undefined : true; renderChecks(); } }, '통과'),
      h('button', { type: 'button', class: `tri fail ${v === false ? 'on' : ''}`, onclick: () => { state.reviewDraft[k] = v === false ? undefined : false; renderChecks(); } }, '불합격'));
  }
}

function renderReviews(cut) {
  const c = selectedCandidate(cut);
  $('#review').classList.toggle('disabled', !c);
  const label = { face: '얼굴', hair: '헤어', outfit: '의상', props: '소품', scene: '장면' };
  $('#review-list').replaceChildren(...(c?.reviews ?? []).map((r) => h('div', { class: 'review-row' },
    h('b', {}, r.reviewer), ' ',
    CHECKS.filter((k) => r.checklist[k] !== undefined).map((k) => h('span', { class: `rk ${r.checklist[k] ? 'ok' : 'ng'}` }, label[k])),
    r.note ? h('span', { class: 'muted' }, ` — ${r.note}`) : null)));
}

function renderCutRefs(cut) {
  for (const slot of ['background', 'prop']) {
    const drop = $(`[data-cutslot="${slot}"]`);
    const a = cut[slot === 'background' ? 'backgroundRef' : 'propRef'];
    const img = $('img', drop);
    if (a) { img.src = assetUrl(a); drop.classList.add('filled'); } else { img.removeAttribute('src'); drop.classList.remove('filled'); }
  }
}

// ---------- polling ----------

function schedulePoll() {
  clearTimeout(state.pollTimer);
  if (!P() || !activeJobs().length) return;
  state.pollTimer = setTimeout(async () => {
    try {
      const before = activeJobs().length;
      const p = await api('GET', `/api/projects/${P().id}`);
      if (p.id !== P()?.id) return;
      setProject(p);
      const failedNow = p.jobs.filter((j) => j.status === 'failed' && j.finishedAt && Date.now() - Date.parse(j.finishedAt) < 2500);
      if (failedNow.length) toast(`작업 실패: ${failedNow[0].error}`, 'error');
      else if (before && !activeJobs().length) toast('모든 작업이 끝났습니다', 'ok');
    } catch {
      schedulePoll();
    }
  }, 1200);
}

async function refreshHealth() {
  const el = $('#health');
  try {
    const hl = await api('GET', '/api/health');
    el.textContent = hl.backend === 'mock' ? 'MOCK 모드' : hl.ok ? 'ComfyUI 연결됨' : 'ComfyUI 문제';
    el.className = `health ${hl.ok ? (hl.backend === 'mock' ? 'mock' : 'ok') : 'bad'}`;
    el.title = hl.detail + (hl.missingModels ? `\n없는 모델: ${hl.missingModels.join(', ')}` : '');
  } catch {
    el.textContent = '서버 연결 끊김';
    el.className = 'health bad';
  }
}

// ---------- uploads ----------

function wireDrop(drop, upload) {
  const input = $('input[type=file]', drop);
  input.addEventListener('change', () => { if (input.files[0]) upload(input.files[0]); input.value = ''; });
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (f) upload(f);
  });
}

// ---------- wiring ----------

function wire() {
  $('#project-select').addEventListener('change', (e) => guard(() => openProject(e.target.value)));
  $('#project-title').addEventListener('change', (e) => guard(async () => {
    setProject(await api('PATCH', `/api/projects/${P().id}`, { title: e.target.value }));
    await loadProjectList(P().id);
  }));
  $('#style').addEventListener('change', (e) => guard(async () => setProject(await api('PATCH', `/api/projects/${P().id}`, { style: e.target.value }))));
  $('#new-project').addEventListener('click', () => guard(async () => {
    const p = await api('POST', '/api/projects', { title: '새 스토리보드' });
    await loadProjectList(p.id);
    $('#project-title').focus();
    $('#project-title').select();
  }));
  $('#import-file').addEventListener('change', (e) => guard(async () => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const p = await api('POST', '/api/projects/import', f);
    await loadProjectList(p.id);
    toast('프로젝트를 가져왔습니다', 'ok');
  }));
  $('#verify').addEventListener('click', () => guard(async () => {
    const r = await api('GET', `/api/projects/${P().id}/verify`);
    toast(r.ok ? `무결성 확인 완료 · 이미지 ${r.checked}개의 해시가 모두 일치합니다` : `문제 ${r.problems.length}건: ${r.problems.join(', ')}`, r.ok ? 'ok' : 'error');
  }));

  for (const drop of $$('.drop[data-slot]')) {
    wireDrop(drop, (file) => guard(async () => setProject(await api('PUT', `/api/projects/${P().id}/draft/${drop.dataset.slot}`, file))));
  }
  for (const drop of $$('[data-cutslot]')) {
    wireDrop(drop, (file) => guard(async () => setProject(await api('PUT', `/api/projects/${P().id}/cuts/${state.dialogCutId}/ref/${drop.dataset.cutslot}`, file))));
    $('.x', drop).addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      guard(async () => setProject(await api('DELETE', `/api/projects/${P().id}/cuts/${state.dialogCutId}/ref/${drop.dataset.cutslot}`)));
    });
  }

  let traitTimer;
  const saveTraits = () => guard(async () => {
    const f = $('#traits').elements;
    const traits = Object.fromEntries(['name', 'hair', 'outfit', 'props', 'notes'].map((k) => [k, f[k].value]));
    setProject(await api('PUT', `/api/projects/${P().id}/draft/traits`, { traits }));
  });
  $('#traits').addEventListener('input', () => { clearTimeout(traitTimer); traitTimer = setTimeout(saveTraits, 500); });
  $('#traits').addEventListener('submit', (e) => e.preventDefault());
  $('#approve-baseline').addEventListener('click', () => guard(async () => {
    clearTimeout(traitTimer);
    await saveTraits();
    const p = await api('POST', `/api/projects/${P().id}/versions`);
    setProject(p);
    const stale = p.cuts.filter(isStale).length;
    toast(`캐릭터 기준 v${p.versions.at(-1).number} 승인 완료${stale ? ` · 이전 기준으로 만든 승인 컷 ${stale}개는 그대로 유지됩니다` : ''}`, 'ok');
  }));

  $('#refresh-stale').addEventListener('click', () => guard(async () => {
    const p = await api('POST', `/api/projects/${P().id}/refresh-stale`);
    setProject(p);
    toast('이전 기준 컷을 현재 기준으로 맞추는 수정 후보를 만듭니다. 결과는 새 후보로만 추가됩니다');
  }));
  $('#mask-toggle').addEventListener('click', () => setMaskMode(!state.mask.on));
  $('#mask-clear').addEventListener('click', clearMask);

  $('#generate-missing').addEventListener('click', () => guard(async () => {
    const p = await api('POST', `/api/projects/${P().id}/generate-missing`, { count: Number($('#gen-count').value) });
    const n = p.jobs.filter((j) => j.status === 'queued').length - activeJobs().filter((j) => j.status === 'queued').length;
    setProject(p);
    toast(n > 0 ? `작업 ${n}개를 대기열에 넣었습니다` : '생성할 미승인 컷이 없습니다');
  }));

  // dialog
  const dlg = $('#cut-dialog');
  $('#dlg-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  $$('[data-nav]', dlg).forEach((b) => b.addEventListener('click', () => {
    const idx = dialogCut().index + Number(b.dataset.nav);
    const next = P().cuts[(idx + 6) % 6];
    openDialog(next.id);
  }));
  $$('.seg button').forEach((b) => b.addEventListener('click', () => {
    state.compareMode = b.dataset.mode;
    $('#compare').dataset.key = '';
    renderCompare(dialogCut());
  }));
  $('#approve-cand').addEventListener('click', () => guard(async () => {
    const cut = dialogCut();
    setProject(await api('POST', `/api/projects/${P().id}/cuts/${cut.id}/approve`, { candidateId: state.selectedCandidateId }));
    toast(`컷 ${cut.index + 1} 승인 완료`, 'ok');
  }));
  $('#unapprove').addEventListener('click', () => guard(async () => {
    const cut = dialogCut();
    setProject(await api('POST', `/api/projects/${P().id}/cuts/${cut.id}/approve`, { candidateId: null }));
  }));
  $('#edit-run').addEventListener('click', () => guard(async () => {
    const cut = dialogCut();
    const instruction = $('#edit-instruction').value.trim();
    if (!instruction) throw new Error('수정 지시를 입력하세요');
    const seedText = $('#edit-seed').value.trim();
    const mask = maskDataUrl();
    if (state.mask.on && !mask) throw new Error('수정할 영역을 칠하거나 “영역 칠하기”를 끄세요');
    const body = { instruction, ...(seedText ? { seed: Number(seedText) } : {}), ...(mask ? { mask } : {}) };
    setProject(await api('POST', `/api/projects/${P().id}/cuts/${cut.id}/candidates/${state.selectedCandidateId}/edit`, body));
    toast('수정 작업을 대기열에 넣었습니다. 결과는 새 후보로 추가됩니다');
  }));
  $('#review').addEventListener('submit', (e) => {
    e.preventDefault();
    guard(async () => {
      const f = e.target.elements;
      const cut = dialogCut();
      remember('cb.reviewer', f.reviewer.value.trim());
      const checklist = Object.fromEntries(CHECKS.filter((k) => state.reviewDraft[k] !== undefined).map((k) => [k, state.reviewDraft[k]]));
      setProject(await api('POST', `/api/projects/${P().id}/cuts/${cut.id}/candidates/${state.selectedCandidateId}/reviews`, {
        reviewer: f.reviewer.value, checklist, note: f.note.value,
      }));
      toast('평가를 저장했습니다', 'ok');
    });
  });
}

wire();
refreshHealth();
setInterval(refreshHealth, 15000);
guard(() => loadProjectList());
