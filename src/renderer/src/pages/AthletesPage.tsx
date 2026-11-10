import { useEffect, useMemo, useRef, useState } from 'react'
import type { Athlete, BodyMeasure, GrowthRecord, ScoreKey } from '@shared/types'
import { DEFAULT_GROUPS, SCORE_ITEMS } from '@shared/types'
import { errMsg, now, uid } from '../util'
import { buildRecordHtml } from '../growthPrint'

const thisMonth = (): string => new Date().toISOString().slice(0, 7)
const monthLabel = (m: string): string => `${m.slice(0, 4)}년 ${Number(m.slice(5, 7))}월`

function newAthlete(group: string): Athlete {
  const t = now()
  return {
    id: uid(), name: '', group, school: '', grade: '', belt: '', mainPoomsae: '', freestyleSkill: '',
    attendance: '', academicGrade: '', universities: ['', '', ''], finalGoal: '', memo: '',
    active: true, createdAt: t, updatedAt: t
  }
}

function emptyRecord(athleteId: string, month: string): GrowthRecord {
  return {
    // 같은 선수·같은 달은 어느 PC에서 만들어도 같은 id (중복 방지)
    id: `${athleteId}_${month}`, athleteId, month, measures: [],
    scores: { accuracy: null, expression: null, jump: null, spin: null },
    condition: '', growth: '', competition: '', nextGoal: '', coachFeedback: '', updatedAt: now()
  }
}

const emptyMeasure = (): BodyMeasure => ({
  date: new Date().toISOString().slice(0, 10), weight: null, muscle: null, fatPct: null, fitnessNote: '', balanceNote: ''
})

/** 저장 대기 중인 내용을 0.8초 뒤 한 번에 저장 */
function useDebouncedSave<T>(save: (v: T) => Promise<unknown>): { queue(v: T): void; flush(): Promise<void>; state: string } {
  const timer = useRef<number | null>(null)
  const pending = useRef<T | null>(null)
  const [state, setState] = useState('저장됨')
  const flush = async (): Promise<void> => {
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = null
    const v = pending.current
    pending.current = null
    if (v === null) return
    setState('저장 중…')
    await save(v)
    setState('저장됨')
  }
  const queue = (v: T): void => {
    pending.current = v
    setState('수정됨')
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(flush, 800)
  }
  return { queue, flush, state }
}

export default function AthletesPage(): JSX.Element {
  const [athletes, setAthletes] = useState<Athlete[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [groupFilter, setGroupFilter] = useState('전체')
  const [query, setQuery] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const [tab, setTab] = useState<'record' | 'profile'>('record')

  const reload = async (): Promise<void> => setAthletes(await window.api.listAthletes())
  useEffect(() => {
    reload()
    return window.api.onDataChanged(() => reload())
  }, [])

  const groups = useMemo(
    () => [...new Set([...DEFAULT_GROUPS, ...athletes.map((a) => a.group).filter(Boolean)])],
    [athletes]
  )
  const list = athletes
    .filter((a) => showInactive || a.active)
    .filter((a) => groupFilter === '전체' || a.group === groupFilter)
    .filter((a) => !query.trim() || [a.name, a.school, a.belt].join(' ').includes(query.trim()))
  const selected = athletes.find((a) => a.id === selectedId) ?? null

  const create = async (): Promise<void> => {
    const a = newAthlete(groupFilter === '전체' ? '일반부' : groupFilter)
    await window.api.saveAthlete(a)
    await reload()
    setSelectedId(a.id)
    setTab('profile')
  }

  return (
    <div className="split">
      <section className="list-pane">
        <div className="list-head">
          <h1>선수 관리</h1>
          <button className="primary" onClick={create}>+ 새 선수</button>
        </div>
        <input className="search" placeholder="이름, 학교, 품·단 검색" value={query} onChange={(e) => setQuery(e.target.value)} />
        <div className="filters">
          {['전체', ...groups].map((g) => (
            <button key={g} className={groupFilter === g ? 'pill on' : 'pill'} onClick={() => setGroupFilter(g)}>
              {g}
              <span className="pill-count">{g === '전체' ? athletes.filter((a) => a.active).length : athletes.filter((a) => a.active && a.group === g).length}</span>
            </button>
          ))}
        </div>
        <label className="check small pad-x">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> 그만둔 선수도 보기
        </label>
        <div className="items">
          {list.length === 0 && <p className="muted pad">선수가 없습니다. '+ 새 선수'로 등록하세요.</p>}
          {list.map((a) => (
            <button key={a.id} className={a.id === selectedId ? 'item on' : 'item'} onClick={() => setSelectedId(a.id)}>
              <div className="item-title">{a.name || '(이름 없음)'} {!a.active && <span className="chip">퇴관</span>}</div>
              <div className="item-meta">
                <span className={a.group === '입시부' ? 'chip accent' : 'chip'}>{a.group || '구분 없음'}</span>
                {a.school && <span>{a.school} {a.grade}</span>}
                {a.belt && <span>· {a.belt}</span>}
              </div>
            </button>
          ))}
        </div>
      </section>

      <section className="editor-pane">
        {!selected ? (
          <div className="empty"><p>왼쪽에서 선수를 고르거나 새 선수를 등록하세요.</p></div>
        ) : (
          <div className="editor">
            <div className="editor-top">
              <h1 className="grow">{selected.name || '(이름 없음)'} <span className={selected.group === '입시부' ? 'chip accent' : 'chip'}>{selected.group}</span></h1>
            </div>
            <div className="tabs">
              <button className={tab === 'record' ? 'tab on' : 'tab'} onClick={() => setTab('record')}>월별 기록</button>
              <button className={tab === 'profile' ? 'tab on' : 'tab'} onClick={() => setTab('profile')}>선수 정보</button>
            </div>
            {tab === 'profile' ? (
              <ProfileForm
                key={selected.id}
                athlete={selected}
                groups={groups}
                onSaved={reload}
                onDeleted={async () => {
                  setSelectedId(null)
                  await reload()
                }}
              />
            ) : (
              <MonthlyRecord key={selected.id} athlete={selected} />
            )}
          </div>
        )}
      </section>
    </div>
  )
}

/* ---------------- 1. 선수 정보 ---------------- */

function ProfileForm({ athlete, groups, onSaved, onDeleted }: {
  athlete: Athlete
  groups: string[]
  onSaved(): Promise<void>
  onDeleted(): Promise<void>
}): JSX.Element {
  const [a, setA] = useState(athlete)
  const saver = useDebouncedSave<Athlete>(async (v) => {
    await window.api.saveAthlete(v)
    await onSaved()
  })
  useEffect(() => () => void saver.flush(), []) // eslint-disable-line react-hooks/exhaustive-deps

  // 다른 PC에서 고친 내용 반영 (이 PC에서 입력 중이 아닐 때만)
  useEffect(() => {
    if (saver.state === '저장됨' && athlete.updatedAt > a.updatedAt) setA(athlete)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [athlete])

  const set = <K extends keyof Athlete>(k: K, v: Athlete[K]): void => {
    const next = { ...a, [k]: v }
    setA(next)
    saver.queue(next)
  }
  const setUni = (i: number, v: string): void => {
    const u = [...a.universities]
    u[i] = v
    set('universities', u)
  }

  const remove = async (): Promise<void> => {
    if (!confirm(`${a.name || '이 선수'}의 정보와 모든 월별 기록을 삭제할까요?\n그만둔 선수라면 삭제 대신 '퇴관 처리'를 권장합니다.`)) return
    await window.api.deleteAthlete(a.id)
    await onDeleted()
  }

  return (
    <div className="sheet">
      <div className="sheet-head">
        <h2>1. 선수 프로필 & 입시 목표</h2>
        <span className="save-state">{saver.state}</span>
      </div>
      <div className="form-grid">
        <Field label="선수 성명"><input value={a.name} onChange={(e) => set('name', e.target.value)} autoFocus={!a.name} /></Field>
        <Field label="구분">
          <input list="groups" value={a.group} onChange={(e) => set('group', e.target.value)} placeholder="일반부 / 입시부 …" />
          <datalist id="groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
        </Field>
        <Field label="학교"><input value={a.school} onChange={(e) => set('school', e.target.value)} /></Field>
        <Field label="학년"><input value={a.grade} onChange={(e) => set('grade', e.target.value)} placeholder="예: 고2" /></Field>
        <Field label="현재 품·단"><input value={a.belt} onChange={(e) => set('belt', e.target.value)} placeholder="예: 3단" /></Field>
        <Field label="출결 상황"><input value={a.attendance} onChange={(e) => set('attendance', e.target.value)} /></Field>
        <Field label="주특기 품새"><input value={a.mainPoomsae} onChange={(e) => set('mainPoomsae', e.target.value)} /></Field>
        <Field label="자유품새 기술"><input value={a.freestyleSkill} onChange={(e) => set('freestyleSkill', e.target.value)} /></Field>
      </div>

      <h3 className="sub">입시 정보 <span className="muted small">(입시 준비 선수만 입력)</span></h3>
      <div className="form-grid">
        <Field label="교과 등급"><input value={a.academicGrade} onChange={(e) => set('academicGrade', e.target.value)} /></Field>
        <div />
        {[0, 1, 2].map((i) => (
          <Field key={i} label={`${i + 1}지망 대학`}><input value={a.universities[i] ?? ''} onChange={(e) => setUni(i, e.target.value)} /></Field>
        ))}
      </div>
      <Field label="최종 목표"><textarea rows={2} value={a.finalGoal} onChange={(e) => set('finalGoal', e.target.value)} /></Field>
      <Field label="메모 (연락처, 특이사항 등)"><textarea rows={3} value={a.memo} onChange={(e) => set('memo', e.target.value)} /></Field>

      <div className="row-actions top-gap">
        <label className="check">
          <input type="checkbox" checked={!a.active} onChange={(e) => set('active', !e.target.checked)} /> 퇴관 처리 (목록에서 숨김, 기록은 보관)
        </label>
        <button className="ghost danger" onClick={remove}>선수 삭제</button>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  )
}

/* ---------------- 2~4. 월별 기록 ---------------- */

function MonthlyRecord({ athlete }: { athlete: Athlete }): JSX.Element {
  const [month, setMonth] = useState(thisMonth())
  const [records, setRecords] = useState<GrowthRecord[]>([])
  const [rec, setRec] = useState<GrowthRecord>(emptyRecord(athlete.id, month))
  const [msg, setMsg] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  const saver = useDebouncedSave<GrowthRecord>(async (v) => {
    const saved = await window.api.saveGrowthRecord(v)
    setRecords((rs) => [...rs.filter((r) => r.month !== saved.month), saved].sort((a, b) => a.month.localeCompare(b.month)))
  })

  useEffect(() => {
    window.api.listGrowthRecords(athlete.id).then((rs) => {
      setRecords(rs)
      setLoaded(true)
    })
  }, [athlete.id])

  // 다른 PC에서 고친 기록 반영 (이 PC에서 입력 중이 아닐 때만)
  const stateRef = useRef(saver.state)
  stateRef.current = saver.state
  useEffect(
    () =>
      window.api.onDataChanged(async () => {
        const rs = await window.api.listGrowthRecords(athlete.id)
        setRecords(rs)
        if (stateRef.current !== '저장됨') return
        setRec((cur) => {
          const fresh = rs.find((r) => r.month === cur.month)
          return fresh && fresh.updatedAt > cur.updatedAt ? fresh : cur
        })
      }),
    [athlete.id]
  )

  // 달을 바꾸면(또는 처음 불러오면) 그 달 기록을 열고, 없으면 빈 기록으로 시작
  useEffect(() => {
    if (!loaded) return
    saver.flush()
    setRec(records.find((r) => r.month === month) ?? emptyRecord(athlete.id, month))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, loaded])

  useEffect(() => () => void saver.flush(), []) // eslint-disable-line react-hooks/exhaustive-deps

  const prev = [...records].reverse().find((r) => r.month < month) ?? null

  const update = (patch: Partial<GrowthRecord>): void => {
    const next = { ...rec, ...patch }
    setRec(next)
    saver.queue(next)
  }
  const setMeasure = (i: number, patch: Partial<BodyMeasure>): void =>
    update({ measures: rec.measures.map((m, j) => (j === i ? { ...m, ...patch } : m)) })
  const setScore = (k: ScoreKey, v: number | null): void => update({ scores: { ...rec.scores, [k]: v } })

  const moveMonth = (d: number): void => {
    const [y, m] = month.split('-').map(Number)
    const dt = new Date(y, m - 1 + d, 1)
    setMonth(`${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`)
  }

  const exportPdf = async (): Promise<void> => {
    setMsg(null)
    try {
      await saver.flush()
      const path = await window.api.savePdf(
        buildRecordHtml(athlete, rec, prev),
        `${athlete.name || '선수'}_성장기록부_${month}.pdf`
      )
      if (path) setMsg(`PDF로 저장했습니다: ${path}`)
    } catch (e) {
      setMsg('PDF 저장 실패: ' + errMsg(e))
    }
  }

  const lastOf = (r: GrowthRecord | null): BodyMeasure | null => (r?.measures.length ? r.measures[r.measures.length - 1] : null)
  const cur = lastOf(rec)
  const before = lastOf(prev)

  return (
    <div className="sheet">
      <div className="month-bar">
        <button onClick={() => moveMonth(-1)}>◀</button>
        <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        <button onClick={() => moveMonth(1)}>▶</button>
        <span className="save-state">{saver.state}</span>
        <span className="muted small">{prev ? `비교 기준: ${monthLabel(prev.month)}` : '이전 기록 없음'}</span>
        <button className="right" onClick={exportPdf}>📄 PDF로 저장</button>
      </div>
      {msg && <div className="notice">{msg}</div>}

      <div className="sheet-head"><h2>2. 체성분(InBody) 및 체력 지표</h2></div>
      <table className="grid-table">
        <thead>
          <tr>
            <th>측정일</th><th>체중(kg)</th><th>골격근량(kg)</th><th>체지방률(%)</th>
            <th>기초 체력 특이사항<br /><span className="muted small">유연성·밸런스·탄력 등</span></th>
            <th>신체 균형·고관절 가동성 피드백</th><th />
          </tr>
        </thead>
        <tbody>
          {rec.measures.map((m, i) => (
            <tr key={i}>
              <td><input type="date" value={m.date} onChange={(e) => setMeasure(i, { date: e.target.value })} /></td>
              <td><NumInput value={m.weight} onChange={(v) => setMeasure(i, { weight: v })} /></td>
              <td><NumInput value={m.muscle} onChange={(v) => setMeasure(i, { muscle: v })} /></td>
              <td><NumInput value={m.fatPct} onChange={(v) => setMeasure(i, { fatPct: v })} /></td>
              <td><textarea rows={2} value={m.fitnessNote} onChange={(e) => setMeasure(i, { fitnessNote: e.target.value })} /></td>
              <td><textarea rows={2} value={m.balanceNote} onChange={(e) => setMeasure(i, { balanceNote: e.target.value })} /></td>
              <td><button className="ghost small" onClick={() => update({ measures: rec.measures.filter((_, j) => j !== i) })}>✕</button></td>
            </tr>
          ))}
          <tr>
            <td colSpan={7}><button className="link" onClick={() => update({ measures: [...rec.measures, emptyMeasure()] })}>+ 측정 기록 추가</button></td>
          </tr>
        </tbody>
      </table>
      {cur && before && (
        <div className="diff-row">
          전월 대비 · 체중 <Diff a={before.weight} b={cur.weight} unit="kg" />
          · 골격근량 <Diff a={before.muscle} b={cur.muscle} unit="kg" good="up" />
          · 체지방률 <Diff a={before.fatPct} b={cur.fatPct} unit="%" good="down" />
        </div>
      )}

      <div className="sheet-head"><h2>3. 이달의 품새 세부 기량 점검 & 전월 대비 변화</h2></div>
      <table className="grid-table scores">
        <tbody>
          {SCORE_ITEMS.map((item, i) => (
            <tr key={item.key}>
              {(i === 0 || SCORE_ITEMS[i - 1].category !== item.category) && (
                <th rowSpan={SCORE_ITEMS.filter((x) => x.category === item.category).length}>{item.category}</th>
              )}
              <td>{item.label}</td>
              <td>
                <div className="score-pick">
                  {[1, 2, 3, 4, 5].map((n) => (
                    <button
                      key={n}
                      className={rec.scores[item.key] === n ? 'score on' : 'score'}
                      onClick={() => setScore(item.key, rec.scores[item.key] === n ? null : n)}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </td>
              <td className="diff-cell">
                {prev?.scores[item.key] != null && rec.scores[item.key] != null ? (
                  <Diff a={prev.scores[item.key]} b={rec.scores[item.key]} unit="점" good="up" />
                ) : (
                  <span className="muted small">{prev?.scores[item.key] != null ? `지난달 ${prev.scores[item.key]}점` : ''}</span>
                )}
              </td>
            </tr>
          ))}
          <tr>
            <th>부상 · 컨디션</th>
            <td colSpan={3}><textarea rows={2} value={rec.condition} onChange={(e) => update({ condition: e.target.value })} /></td>
          </tr>
        </tbody>
      </table>

      <div className="sheet-head"><h2>4. 이달의 기량 평가 & 지도자 종합 피드백</h2></div>
      <table className="grid-table feedback">
        <tbody>
          {([
            ['growth', '이달의 주요 성장 및 성취 피드백'],
            ['competition', '전국대회 실적 및 상장 관리'],
            ['nextGoal', '다음 달 목표 및 입시 제언'],
            ['coachFeedback', '지도진 종합 피드백']
          ] as const).map(([k, label]) => (
            <tr key={k}>
              <th>{label}</th>
              <td><textarea rows={3} value={rec[k]} onChange={(e) => update({ [k]: e.target.value } as Partial<GrowthRecord>)} /></td>
            </tr>
          ))}
        </tbody>
      </table>

      {records.length > 1 && <History records={records} current={month} onPick={setMonth} />}
    </div>
  )
}

function NumInput({ value, onChange }: { value: number | null; onChange(v: number | null): void }): JSX.Element {
  const [text, setText] = useState(value == null ? '' : String(value))
  useEffect(() => setText(value == null ? '' : String(value)), [value])
  return (
    <input
      className="num"
      inputMode="decimal"
      value={text}
      onChange={(e) => {
        const t = e.target.value.replace(/[^0-9.]/g, '')
        setText(t)
        const n = parseFloat(t)
        onChange(Number.isFinite(n) ? n : null)
      }}
    />
  )
}

function Diff({ a, b, unit, good }: { a: number | null; b: number | null; unit: string; good?: 'up' | 'down' }): JSX.Element {
  if (a == null || b == null) return <span className="muted">-</span>
  const d = Math.round((b - a) * 10) / 10
  if (d === 0) return <span className="muted">변화 없음</span>
  const better = good ? (good === 'up' ? d > 0 : d < 0) : null
  return (
    <span className={better === null ? 'diff' : better ? 'diff good' : 'diff bad'}>
      {d > 0 ? '▲' : '▼'} {Math.abs(d)}{unit}
    </span>
  )
}

/** 지난 기록 한눈에 보기 (점수·체성분 추이) */
function History({ records, current, onPick }: { records: GrowthRecord[]; current: string; onPick(m: string): void }): JSX.Element {
  const last = (r: GrowthRecord): BodyMeasure | null => (r.measures.length ? r.measures[r.measures.length - 1] : null)
  return (
    <>
      <div className="sheet-head"><h2>월별 추이</h2></div>
      <table className="grid-table history">
        <thead>
          <tr>
            <th>월</th><th>체중</th><th>골격근량</th><th>체지방률</th>
            {SCORE_ITEMS.map((s) => <th key={s.key}>{s.label.match(/\[(.+?)\]/)?.[1]}</th>)}
          </tr>
        </thead>
        <tbody>
          {[...records].reverse().map((r) => (
            <tr key={r.id} className={r.month === current ? 'on' : ''} onClick={() => onPick(r.month)}>
              <td>{monthLabel(r.month)}</td>
              <td>{last(r)?.weight ?? '-'}</td>
              <td>{last(r)?.muscle ?? '-'}</td>
              <td>{last(r)?.fatPct ?? '-'}</td>
              {SCORE_ITEMS.map((s) => <td key={s.key}>{r.scores[s.key] ?? '-'}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
