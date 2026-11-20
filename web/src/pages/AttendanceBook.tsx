import { useCallback, useEffect, useMemo, useState } from 'react'
import { useKeep } from '../keep'
import { supabase, errText, type Student } from '../supabase'
import { SESSION_TIMES, type StudentFull } from './StudentForm'

/* 출석부: 일별 (하루 표, 상태 바로 수정) · 월별 (한 달 달력표) */

interface Att { id: string; student_id: string; kind: 'in' | 'out'; at: string }
type AbsKind = 'absent' | 'sick' | 'trip' | 'early'
interface Abs { student_id: string; date: string; reason: string; kind?: AbsKind }
/** 결석 종류: 결석 · 병가 · 체험학습 · 조퇴(왔다가 일찍 감) */
export const ABS_LABEL: Record<AbsKind, string> = { absent: '결석', sick: '병가', trip: '체험학습', early: '조퇴' }
const absErr = (e: unknown): string => (/kind/.test(errText(e)) ? '병가·체험학습·조퇴는 Supabase에서 schema-v16-absence-kinds.sql 을 실행한 뒤 쓸 수 있어요.' : errText(e))
interface Contact { student_id: string; name: string; phone: string; relation: string; sort: number }

const DOW = ['일', '월', '화', '수', '목', '금', '토']
const kstToday = (): string => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)
const kstDay = (iso: string): string => new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 10)
const kstTime = (iso: string): string => new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(11, 16)
const addDays = (d: string, n: number): string => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400_000).toISOString().slice(0, 10)
const dowOf = (d: string): number => new Date(d + 'T00:00:00Z').getUTCDay()
const startIso = (d: string): string => `${d}T00:00:00+09:00`
const sessionName = (s: StudentFull): string => (s.session_no ? `${s.session_no}부` : s.session_label || '')
const attendsOn = (s: StudentFull, d: string): boolean => {
  const days = (s.attend_days ?? '').split(/[,\s]+/).filter(Boolean)
  return days.length ? days.includes(DOW[dowOf(d)]) : dowOf(d) > 0 && dowOf(d) < 6
}

function downloadCsv(name: string, rows: (string | number)[][]): void {
  const csv = rows.map((r) => r.map((c) => { const t = String(c ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t }).join(',')).join('\r\n')
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

function useFilters(students: StudentFull[]): {
  group: string; setGroup(g: string): void; session: string; setSession(s: string): void; q: string; setQ(q: string): void
  groups: string[]; sessions: number[]; pass(s: StudentFull): boolean
} {
  const [group, setGroup] = useState('전체')
  const [session, setSession] = useState('all')
  const [q, setQ] = useState('')
  const groups = ['전체', ...new Set(students.map((s) => s.group_name).filter(Boolean))]
  const sessions = [...new Set(students.map((s) => s.session_no).filter((x): x is number => !!x))].sort()
  const pass = (s: StudentFull): boolean =>
    (group === '전체' || s.group_name === group) &&
    (session === 'all' || (session === 'none' ? !s.session_no : String(s.session_no) === session)) &&
    (!q || s.name.includes(q) || s.code.includes(q) || (s.school ?? '').includes(q))
  return { group, setGroup, session, setSession, q, setQ, groups, sessions, pass }
}

function Filters({ f, children }: { f: ReturnType<typeof useFilters>; children?: React.ReactNode }): JSX.Element {
  return (
    <div className="bt-filters">
      <select value={f.group} onChange={(e) => f.setGroup(e.target.value)}>{f.groups.map((g) => <option key={g} value={g}>{g === '전체' ? '반: 전체' : g}</option>)}</select>
      <select value={f.session} onChange={(e) => f.setSession(e.target.value)}>
        <option value="all">부: 전체</option>
        {f.sessions.map((n) => <option key={n} value={String(n)}>{n}부 {SESSION_TIMES[n] ?? ''}</option>)}
        <option value="none">미지정</option>
      </select>
      {children}
      <input className="bt-search" placeholder="이름·출석번호·학교 검색" value={f.q} onChange={(e) => f.setQ(e.target.value)} />
    </div>
  )
}

/* ---------------- 일별 ---------------- */

type DayStatus = 'in' | 'out' | 'early' | 'absent' | 'sick' | 'trip' | 'none'
const ST: Record<DayStatus, string> = { in: '등원', out: '하원', early: '조퇴', absent: '결석', sick: '병가', trip: '체험학습', none: '상태없음' }
const isAbsType = (k: DayStatus): k is 'absent' | 'sick' | 'trip' => k === 'absent' || k === 'sick' || k === 'trip'

export function DailyBook({ students: all, initialDate }: { students: Student[]; initialDate?: string }): JSX.Element {
  const students = (all as StudentFull[]).filter((s) => s.active)
  const [date, setDate] = useKeep(initialDate ? null : 'att-date', initialDate ?? kstToday())
  const [att, setAtt] = useState<Att[]>([])
  const [abs, setAbs] = useState<Abs[]>([])
  const [contacts, setContacts] = useState<Contact[]>([])
  const [linked, setLinked] = useState<Set<string>>(new Set())
  const [show, setShow] = useState<'attended' | 'expected' | 'all'>('expected')
  const [sort, setSort] = useState<'in' | 'session' | 'name'>('session')
  const [busy, setBusy] = useState<string | null>(null)
  const f = useFilters(students)

  const load = useCallback(async () => {
    const [a, b] = await Promise.all([
      supabase.from('attendance').select('id,student_id,kind,at').gte('at', startIso(date)).lt('at', startIso(addDays(date, 1))).order('at'),
      supabase.from('absences').select('*').eq('date', date)
    ])
    setAtt((a.data as Att[]) ?? [])
    setAbs((b.data as Abs[]) ?? [])
  }, [date])
  useEffect(() => {
    load()
    const ch = supabase.channel('daily-book')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'attendance' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'absences' }, () => load())
      .subscribe()
    return () => void supabase.removeChannel(ch)
  }, [load])
  useEffect(() => {
    supabase.from('student_contacts').select('student_id,name,phone,relation,sort').order('sort').then(({ data }) => setContacts((data as Contact[]) ?? []))
    supabase.from('guardians').select('student_id').then(({ data }) => setLinked(new Set(((data as { student_id: string }[]) ?? []).map((g) => g.student_id))))
  }, [])

  const info = (s: StudentFull): { st: DayStatus; inAt?: string; outAt?: string; reason?: string } => {
    const rs = att.filter((r) => r.student_id === s.id)
    const firstIn = rs.find((r) => r.kind === 'in')
    const lastOut = [...rs].reverse().find((r) => r.kind === 'out')
    const lastIn = [...rs].reverse().find((r) => r.kind === 'in')
    const ab = abs.find((x) => x.student_id === s.id)
    if (ab?.kind === 'early') return { st: 'early', inAt: firstIn?.at, outAt: lastOut?.at, reason: ab.reason }
    if (firstIn) return { st: lastOut && (!lastIn || lastOut.at > lastIn.at) ? 'out' : 'in', inAt: firstIn.at, outAt: lastOut?.at }
    if (ab) return { st: ab.kind ?? 'absent', reason: ab.reason }
    return { st: 'none' }
  }

  const rows = students
    .filter(f.pass)
    .map((s) => ({ s, ...info(s) }))
    .filter((r) => show === 'all' || (show === 'attended' ? r.st !== 'none' : r.st !== 'none' || attendsOn(r.s, date)))
    .sort((a, b) =>
      sort === 'in' ? (b.inAt ?? '').localeCompare(a.inAt ?? '') || a.s.name.localeCompare(b.s.name, 'ko')
        : sort === 'session' ? (a.s.session_no ?? 99) - (b.s.session_no ?? 99) || a.s.name.localeCompare(b.s.name, 'ko')
          : a.s.name.localeCompare(b.s.name, 'ko'))

  const all4 = students.filter(f.pass).map(info)
  const count = (k: DayStatus): number => all4.filter((x) => x.st === k).length
  const isToday = date === kstToday()

  /** 기록할 시각: 오늘이면 지금, 지난 날이면 그 학생 부 시작/끝 시각 */
  const timeFor = (s: StudentFull, kind: 'in' | 'out'): string => {
    if (isToday) return new Date().toISOString()
    const t = SESSION_TIMES[s.session_no ?? 0]?.split('~')[kind === 'in' ? 0 : 1] ?? (kind === 'in' ? '15:00' : '16:00')
    return `${date}T${t.padStart(5, '0')}:00+09:00`
  }

  const change = async (s: StudentFull, to: DayStatus): Promise<void> => {
    const cur = info(s)
    if (to === cur.st) return
    let reason = ''
    if (isAbsType(to) || to === 'early') {
      const r = window.prompt(`${s.name} ${date.slice(5).replace('-', '/')} ${ST[to]} 사유 (비워도 돼요)`, '')
      if (r === null) return
      reason = r
    }
    const mine = att.filter((r) => r.student_id === s.id)
    if ((isAbsType(to) || to === 'none') && mine.length && !window.confirm(`${s.name}의 이날 등·하원 기록을 지울까요?`)) return
    setBusy(s.id)
    const hadAbs = abs.some((x) => x.student_id === s.id)
    const ops: PromiseLike<{ error: unknown }>[] = []
    if (hadAbs) ops.push(supabase.from('absences').delete().eq('student_id', s.id).eq('date', date))
    if (isAbsType(to) || to === 'none') {
      if (mine.length) ops.push(supabase.from('attendance').delete().in('id', mine.map((r) => r.id)))
      if (isAbsType(to)) ops.push(supabase.from('absences').insert({ org_id: s.org_id, student_id: s.id, date, reason, kind: to }))
    } else if (to === 'early') {
      // 조퇴: 등원 기록 + 하원 기록(일찍) + 조퇴 표시
      const rows: object[] = []
      if (!mine.some((r) => r.kind === 'in')) rows.push({ org_id: s.org_id, student_id: s.id, kind: 'in', at: timeFor(s, 'in'), source: 'staff' })
      if (!mine.some((r) => r.kind === 'out')) rows.push({ org_id: s.org_id, student_id: s.id, kind: 'out', at: isToday ? new Date().toISOString() : timeFor(s, 'out'), source: 'staff' })
      if (rows.length) ops.push(supabase.from('attendance').insert(rows))
      ops.push(supabase.from('absences').insert({ org_id: s.org_id, student_id: s.id, date, reason, kind: 'early' }))
    } else if (to === 'in') {
      if (mine.some((r) => r.kind === 'out')) ops.push(supabase.from('attendance').delete().in('id', mine.filter((r) => r.kind === 'out').map((r) => r.id)))
      if (!mine.some((r) => r.kind === 'in')) ops.push(supabase.from('attendance').insert({ org_id: s.org_id, student_id: s.id, kind: 'in', at: timeFor(s, 'in'), source: 'staff' }))
    } else {
      const rows: object[] = []
      if (!mine.some((r) => r.kind === 'in')) rows.push({ org_id: s.org_id, student_id: s.id, kind: 'in', at: timeFor(s, 'in'), source: 'staff' })
      if (!mine.some((r) => r.kind === 'out') || cur.st === 'in') rows.push({ org_id: s.org_id, student_id: s.id, kind: 'out', at: timeFor(s, 'out'), source: 'staff' })
      if (rows.length) ops.push(supabase.from('attendance').insert(rows))
    }
    // 순서대로 (삭제 → 추가)
    for (const op of ops) {
      const { error } = await op
      if (error) { alert('저장 실패: ' + absErr(error)); break }
    }
    setBusy(null)
    load()
  }

  const parent = (sid: string, n: number): Contact | undefined => contacts.filter((c) => c.student_id === sid)[n]

  const exportCsv = (): void => downloadCsv(`강철노트_출석부_${date}.csv`, [
    ['NO', '반', '부', '학교', '학년', '이름', '출석번호', '상태', '등원', '하원', '부모1', '부모1 연락처', '부모2', '부모2 연락처', '비고'],
    ...rows.map((r, i) => [i + 1, r.s.group_name, sessionName(r.s), r.s.school ?? '', r.s.grade ?? '', r.s.name, r.s.code, ST[r.st],
      r.inAt ? kstTime(r.inAt) : '', r.outAt ? kstTime(r.outAt) : '',
      parent(r.s.id, 0)?.name ?? '', parent(r.s.id, 0)?.phone ?? '', parent(r.s.id, 1)?.name ?? '', parent(r.s.id, 1)?.phone ?? '', r.reason ?? ''])
  ])

  return (
    <div className="page attbook">
      <div className="month-nav">
        <button onClick={() => setDate(addDays(date, -1))}>◀</button>
        <b>{date.slice(0, 4)}년 {Number(date.slice(5, 7))}월 {Number(date.slice(8))}일({DOW[dowOf(date)]})</b>
        <button onClick={() => setDate(addDays(date, 1))}>▶</button>
        <input type="date" className="date-pick" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
        {!isToday && <button className="ghost small-btn" onClick={() => setDate(kstToday())}>오늘</button>}
      </div>
      <div className="att-summary">
        <span>등원 <b className="ok">{count('in')}</b></span>
        <span>하원 <b>{count('out')}</b></span>
        <span>조퇴 <b>{count('early')}</b></span>
        <span>결석 <b className="danger">{count('absent')}</b></span>
        <span>병가 <b>{count('sick')}</b></span>
        <span>체험학습 <b>{count('trip')}</b></span>
        <span>상태없음 <b>{count('none')}</b></span>
      </div>
      <Filters f={f}>
        <select value={show} onChange={(e) => setShow(e.target.value as typeof show)}>
          <option value="expected">이날 수업 학생</option><option value="attended">출결 기록 있는 학생만</option><option value="all">재원생 전체</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          <option value="session">정렬: 부(시간)순</option><option value="in">정렬: 등원 늦은 순</option><option value="name">정렬: 이름순</option>
        </select>
      </Filters>
      <div className="bt-actions">
        <span className="muted small">{rows.length}명{!isToday && ' · 지난 날짜는 부 시간으로 기록돼요 (학부모 알림 없음)'}</span>
        <button onClick={exportCsv}>📥 엑셀출력</button>
        <button onClick={() => window.print()}>🖨 프린트출력</button>
      </div>
      <div className="bt-wrap">
        <table className="bt-table att-day">
          <thead>
            <tr><th>NO</th><th>반</th><th>부</th><th>학교</th><th>학년</th><th>이름</th><th>상태</th><th>부모1</th><th>부모2</th><th>등원</th><th>하원</th><th>비고</th></tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const p1 = parent(r.s.id, 0), p2 = parent(r.s.id, 1)
              return (
                <tr key={r.s.id}>
                  <td>{i + 1}</td>
                  <td>{r.s.group_name}</td>
                  <td>{sessionName(r.s)}{r.s.session_no && SESSION_TIMES[r.s.session_no] ? <div className="muted tiny">{SESSION_TIMES[r.s.session_no]}</div> : null}</td>
                  <td>{(r.s.school ?? '').replace(/등학교$/, '')}</td>
                  <td>{r.s.grade}</td>
                  <td className="bt-name">{r.s.name}</td>
                  <td>
                    <select className={`att-sel att-${r.st}`} disabled={busy === r.s.id} value={r.st} onChange={(e) => change(r.s, e.target.value as DayStatus)}>
                      {(Object.keys(ST) as DayStatus[]).map((k) => <option key={k} value={k}>{ST[k]}</option>)}
                    </select>
                  </td>
                  <td>{p1 ? <>{p1.name || p1.relation}{linked.has(r.s.id) && <span className="app-dot" title="앱 연결됨"> 📱</span>}</> : <span className="muted">-</span>}</td>
                  <td>{p2 ? p2.name || p2.relation : <span className="muted">-</span>}</td>
                  <td>{r.inAt ? kstTime(r.inAt) : ''}</td>
                  <td>{r.outAt ? kstTime(r.outAt) : ''}</td>
                  <td className="att-note">{r.reason ?? ''}</td>
                </tr>
              )
            })}
            {!rows.length && <tr><td colSpan={12} className="muted center">해당하는 학생이 없어요.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}

/* ---------------- 월별 ---------------- */

type Cell = 'in' | AbsKind | 'off' | 'future' | 'miss'

export function MonthlyBook({ students: all, onOpenDay }: { students: Student[]; onOpenDay(d: string): void }): JSX.Element {
  const students = (all as StudentFull[]).filter((s) => s.active)
  const [month, setMonth] = useKeep('att-month', kstToday().slice(0, 7))
  const [att, setAtt] = useState<Att[]>([])
  const [abs, setAbs] = useState<Abs[]>([])
  const [loaded, setLoaded] = useState(false)
  const f = useFilters(students)

  const days = useMemo(() => {
    const out: string[] = []
    for (let d = `${month}-01`; d.startsWith(month); d = addDays(d, 1)) out.push(d)
    return out
  }, [month])
  const shift = (n: number): void => {
    const [y, m] = month.split('-').map(Number)
    const t = new Date(Date.UTC(y, m - 1 + n, 1))
    setMonth(`${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`)
  }

  const [reload, setReload] = useState(0)
  const [cellEdit, setCellEdit] = useState<{ s: StudentFull; d: string } | null>(null)
  useEffect(() => {
    setLoaded(false)
    const end = addDays(days[days.length - 1], 1)
    ;(async () => {
      // 한 달 치는 많을 수 있어 나눠 받기
      const rows: Att[] = []
      for (let from = 0; ; from += 1000) {
        const { data } = await supabase.from('attendance').select('id,student_id,kind,at').eq('kind', 'in')
          .gte('at', startIso(days[0])).lt('at', startIso(end)).order('at').range(from, from + 999)
        rows.push(...((data as Att[]) ?? []))
        if (!data || data.length < 1000) break
      }
      const { data: b } = await supabase.from('absences').select('*').gte('date', days[0]).lt('date', end)
      setAtt(rows)
      setAbs((b as Abs[]) ?? [])
      setLoaded(true)
    })()
  }, [days, reload])

  const present = useMemo(() => {
    const m = new Map<string, Set<string>>()
    for (const r of att) {
      const k = r.student_id
      if (!m.has(k)) m.set(k, new Set())
      m.get(k)!.add(kstDay(r.at))
    }
    return m
  }, [att])
  const absent = useMemo(() => new Map(abs.map((a) => [`${a.student_id}|${a.date}`, a])), [abs])
  const today = kstToday()

  const rows = students.filter(f.pass).sort((a, b) => a.name.localeCompare(b.name, 'ko'))
  const cell = (s: StudentFull, d: string): Cell => {
    const ab = absent.get(`${s.id}|${d}`)
    if (ab?.kind === 'early') return 'early'
    if (present.get(s.id)?.has(d)) return 'in'
    if (ab) return ab.kind ?? 'absent'
    if (!attendsOn(s, d)) return 'off'
    if (d > today) return 'future'
    return 'miss'
  }
  const dayTotal = (d: string): number => rows.filter((s) => present.get(s.id)?.has(d)).length

  const exportCsv = (): void => downloadCsv(`강철노트_월별출석부_${month}.csv`, [
    ['반', '이름', '학년', '부', ...days.map((d) => `${Number(d.slice(8))}(${DOW[dowOf(d)]})`), '출석', '결석', '병가', '체험학습', '조퇴'],
    ...rows.map((s) => {
      const cs = days.map((d) => cell(s, d))
      return [s.group_name, s.name, s.grade ?? '', sessionName(s), ...cs.map((c) => (c === 'in' ? '등원' : c === 'off' ? '-' : c in ABS_LABEL ? ABS_LABEL[c as AbsKind] : '')),
        cs.filter((c) => c === 'in' || c === 'early').length, cs.filter((c) => c === 'absent').length, cs.filter((c) => c === 'sick').length, cs.filter((c) => c === 'trip').length, cs.filter((c) => c === 'early').length]
    })
  ])

  return (
    <div className="page attbook">
      <div className="month-nav">
        <button onClick={() => shift(-1)}>◀</button>
        <b>{month.slice(0, 4)}년 {Number(month.slice(5))}월</b>
        <button onClick={() => shift(1)}>▶</button>
      </div>
      <Filters f={f} />
      <div className="bt-actions">
        <span className="muted small">{rows.length}명 · 날짜를 누르면 그날 일별 출석부로 가요{!loaded && ' · 불러오는 중…'}</span>
        <button onClick={exportCsv}>📥 엑셀출력</button>
        <button onClick={() => window.print()}>🖨 출석부 출력</button>
      </div>
      <div className="bt-wrap">
        <table className="bt-table att-month">
          <thead>
            <tr>
              <th className="sticky-col">이름</th><th>반</th><th>학년</th>
              {days.map((d) => {
                const w = dowOf(d)
                return (
                  <th key={d} className={`day-h ${w === 0 ? 'sun' : w === 6 ? 'sat' : ''} ${d === today ? 'today' : ''}`} onClick={() => onOpenDay(d)} title="이날 출석부 보기">
                    {Number(d.slice(8))}<div>{DOW[w]}</div>
                  </th>
                )
              })}
              <th>출석</th><th>결석</th><th>병가</th><th>체험</th><th>조퇴</th>
            </tr>
            <tr className="bt-total">
              <td className="sticky-col">합계</td><td /><td />
              {days.map((d) => <td key={d}>{dayTotal(d) || ''}</td>)}
              <td>{rows.reduce((n, s) => n + (present.get(s.id)?.size ?? 0), 0)}</td><td /><td /><td /><td />
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const cs = days.map((d) => cell(s, d))
              return (
                <tr key={s.id}>
                  <td className="sticky-col bt-name">{s.name}</td>
                  <td>{s.group_name}</td>
                  <td>{s.grade}</td>
                  {cs.map((c, i) => (
                    <td key={days[i]} className="mcell clickable" title="눌러서 이날 상태 바꾸기" onClick={() => setCellEdit({ s, d: days[i] })}>
                      {c === 'in' && <span className="mchip in">등원</span>}
                      {c in ABS_LABEL && <span className={`mchip ${c}`} title={absent.get(`${s.id}|${days[i]}`)?.reason || ABS_LABEL[c as AbsKind]}>{c === 'trip' ? '체험' : ABS_LABEL[c as AbsKind]}</span>}
                      {c === 'off' && <span className="mchip off">-</span>}
                    </td>
                  ))}
                  <td><b>{cs.filter((c) => c === 'in' || c === 'early').length}</b></td>
                  <td className="danger">{cs.filter((c) => c === 'absent').length || ''}</td>
                  <td>{cs.filter((c) => c === 'sick').length || ''}</td>
                  <td>{cs.filter((c) => c === 'trip').length || ''}</td>
                  <td>{cs.filter((c) => c === 'early').length || ''}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="muted small">초록 = 등원 · 빨강 = 결석 · 주황 = 병가 · 보라 = 체험학습 · 파랑 = 조퇴 · 회색 - = 수업 없는 요일(학생 정보의 수업 요일 기준) · 빈칸 = 기록 없음 · <b>칸을 누르면 그날 상태를 바꿀 수 있어요</b></p>
      {cellEdit && (
        <DayCellSheet student={cellEdit.s} date={cellEdit.d} cur={cell(cellEdit.s, cellEdit.d)} reason={absent.get(`${cellEdit.s.id}|${cellEdit.d}`)?.reason ?? ''}
          onClose={() => setCellEdit(null)} onDone={() => { setCellEdit(null); setReload((n) => n + 1) }} />
      )}
    </div>
  )
}

/* ---------------- 월별: 한 칸(학생 × 날짜) 상태 바꾸기 ---------------- */

function DayCellSheet({ student: s, date, cur, reason: oldReason, onClose, onDone }: {
  student: StudentFull; date: string; cur: Cell; reason: string; onClose(): void; onDone(): void
}): JSX.Element {
  const [reason, setReason] = useState(oldReason)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const future = date > kstToday()
  const label = `${Number(date.slice(5, 7))}월 ${Number(date.slice(8))}일(${DOW[dowOf(date)]})`
  const curLabel = cur === 'in' ? '등원' : cur in ABS_LABEL ? `${ABS_LABEL[cur as AbsKind]}${oldReason ? ` · ${oldReason}` : ''}` : cur === 'off' ? '수업 없는 요일' : '기록 없음'

  /** 지난 날짜는 학생 부(시간) 시작·끝 시각으로 기록 (학부모 알림 없음) */
  const timeOf = (k: 'in' | 'out'): string => {
    if (date === kstToday() && k === 'in') return new Date().toISOString()
    if (date === kstToday() && k === 'out') return new Date().toISOString()
    const t = SESSION_TIMES[s.session_no ?? 0]?.split('~')[k === 'in' ? 0 : 1] ?? (k === 'in' ? '15:00' : '16:00')
    return `${date}T${t.padStart(5, '0')}:00+09:00`
  }
  const set = async (to: 'in' | AbsKind | 'none'): Promise<void> => {
    setBusy(true); setErr(null)
    try {
      const { data: rows } = await supabase.from('attendance').select('id,kind').eq('student_id', s.id).gte('at', startIso(date)).lt('at', startIso(addDays(date, 1)))
      const list = (rows as { id: string; kind: 'in' | 'out' }[]) ?? []
      await supabase.from('absences').delete().eq('student_id', s.id).eq('date', date)
      if (to === 'absent' || to === 'sick' || to === 'trip' || to === 'none') {
        if (list.length) {
          const { error } = await supabase.from('attendance').delete().in('id', list.map((r) => r.id))
          if (error) throw error
        }
      }
      if (to === 'in' || to === 'early') {
        const add: object[] = []
        if (!list.some((r) => r.kind === 'in')) add.push({ org_id: s.org_id, student_id: s.id, kind: 'in', at: timeOf('in'), source: 'staff' })
        if (to === 'early' && !list.some((r) => r.kind === 'out')) add.push({ org_id: s.org_id, student_id: s.id, kind: 'out', at: timeOf('out'), source: 'staff' })
        if (add.length) {
          const { error } = await supabase.from('attendance').insert(add)
          if (error) throw error
        }
      }
      if (to !== 'in' && to !== 'none') {
        const { error } = await supabase.from('absences').insert({ org_id: s.org_id, student_id: s.id, date, reason: reason.trim(), kind: to })
        if (error) throw error
      }
      onDone()
    } catch (e) {
      setErr('저장 실패: ' + absErr(e))
    } finally {
      setBusy(false)
    }
  }
  const opt = (k: 'in' | AbsKind, icon: string, text: string, disabled = false): JSX.Element => (
    <button className={`cell-opt ${k} ${cur === k ? 'on' : ''}`} disabled={busy || disabled} onClick={() => set(k)}>{icon} {text}</button>
  )
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head"><h2>{s.name} · {label}</h2><button className="ghost" onClick={onClose}>✕</button></div>
        <div className="form">
          <p className="small">지금 상태: <b>{curLabel}</b></p>
          <label>사유 <span className="hint">(먼저 적고 아래 상태를 누르세요, 비워도 돼요)</span>
            <input placeholder="예: 감기, 가족여행, 병원" value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="cell-grid">
            {opt('in', '✅', '등원(출석)', future)}
            {opt('early', '🏃', '조퇴', future)}
            {opt('absent', '🚫', '결석')}
            {opt('sick', '🤒', '병가')}
            {opt('trip', '🎒', '체험학습')}
            <button className="cell-opt none" disabled={busy || cur === 'off' || cur === 'miss' || cur === 'future'} onClick={() => {
              if ((cur === 'in' || cur === 'early') && !window.confirm('이날 등·하원 기록을 지울까요?')) return
              set('none')
            }}>⬜ 기록 없음</button>
          </div>
          {future && <p className="muted tiny">앞으로 올 날짜는 등원·조퇴로 바꿀 수 없어요. 결석·병가·체험학습(미리 알림)은 가능해요.</p>}
          {date !== kstToday() && <p className="muted tiny">지난 날짜 등원은 그 학생 부 시간으로 기록돼요. (학부모 알림은 가지 않아요)</p>}
          {err && <div className="error">{err}</div>}
        </div>
      </div>
    </div>
  )
}
