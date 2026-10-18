// Continuity Board — browser UI. No build step; talks to the JSON API in server/app.ts.

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const SHOTS = [
  ['extreme-wide', '익스트림 와이드'], ['wide', '와이드'], ['full', '풀샷'],
  ['medium', '미디엄'], ['close-up', '클로즈업'], ['extreme-close-up', '익스트림 클로즈업'],
];
const CHECKS = ['face', 'hair', 'outfit', 'props', 'scene', 'instruction'];
const CHECK_LABEL = { face: '얼굴', hair: '헤어', outfit: '의상', props: '소품', scene: '장면 지시', instruction: '수정 지시' };
const REFRESH_INSTRUCTION = 'redraw the person so the face, hair, outfit and props exactly match the current character baseline in image 2 and image 3';

const state = {
  project: null,
  cutEls: new Map(),
  dialogCutId: null,
  selectedCandidateId: null,
  compareMode: 'side',
  reviewDraft: {},
  pollTimer: null,
  events: null,
  health: null,
  mask: { on: false, dirty: false, canvas: null, cursor: null, tool: 'paint', undo: [] },
  zoom: { on: false, scale: 3, fx: 0.5, fy: 0.5 },
  // Items already shown: only newcomers get the staggered entrance (lists re-render on every live update).
  seen: { candidates: new Set(), versions: new Set() },
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

// The button that started the current interaction: it is disabled while the request it triggered is in flight,
// so a double click cannot queue a second GPU job (UI/UX rule "loading-buttons").
let triggerButton = null;
document.addEventListener('click', (e) => {
  triggerButton = e.target.closest?.('button') ?? null;
  setTimeout(() => { triggerButton = null; });
}, true);
const inFlight = new Map();

async function api(method, path, body) {
  if (method === 'GET') return request(method, path, body);
  // Identical writes already in flight are shared instead of sent twice.
  const key = `${method} ${path} ${body instanceof Blob ? `blob:${body.size}` : JSON.stringify(body ?? null)}`;
  if (inFlight.has(key)) return inFlight.get(key);
  const btn = triggerButton;
  const wasDisabled = btn?.disabled;
  if (btn) { btn.disabled = true; btn.setAttribute('aria-busy', 'true'); }
  const pending = request(method, path, body).finally(() => {
    inFlight.delete(key);
    if (btn) { btn.removeAttribute('aria-busy'); if (!wasDisabled && btn.isConnected) btn.disabled = false; }
  });
  inFlight.set(key, pending);
  return pending;
}

async function request(method, path, body) {
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

// ---------- ripple (press feedback) ----------
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const RIPPLE_TARGETS = '.btn, .cand, .tri, .seg button';

function ripple(el, x, y) {
  if (reducedMotion.matches || el.disabled) return;
  const r = el.getBoundingClientRect();
  const size = Math.max(r.width, r.height) * 2;
  el.classList.add('ripple-host');
  const dot = document.createElement('span');
  dot.className = 'ripple';
  dot.setAttribute('aria-hidden', 'true');
  Object.assign(dot.style, { width: `${size}px`, height: `${size}px`, left: `${x - r.left - size / 2}px`, top: `${y - r.top - size / 2}px` });
  el.append(dot);
  dot.addEventListener('animationend', () => dot.remove());
}
document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest?.(RIPPLE_TARGETS);
  if (el) ripple(el, e.clientX, e.clientY);
});
// Keyboard activation (Enter/Space) has no pointer position: ripple from the centre.
document.addEventListener('click', (e) => {
  if (e.detail !== 0) return;
  const el = e.target.closest?.(RIPPLE_TARGETS);
  if (!el) return;
  const r = el.getBoundingClientRect();
  ripple(el, r.left + r.width / 2, r.top + r.height / 2);
});

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
// Same rule as server/model.ts: a baseline is identified by its content, so restoring an old one makes its cuts current.
const fingerprint = (v) => JSON.stringify([v.faceRef.sha256, v.bodyRef.sha256, v.traits.name, v.traits.hair, v.traits.outfit, v.traits.props, v.traits.notes]);
const isCurrentBaseline = (versionId) => {
  const v = versionOf(versionId), cur = currentVersion();
  return !!v && !!cur && fingerprint(v) === fingerprint(cur);
};
const isStale = (cut) => { const a = approvedOf(cut); return !!a && !!currentVersion() && !isCurrentBaseline(a.characterVersionId); };
const cutJobs = (cut) => P().jobs.filter((j) => j.cutId === cut.id);
const activeJobs = () => P().jobs.filter((j) => j.status === 'queued' || j.status === 'running');
const liveOf = (job) => P().live?.[job.id];
const pad2 = (n) => String(n).padStart(2, '0');
const fmtTime = (iso) => new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtSec = (ms) => `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}초`;
const remember = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const recall = (k) => { try { return localStorage.getItem(k); } catch { return null; } };

function setProject(p) {
  const prev = state.project;
  state.project = p;
  if (prev && prev.id === p.id) notifyTransitions(prev, p);
  renderAll();
  schedulePoll();
}

/** Toasts for jobs that just failed, or for the queue becoming empty. */
function notifyTransitions(prev, next) {
  const was = new Map(prev.jobs.map((j) => [j.id, j.status]));
  const failed = next.jobs.find((j) => j.status === 'failed' && was.get(j.id) !== 'failed' && was.has(j.id));
  const active = (p) => p.jobs.some((j) => j.status === 'queued' || j.status === 'running');
  if (failed) toast(`작업 실패: ${failed.error}`, 'error');
  else if (active(prev) && !active(next)) toast('모든 작업이 끝났습니다', 'ok');
}

/** Live updates over server-sent events; polling is only the fallback while the stream is down. */
function subscribe(id) {
  state.events?.close();
  const es = new EventSource(`/api/projects/${id}/events`);
  state.events = es;
  es.addEventListener('project', (e) => {
    const p = JSON.parse(e.data);
    if (p.id === P()?.id) setProject(p);
  });
  es.addEventListener('live', (e) => {
    if (!P() || P().id !== id) return;
    Object.assign(state.project, JSON.parse(e.data));
    renderAll();
  });
  es.addEventListener('open', () => clearTimeout(state.pollTimer));
  es.addEventListener('error', () => schedulePoll());
}

const streaming = () => state.events?.readyState === EventSource.OPEN;

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
  state.seen.versions.clear();
  $('#cuts').replaceChildren();
  state.project = null;
  setProject(await api('GET', `/api/projects/${id}`));
  subscribe(id);
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
  if (state.health) renderHealthBanner();
  const wait = p.backendWait;
  $('#backend-wait').hidden = !wait;
  if (wait) {
    $('#wait-count').textContent = String(activeJobs().length);
    const next = Math.max(0, Math.round((Date.parse(wait.nextCheckAt) - Date.now()) / 1000));
    $('#wait-detail').textContent = `${wait.message} · 다음 확인 ${next}초 후`;
  }
  const busyCuts = new Set(activeJobs().map((j) => j.cutId));
  // Same rule as the server's needsRefresh(): stale, not busy, and no refresh candidate from the current baseline yet.
  const refreshed = (c) => c.candidates.some((x) => x.parentId === c.approvedCandidateId
    && isCurrentBaseline(x.characterVersionId) && x.instruction === REFRESH_INSTRUCTION);
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

  let newVersions = 0;
  $('#spawn-project').hidden = !v;
  $('#version-list').replaceChildren(...[...p.versions].reverse().map((ver) => {
    const isNew = !state.seen.versions.has(ver.id);
    state.seen.versions.add(ver.id);
    const used = p.cuts.filter((c) => approvedOf(c)?.characterVersionId === ver.id).length;
    const restorable = ver !== v && v && fingerprint(ver) !== fingerprint(v);
    return h('li', { class: `${ver === v ? 'current' : ''} ${isNew ? 'enter' : ''}`, style: isNew ? `--stagger:${newVersions++}` : null },
      h('div', { class: 'vthumbs' }, h('img', { src: assetUrl(ver.faceRef), alt: '' }), h('img', { src: assetUrl(ver.bodyRef), alt: '' })),
      h('div', {},
        h('div', { class: 'vline' }, h('b', {}, `v${ver.number}`), h('span', { class: 'mono small muted' }, fmtTime(ver.createdAt))),
        h('div', { class: 'small' }, [ver.traits.hair, ver.traits.outfit, ver.traits.props].filter(Boolean).join(' / ') || '—'),
        h('div', { class: 'small muted' }, `승인 컷 ${used}개`),
        restorable ? h('button', {
          class: 'linkish small', onclick: () => guard(async () => {
            setProject(await api('POST', `/api/projects/${P().id}/draft/from-version/${ver.id}`, {}));
            toast(`v${ver.number}의 참조와 특징을 불러왔습니다. “기준 승인”을 누르면 다시 현재 기준이 됩니다`);
          }),
        }, `v${ver.number} 불러오기`) : null));
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
        h('button', { class: 'btn ghost sm icon', dataset: { act: 'left' }, 'aria-label': '앞으로 옮기기', title: '앞으로 옮기기' }, '◀'),
        h('button', { class: 'btn ghost sm icon', dataset: { act: 'right' }, 'aria-label': '뒤로 옮기기', title: '뒤로 옮기기' }, '▶'),
        h('button', { class: 'btn ghost sm', dataset: { act: 'gen' } }, '생성'),
        h('button', { class: 'btn ink sm', dataset: { act: 'open' } }, '검토·수정'))));
  $('.frame', el).addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDialog(cut.id); } });
  $('[data-act="gen"]', el).addEventListener('click', () => guard(async () => {
    setProject(await api('POST', `/api/projects/${P().id}/cuts/${cut.id}/generate`, { count: Number($('#gen-count').value) }));
    toast(`컷 ${cut.index + 1} 생성 작업을 대기열에 넣었습니다`);
  }));
  $('[data-act="open"]', el).addEventListener('click', () => openDialog(cut.id));
  for (const [act, delta] of [['left', -1], ['right', 1]]) {
    $(`[data-act="${act}"]`, el).addEventListener('click', () => guard(async () => {
      const current = P().cuts.find((c) => c.id === cut.id);
      setProject(await api('POST', `/api/projects/${P().id}/cuts/${cut.id}/move`, { to: current.index + delta }));
      $(`[data-act="${act}"]`, state.cutEls.get(cut.id))?.focus();
    }));
  }
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
  // Keep the DOM in board order (cuts can be reordered); append() moves existing nodes.
  const ordered = P().cuts.map((c) => state.cutEls.get(c.id));
  if (ordered.some((el, i) => container.children[i] !== el)) container.append(...ordered);
}

function updateCutCard(el, cut) {
  $('.cutno', el).textContent = `CUT ${pad2(cut.index + 1)}`;
  $('.frame', el).setAttribute('aria-label', `컷 ${cut.index + 1} 검토 열기`);
  $('[data-act="left"]', el).disabled = cut.index === 0;
  $('[data-act="right"]', el).disabled = cut.index === P().cuts.length - 1;
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
  state.seen.candidates.clear();
  state.compareRefId = null;
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
  return h('figure', { class: 'fig' }, h('div', { class: 'zclip' }, h('img', { src: assetUrl(c.image), alt: `${label} #${n}` })),
    h('figcaption', {}, h('b', {}, label), ` #${n} · ${c.kind === 'edit' ? '수정' : '생성'} · v${versionOf(c.characterVersionId)?.number ?? '?'}`));
}

/**
 * What the selected candidate is compared against: a pinned candidate, else the approved one, else (nothing approved
 * yet) another candidate - so candidates can be compared before the first approval.
 */
function compareReference(cut, sel) {
  const pinned = cut.candidates.find((c) => c.id === state.compareRefId);
  if (pinned && pinned !== sel) return { cand: pinned, label: '비교 기준' };
  const approved = approvedOf(cut);
  if (approved && approved !== sel) return { cand: approved, label: '승인본' };
  if (approved) return null;
  const other = [...cut.candidates].reverse().find((c) => c !== sel);
  return other ? { cand: other, label: '다른 후보' } : null;
}

function renderCompare(cut) {
  const box = $('#compare');
  const sel = selectedCandidate(cut);
  const ref = sel ? compareReference(cut, sel) : null;
  const approved = ref?.cand;
  let mode = state.mask.on ? 'single' : state.compareMode;
  if ((mode === 'side' || mode === 'swipe') && !ref) mode = 'single';
  $$('.compare-toolbar .seg button').forEach((b) => {
    b.classList.toggle('on', b.dataset.mode === state.compareMode);
    b.setAttribute('aria-pressed', String(b.dataset.mode === state.compareMode));
  });
  box.className = `compare ${mode}`;
  const key = `${mode}|${approved?.id}|${ref?.label}|${sel?.id}|${state.mask.on}`;
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  $('#cmp-caption').textContent = mode === 'single' && state.compareMode !== 'single' && !state.mask.on
    ? (cut.candidates.length < 2 ? '비교할 다른 후보가 없습니다' : '선택한 후보가 승인본입니다 · 다른 후보를 “비교 기준”으로 고정하세요')
    : '';
  if (mode === 'side') {
    box.replaceChildren(figure(approved, ref.label, cut), figure(sel, '선택 후보', cut));
    $$('.fig', box).forEach((f) => { f.dataset.zoomable = ''; });
  } else if (mode === 'swipe') {
    const top = h('img', { src: assetUrl(sel.image), alt: '선택 후보', class: 'top' });
    const range = h('input', { type: 'range', min: 0, max: 100, value: 50, 'aria-label': '비교 위치' });
    const line = h('div', { class: 'swipe-line' });
    const apply = () => { top.style.clipPath = `inset(0 0 0 ${range.value}%)`; line.style.left = `${range.value}%`; };
    range.addEventListener('input', apply);
    box.replaceChildren(h('div', { class: 'swipe' },
      h('img', { src: assetUrl(approved.image), alt: ref.label }), top, line,
      h('span', { class: 'sw-l' }, ref.label), h('span', { class: 'sw-r' }, '선택 후보')), range);
    apply();
  } else {
    const fig = figure(sel, sel && sel.id === cut.approvedCandidateId ? '승인본' : '선택 후보', cut);
    fig.dataset.zoomable = '';
    if (state.mask.on && sel) {
      const img = $('img', fig);
      const stage = h('div', { class: 'mask-stage' });
      img.before(stage);
      stage.append(img, maskCanvas(), state.mask.cursor);
    }
    box.replaceChildren(fig);
  }
}

// ---------- linked zoom for reviewing faces and details ----------

/** Zooms every image in the compare box around the same relative point, so approved and candidate stay aligned. */
function applyZoom(fx = state.zoom.fx, fy = state.zoom.fy) {
  state.zoom.fx = fx;
  state.zoom.fy = fy;
  for (const img of $$('#compare [data-zoomable] img')) {
    img.style.transformOrigin = `${fx * 100}% ${fy * 100}%`;
    img.style.transform = `scale(${state.zoom.scale})`;
  }
}

function resetZoom() {
  for (const img of $$('#compare img')) { img.style.transform = ''; img.style.transformOrigin = ''; }
}

function setZoom(on) {
  state.zoom.on = on && !state.mask.on;
  $('#zoom-toggle').setAttribute('aria-pressed', String(state.zoom.on));
  $('#compare').classList.toggle('zooming', state.zoom.on);
  if (!state.zoom.on) resetZoom();
}

// ---------- mask painting (masked edit) ----------

const MASK_W = 1344, MASK_H = 768;

function maskCanvas() {
  if (state.mask.canvas) return state.mask.canvas;
  const c = h('canvas', { width: MASK_W, height: MASK_H, class: 'mask-canvas', 'aria-label': '수정할 영역을 칠하는 캔버스' });
  // Read back after every stroke (undo snapshots, "anything painted?"), so keep it CPU-side.
  const ctx = c.getContext('2d', { willReadFrequently: true });
  let last = null;
  const pos = (e) => {
    const r = c.getBoundingClientRect();
    return [(e.clientX - r.left) * MASK_W / r.width, (e.clientY - r.top) * MASK_H / r.height];
  };
  const paint = (a, b) => {
    ctx.globalCompositeOperation = state.mask.tool === 'erase' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = 'rgb(232, 60, 50)';
    ctx.lineWidth = Number($('#mask-brush').value);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(...a);
    ctx.lineTo(...b);
    ctx.stroke();
  };
  // Circle showing the real brush size under the pointer.
  const cursor = h('div', { class: 'mask-cursor', hidden: true });
  const moveCursor = (e) => {
    const r = c.getBoundingClientRect();
    const d = Number($('#mask-brush').value) * r.width / MASK_W;
    Object.assign(cursor.style, { width: `${d}px`, height: `${d}px`, left: `${e.clientX - r.left - d / 2}px`, top: `${e.clientY - r.top - d / 2}px` });
    cursor.classList.toggle('erase', state.mask.tool === 'erase');
    cursor.hidden = false;
  };
  c.addEventListener('pointerdown', (e) => {
    c.setPointerCapture(e.pointerId);
    state.mask.undo.push(ctx.getImageData(0, 0, MASK_W, MASK_H));
    if (state.mask.undo.length > 30) state.mask.undo.shift();
    last = pos(e);
    paint(last, last);
  });
  c.addEventListener('pointermove', (e) => { moveCursor(e); if (!last) return; const p = pos(e); paint(last, p); last = p; });
  c.addEventListener('pointerleave', () => { cursor.hidden = true; });
  const end = () => { if (last) updateMaskState(); last = null; };
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
  state.mask.canvas = c;
  state.mask.cursor = cursor;
  return c;
}

/** Recomputes whether anything is painted (after strokes, erasing or undo) and labels the edit button. */
function updateMaskState() {
  const c = state.mask.canvas;
  let painted = false;
  if (c) {
    const data = c.getContext('2d').getImageData(0, 0, MASK_W, MASK_H).data;
    for (let i = 3; i < data.length; i += 4) if (data[i]) { painted = true; break; }
  }
  state.mask.dirty = painted;
  $('#edit-run').textContent = painted ? '영역 수정 후보 만들기' : '수정 후보 만들기';
  $('#mask-undo').disabled = !state.mask.undo.length;
}

function undoMask() {
  const prev = state.mask.undo.pop();
  if (prev && state.mask.canvas) state.mask.canvas.getContext('2d').putImageData(prev, 0, 0);
  updateMaskState();
}

function setMaskTool(tool) {
  state.mask.tool = tool;
  for (const b of $$('[data-mask-tool]')) b.setAttribute('aria-pressed', String(b.dataset.maskTool === tool));
}

function clearMask() {
  if (state.mask.canvas) state.mask.canvas.getContext('2d').clearRect(0, 0, MASK_W, MASK_H);
  state.mask.undo = [];
  updateMaskState();
}

function setMaskMode(on) {
  if (on) setZoom(false);
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
  // Re-rendering replaces the buttons; keep keyboard focus on the same candidate instead of losing it to <body>.
  const focusedCand = document.activeElement?.closest?.('#strip [data-cand]')?.dataset.cand;
  const jobs = cutJobs(cut).filter((j) => j.status !== 'done');
  let newcomers = 0;
  const entering = (id) => {
    if (state.seen.candidates.has(id)) return null;
    state.seen.candidates.add(id);
    return newcomers++;
  };
  const items = cut.candidates.map((c, i) => {
    const parentIdx = c.parentId ? cut.candidates.findIndex((x) => x.id === c.parentId) + 1 : 0;
    const n = entering(c.id);
    return h('button', {
      dataset: { cand: c.id },
      class: `cand ${c.id === state.selectedCandidateId ? 'sel' : ''} ${c.id === cut.approvedCandidateId ? 'appr' : ''} ${n !== null ? 'enter' : ''}`,
      style: n !== null ? `--stagger:${n}` : null,
      onclick: () => { state.selectedCandidateId = c.id; clearMask(); loadReviewDraft(); renderDialog(); },
      'aria-pressed': c.id === state.selectedCandidateId,
    },
    h('img', { src: assetUrl(c.image), alt: '', loading: 'lazy' }),
    h('span', { class: 'cand-label mono' }, `#${i + 1}`, c.kind === 'edit' ? ` ✎←#${parentIdx}` : ''),
    c.id === cut.approvedCandidateId ? h('span', { class: 'mini-stamp' }, '승인') : null,
    c.id === state.compareRefId ? h('span', { class: 'mini-ref' }, '비교 기준') : null,
    !isCurrentBaseline(c.characterVersionId) ? h('span', { class: 'mini-stale' }, `v${versionOf(c.characterVersionId)?.number}`) : null);
  });
  for (const j of jobs) {
    const live = j.status === 'running' && liveOf(j);
    const label = j.status === 'running' ? (live ? `${live.phase} · ${Math.round(live.fraction * 100)}%` : (j.kind === 'edit' ? '수정 시작' : '생성 시작'))
      : j.status === 'queued' ? '대기 중' : j.status === 'cancelled' ? '취소됨' : '실패';
    const active = j.status === 'running' || j.status === 'queued';
    const n = entering(`job:${j.id}`);
    items.push(h('div', { class: `cand placeholder ${j.status} ${n !== null ? 'enter' : ''}`, title: j.error ?? '', style: `--p:${live ? live.fraction : 0}${n !== null ? `;--stagger:${n}` : ''}` },
      h('span', {}, label),
      active ? h('button', { class: 'linkish', onclick: () => cancelJobs([j]) }, '취소')
        : h('button', { class: 'linkish', onclick: () => retryJob(j.id) }, '재시도')));
  }
  if (!items.length) items.push(h('div', { class: 'strip-empty small muted' }, '아직 후보가 없습니다. 보드에서 “생성”을 누르세요.'));
  $('#strip').replaceChildren(...items);
  if (focusedCand) $(`#strip [data-cand="${focusedCand}"]`)?.focus();
}

function renderMeta(cut) {
  const c = selectedCandidate(cut);
  const box = $('#cand-meta');
  $('#approve-cand').disabled = !c || c.id === cut.approvedCandidateId;
  $('#approve-cand').textContent = c && c.id === cut.approvedCandidateId ? '승인된 후보' :
    c && cut.approvals.some((e) => e.candidateId === c.id) ? '이 후보로 복원' : '이 후보 승인';
  $('#unapprove').disabled = !cut.approvedCandidateId;
  $('#edit-run').disabled = !c || blockingProblems().length > 0;
  if (!c) { box.replaceChildren(h('p', { class: 'small muted' }, '후보를 선택하세요.')); return; }
  const g = c.generation;
  const ver = versionOf(c.characterVersionId);
  const roleKo = { cut: '수정할 컷', face: '얼굴·머리', body: '의상·전신', background: '배경', prop: '소품' };
  box.replaceChildren(
    h('dl', {},
      h('dt', {}, '종류'), h('dd', {}, c.kind === 'edit' ? `수정 (#${cut.candidates.findIndex((x) => x.id === c.parentId) + 1}에서)` : '생성'),
      c.instruction ? [h('dt', {}, '지시'), h('dd', {}, c.instruction)] : null,
      h('dt', {}, '기준'), h('dd', {}, `v${ver?.number ?? '?'}`, ver && !isCurrentBaseline(ver.id) ? h('span', { class: 'warn' }, ' · 이전 기준') : null),
      h('dt', {}, '시드'), h('dd', { class: 'mono' }, g.seed),
      h('dt', {}, '시간'), h('dd', {}, fmtSec(g.durationMs),
        g.coldStart ? h('span', { class: 'muted' }, ' · 모델을 불러온 실행') : h('span', { class: 'muted' }, ' · 모델이 이미 올라와 있던 실행'),
        g.phases?.sampleMs !== undefined ? h('div', { class: 'small muted' },
          `준비 ${fmtSec(g.phases.prepareMs ?? 0)} · 그리기 ${fmtSec(g.phases.sampleMs)} · 마무리 ${fmtSec(g.phases.finishMs ?? 0)}${g.phases.queueMs ? ` · ComfyUI 대기 ${fmtSec(g.phases.queueMs)}` : ''}`) : null),
      h('dt', {}, '실행'), h('dd', { class: 'mono small' }, `${g.backend} · ${g.model.diffusion} · ${g.steps} steps · wf ${g.workflow.version}`)),
    h('div', { class: 'refs-used' }, g.references.map((r, i) => {
      const a = { sha256: r.sha256, ext: r.role === 'cut' ? cut.candidates.find((x) => x.image.sha256 === r.sha256)?.image.ext ?? 'png' : findExt(r.sha256) };
      return h('figure', {}, h('img', { src: assetUrl(a), alt: '' }), h('figcaption', {}, `image ${i + 1} · ${roleKo[r.role] ?? r.role}`));
    })),
    h('details', {}, h('summary', {}, '프롬프트'), h('p', { class: 'prompt mono small' }, g.prompt)),
    h('div', { class: 'row small' },
      h('a', { href: assetUrl(c.image), download: `cut${cut.index + 1}-${c.id}.${c.image.ext}` }, '이미지 받기'),
      g.hasGraph ? h('a', { href: `/api/projects/${P().id}/cuts/${cut.id}/candidates/${c.id}/graph.json` }, 'ComfyUI 워크플로(API)') : null,
      h('button', { class: 'linkish', onclick: () => { $('#edit-seed').value = g.seed; } }, '이 시드 쓰기'),
      h('button', { class: 'linkish', 'aria-pressed': String(state.compareRefId === c.id), onclick: () => togglePin(c.id) },
        state.compareRefId === c.id ? '비교 기준 해제' : '비교 기준으로 (P)')));
}

function togglePin(id) {
  state.compareRefId = state.compareRefId === id ? null : id;
  $('#compare').dataset.key = '';
  renderDialog();
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
      h('button', { type: 'button', class: `tri pass ${v === true ? 'on' : ''}`, 'aria-pressed': String(v === true), 'aria-label': `${CHECK_LABEL[k]} 통과`, onclick: () => { state.reviewDraft[k] = v === true ? undefined : true; renderChecks(); } }, '통과'),
      h('button', { type: 'button', class: `tri fail ${v === false ? 'on' : ''}`, 'aria-pressed': String(v === false), 'aria-label': `${CHECK_LABEL[k]} 불합격`, onclick: () => { state.reviewDraft[k] = v === false ? undefined : false; renderChecks(); } }, '불합격'));
  }
}

function renderReviews(cut) {
  const c = selectedCandidate(cut);
  $('#review').classList.toggle('disabled', !c);
  const label = { face: '얼굴', hair: '헤어', outfit: '의상', props: '소품', scene: '장면', instruction: '수정 지시' };
  // "Edit instruction carried out" only applies to edits.
  $$('#review .edit-only').forEach((el) => { el.hidden = c?.kind !== 'edit'; });
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
  if (!P() || streaming()) return;
  // Without the event stream: poll quickly while jobs run, slowly otherwise (picks up other tabs' work).
  state.pollTimer = setTimeout(async () => {
    try {
      const p = await api('GET', `/api/projects/${P().id}`);
      if (p.id === P()?.id) setProject(p);
    } catch {
      schedulePoll();
    }
  }, activeJobs().length ? 1200 : 8000);
}

async function refreshHealth() {
  const el = $('#health');
  try {
    const hl = await api('GET', '/api/health');
    el.textContent = hl.queue?.backendWait ? 'ComfyUI 기다리는 중' : hl.backend === 'mock' ? 'MOCK 모드' : hl.ok ? 'ComfyUI 연결됨' : 'ComfyUI 문제';
    el.className = `health ${hl.ok ? (hl.backend === 'mock' ? 'mock' : 'ok') : 'bad'}`;
    el.title = hl.detail + (hl.missingModels ? `\n없는 모델: ${hl.missingModels.join(', ')}` : '');
    state.health = hl;
  } catch {
    el.textContent = '서버 연결 끊김';
    el.className = 'health bad';
    state.health = null;
  }
  renderHealthBanner();
}

/** Blocking setup problems (missing model files or nodes) get a banner with the exact fix, and block generation. */
const blockingProblems = () => (state.health?.problems ?? []).filter((p) => p.kind !== 'unreachable');

function renderHealthBanner() {
  const problems = state.health?.problems ?? [];
  // While jobs wait for an unreachable ComfyUI, the queue banner already explains it.
  const shown = problems.filter((p) => p.kind !== 'unreachable' || !P()?.backendWait);
  const box = $('#health-banner');
  box.hidden = !shown.length;
  const title = { unreachable: 'ComfyUI에 연결할 수 없습니다', 'missing-node': '필요한 ComfyUI 노드가 없습니다', 'missing-model': '모델 파일이 없습니다' };
  box.replaceChildren(
    h('div', { class: 'hb-body' }, ...shown.map((p) => h('div', { class: 'hb-item' },
      h('b', {}, title[p.kind], p.item ? h('span', { class: 'mono' }, `  ${p.item}`) : null),
      p.folder ? h('div', { class: 'small' }, `넣을 위치: ComfyUI/models/${p.folder}/`) : null,
      p.available ? h('div', { class: 'small' }, `지금 있는 파일: ${p.available.length ? p.available.join(', ') : '없음'}`) : null,
      h('ol', { class: 'small' }, p.fix.map((f) => h('li', {}, /^(\.\/|WITH_|~\/)/.test(f) ? h('code', {}, f) : f)))))),
    h('button', { class: 'btn ghost sm', onclick: () => refreshHealth().then(() => toast(state.health?.ok ? 'ComfyUI 준비 완료' : '아직 해결되지 않았습니다')) }, '다시 확인'));
  const blocked = blockingProblems().length > 0;
  for (const b of $$('[data-act="gen"], #generate-missing, #edit-run, #refresh-stale')) {
    b.toggleAttribute('data-blocked', blocked);
    if (blocked) { b.disabled = true; b.title = '모델 설정 문제를 먼저 해결하세요'; } else if (b.title === '모델 설정 문제를 먼저 해결하세요') { b.disabled = false; b.title = ''; }
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
  $('#spawn-project').addEventListener('click', () => guard(async () => {
    const created = await api('POST', `/api/projects/${P().id}/spawn`, {});
    await loadProjectList(created.id);
    toast(`“${created.title}”을(를) 만들었습니다 · 캐릭터 기준 v1이 이미 승인되어 있습니다`, 'ok');
  }));
  $('#delete-project').addEventListener('click', () => guard(async () => {
    const p = P();
    const candidates = p.cuts.reduce((n, c) => n + c.candidates.length, 0);
    const ok = confirm(`“${p.title}” 프로젝트를 삭제할까요?\n후보 이미지 ${candidates}개와 캐릭터 기준 ${p.versions.length}개가 함께 지워지고 되돌릴 수 없습니다.\n먼저 “내보내기 ZIP”으로 보관할 수 있습니다.`);
    if (!ok) return;
    state.events?.close();
    await api('DELETE', `/api/projects/${p.id}`);
    remember('cb.project', '');
    await loadProjectList();
    toast(`“${p.title}”을(를) 삭제했습니다`, 'ok');
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
  $('#wait-retry').addEventListener('click', () => guard(async () => {
    await api('POST', '/api/queue/retry-now', {});
    toast('ComfyUI 연결을 다시 확인합니다');
  }));
  $('#mask-toggle').addEventListener('click', () => setMaskMode(!state.mask.on));
  $('#mask-clear').addEventListener('click', clearMask);
  $('#zoom-toggle').addEventListener('click', () => setZoom(!state.zoom.on));
  const compareBox = $('#compare');
  compareBox.addEventListener('pointermove', (e) => {
    if (!state.zoom.on) return;
    const img = e.target.closest('[data-zoomable]')?.querySelector('img');
    if (!img) return;
    const r = img.parentElement.getBoundingClientRect();
    applyZoom(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
  });
  compareBox.addEventListener('pointerleave', () => { if (state.zoom.on) resetZoom(); });
  compareBox.addEventListener('wheel', (e) => {
    if (!state.zoom.on) return;
    e.preventDefault();
    state.zoom.scale = Math.min(8, Math.max(2, state.zoom.scale * (e.deltaY < 0 ? 1.25 : 0.8)));
    applyZoom();
  }, { passive: false });
  $('#mask-undo').addEventListener('click', undoMask);
  $$('[data-mask-tool]').forEach((b) => b.addEventListener('click', () => setMaskTool(b.dataset.maskTool)));

  $('#generate-missing').addEventListener('click', () => guard(async () => {
    const p = await api('POST', `/api/projects/${P().id}/generate-missing`, { count: Number($('#gen-count').value) });
    // The server says how many it queued; diffing local state is wrong once the event stream has already delivered them.
    const n = p.queued;
    setProject(p);
    const skipped = p.skipped?.length ? ` · 장면이 비어 있는 컷 ${p.skipped.join(', ')}은 건너뛰었습니다` : '';
    toast(n > 0 ? `작업 ${n}개를 대기열에 넣었습니다${skipped}` : '생성할 미승인 컷이 없습니다');
  }));

  // dialog
  const dlg = $('#cut-dialog');
  // Review shortcuts: ←/→ change cut, 1–9 pick a candidate, A approves it. Ignored while typing or painting.
  document.addEventListener('keydown', (e) => {
    if (!dlg.open) return;
    const t = e.target;
    if (state.mask.on && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !t.matches('input, textarea')) {
      e.preventDefault();
      undoMask();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || t.matches('input, textarea, select, [contenteditable]')) return;
    const cut = dialogCut();
    if (!cut) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      openDialog(P().cuts[(cut.index + (e.key === 'ArrowRight' ? 1 : 5)) % 6].id);
    } else if (/^[1-9]$/.test(e.key) && cut.candidates[Number(e.key) - 1]) {
      state.selectedCandidateId = cut.candidates[Number(e.key) - 1].id;
      clearMask();
      loadReviewDraft();
      renderDialog();
    } else if ((e.key === 'p' || e.key === 'P') && state.selectedCandidateId) {
      togglePin(state.selectedCandidateId);
    } else if (e.key === 'z' || e.key === 'Z') {
      setZoom(!state.zoom.on);
    } else if ((e.key === 'a' || e.key === 'A') && !$('#approve-cand').disabled) {
      e.preventDefault();
      $('#approve-cand').click();
    }
  });
  $('#dlg-close').addEventListener('click', () => dlg.close());
  dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
  $$('[data-nav]', dlg).forEach((b) => b.addEventListener('click', () => {
    const idx = dialogCut().index + Number(b.dataset.nav);
    const next = P().cuts[(idx + 6) % 6];
    openDialog(next.id);
  }));
  $$('.compare-toolbar .seg button').forEach((b) => b.addEventListener('click', () => {
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
      const kind = selectedCandidate(cut)?.kind;
      const checklist = Object.fromEntries(CHECKS
        .filter((k) => state.reviewDraft[k] !== undefined && (k !== 'instruction' || kind === 'edit'))
        .map((k) => [k, state.reviewDraft[k]]));
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
