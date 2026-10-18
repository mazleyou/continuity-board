import type { Candidate, Checklist, Project } from './model.ts';
import { REFRESH_INSTRUCTION } from './prompt.ts';

// Evaluation summary across projects, matching the plan's first-two-days gate:
//   - within the first 3 generated candidates, ≥15 of 18 cuts pass face, hair and outfit
//   - ≥4 of 6 edits carry out the instruction while keeping face, hair and outfit
//   - at least two reviewers judge with the same checklist
// An item passes when at least one reviewer judged it and every reviewer who judged it passed it.

export const TARGETS = { cutPassRate: 15 / 18, editPassRate: 4 / 6, minReviewers: 2, candidatesPerCut: 3 };
const IDENTITY: (keyof Checklist)[] = ['face', 'hair', 'outfit'];

type Verdict = 'pass' | 'fail' | 'unreviewed';

export function itemVerdict(c: Candidate, key: keyof Checklist): Verdict {
  const judged = c.reviews.map((r) => r.checklist[key]).filter((v): v is boolean => typeof v === 'boolean');
  if (!judged.length) return 'unreviewed';
  return judged.every(Boolean) ? 'pass' : 'fail';
}

function allOf(c: Candidate, keys: (keyof Checklist)[]): Verdict {
  const v = keys.map((k) => itemVerdict(c, k));
  return v.includes('fail') ? 'fail' : v.includes('unreviewed') ? 'unreviewed' : 'pass';
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

export interface Report {
  projects: number;
  cuts: { total: number; pass: number; fail: number; unreviewed: number; rate: number | null; meetsTarget: boolean | null; detail: { project: string; cut: number; verdict: Verdict; tried: number }[] };
  edits: { total: number; pass: number; fail: number; unreviewed: number; rate: number | null; meetsTarget: boolean | null };
  reviewers: { names: string[]; candidatesReviewed: number; withTwoOrMore: number; itemsCompared: number; itemsAgreed: number; agreement: number | null };
  timing: { preset: string; kind: string; cold: boolean; n: number; medianMs: number | null }[];
  integrity?: { project: string; ok: boolean; problems: string[] }[];
}

export function buildReport(projects: Project[]): Report {
  const cutDetail: Report['cuts']['detail'] = [];
  const edits: Verdict[] = [];
  const reviewerNames = new Set<string>();
  let reviewed = 0, twoPlus = 0, compared = 0, agreed = 0;
  const times = new Map<string, number[]>();

  for (const p of projects) {
    for (const cut of p.cuts) {
      const generated = cut.candidates.filter((c) => c.kind === 'generate');
      const firstTry = generated.slice(0, TARGETS.candidatesPerCut);
      if (firstTry.length) {
        const verdicts = firstTry.map((c) => allOf(c, IDENTITY));
        const verdict: Verdict = verdicts.includes('pass') ? 'pass' : verdicts.includes('unreviewed') ? 'unreviewed' : 'fail';
        cutDetail.push({ project: p.title, cut: cut.index + 1, verdict, tried: firstTry.length });
      }
      for (const c of cut.candidates) {
        // Baseline refreshes are maintenance, not the plan's "edit" cases.
        if (c.kind === 'edit' && c.instruction !== REFRESH_INSTRUCTION) edits.push(allOf(c, [...IDENTITY, 'instruction']));
        if (c.reviews.length) reviewed++;
        if (c.reviews.length >= 2) twoPlus++;
        for (const r of c.reviews) reviewerNames.add(r.reviewer);
        for (const key of [...IDENTITY, 'props', 'scene', 'instruction'] as (keyof Checklist)[]) {
          const judged = c.reviews.map((r) => r.checklist[key]).filter((v) => typeof v === 'boolean');
          if (judged.length >= 2) {
            compared++;
            if (judged.every((v) => v === judged[0])) agreed++;
          }
        }
        const g = c.generation;
        const k = `${g.preset ?? 'distilled'}|${c.kind}|${g.coldStart}`;
        times.set(k, [...(times.get(k) ?? []), g.durationMs]);
      }
    }
  }

  const count = (vs: Verdict[]) => {
    const pass = vs.filter((v) => v === 'pass').length;
    const fail = vs.filter((v) => v === 'fail').length;
    const judged = pass + fail;
    return { total: vs.length, pass, fail, unreviewed: vs.length - judged, rate: judged ? pass / judged : null };
  };
  const cuts = count(cutDetail.map((d) => d.verdict));
  const editCount = count(edits);
  return {
    projects: projects.length,
    cuts: { ...cuts, meetsTarget: cuts.rate === null ? null : cuts.rate >= TARGETS.cutPassRate, detail: cutDetail },
    edits: { ...editCount, meetsTarget: editCount.rate === null ? null : editCount.rate >= TARGETS.editPassRate },
    reviewers: {
      names: [...reviewerNames].sort(), candidatesReviewed: reviewed, withTwoOrMore: twoPlus,
      itemsCompared: compared, itemsAgreed: agreed, agreement: compared ? agreed / compared : null,
    },
    timing: [...times.entries()].map(([k, v]) => {
      const [preset, kind, cold] = k.split('|');
      return { preset, kind, cold: cold === 'true', n: v.length, medianMs: median(v) };
    }).sort((a, b) => `${a.preset}${a.kind}${a.cold}`.localeCompare(`${b.preset}${b.kind}${b.cold}`)),
  };
}

const pct = (x: number | null) => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);
const mark = (ok: boolean | null) => (ok === null ? '판정 불가 (평가 없음)' : ok ? '✅ 목표 달성' : '❌ 목표 미달');
const sec = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(1)}초`);

export function renderMarkdown(r: Report, generatedAt = new Date().toISOString()): string {
  const lines = [
    '# Continuity Board 평가 보고서',
    '',
    `생성 시각: ${generatedAt} · 프로젝트 ${r.projects}개`,
    '',
    '판정 규칙: 한 명 이상이 판정했고, 판정한 평가자가 모두 통과를 준 항목만 통과로 봅니다. 한 명이라도 불합격을 주면 불합격입니다.',
    '',
    '## 목표 대비',
    '',
    '| 기준 | 목표 | 결과 | 판정 |',
    '|---|---|---|---|',
    `| 컷 (첫 ${TARGETS.candidatesPerCut}개 후보 안에서 얼굴·헤어·의상 통과) | ${pct(TARGETS.cutPassRate)} (18컷 중 15컷) | ${r.cuts.pass}/${r.cuts.pass + r.cuts.fail} = ${pct(r.cuts.rate)}${r.cuts.unreviewed ? ` · 미평가 ${r.cuts.unreviewed}` : ''} | ${mark(r.cuts.meetsTarget)} |`,
    `| 수정 (지시 반영 + 얼굴·헤어·의상 유지) | ${pct(TARGETS.editPassRate)} (6건 중 4건) | ${r.edits.pass}/${r.edits.pass + r.edits.fail} = ${pct(r.edits.rate)}${r.edits.unreviewed ? ` · 미평가 ${r.edits.unreviewed}` : ''} | ${mark(r.edits.meetsTarget)} |`,
    `| 평가자 수 | ${TARGETS.minReviewers}명 이상 | ${r.reviewers.names.length}명 (${r.reviewers.names.join(', ') || '없음'}) | ${r.reviewers.names.length >= TARGETS.minReviewers ? '✅' : '❌'} |`,
    '',
    '## 평가자 일치도',
    '',
    `평가된 후보 ${r.reviewers.candidatesReviewed}개 중 ${r.reviewers.withTwoOrMore}개를 2명 이상이 평가했습니다. 2명 이상이 판정한 항목 ${r.reviewers.itemsCompared}개 중 ${r.reviewers.itemsAgreed}개(${pct(r.reviewers.agreement)})에서 판정이 일치했습니다.`,
    '',
    '## 처리 시간 (중앙값)',
    '',
    '| 프리셋 | 종류 | 모델 로딩 | 건수 | 중앙값 |',
    '|---|---|---|---|---|',
    ...r.timing.map((t) => `| ${t.preset} | ${t.kind === 'edit' ? '수정' : '생성'} | ${t.cold ? '불러옴 (cold)' : '이미 올라옴 (warm)'} | ${t.n} | ${sec(t.medianMs)} |`),
  ];
  if (r.integrity) {
    const bad = r.integrity.filter((x) => !x.ok);
    lines.push('', '## 승인 파일 무결성', '', bad.length
      ? `❌ ${bad.length}개 프로젝트에서 문제 발견: ${bad.map((b) => `${b.project} (${b.problems.join(', ')})`).join('; ')}`
      : `✅ 모든 프로젝트(${r.integrity.length}개)에서 이미지 해시가 기록과 일치합니다.`);
  }
  lines.push('', '## 컷별 결과', '', '| 프로젝트 | 컷 | 시도한 후보 | 판정 |', '|---|---|---|---|',
    ...r.cuts.detail.map((d) => `| ${d.project} | ${d.cut} | ${d.tried} | ${d.verdict === 'pass' ? '통과' : d.verdict === 'fail' ? '불합격' : '미평가'} |`));
  return lines.join('\n') + '\n';
}
