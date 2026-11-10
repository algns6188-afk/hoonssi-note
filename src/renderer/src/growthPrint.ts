import type { Athlete, BodyMeasure, GrowthRecord } from '@shared/types'
import { SCORE_ITEMS } from '@shared/types'

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
const multi = (s: string): string => esc(s).replace(/\n/g, '<br>')

function diff(a: number | null | undefined, b: number | null | undefined, unit: string): string {
  if (a == null || b == null) return ''
  const d = Math.round((b - a) * 10) / 10
  if (d === 0) return '<span class="d">(변화 없음)</span>'
  return `<span class="d">(${d > 0 ? '▲' : '▼'}${Math.abs(d)}${unit})</span>`
}

/** 종이 양식과 같은 배치의 성장기록부 HTML (A4 PDF 용) */
export function buildRecordHtml(a: Athlete, r: GrowthRecord, prev: GrowthRecord | null, orgName: string): string {
  const [y, m] = r.month.split('-')
  const rows: (BodyMeasure | null)[] = [...r.measures]
  while (rows.length < 3) rows.push(null)
  const prevLast = prev?.measures.length ? prev.measures[prev.measures.length - 1] : null

  const measureRows = rows
    .map((x, i) => {
      if (!x) return '<tr><td class="c">/</td><td></td><td></td><td></td><td></td><td></td></tr>'
      const base = i === 0 ? prevLast : r.measures[i - 1]
      return `<tr>
        <td class="c">${esc(x.date.slice(5).replace('-', ' / '))}</td>
        <td class="c">${esc(x.weight ?? '')} ${diff(base?.weight, x.weight, '')}</td>
        <td class="c">${esc(x.muscle ?? '')} ${diff(base?.muscle, x.muscle, '')}</td>
        <td class="c">${esc(x.fatPct ?? '')} ${diff(base?.fatPct, x.fatPct, '')}</td>
        <td>${multi(x.fitnessNote)}</td>
        <td>${multi(x.balanceNote)}</td></tr>`
    })
    .join('')

  const scoreRows = SCORE_ITEMS.map((item, i) => {
    const v = r.scores[item.key]
    const p = prev?.scores[item.key]
    const circles = [1, 2, 3, 4, 5].map((n) => `<span class="o${v === n ? ' on' : ''}">${n}</span>`).join('')
    const first = i === 0 || SCORE_ITEMS[i - 1].category !== item.category
    const span = SCORE_ITEMS.filter((s) => s.category === item.category).length
    const sub = item.category === '공인 품새' ? '(정확성/표현력)' : '(실기 고난도)'
    return `<tr>${first ? `<th rowspan="${span}">${item.category}<br><small>${sub}</small></th>` : ''}
      <td class="lbl">${esc(item.label)}</td><td class="circles">${circles} ${diff(p, v, '')}</td></tr>`
  }).join('')

  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { font-family: 'Malgun Gothic','Apple SD Gothic Neo','Noto Sans KR',sans-serif; color:#111; font-size:11px; margin:0; }
    .banner { background:#222; color:#fff; border-radius:8px; padding:14px 18px; display:flex; justify-content:space-between; align-items:center; }
    .banner h1 { margin:0; font-size:20px; } .banner p { margin:4px 0 0; color:#aaa; font-size:10px; }
    .month { background:#fff; color:#111; border-radius:4px; padding:6px 14px; font-weight:700; font-size:15px; }
    h2 { font-size:13px; margin:16px 0 6px; border-left:4px solid #222; padding-left:8px; }
    table { width:100%; border-collapse:collapse; table-layout:fixed; }
    th, td { border:1px solid #999; padding:5px 6px; vertical-align:middle; word-break:break-all; }
    th { background:#e6e6e6; font-weight:700; }
    td.c { text-align:center; } td.shade { background:#f2f2f2; }
    .lbl { font-weight:600; } small { font-weight:400; color:#555; }
    .o { display:inline-block; width:18px; height:18px; border:1px solid #555; border-radius:50%; text-align:center; line-height:16px; margin-right:4px; font-size:10px; }
    .o.on { background:#222; color:#fff; border-color:#222; }
    .d { color:#555; font-size:9px; }
    .fb th { width:22%; height:70px; } .fb td { vertical-align:top; }
    .page2 { page-break-before: always; }
  </style></head><body>
    <div class="banner"><div><h1>품새 선수단 입시·성장 기록부</h1><p>${esc(orgName ? orgName + ' ' : '')}선수단 기량 향상 및 컨디셔닝 매니지먼트 시스템</p></div>
      <div class="month">${esc(y)}년 ${Number(m)}월</div></div>

    <h2>1. 선수 프로필 &amp; 입시 목표 대학</h2>
    <table>
      <tr><th>선수 성명</th><td>${esc(a.name)}</td><th>학교 / 학년</th><td>${esc([a.school, a.grade].filter(Boolean).join(' / '))}</td><th>현재 품·단</th><td>${esc(a.belt)}</td></tr>
      <tr><th>주특기 품새</th><td>${esc(a.mainPoomsae)}</td><th>자유품새 기술</th><td>${esc(a.freestyleSkill)}</td><th>출결 상황</th><td>${esc(a.attendance)}</td></tr>
      <tr><th>교과 등급</th><td>${esc(a.academicGrade)}</td><th>지망 대학</th><td colspan="3">1지망: ${esc(a.universities[0])} &nbsp;&nbsp; 2지망: ${esc(a.universities[1])} &nbsp;&nbsp; 3지망: ${esc(a.universities[2])}</td></tr>
      <tr><th>최종 목표</th><td colspan="5" class="shade">${multi(a.finalGoal)}</td></tr>
    </table>

    <h2>2. 체성분(InBody) 및 체력 지표 기록</h2>
    <table>
      <tr><th rowspan="2" style="width:11%">측정일자</th><th colspan="3">인바디 데이터 (체성분)</th><th rowspan="2">기초 체력 특이사항<br><small>(유연성·밸런스·탄력 등 자유 기술)</small></th><th rowspan="2">신체 균형 및 고관절 가동성 피드백</th></tr>
      <tr><th>체중 (kg)</th><th>골격근량 (kg)</th><th>체지방률 (%)</th></tr>
      ${measureRows}
    </table>

    <h2>3. 이달의 품새 세부 기량 점검 &amp; 전월 대비 변화된 점</h2>
    <table>
      <colgroup><col style="width:16%"><col style="width:42%"><col></colgroup>
      ${scoreRows}
      <tr><th>부상 · 컨디션</th><td colspan="2" class="shade" style="height:50px">${multi(r.condition)}</td></tr>
    </table>

    <div class="page2">
    <h2>4. 이달의 기량 평가 &amp; 지도자 종합 피드백</h2>
    <table class="fb">
      <tr><th>이달의 주요 성장<br>및 성취 피드백</th><td>${multi(r.growth)}</td></tr>
      <tr><th>전국대회 실적<br>및 상장 관리</th><td>${multi(r.competition)}</td></tr>
      <tr><th>다음 달 목표<br>및 입시 제언</th><td>${multi(r.nextGoal)}</td></tr>
      <tr><th>지도진 종합<br>피드백</th><td>${multi(r.coachFeedback)}</td></tr>
    </table></div>
  </body></html>`
}
