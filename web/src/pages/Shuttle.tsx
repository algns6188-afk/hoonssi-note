import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase, errText, type Member, type Student } from '../supabase'
import { DriverMode, PickMap, RequestSheet, RouteView, usePlace, useTrips } from './ShuttleLive'
import { addressQuery, geocode } from '../mapAdapter'

/* ---------------- 데이터 ---------------- */

export interface Vehicle { id: string; name: string; plate: string; capacity: number; active: boolean }
export interface Stop { id: string; name: string; parent_name?: string | null; address: string; wait_note: string; lat: number | null; lng: number | null; active: boolean }
/** 정류장 이름: 학부모 화면이면 학부모용 이름(없으면 관리자 이름과 같음) */
export const stopLabel = (s: Stop | undefined, parent?: boolean): string => (s ? (parent && s.parent_name ? s.parent_name : s.name) : '')
export interface Run {
  id: string; vehicle_id: string | null; name: string; session_no: number | null; kind: 'to' | 'from' | 'mixed'
  class_start: string | null; weekdays: string; cutoff_minutes: number; sort: number; active: boolean
}
export interface RunStop { id: string; run_id: string; stop_id: string; at_time: string; weekdays: string | null; note: string }
export interface Ride { id: string; run_stop_id: string; student_id: string; action: 'board' | 'alight'; weekdays: string | null; note: string }
export interface RideException { id: string; date: string; run_stop_id: string; student_id: string; action: 'board' | 'alight'; type: 'skip' | 'add'; request_id: string | null; note: string }
export interface RideRequest {
  id: string; student_id: string; kind: 'skip' | 'add' | 'change'; scope: 'once' | 'always'; date: string | null
  from_run_stop_id: string | null; to_run_stop_id: string | null; action: 'board' | 'alight'; weekdays: string | null
  reason: string; late: boolean; status: 'pending' | 'approved' | 'rejected' | 'canceled'; created_at: string; decided_at: string | null; decide_note: string
}
export interface ShuttleData {
  vehicles: Vehicle[]; stops: Stop[]; runs: Run[]; runStops: RunStop[]; rides: Ride[]
  exceptions: RideException[]; requests: RideRequest[]; requestsOk: boolean
}
/** 이 요일의 가장 가까운 날짜 (오늘 포함) */
export function nextDateOf(d: string): string {
  const now = new Date(Date.now() + 9 * 3600_000)
  const diff = ('일월화수목금토'.indexOf(d) - now.getUTCDay() + 7) % 7
  return new Date(now.getTime() + diff * 86400_000).toISOString().slice(0, 10)
}
export const dayOfDate = (date: string): string => '일월화수목금토'[new Date(date + 'T00:00:00Z').getUTCDay()]

/** 정류장 탑승 명단 + 바뀐 것 표시: skip(그날 안 탐) · add(그날 추가) · moved(다른 곳으로 옮김/중단, 최근 7일) · new(새로 옮겨옴, 최근 7일) */
export interface RideView { key: string; student_id: string; action: 'board' | 'alight'; tag: '' | 'skip' | 'add' | 'moved' | 'new'; note: string; ride?: Ride; to?: string; toRs?: string }
export function ridersView(data: ShuttleData, rs: RunStop, run: Run, d: string, date: string): RideView[] {
  const recent = (q: RideRequest): boolean => q.status === 'approved' && q.scope === 'always' && !!q.decided_at && Date.now() - Date.parse(q.decided_at) < 7 * 86400_000
  const ex = data.exceptions.filter((e) => e.date === date && e.run_stop_id === rs.id)
  const out: RideView[] = ridersAt(data, rs, run, d).map((r) => {
    const sk = ex.find((e) => e.type === 'skip' && e.student_id === r.student_id && e.action === r.action)
    const nw = data.requests.find((q) => recent(q) && q.to_run_stop_id === rs.id && q.student_id === r.student_id)
    return { key: r.id, student_id: r.student_id, action: r.action, ride: r, tag: sk ? 'skip' : nw ? 'new' : '', note: sk ? sk.note : nw ? nw.reason : '' }
  })
  for (const e of ex.filter((e) => e.type === 'add')) {
    if (!out.some((o) => o.student_id === e.student_id && o.action === e.action)) out.push({ key: e.id, student_id: e.student_id, action: e.action, tag: 'add', note: e.note })
  }
  for (const q of data.requests.filter((q) => recent(q) && q.from_run_stop_id === rs.id && q.kind !== 'add')) {
    if (out.some((o) => o.student_id === q.student_id)) continue
    const to = q.to_run_stop_id ? data.runStops.find((x) => x.id === q.to_run_stop_id) : undefined
    out.push({ key: 'm' + q.id, student_id: q.student_id, action: q.action, tag: 'moved', note: q.reason, toRs: to?.id, to: to ? `${hm(to.at_time)} ${data.stops.find((s) => s.id === to.stop_id)?.name ?? ''}` : '' })
  }
  return out
}
export const activeRide = (v: RideView): boolean => v.tag !== 'skip' && v.tag !== 'moved'

export const DAYS = ['월', '화', '수', '목', '금', '토']
export const hm = (t: string | null): string => (t ? t.slice(0, 5) : '')
export const todayDay = (): string => '일월화수목금토'[new Date(Date.now() + 9 * 3600_000).getUTCDay()]
const has = (list: string | null, d: string): boolean => !list || list.split(',').includes(d)

/** 그 요일에 이 학생이 이 정류장을 이용하는지 */
export function rideOn(r: Ride, rs: RunStop, run: Run, d: string): boolean {
  return (r.weekdays ? r.weekdays.split(',') : rs.weekdays ? rs.weekdays.split(',') : run.weekdays.split(',')).includes(d)
}
/** 그 요일의 운행 정류장 (시간순) */
export function stopsOn(data: ShuttleData, run: Run, d: string, date?: string): RunStop[] {
  return data.runStops
    .filter((rs) => rs.run_id === run.id)
    .filter((rs) => (has(rs.weekdays, d) && has(run.weekdays, d)) || data.rides.some((r) => r.run_stop_id === rs.id && rideOn(r, rs, run, d)) ||
      (!!date && data.exceptions.some((e) => e.date === date && e.run_stop_id === rs.id && e.type === 'add')))
    .sort((a, b) => a.at_time.localeCompare(b.at_time))
}
/** 그 요일 운행 중 한 번에 가장 많이 타고 있는 인원 (도장에서 탄 하원 아이 → 정류장 순서대로 내리고 탐) */
export function peakLoad(data: ShuttleData, run: Run, d: string): number {
  const list = stopsOn(data, run, d)
  const all = list.flatMap((rs) => ridersAt(data, rs, run, d))
  let load = all.filter((r) => r.action === 'alight').length
  let peak = load
  for (const rs of list) {
    const rr = ridersAt(data, rs, run, d)
    load -= rr.filter((r) => r.action === 'alight').length
    load += rr.filter((r) => r.action === 'board').length
    peak = Math.max(peak, load)
  }
  return peak
}

export function ridersAt(data: ShuttleData, rs: RunStop, run: Run, d: string): Ride[] {
  return data.rides.filter((r) => r.run_stop_id === rs.id && rideOn(r, rs, run, d))
}

export async function loadShuttle(): Promise<ShuttleData> {
  const from = new Date(Date.now() + 9 * 3600_000 - 86400_000).toISOString().slice(0, 10)
  const since = new Date(Date.now() - 14 * 86400_000).toISOString()
  const [v, s, r, rs, ra, ex, rq] = await Promise.all([
    supabase.from('vehicles').select('*').order('name'),
    supabase.from('stops').select('*').order('name'),
    supabase.from('runs').select('*').order('sort'),
    supabase.from('run_stops').select('*'),
    supabase.from('ride_assignments').select('*'),
    supabase.from('ride_exceptions').select('*').gte('date', from),
    supabase.from('ride_requests').select('*').or(`status.eq.pending,created_at.gte.${since}`).order('created_at', { ascending: false })
  ])
  return {
    vehicles: (v.data as Vehicle[]) ?? [], stops: (s.data as Stop[]) ?? [], runs: (r.data as Run[]) ?? [],
    runStops: (rs.data as RunStop[]) ?? [], rides: (ra.data as Ride[]) ?? [],
    exceptions: (ex.data as RideException[]) ?? [], requests: (rq.data as RideRequest[]) ?? [], requestsOk: !rq.error
  }
}

const KIND: Record<Run['kind'], string> = { to: '등원', from: '하원', mixed: '하원+등원' }

/* ---------------- 관리자: 차량 탭 ---------------- */

export default function ShuttleTab({ students, member }: { students: Student[]; member: Member }): JSX.Element {
  const [data, setData] = useState<ShuttleData | null>(null)
  const [day, setDay] = useState(DAYS.includes(todayDay()) ? todayDay() : '월')
  const [open, setOpen] = useState<string | null>(null)
  const [edit, setEdit] = useState<{ run: Run; rs: RunStop } | null>(null)
  const [sheet, setSheet] = useState<'stops' | 'vehicle' | null>(null)
  const [q, setQ] = useState('')
  const [driving, setDriving] = useState<Run | null>(null)
  const [changing, setChanging] = useState<RideRequest | 'new' | null>(null)
  const { trips, v9: liveOk } = useTrips()
  const place = usePlace()

  const load = useCallback(async () => setData(await loadShuttle()), [])
  useEffect(() => {
    load()
    const ch = supabase.channel('shuttle-admin')
    for (const t of ['runs', 'run_stops', 'ride_assignments', 'stops', 'vehicles', 'ride_requests', 'ride_exceptions']) ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, () => load())
    ch.subscribe()
    return () => void supabase.removeChannel(ch)
  }, [load])

  const nameOf = useCallback((id: string) => students.find((s) => s.id === id)?.name ?? '?', [students])
  const stopOf = useCallback((id: string) => data?.stops.find((s) => s.id === id), [data])

  // 학생 이름으로 찾기: 그 요일에 어디서 타고 내리는지
  const found = useMemo(() => {
    if (!data || !q.trim()) return []
    const ids = students.filter((s) => s.name.includes(q.trim())).map((s) => s.id)
    return data.rides
      .filter((r) => ids.includes(r.student_id))
      .map((r) => {
        const rs = data.runStops.find((x) => x.id === r.run_stop_id)!
        const run = data.runs.find((x) => x.id === rs.run_id)!
        return { r, rs, run }
      })
      .filter((x) => x.rs && x.run && rideOn(x.r, x.rs, x.run, day))
      .sort((a, b) => a.rs.at_time.localeCompare(b.rs.at_time))
  }, [data, q, students, day])

  if (!data) return <p className="center muted">불러오는 중…</p>
  if (driving) return <DriverMode data={data} run={driving} day={todayDay()} place={place} orgId={member.org_id} onExit={() => setDriving(null)} />
  const isToday = day === todayDay()
  const date = nextDateOf(day)
  const pending = data.requests.filter((q) => q.status === 'pending')
  /** 하루 변경(안 탐·추가) 되돌리기 */
  const undoException = async (v: { student_id: string; tag: string; key: string; action: string }, rsId: string): Promise<void> => {
    const ex = data.exceptions.find((e) => (v.tag === 'add' ? e.id === v.key : e.student_id === v.student_id && e.type === 'skip' && e.date === date && e.run_stop_id === rsId && e.action === v.action))
    if (!ex || !window.confirm(`${nameOf(v.student_id)} ${date.slice(5).replace('-', '/')} ${v.tag === 'skip' ? '안 탐' : '추가'}을 취소하고 원래대로 돌릴까요?`)) return
    const { error } = await supabase.from('ride_exceptions').delete().eq('id', ex.id)
    if (error) return alert('실패: ' + errText(error))
    await supabase.from('timeline').insert({ org_id: member.org_id, kind: 'shuttle', student_id: v.student_id,
      summary: `↩ ${nameOf(v.student_id)} ${date.slice(5).replace('-', '/')} 차량 ${v.tag === 'skip' ? '안 탐' : '추가'} 취소 (원래대로)` })
    load()
  }
  const runs = data.runs.filter((r) => r.active && has(r.weekdays, day))
  const vehicle = data.vehicles[0]

  return (
    <div className="page shuttle">
      <div className="row wrap">
        <div className="pills grow">
          {DAYS.map((d) => <button key={d} className={d === day ? 'pill on' : 'pill'} onClick={() => setDay(d)}>{d}{d === todayDay() ? ' (오늘)' : ''}</button>)}
        </div>
        <button className="ghost small-btn" onClick={() => setSheet('stops')}>📍 정류장 {data.stops.length}</button>
        <button className="ghost small-btn" onClick={() => setSheet('vehicle')}>🚐 {vehicle?.name ?? '차량'}</button>
        {data.requestsOk && <button className="primary small-btn" onClick={() => setChanging('new')}>✏️ 변경 입력</button>}
      </div>
      <p className="muted small">{date.slice(5).replace('-', '/')}({day}) 기준 · 하루 변경(안 탐·추가)과 최근 7일 안에 바뀐 자리가 표시돼요.</p>
      {!data.requestsOk && <p className="notice small">학부모 차량 변경 신청은 Supabase에서 <b>schema-v13-ride-requests.sql</b> 을 실행한 뒤 쓸 수 있어요.</p>}
      <input className="search" placeholder="학생 이름으로 찾기 (그 요일 차량)" value={q} onChange={(e) => setQ(e.target.value)} />
      {q.trim() && (
        <ul className="plain found">
          {found.length === 0 ? <li className="muted small">{day}요일에 차량 이용 기록이 없어요.</li> : found.map(({ r, rs, run }) => (
            <li key={r.id}>
              <b>{nameOf(r.student_id)}</b> · {run.name} · {hm(rs.at_time)} {stopOf(rs.stop_id)?.name} {r.action === 'board' ? '승차' : '하차'}
              <button className="ghost small-btn" onClick={() => setEdit({ run, rs })}>수정</button>
            </li>
          ))}
        </ul>
      )}

      {pending.length > 0 && <RequestsBox data={data} requests={pending} nameOf={nameOf} reload={load} onEdit={(q) => setChanging(q)} />}
      {changing && (
        <RequestSheet data={data} kids={students.filter((s) => s.active).map((s) => ({ id: s.id, name: s.name }))} admin orgId={member.org_id}
          initial={changing === 'new' ? undefined : changing} onClose={() => setChanging(null)} onDone={() => { setChanging(null); load() }} />
      )}

      {(() => {
        const info = runs.map((run) => {
          const list = stopsOn(data, run, day, date)
          const views = list.flatMap((rs) => ridersView(data, rs, run, day, date))
          const riders = views.filter(activeRide)
          return {
            run, list, changed: views.filter((v) => v.tag).length,
            boards: riders.filter((r) => r.action === 'board').length,
            alights: riders.filter((r) => r.action === 'alight').length,
            max: peakLoad(data, run, day),
            trip: isToday ? trips.find((t) => t.run_id === run.id) : undefined
          }
        })
        if (!info.length) return null
        const sel = info.find((x) => x.run.id === open) ?? info.find((x) => x.trip && !x.trip.ended_at) ?? info[0]
        const { run, list, trip } = sel
        return (
          <>
            <div className="run-strip">
              {info.map((x) => {
                const over = vehicle && x.max > vehicle.capacity
                return (
                  <button key={x.run.id} className={`run-tile ${x.run.id === sel.run.id ? 'on' : ''}`} onClick={() => setOpen(x.run.id)}>
                    <span className="run-time">{hm(x.list[0]?.at_time ?? null)}~{hm(x.list.at(-1)?.at_time ?? null)}</span>
                    <b>{x.run.name}</b>
                    <span className="run-tile-chips">
                      <span className="chip">{KIND[x.run.kind]}</span>
                      {x.trip && <span className={`chip ${x.trip.ended_at ? '' : 'live'}`}>{x.trip.ended_at ? '끝' : '● 운행 중'}</span>}
                      {x.changed > 0 && <span className="chip changed">변경 {x.changed}</span>}
                    </span>
                    <span className="small">
                      {x.boards > 0 && <>⬆ {x.boards} </>}{x.alights > 0 && <>⬇ {x.alights}</>}
                    </span>
                    <span className={`tiny ${over ? 'danger' : 'muted'}`}>최대 {x.max}명{over ? ` · 정원 ${vehicle.capacity} 초과` : ''}</span>
                  </button>
                )
              })}
            </div>
            <section className="card run run-detail">
              <div className="run-detail-head">
                <span className="run-time">{hm(list[0]?.at_time ?? null)}~{hm(list.at(-1)?.at_time ?? null)}</span>
                <b>{run.name}</b> <span className="chip">{KIND[run.kind]}</span>
              </div>
            {(
              <div className="live-box">
                {isToday && liveOk && (
                  <button className="primary wide" onClick={() => setDriving(run)}>{trip && !trip.ended_at ? '🚐 운행 화면 열기 (기사님 폰)' : '▶ 운행 시작 (기사님 폰 GPS)'}</button>
                )}
                {!liveOk && <p className="notice small">실시간 위치는 Supabase에서 <b>schema-v12-shuttle-live.sql</b> 을 실행한 뒤 쓸 수 있어요.</p>}
                {isToday && <RouteView data={data} run={run} day={day} trip={trip} place={place} names={(id) => nameOf(id)}
                  onEditStop={(rs) => setEdit({ run, rs })} onUndo={(v, rsId) => undoException(v, rsId)} />}
              </div>
            )}
            {!isToday && (
              <ol className="route">
                {run.kind !== 'to' && <li className="dojang"><span className="rt">출발</span><span>🥋 태권도장 {run.kind === 'mixed' ? '(하원 아이들 승차)' : '승차'}</span></li>}
                {list.map((rs) => {
                  const rr = ridersView(data, rs, run, day, date)
                  const st = stopOf(rs.stop_id)
                  return (
                    <li key={rs.id} onClick={() => setEdit({ run, rs })}>
                      <span className="rt">{hm(rs.at_time)}</span>
                      <div className="grow">
                        <b>{st?.name}</b> {st?.address && <span className="muted small">{st.address}</span>}
                        {rs.weekdays && <span className="chip">{rs.weekdays.replace(/,/g, '')}</span>}
                        <div className="riders">
                          {rr.map((v) => (
                            <span key={v.key} className={`rider ${v.action} ${v.tag ? 'tag-' + v.tag : ''}`} title={v.note}>
                              {v.action === 'board' ? '⬆' : '⬇'} {nameOf(v.student_id)}
                              {v.ride?.weekdays ? <small>({v.ride.weekdays.replace(/,/g, '')})</small> : null}
                              {v.tag === 'skip' && <em>{date.slice(5).replace('-', '/')} 안 탐</em>}
                              {v.tag === 'add' && <em>{date.slice(5).replace('-', '/')} 추가</em>}
                              {(v.tag === 'skip' || v.tag === 'add') && (
                                <button className="undo" title="하루 변경 취소" onClick={(e) => { e.stopPropagation(); undoException(v, rs.id) }}>↩</button>
                              )}
                              {v.tag === 'moved' && <em>{v.to ? `→ ${v.to} 로 변경` : '이용 중단'}</em>}
                              {v.tag === 'new' && <em>새로 변경됨</em>}
                              {v.note && v.tag && <small> · {v.note}</small>}
                              {!v.tag && v.ride?.note && <small> · {v.ride.note}</small>}
                            </span>
                          ))}
                          {rr.length === 0 && <span className="muted small">이 요일엔 타는 아이 없음</span>}
                        </div>
                      </div>
                    </li>
                  )
                })}
                {run.kind !== 'from' && <li className="dojang"><span className="rt">도착</span><span>🥋 태권도장 하차{run.class_start ? ` · 수업 ${hm(run.class_start)}` : ''}</span></li>}
              </ol>
            )}
            </section>
          </>
        )
      })()}
      {runs.length === 0 && <p className="muted center">{day}요일 운행이 없어요.</p>}

      {edit && <RunStopSheet data={data} run={edit.run} rs={edit.rs} students={students} member={member} onClose={() => setEdit(null)} onSaved={load} />}
      {sheet === 'stops' && <StopsSheet data={data} member={member} onClose={() => setSheet(null)} onSaved={load} />}
      {sheet === 'vehicle' && vehicle && <VehicleSheet vehicle={vehicle} onClose={() => setSheet(null)} onSaved={load} />}
    </div>
  )
}

/* ---------------- 정류장 한 곳 수정 (시간·요일·학생) — 사유 필수, 타임라인 기록 ---------------- */

function RunStopSheet({ data, run, rs, students, member, onClose, onSaved }: {
  data: ShuttleData; run: Run; rs: RunStop; students: Student[]; member: Member; onClose(): void; onSaved(): Promise<void>
}): JSX.Element {
  const stop = data.stops.find((s) => s.id === rs.stop_id)
  const orig = data.rides.filter((r) => r.run_stop_id === rs.id)
  const [time, setTime] = useState(hm(rs.at_time))
  const [days, setDays] = useState(rs.weekdays ?? '')
  const [rides, setRides] = useState(orig.map((r) => ({ ...r })))
  const [add, setAdd] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const nameOf = (id: string): string => students.find((s) => s.id === id)?.name ?? '?'
  const cands = add.trim() ? students.filter((s) => s.active && s.name.includes(add.trim()) && !rides.some((r) => r.student_id === s.id)).slice(0, 6) : []
  const defaultAction: Ride['action'] = run.kind === 'to' ? 'board' : 'alight'

  const save = async (): Promise<void> => {
    if (!reason.trim()) return setErr('다른 선생님이 알 수 있게 수정 사유를 적어 주세요.')
    setBusy(true)
    setErr(null)
    const changes: string[] = []
    try {
      if (time !== hm(rs.at_time) || (days || null) !== rs.weekdays) {
        const r = await supabase.from('run_stops').update({ at_time: time, weekdays: days || null }).eq('id', rs.id)
        if (r.error) throw r.error
        if (time !== hm(rs.at_time)) changes.push(`시간 ${hm(rs.at_time)} → ${time}`)
        if ((days || null) !== rs.weekdays) changes.push(`요일 ${rs.weekdays ?? '매일'} → ${days || '매일'}`)
      }
      for (const o of orig.filter((o) => !rides.some((r) => r.id === o.id))) {
        await supabase.from('ride_assignments').delete().eq('id', o.id)
        changes.push(`${nameOf(o.student_id)} 빠짐`)
      }
      for (const r of rides) {
        const o = orig.find((x) => x.id === r.id)
        if (!o) {
          const x = await supabase.from('ride_assignments').insert({ run_stop_id: rs.id, student_id: r.student_id, action: r.action, weekdays: r.weekdays || null })
          if (x.error) throw x.error
          changes.push(`${nameOf(r.student_id)} ${r.action === 'board' ? '승차' : '하차'} 추가${r.weekdays ? `(${r.weekdays})` : ''}`)
        } else if (o.action !== r.action || (o.weekdays ?? '') !== (r.weekdays ?? '')) {
          await supabase.from('ride_assignments').update({ action: r.action, weekdays: r.weekdays || null }).eq('id', r.id)
          changes.push(`${nameOf(r.student_id)} ${o.weekdays ?? '매일'} → ${r.weekdays || '매일'}`)
        }
      }
      if (changes.length) {
        await supabase.from('timeline').insert({
          org_id: member.org_id, kind: 'shuttle',
          summary: `🚐 차량표 수정 · ${run.name} ${hm(rs.at_time)} ${stop?.name}: ${changes.join(', ')} · 사유: ${reason.trim()} — ${member.display_name}`
        })
      }
      await onSaved()
      onClose()
    } catch (e) {
      setErr('저장 실패: ' + errText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Sheet title={`${run.name} · ${stop?.name ?? ''}`} onClose={onClose}>
      <div className="form">
        {stop?.address && <p className="muted small">📍 {stop.address}{stop.wait_note ? ` · ${stop.wait_note}` : ''}</p>}
        <div className="row">
          <label className="grow">도착 시간<input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></label>
          <label className="grow">요일 <span className="hint">(비우면 운행 요일 전체)</span><input value={days} onChange={(e) => setDays(e.target.value.replace(/[^월화수목금토,]/g, ''))} placeholder="예: 월,수,금" /></label>
        </div>
        <h3>타는 아이 · 내리는 아이</h3>
        <ul className="plain">
          {rides.map((r, i) => (
            <li key={r.id ?? `n${i}`} className="item-row">
              <span className="grow">{nameOf(r.student_id)}</span>
              <select value={r.action} onChange={(e) => setRides(rides.map((x, j) => (j === i ? { ...x, action: e.target.value as Ride['action'] } : x)))}>
                <option value="board">⬆ 승차</option><option value="alight">⬇ 하차</option>
              </select>
              <input className="amount" value={r.weekdays ?? ''} placeholder="매일" onChange={(e) => setRides(rides.map((x, j) => (j === i ? { ...x, weekdays: e.target.value.replace(/[^월화수목금토,]/g, '') } : x)))} />
              <button className="ghost small-btn danger" onClick={() => setRides(rides.filter((_, j) => j !== i))}>✕</button>
            </li>
          ))}
        </ul>
        <input placeholder="+ 학생 이름으로 추가" value={add} onChange={(e) => setAdd(e.target.value)} />
        {cands.length > 0 && (
          <div className="pills">
            {cands.map((s) => (
              <button key={s.id} className="pill" onClick={() => { setRides([...rides, { id: '', run_stop_id: rs.id, student_id: s.id, action: defaultAction, weekdays: null, note: '' }]); setAdd('') }}>{s.name}</button>
            ))}
          </div>
        )}
        <label>수정 사유 <span className="hint">(다른 선생님께 공유돼요)</span><input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="예: 학부모 전화 요청" /></label>
        {err && <div className="error">{err}</div>}
        <button className="primary big" disabled={busy} onClick={save}>{busy ? '저장 중…' : '저장'}</button>
      </div>
    </Sheet>
  )
}

/* ---------------- 정류장 목록 ---------------- */

function StopsSheet({ data, member, onClose, onSaved }: { data: ShuttleData; member: Member; onClose(): void; onSaved(): Promise<void> }): JSX.Element {
  const [q, setQ] = useState('')
  const [editing, setEditing] = useState<Stop | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [wait, setWait] = useState('')
  const [pname, setPname] = useState('')
  const [same, setSame] = useState(true)
  const [lat, setLat] = useState<number | null>(null)
  const [lng, setLng] = useState<number | null>(null)
  const [placeOpen, setPlaceOpen] = useState(false)
  const [org, setOrg] = useState<{ lat: number | null; lng: number | null }>({ lat: null, lng: null })
  useEffect(() => {
    supabase.rpc('org_place').then(({ data: d }) => { const p = (d as { lat: number | null; lng: number | null }[] | null)?.[0]; if (p) setOrg(p) })
  }, [])
  // 주소로 위치 자동 찾기
  const [geo, setGeo] = useState<{ done: number; total: number; fails: { s: Stop; why: string }[]; msg?: string } | null>(null)
  const [orgAddr, setOrgAddr] = useState('')
  const near = (ll: [number, number]): boolean => Math.abs(ll[0] - 37.32) < 0.15 && Math.abs(ll[1] - 126.83) < 0.2 // 안산 근처만
  const autoLocate = async (): Promise<void> => {
    const todo = data.stops.filter((x) => x.lat == null)
    const fails: { s: Stop; why: string }[] = []
    setGeo({ done: 0, total: todo.length, fails })
    let ok = 0
    for (let i = 0; i < todo.length; i++) {
      const st = todo[i]
      const q = addressQuery(st.address, st.name)
      if (!q) { fails.push({ s: st, why: '주소 없음' }) } else {
        const r = await geocode(q)
        if (r === 'unavailable') {
          setGeo({ done: i, total: todo.length, fails, msg: '네이버 주소 검색을 쓸 수 없어요. 네이버 클라우드 → Maps → 강철노트 Application 에서 "Geocoding" 도 체크해 주세요.' })
          await onSaved()
          return
        }
        if (!r) fails.push({ s: st, why: '주소를 못 찾음' })
        else if (!near(r)) fails.push({ s: st, why: '안산 밖으로 나옴' })
        else {
          const { error } = await supabase.from('stops').update({ lat: r[0], lng: r[1] }).eq('id', st.id)
          if (error) fails.push({ s: st, why: errText(error) }); else ok++
        }
      }
      setGeo({ done: i + 1, total: todo.length, fails: [...fails] })
    }
    setGeo({ done: todo.length, total: todo.length, fails, msg: `✅ ${ok}곳 위치를 찾았어요.${fails.length ? ` 못 찾은 ${fails.length}곳은 눌러서 지도에서 직접 찍어 주세요.` : ''}` })
    await onSaved()
  }
  const orgByAddr = async (): Promise<void> => {
    const q = addressQuery(orgAddr, '') ?? (orgAddr.trim() ? `경기도 안산시 단원구 ${orgAddr.trim()}` : '')
    if (!q) return
    const r = await geocode(q)
    if (r === 'unavailable') return setErr('네이버 주소 검색을 쓸 수 없어요. 네이버 클라우드에서 "Geocoding" 을 체크해 주세요.')
    if (!r) return setErr('주소를 못 찾았어요. 지도에서 직접 찍어 주세요.')
    await saveOrg(r[0], r[1])
  }
  const saveOrg = async (la: number, ln: number): Promise<void> => {
    setOrg({ lat: la, lng: ln })
    const { error } = await supabase.from('orgs').update({ lat: la, lng: ln }).eq('id', member.org_id)
    if (error) setErr('도장 위치 저장 실패: ' + errText(error))
  }
  const [err, setErr] = useState<string | null>(null)
  const used = (id: string): number => data.runStops.filter((r) => r.stop_id === id).length
  const list = data.stops.filter((s) => !q || [s.name, s.address, s.wait_note].some((x) => x.includes(q)))

  const pick = (s: Stop | null, open = !!s): void => {
    setEditing(s)
    setFormOpen(open)
    setName(s?.name ?? '')
    setAddress(s?.address ?? '')
    setWait(s?.wait_note ?? '')
    setPname(s?.parent_name ?? '')
    setSame(!s?.parent_name)
    setLat(s?.lat ?? null)
    setLng(s?.lng ?? null)
    if (open) window.setTimeout(() => document.querySelector('.sheet')?.scrollTo({ top: 0, behavior: 'smooth' }), 50)
    setErr(null)
  }
  const save = async (): Promise<void> => {
    if (!name.trim()) return setErr('정류장 이름을 적어 주세요.')
    if (!same && !pname.trim()) return setErr('학부모에게 보일 이름을 적거나 "관리자 이름과 같음"을 체크해 주세요.')
    const row = { name: name.trim(), parent_name: same ? null : pname.trim(), address: address.trim(), wait_note: wait.trim(), lat, lng }
    const r = editing?.id
      ? await supabase.from('stops').update(row).eq('id', editing.id)
      : await supabase.from('stops').insert({ ...row, org_id: member.org_id })
    if (r.error) return setErr(/duplicate|unique/i.test(r.error.message) ? '같은 이름의 정류장이 있어요.'
      : /parent_name/.test(r.error.message) ? '학부모용 이름은 Supabase에서 schema-v15-stop-parent-name.sql 을 실행한 뒤 쓸 수 있어요.' : errText(r.error))
    await onSaved()
    pick(null)
  }

  return (
    <Sheet title="📍 정류장" onClose={onClose}>
      <div className="form">
        <button className="ghost" onClick={() => setPlaceOpen(!placeOpen)}>🥋 도장 위치 {org.lat != null ? '✓' : '(지정 안 됨)'} {placeOpen ? '▲' : '▼'}</button>
        {placeOpen && (
          <>
            <div className="row">
              <input className="grow" placeholder="도장 주소 (예: 원곡로 45)" value={orgAddr} onChange={(e) => setOrgAddr(e.target.value)} />
              <button className="small-btn" onClick={orgByAddr}>주소로 찾기</button>
            </div>
            <PickMap key={`${org.lat}`} lat={org.lat} lng={org.lng} onPick={saveOrg} />
          </>
        )}
        {(() => {
          const missing = data.stops.filter((x) => x.lat == null).length
          return (
            <div className="geo-box">
              <div className="small"><b>📍 지도 위치</b> {data.stops.length - missing}/{data.stops.length}곳 지정됨</div>
              {missing > 0 && !geo && <button className="primary" onClick={autoLocate}>주소로 위치 자동 찾기 ({missing}곳)</button>}
              {geo && geo.done < geo.total && !geo.msg && <div className="small">찾는 중… {geo.done}/{geo.total}</div>}
              {geo?.msg && <div className={geo.msg.startsWith('✅') ? 'notice-ok small' : 'error'}>{geo.msg}</div>}
              {geo && geo.fails.length > 0 && (
                <ul className="plain geo-fails">
                  {geo.fails.map(({ s: st, why }) => (
                    <li key={st.id} onClick={() => pick(st)}><b>{st.name}</b> <span className="muted small">{st.address || ''} · {why}</span> <span className="small">→ 지도에서 찍기</span></li>
                  ))}
                </ul>
              )}
            </div>
          )
        })()}
        {formOpen ? (
          <>
            <label>관리자용 이름 <span className="muted small">(차량표·기사님 화면)</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label className="check"><input type="checkbox" checked={same} onChange={(e) => setSame(e.target.checked)} /><span>학부모에게도 같은 이름으로 보이기</span></label>
            {!same && (
              <label>학부모용 이름 <span className="muted small">(학부모 앱 노선도·지도·신청 화면)</span>
                <input value={pname} onChange={(e) => setPname(e.target.value)} placeholder="예: 원곡초 정문 앞 큰길" />
              </label>
            )}
            <label>주소<input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="원선로47" /></label>
            <label>대기 위치<input value={wait} onChange={(e) => setWait(e.target.value)} placeholder="예: 정문 앞 편의점 쪽" /></label>
            <div className="small"><b>지도 위치</b> {lat != null ? <span className="ok">✓ 지정됨</span> : <span className="muted">없음 (학부모 지도·자동 "지남" 표시에 필요)</span>}</div>
            <PickMap key={editing?.id ?? 'new'} lat={lat} lng={lng} onPick={(a, b) => { setLat(a); setLng(b) }} />
            {err && <div className="error">{err}</div>}
            <div className="row"><button className="primary grow" onClick={save}>저장</button><button className="ghost" onClick={() => pick(null)}>취소</button></div>
          </>
        ) : (
          <button onClick={() => pick(null, true)}>+ 정류장 추가</button>
        )}
        <input className="search" placeholder="정류장 이름·주소 검색" value={q} onChange={(e) => setQ(e.target.value)} />
        <ul className="plain">
          {list.map((s) => (
            <li key={s.id} className="item-row" onClick={() => pick(s)}>
              <span className="grow"><b>{s.name}</b>{s.parent_name && <span className="small pname"> 👪 {s.parent_name}</span>} <span className="muted small">{s.address || '주소 없음'}</span>{s.lat == null && <span className="chip">지도 ✗</span>}</span>
              <span className="small muted">운행 {used(s.id)}</span>
            </li>
          ))}
        </ul>
      </div>
    </Sheet>
  )
}

function VehicleSheet({ vehicle, onClose, onSaved }: { vehicle: Vehicle; onClose(): void; onSaved(): Promise<void> }): JSX.Element {
  const [name, setName] = useState(vehicle.name)
  const [plate, setPlate] = useState(vehicle.plate)
  const [cap, setCap] = useState(String(vehicle.capacity))
  const [err, setErr] = useState<string | null>(null)
  const save = async (): Promise<void> => {
    const r = await supabase.from('vehicles').update({ name: name.trim(), plate: plate.trim(), capacity: Number(cap) || 15 }).eq('id', vehicle.id)
    if (r.error) return setErr(errText(r.error))
    await onSaved()
    onClose()
  }
  return (
    <Sheet title="🚐 차량" onClose={onClose}>
      <div className="form">
        <label>이름<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>차량 번호<input value={plate} onChange={(e) => setPlate(e.target.value)} placeholder="경기 12가 3456" /></label>
        <label>정원 (아이 기준)<input inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value.replace(/\D/g, ''))} /></label>
        {err && <div className="error">{err}</div>}
        <button className="primary big" onClick={save}>저장</button>
      </div>
    </Sheet>
  )
}

function Sheet({ title, onClose, children }: { title: string; onClose(): void; children: React.ReactNode }): JSX.Element {
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

/* ---------------- 학생 화면용: 이 학생의 차량 이용 요약 ---------------- */

export function StudentRides({ studentId }: { studentId: string }): JSX.Element | null {
  const [data, setData] = useState<ShuttleData | null>(null)
  useEffect(() => {
    loadShuttle().then(setData)
  }, [])
  if (!data) return null
  const mine = data.rides.filter((r) => r.student_id === studentId)
  if (!mine.length) return <p className="muted small">차량표에 배정된 운행이 없어요. (🚐 차량 탭에서 정류장을 눌러 추가)</p>
  return (
    <ul className="plain small">
      {DAYS.slice(0, 5).map((d) => {
        const items = mine
          .map((r) => {
            const rs = data.runStops.find((x) => x.id === r.run_stop_id)!
            const run = data.runs.find((x) => x.id === rs?.run_id)!
            return { r, rs, run }
          })
          .filter((x) => x.rs && x.run && rideOn(x.r, x.rs, x.run, d))
          .sort((a, b) => a.rs.at_time.localeCompare(b.rs.at_time))
        return (
          <li key={d}>
            <b>{d}</b>{' '}
            {items.length ? items.map(({ r, rs }) => `${hm(rs.at_time)} ${data.stops.find((s) => s.id === rs.stop_id)?.name} ${r.action === 'board' ? '승차' : '하차'}`).join(' → ') : <span className="muted">이용 없음</span>}
          </li>
        )
      })}
    </ul>
  )
}

/* ---------------- 학부모 차량 변경 신청 → 승인/거절 ---------------- */

export function describeRequest(data: ShuttleData, q: RideRequest, parent = false): { what: string; when: string; from: string; to: string } {
  const label = (id: string | null): string => {
    const rs = id ? data.runStops.find((x) => x.id === id) : undefined
    if (!rs) return ''
    const run = data.runs.find((r) => r.id === rs.run_id)
    return `${run?.name ?? ''} ${hm(rs.at_time)} ${stopLabel(data.stops.find((s) => s.id === rs.stop_id), parent)}`
  }
  return {
    what: q.kind === 'skip' ? '🚫 안 탐' : q.kind === 'add' ? '✅ 탑승' : '🔄 장소 변경',
    when: q.scope === 'once' ? `${q.date?.slice(5).replace('-', '/')}(${q.date ? dayOfDate(q.date) : ''}) 하루` : `계속${q.weekdays ? ` (${q.weekdays.replace(/,/g, '')})` : ''}`,
    from: label(q.from_run_stop_id),
    to: label(q.to_run_stop_id) + (q.kind === 'add' ? (q.action === 'board' ? ' 승차' : ' 하차') : '')
  }
}

function RequestsBox({ data, requests, nameOf, reload, onEdit }: { data: ShuttleData; requests: RideRequest[]; nameOf(id: string): string; reload(): Promise<void>; onEdit(q: RideRequest): void }): JSX.Element {
  const [busy, setBusy] = useState<string | null>(null)
  const vehicle = data.vehicles[0]
  const decide = async (q: RideRequest, ok: boolean): Promise<void> => {
    let note = ''
    if (!ok) {
      const r = window.prompt('거절 사유 (학부모에게 보여요, 비워도 돼요)', '')
      if (r === null) return
      note = r
    } else if (q.to_run_stop_id && vehicle) {
      // 정원 확인: 그날(또는 그 요일) 최대 인원 + 1
      const rs = data.runStops.find((x) => x.id === q.to_run_stop_id)
      const run = rs && data.runs.find((r) => r.id === rs.run_id)
      const d = q.date ? dayOfDate(q.date) : todayDay()
      if (run && peakLoad(data, run, d) + 1 > vehicle.capacity &&
        !window.confirm(`${run.name} 정원(${vehicle.capacity}명)을 넘을 수 있어요. 그래도 승인할까요?`)) return
    }
    setBusy(q.id)
    const { data: r, error } = await supabase.rpc('decide_ride_request', { p_id: q.id, p_ok: ok, p_note: note })
    setBusy(null)
    const e = error ? errText(error) : (r as { error?: string })?.error
    if (e) alert('처리 실패: ' + (e === 'already' ? '이미 처리된 신청이에요.' : e))
    await reload()
  }
  return (
    <section className="card req-box">
      <h3>📮 학부모 차량 변경 신청 {requests.length}건</h3>
      <ul className="plain">
        {requests.map((q) => {
          const d = describeRequest(data, q)
          return (
            <li key={q.id} className="req-row">
              <div className="grow">
                <b>{nameOf(q.student_id)}</b> <span className="chip">{d.what}</span> <span className="small">{d.when}</span>
                {q.late && <span className="chip danger">마감 후</span>}
                <div className="small">
                  {d.from && <span className="req-from">{d.from}</span>}
                  {d.from && d.to && ' → '}
                  {d.to && <b className="req-to">{d.to}</b>}
                </div>
                {q.reason && <div className="muted small">사유: {q.reason}</div>}
              </div>
              <div className="col">
                <button className="primary small-btn" disabled={busy === q.id} onClick={() => decide(q, true)}>승인</button>
                <button className="ghost small-btn" disabled={busy === q.id} onClick={() => onEdit(q)}>수정</button>
                <button className="ghost small-btn" disabled={busy === q.id} onClick={() => decide(q, false)}>거절</button>
              </div>
            </li>
          )
        })}
      </ul>
      <p className="muted tiny">승인하면 차량표에 바로 반영되고, 바뀐 자리에 표시돼요. (하루 변경은 그날만, "계속"은 차량표 자체가 바뀜)</p>
    </section>
  )
}
