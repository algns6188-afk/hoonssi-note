import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase, errText, type Member, type Student } from '../supabase'
import { DriverMode, PickMap, RouteView, usePlace, useTrips } from './ShuttleLive'

/* ---------------- 데이터 ---------------- */

export interface Vehicle { id: string; name: string; plate: string; capacity: number; active: boolean }
export interface Stop { id: string; name: string; address: string; wait_note: string; lat: number | null; lng: number | null; active: boolean }
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
export interface RideView { key: string; student_id: string; action: 'board' | 'alight'; tag: '' | 'skip' | 'add' | 'moved' | 'new'; note: string; ride?: Ride; to?: string }
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
    out.push({ key: 'm' + q.id, student_id: q.student_id, action: q.action, tag: 'moved', note: q.reason, to: to ? `${hm(to.at_time)} ${data.stops.find((s) => s.id === to.stop_id)?.name ?? ''}` : '' })
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

      {pending.length > 0 && <RequestsBox data={data} requests={pending} nameOf={nameOf} reload={load} />}

      {runs.map((run) => {
        const list = stopsOn(data, run, day, date)
        const riders = list.flatMap((rs) => ridersView(data, rs, run, day, date)).filter(activeRide)
        const changed = list.flatMap((rs) => ridersView(data, rs, run, day, date)).filter((v) => v.tag).length
        const boards = riders.filter((r) => r.action === 'board').length
        const alights = riders.filter((r) => r.action === 'alight').length
        const onBoardMax = peakLoad(data, run, day)
        const over = vehicle && onBoardMax > vehicle.capacity
        const trip = isToday ? trips.find((t) => t.run_id === run.id) : undefined
        return (
          <section key={run.id} className="card run">
            <button className="run-head" onClick={() => setOpen(open === run.id ? null : run.id)}>
              <span className="run-time">{hm(list[0]?.at_time ?? null)}~{hm(list.at(-1)?.at_time ?? null)}</span>
              <span className="grow"><b>{run.name}</b> <span className="chip">{KIND[run.kind]}</span>
                {trip && <span className={`chip ${trip.ended_at ? '' : 'live'}`}>{trip.ended_at ? '운행 끝' : '● 운행 중'}</span>}
                {changed > 0 && <span className="chip changed">변경 {changed}</span>}</span>
              <span className="small">
                {boards > 0 && <>⬆ {boards} </>}{alights > 0 && <>⬇ {alights}</>}
                <span className={over ? 'danger' : 'muted'}> · 최대 {onBoardMax}명{over ? ` (정원 ${vehicle.capacity} 초과)` : ''}</span>
              </span>
              <span className="muted">{open === run.id ? '▲' : '▼'}</span>
            </button>
            {open === run.id && (
              <div className="live-box">
                {isToday && liveOk && (
                  <button className="primary wide" onClick={() => setDriving(run)}>{trip && !trip.ended_at ? '🚐 운행 화면 열기 (기사님 폰)' : '▶ 운행 시작 (기사님 폰 GPS)'}</button>
                )}
                {!liveOk && <p className="notice small">실시간 위치는 Supabase에서 <b>schema-v12-shuttle-live.sql</b> 을 실행한 뒤 쓸 수 있어요.</p>}
                {isToday && <RouteView data={data} run={run} day={day} trip={trip} place={place} names={(id) => nameOf(id)} />}
              </div>
            )}
            {open === run.id && (
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
        )
      })}
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
  const [lat, setLat] = useState<number | null>(null)
  const [lng, setLng] = useState<number | null>(null)
  const [placeOpen, setPlaceOpen] = useState(false)
  const [org, setOrg] = useState<{ lat: number | null; lng: number | null }>({ lat: null, lng: null })
  useEffect(() => {
    supabase.rpc('org_place').then(({ data: d }) => { const p = (d as { lat: number | null; lng: number | null }[] | null)?.[0]; if (p) setOrg(p) })
  }, [])
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
    setLat(s?.lat ?? null)
    setLng(s?.lng ?? null)
    setErr(null)
  }
  const save = async (): Promise<void> => {
    if (!name.trim()) return setErr('정류장 이름을 적어 주세요.')
    const row = { name: name.trim(), address: address.trim(), wait_note: wait.trim(), lat, lng }
    const r = editing?.id
      ? await supabase.from('stops').update(row).eq('id', editing.id)
      : await supabase.from('stops').insert({ ...row, org_id: member.org_id })
    if (r.error) return setErr(/duplicate|unique/i.test(r.error.message) ? '같은 이름의 정류장이 있어요.' : errText(r.error))
    await onSaved()
    pick(null)
  }

  return (
    <Sheet title="📍 정류장" onClose={onClose}>
      <div className="form">
        <button className="ghost" onClick={() => setPlaceOpen(!placeOpen)}>🥋 도장 위치 {org.lat != null ? '✓' : '(지정 안 됨)'} {placeOpen ? '▲' : '▼'}</button>
        {placeOpen && <PickMap lat={org.lat} lng={org.lng} onPick={saveOrg} />}
        {formOpen ? (
          <>
            <label>이름<input value={name} onChange={(e) => setName(e.target.value)} /></label>
            <label>주소<input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="원선로47" /></label>
            <label>대기 위치<input value={wait} onChange={(e) => setWait(e.target.value)} placeholder="예: 정문 앞 편의점 쪽" /></label>
            <div className="small"><b>지도 위치</b> {lat != null ? <span className="ok">✓ 지정됨</span> : <span className="muted">없음 (학부모 지도·자동 "지남" 표시에 필요)</span>}</div>
            <PickMap lat={lat} lng={lng} onPick={(a, b) => { setLat(a); setLng(b) }} />
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
              <span className="grow"><b>{s.name}</b> <span className="muted small">{s.address || '주소 없음'}</span>{s.lat == null && <span className="chip">지도 ✗</span>}</span>
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

export function describeRequest(data: ShuttleData, q: RideRequest): { what: string; when: string; from: string; to: string } {
  const label = (id: string | null): string => {
    const rs = id ? data.runStops.find((x) => x.id === id) : undefined
    if (!rs) return ''
    const run = data.runs.find((r) => r.id === rs.run_id)
    return `${run?.name ?? ''} ${hm(rs.at_time)} ${data.stops.find((s) => s.id === rs.stop_id)?.name ?? ''}`
  }
  return {
    what: q.kind === 'skip' ? '🚫 안 탐' : q.kind === 'add' ? '✅ 탑승' : '🔄 장소 변경',
    when: q.scope === 'once' ? `${q.date?.slice(5).replace('-', '/')}(${q.date ? dayOfDate(q.date) : ''}) 하루` : `계속${q.weekdays ? ` (${q.weekdays.replace(/,/g, '')})` : ''}`,
    from: label(q.from_run_stop_id),
    to: label(q.to_run_stop_id) + (q.kind === 'add' ? (q.action === 'board' ? ' 승차' : ' 하차') : '')
  }
}

function RequestsBox({ data, requests, nameOf, reload }: { data: ShuttleData; requests: RideRequest[]; nameOf(id: string): string; reload(): Promise<void> }): JSX.Element {
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
