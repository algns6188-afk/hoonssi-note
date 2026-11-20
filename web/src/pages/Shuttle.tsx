import { useCallback, useEffect, useMemo, useState } from 'react'
import { useKeep } from '../keep'
import { supabase, errText, type Member, type Student } from '../supabase'
import { AreaEditor, DriverMode, PickMap, placeSearch, RequestSheet, RouteView, usePlace, useTrips } from './ShuttleLive'
import { addressQuery, geocode, type Area } from '../mapAdapter'

/* ---------------- 데이터 ---------------- */

export interface Vehicle { id: string; name: string; plate: string; capacity: number; active: boolean; gps_token?: string | null; gps_last_at?: string | null; last_device_id?: string | null }
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
  areas: Area[]; areasOk: boolean
  devices: Device[]   // 차량 위치 기기 (직원만 보임)
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
  const [v, s, r, rs, ra, ex, rq, ar, dv] = await Promise.all([
    supabase.from('vehicles').select('*').order('name'),
    supabase.from('stops').select('*').order('name'),
    supabase.from('runs').select('*').order('sort'),
    supabase.from('run_stops').select('*'),
    supabase.from('ride_assignments').select('*'),
    supabase.from('ride_exceptions').select('*').gte('date', from),
    supabase.from('ride_requests').select('*').or(`status.eq.pending,created_at.gte.${since}`).order('created_at', { ascending: false }),
    supabase.from('shuttle_areas').select('*').order('created_at'),
    supabase.from('vehicle_devices').select('*').order('created_at')
  ])
  return {
    vehicles: (v.data as Vehicle[]) ?? [], stops: (s.data as Stop[]) ?? [], runs: (r.data as Run[]) ?? [],
    runStops: (rs.data as RunStop[]) ?? [], rides: (ra.data as Ride[]) ?? [],
    exceptions: (ex.data as RideException[]) ?? [], requests: (rq.data as RideRequest[]) ?? [], requestsOk: !rq.error,
    areas: (ar.data as Area[]) ?? [], areasOk: !ar.error,
    devices: dv.error ? [] : (dv.data as Device[]) ?? []
  }
}

const KIND: Record<Run['kind'], string> = { to: '등원', from: '하원', mixed: '하원+등원' }

/* ---------------- 관리자: 차량 탭 ---------------- */

export default function ShuttleTab({ students, member }: { students: Student[]; member: Member }): JSX.Element {
  const [data, setData] = useState<ShuttleData | null>(null)
  const [day, setDay] = useKeep('sh-day', DAYS.includes(todayDay()) ? todayDay() : '월')
  const [open, setOpen] = useKeep<string | null>('sh-open', null)
  const [edit, setEdit] = useState<{ run: Run; rs: RunStop } | null>(null)
  const [sheet, setSheet] = useState<'stops' | 'vehicle' | null>(null)
  const [q, setQ] = useState('')
  const [drivingId, setDrivingId] = useKeep<string | null>('sh-driving', null)   // 운행 화면은 앱이 새로 열려도 그대로
  const [changing, setChanging] = useState<RideRequest | 'new' | null>(null)
  const { trips, v9: liveOk } = useTrips()
  const place = usePlace()

  const load = useCallback(async () => setData(await loadShuttle()), [])
  useEffect(() => {
    load()
    const ch = supabase.channel('shuttle-admin')
    for (const t of ['runs', 'run_stops', 'ride_assignments', 'stops', 'vehicles', 'ride_requests', 'ride_exceptions', 'vehicle_devices']) ch.on('postgres_changes', { event: '*', schema: 'public', table: t }, () => load())
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
  const driving = data.runs.find((r) => r.id === drivingId) ?? null
  if (driving) return <DriverMode data={data} run={driving} day={todayDay()} place={place} orgId={member.org_id} onExit={() => setDrivingId(null)} />
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
      <div className="toolbar">
        {data.requestsOk && <button className="primary" onClick={() => setChanging('new')}>✏️ 차량 변경 입력</button>}
        <button onClick={() => setSheet('stops')}>📍 정류장 {data.stops.length}</button>
        <button className="tool-sub" onClick={() => setSheet('vehicle')}>🚐 차량 · 위치 기기</button>
      </div>
      <div className="pills day-pills">
        {DAYS.map((d) => <button key={d} className={d === day ? 'pill on' : 'pill'} onClick={() => setDay(d)}>{d}{d === todayDay() ? ' (오늘)' : ''}</button>)}
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
                {isToday && liveOk && (() => {
                  const first = list[0]?.at_time, lastT = list.at(-1)?.at_time
                  const shift = (t: string | undefined, m: number): string => {
                    if (!t) return ''
                    const [h, mi] = t.split(':').map(Number); const x = h * 60 + mi + m
                    return `${String(Math.floor(((x % 1440) + 1440) % 1440 / 60)).padStart(2, '0')}:${String(((x % 60) + 60) % 60).padStart(2, '0')}`
                  }
                  // 하원 운행은 그 부 수업 끝나기 5분 전 시작
                  const SESSION_END: Record<number, string> = { 1: '15:00', 2: '16:30', 3: '18:00', 4: '19:00', 5: '21:00', 6: '22:00' }
                  const endT = run.kind !== 'to' && run.session_no ? SESSION_END[run.session_no] : undefined
                  const startBase = endT && (!first || endT < first.slice(0, 5)) ? endT : first
                  const running = !!trip && !trip.ended_at
                  const tripCall = async (fn: 'trip_start' | 'trip_end', device?: Device): Promise<void> => {
                    if (fn === 'trip_end' && !window.confirm(`${run.name} 운행을 끝낼까요? 학부모 화면에서 차량 위치가 사라져요.`)) return
                    let { error } = await supabase.rpc(fn, fn === 'trip_start' && device ? { p_run: run.id, p_device: device.id } : { p_run: run.id })
                    if (error && device && /p_device|function/.test(error.message)) {
                      alert('기기를 골라 시작하려면 Supabase에서 schema-v23-trip-device.sql 을 실행해 주세요. 지금은 기기 지정 없이 시작할게요.')
                      ;({ error } = await supabase.rpc(fn, { p_run: run.id }))
                    }
                    if (error) alert(/trip_(start|end)/.test(error.message) ? '직접 시작·종료는 Supabase에서 schema-v19-trip-auto-manual.sql 을 실행한 뒤 쓸 수 있어요.' : '실패: ' + errText(error))
                    else if (device) await load()
                  }
                  // 이 운행 차량의 위치 기기들 (마지막으로 GPS 잡았던 기기가 맨 앞)
                  const vehId = run.vehicle_id ?? (data.vehicles.length === 1 ? data.vehicles[0].id : null)
                  const veh = data.vehicles.find((x) => x.id === vehId)
                  const devs = data.devices.filter((d) => !vehId || d.vehicle_id === vehId)
                    .sort((a, b) => (a.id === veh?.last_device_id ? -1 : b.id === veh?.last_device_id ? 1 : (b.last_at ?? '').localeCompare(a.last_at ?? '')))
                  const lastDev = devs.find((d) => d.id === veh?.last_device_id) ?? null
                  const tripDev = trip?.device_id ? data.devices.find((d) => d.id === trip.device_id) : null
                  return (
                    <div className="trip-ctl">
                      <div className="small">
                        {running
                          ? <><b className="ok">● 운행 중</b>{tripDev && <> · 📡 <b>{tripDev.name}</b></>} <span className="muted">({trip!.manual ? '직접 시작 · 직접 종료할 때까지' : `자동 · ${shift(lastT, 10)}에 자동 종료`})</span></>
                          : trip?.ended_at ? <span className="muted">운행 끝 · 위치 공유 안 함</span>
                            : <span className="muted">자동 시작 {shift(startBase, -5)}{endT ? ` (${run.session_no}부 수업 끝 5분 전)` : ''} · 자동 종료 {shift(lastT, 10)} · {lastDev ? <>📡 <b>{lastDev.name}</b> 기준 (마지막으로 GPS 잡은 기기)</> : '먼저 위치를 보내는 기기 기준'}</span>}
                      </div>
                      {running ? (
                        <div className="row">
                          <button className="danger-btn grow" onClick={() => tripCall('trip_end')}>■ 운행 종료</button>
                          <button className="ghost small-btn" onClick={() => setDrivingId(run.id)}>📱 이 폰으로 위치 보내기</button>
                        </div>
                      ) : (
                        <div className="dev-start">
                          {devs.length > 0 && <span className="tiny muted">어느 기기 GPS로 운행할까요?</span>}
                          {devs.map((d) => (
                            <button key={d.id} className={d.id === lastDev?.id ? 'primary' : ''} onClick={() => tripCall('trip_start', d)}>
                              <span>▶ <b>{d.name}</b>로 운행 시작</span>
                              <span className="tiny">{d.id === lastDev?.id ? '⭐ 마지막 GPS 기기 · ' : ''}{d.kind === 'app' ? 'Traccar 앱' : '웹 화면'} · 마지막 위치 {ago(d.last_at)}{d.enabled ? '' : ' · 위치 비허용 → 시작하면 허용'}</span>
                            </button>
                          ))}
                          <div className="row">
                            {devs.length === 0 && <button className="primary grow" onClick={() => tripCall('trip_start')}>▶ 지금 운행 시작</button>}
                            <button className="ghost small-btn" onClick={() => setDrivingId(run.id)}>📱 이 폰으로 운행 시작</button>
                          </div>
                        </div>
                      )}
                    </div>
                  )
                })()}
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
      {sheet === 'vehicle' && <VehiclesSheet data={data} member={member} onClose={() => setSheet(null)} onSaved={load} />}
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
  // 정류장 정보 수정 (이름·학부모용 이름·주소·대기 위치·지도 위치) / 다른 정류장으로 바꾸기
  const [stopId, setStopId] = useState(rs.stop_id)
  const [stopEdit, setStopEdit] = useState(false)
  const [sf, setSf] = useState({ name: stop?.name ?? '', same: !stop?.parent_name, pname: stop?.parent_name ?? '', address: stop?.address ?? '', wait: stop?.wait_note ?? '', lat: stop?.lat ?? null as number | null, lng: stop?.lng ?? null as number | null })
  const [stopMsg, setStopMsg] = useState<string | null>(null)
  const saveStop = async (): Promise<void> => {
    if (!stop || !sf.name.trim()) return setStopMsg('정류장 이름을 적어 주세요.')
    if (!sf.same && !sf.pname.trim()) return setStopMsg('학부모용 이름을 적거나 "같은 이름"을 체크해 주세요.')
    const { error } = await supabase.from('stops').update({
      name: sf.name.trim(), parent_name: sf.same ? null : sf.pname.trim(), address: sf.address.trim(), wait_note: sf.wait.trim(), lat: sf.lat, lng: sf.lng
    }).eq('id', stop.id)
    if (error) return setStopMsg(/parent_name/.test(error.message) ? '학부모용 이름은 SQL v15 실행 후 쓸 수 있어요.' : /duplicate|unique/i.test(error.message) ? '같은 이름의 정류장이 있어요.' : '저장 실패: ' + errText(error))
    if (sf.name.trim() !== stop.name) {
      await supabase.from('timeline').insert({ org_id: member.org_id, kind: 'shuttle', summary: `📍 정류장 이름 변경: ${stop.name} → ${sf.name.trim()} — ${member.display_name}` })
    }
    setStopMsg('✅ 정류장 정보를 저장했어요. (이 정류장을 쓰는 모든 운행에 반영)')
    setStopEdit(false)
    await onSaved()
  }

  const save = async (): Promise<void> => {
    if (!reason.trim()) return setErr('다른 선생님이 알 수 있게 수정 사유를 적어 주세요.')
    setBusy(true)
    setErr(null)
    const changes: string[] = []
    try {
      if (time !== hm(rs.at_time) || (days || null) !== rs.weekdays || stopId !== rs.stop_id) {
        const r = await supabase.from('run_stops').update({ at_time: time, weekdays: days || null, stop_id: stopId }).eq('id', rs.id)
        if (r.error) throw r.error
        if (stopId !== rs.stop_id) changes.push(`정류장 ${stop?.name} → ${data.stops.find((x) => x.id === stopId)?.name}`)
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
        <div className="rs-stop-box">
          <div className="row">
            <div className="grow">
              <b>📍 {stop?.name}</b>{stop?.parent_name && <span className="small pname"> 👪 {stop.parent_name}</span>}
              <div className="muted small">{stop?.address || '주소 없음'}{stop?.wait_note ? ` · ${stop.wait_note}` : ''}{stop?.lat == null ? ' · 지도 위치 없음' : ''}</div>
            </div>
            <button className="small-btn" onClick={() => { setStopEdit(!stopEdit); setStopMsg(null) }}>{stopEdit ? '닫기' : '✏️ 정류장 수정'}</button>
          </div>
          {stopEdit && (
            <div className="form rs-stop-form">
              <label>관리자용 이름<input value={sf.name} onChange={(e) => setSf({ ...sf, name: e.target.value })} /></label>
              <label className="check"><input type="checkbox" checked={sf.same} onChange={(e) => setSf({ ...sf, same: e.target.checked })} /><span>학부모에게도 같은 이름으로 보이기</span></label>
              {!sf.same && <label>학부모용 이름<input value={sf.pname} onChange={(e) => setSf({ ...sf, pname: e.target.value })} placeholder="예: 원곡초 정문 앞 큰길" /></label>}
              <label>주소<input value={sf.address} onChange={(e) => setSf({ ...sf, address: e.target.value })} placeholder="원선로47" /></label>
              <label>대기 위치<input value={sf.wait} onChange={(e) => setSf({ ...sf, wait: e.target.value })} placeholder="예: 정문 앞 편의점 쪽" /></label>
              <PickMap lat={sf.lat} lng={sf.lng} onPick={(a, b) => setSf((x) => ({ ...x, lat: a, lng: b }))} onAddress={(ad) => setSf((x) => ({ ...x, address: x.address || ad }))} />
              <p className="muted tiny">이 정류장을 쓰는 다른 운행에도 같이 바뀌어요.</p>
              <button className="primary" onClick={saveStop}>정류장 저장</button>
            </div>
          )}
          {stopMsg && <div className={stopMsg.startsWith('✅') ? 'notice-ok small' : 'error'}>{stopMsg}</div>}
          <label className="small">이 운행에서 다른 정류장으로 바꾸기
            <select value={stopId} onChange={(e) => setStopId(e.target.value)}>
              {data.stops.filter((x) => x.active || x.id === rs.stop_id).map((x) => <option key={x.id} value={x.id}>{x.name}{x.id === rs.stop_id ? ' (지금)' : ''}</option>)}
            </select>
          </label>
        </div>
        <div className="row">
          <label className="grow">도착 시간<input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></label>
          <label className="grow">요일 <span className="hint">(비우면 운행 요일 전체)</span><input value={days} onChange={(e) => setDays(e.target.value.replace(/[^월화수목금토,]/g, ''))} placeholder="예: 월,수,금" /></label>
        </div>
        <h3>타는 아이 · 내리는 아이</h3>
        <ul className="plain">
          {rides.map((r, i) => (
            <li key={r.id ?? `n${i}`} className="item-row">
              <span className="grow ride-name">{nameOf(r.student_id)}</span>
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
      if (!q) {
        // 주소가 없으면 장소 이름으로 찾아보기 (이름이 거의 같은 곳만)
        const norm = (x: string): string => x.replace(/\(.*?\)|정문|앞|건너편|건너주기|\s|[^가-힣0-9a-zA-Z]/g, '').toLowerCase()
        const key = norm(st.name)
        const hits = key.length >= 2 ? await placeSearch(st.name.replace(/\(.*?\)/g, '').trim()) : 'unavailable'
        const hit = Array.isArray(hits) ? hits.find((h) => { const n = norm(h.name); return n && (n.includes(key) || key.includes(n)) && near([h.lat, h.lng]) }) : undefined
        if (hit) {
          const { error } = await supabase.from('stops').update({ lat: hit.lat, lng: hit.lng, address: st.address || hit.address.replace(/^경기도?\s*안산시\s*(단원구|상록구)?\s*/, '') }).eq('id', st.id)
          if (error) fails.push({ s: st, why: errText(error) }); else ok++
        } else fails.push({ s: st, why: Array.isArray(hits) ? '장소를 못 찾음' : '주소 없음' })
      } else {
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
            <PickMap key={editing?.id ?? 'new'} lat={lat} lng={lng} onPick={(a, b) => { setLat(a); setLng(b) }} onAddress={(ad) => setAddress((cur) => cur || ad)} />
            {err && <div className="error">{err}</div>}
            <div className="row"><button className="primary grow" onClick={save}>저장</button><button className="ghost" onClick={() => pick(null)}>취소</button></div>
            {editing?.id && (used(editing.id) === 0 ? (
              <button className="ghost danger" onClick={async () => {
                if (!window.confirm(`"${editing.name}" 정류장을 삭제할까요?`)) return
                const { error } = await supabase.from('stops').delete().eq('id', editing.id)
                if (error) return setErr('삭제 실패: ' + errText(error))
                await onSaved(); pick(null)
              }}>🗑 정류장 삭제</button>
            ) : <p className="muted tiny">운행 {used(editing.id)}곳에서 쓰는 정류장이라 삭제할 수 없어요. 먼저 차량표에서 빼 주세요.</p>)}
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
              <button className="small-btn" onClick={(e) => { e.stopPropagation(); pick(s) }}>✏️ 수정</button>
            </li>
          ))}
        </ul>
      </div>
    </Sheet>
  )
}

export interface Device { id: string; vehicle_id: string; name: string; kind: 'app' | 'web'; token: string; enabled: boolean; last_at: string | null }
const GPS_URL = 'https://gqgeduyjicntceotatku.supabase.co/functions/v1/gps'
export const newDeviceToken = (): string => {
  const a = new Uint8Array(12); crypto.getRandomValues(a)
  return 'kc' + Array.from(a, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 18)
}
const ago = (iso: string | null): string => {
  if (!iso) return '아직 없음'
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000)
  return m < 1 ? '방금' : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.round(m / 60)}시간 전` : `${Math.round(m / 1440)}일 전`
}

/** 차량 관리: 차량별 정보 · 맡는 운행 · 위치 보내는 기기(켬/끔) */
function VehiclesSheet({ data, member, onClose, onSaved }: { data: ShuttleData; member: Member; onClose(): void; onSaved(): Promise<void> }): JSX.Element {
  const [devices, setDevices] = useState<Device[] | null>(null)
  const [open, setOpen] = useState<string | null>(data.vehicles[0]?.id ?? null)
  const [msg, setMsg] = useState<string | null>(null)
  const loadDevices = useCallback(async () => {
    const { data: d, error } = await supabase.from('vehicle_devices').select('*').order('created_at')
    setDevices(error ? null : (d as Device[]) ?? [])
  }, [])
  useEffect(() => { loadDevices() }, [loadDevices])
  const addVehicle = async (): Promise<void> => {
    const n = data.vehicles.length + 1
    const { error } = await supabase.from('vehicles').insert({ org_id: member.org_id, name: `${n}호차`, capacity: 15 })
    if (error) return setMsg('추가 실패: ' + errText(error))
    await onSaved()
  }
  return (
    <Sheet title="🚐 차량 · 위치 기기" onClose={onClose}>
      <div className="form">
        {devices === null && <p className="notice small">위치 기기 관리는 Supabase에서 <b>schema-v22-vehicle-devices.sql</b> 을 실행한 뒤 쓸 수 있어요.</p>}
        {data.vehicles.map((v) => (
          <div key={v.id} className="veh-card">
            <button className="veh-head" onClick={() => setOpen(open === v.id ? null : v.id)}>
              <b>🚐 {v.name}</b> <span className="muted small">{v.plate || '번호 없음'} · 정원 {v.capacity}</span>
              {devices && (() => {
                const last = devices.find((d) => d.vehicle_id === v.id && d.id === v.last_device_id)
                const n = devices.filter((d) => d.vehicle_id === v.id && d.enabled).length
                return <span className={`chip ${n ? 'live' : ''}`}>{last ? `⭐ ${last.name}` : n ? `📡 기기 ${n}대` : '위치 기기 없음'}</span>
              })()}
              <span className="muted">{open === v.id ? '▲' : '▼'}</span>
            </button>
            {open === v.id && <VehicleBody vehicle={v} data={data} devices={devices} member={member} onSaved={async () => { await onSaved(); await loadDevices() }} />}
          </div>
        ))}
        <button onClick={addVehicle}>+ 차량 추가</button>
        {msg && <div className="error">{msg}</div>}
      </div>
    </Sheet>
  )
}

function VehicleBody({ vehicle, data, devices, member, onSaved }: { vehicle: Vehicle; data: ShuttleData; devices: Device[] | null; member: Member; onSaved(): Promise<void> }): JSX.Element {
  const [name, setName] = useState(vehicle.name)
  const [plate, setPlate] = useState(vehicle.plate)
  const [cap, setCap] = useState(String(vehicle.capacity))
  const [msg, setMsg] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const [shown, setShown] = useState<string | null>(null)
  const mine = (devices ?? []).filter((d) => d.vehicle_id === vehicle.id)
  const multi = data.vehicles.length > 1

  const save = async (): Promise<void> => {
    const r = await supabase.from('vehicles').update({ name: name.trim(), plate: plate.trim(), capacity: Number(cap) || 15 }).eq('id', vehicle.id)
    setMsg(r.error ? errText(r.error) : '✅ 저장했어요.')
    await onSaved()
  }
  const addDevice = async (kind: 'app' | 'web'): Promise<void> => {
    const token = newDeviceToken()
    const label = newName.trim() || (kind === 'app' ? `폰 ${mine.length + 1} (Traccar 앱)` : `폰 ${mine.length + 1} (웹 화면)`)
    const { data: d, error } = await supabase.from('vehicle_devices').insert({ org_id: member.org_id, vehicle_id: vehicle.id, name: label, kind, token, enabled: true }).select().single()
    if (error) return setMsg('추가 실패: ' + errText(error))
    if (kind === 'web') { try { localStorage.setItem('kc-device-token', token) } catch { /* 없음 */ } }
    setNewName(''); setShown((d as Device).id)
    setMsg(kind === 'app' ? '✅ 기기를 추가했어요. 아래 서버 URL과 식별자를 그 폰의 Traccar 앱에 넣어 주세요.' : '✅ 이 폰을 웹 화면 기기로 등록했어요. 운행 화면을 켜 두면 위치를 보내요.')
    await onSaved()
  }
  const toggle = async (d: Device): Promise<void> => {
    const { error } = await supabase.rpc('set_device_enabled', { p_device: d.id, p_on: !d.enabled })
    setMsg(error ? '실패: ' + errText(error) : !d.enabled ? `✅ "${d.name}" 위치를 허용했어요.` : `"${d.name}" 위치를 비허용했어요. 이 기기에서 오는 위치는 버려요.`)
    await onSaved()
  }
  const remove = async (d: Device): Promise<void> => {
    if (!window.confirm(`"${d.name}" 기기를 지울까요? 이 기기에서 오는 위치는 더 이상 받지 않아요.`)) return
    await supabase.from('vehicle_devices').delete().eq('id', d.id)
    await onSaved()
  }
  const copy = (t: string): void => { void navigator.clipboard?.writeText(t).then(() => setMsg('📋 복사했어요: ' + t), () => setMsg(t)) }
  const myToken = ((): string | null => { try { return localStorage.getItem('kc-device-token') } catch { return null } })()
  const assignRun = async (runId: string, on: boolean): Promise<void> => {
    await supabase.from('runs').update({ vehicle_id: on ? vehicle.id : null }).eq('id', runId)
    await onSaved()
  }

  return (
    <div className="veh-body form">
      <div className="row wrap">
        <label className="grow">이름<input value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label className="grow">차량 번호<input value={plate} onChange={(e) => setPlate(e.target.value)} placeholder="경기 12가 3456" /></label>
        <label style={{ width: 110 }}>정원<input inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value.replace(/\D/g, ''))} /></label>
      </div>
      <button onClick={save}>차량 정보 저장</button>

      {multi && (
        <div>
          <h3>이 차량이 맡는 운행</h3>
          <div className="pills">
            {data.runs.filter((r) => r.active).map((r) => {
              const on = r.vehicle_id === vehicle.id
              const other = r.vehicle_id && r.vehicle_id !== vehicle.id ? data.vehicles.find((x) => x.id === r.vehicle_id)?.name : null
              return <button key={r.id} className={on ? 'pill on' : 'pill'} onClick={() => assignRun(r.id, !on)}>{r.name}{other ? ` (${other})` : ''}</button>
            })}
          </div>
          <p className="muted tiny">아무 차량도 안 고른 운행은 어느 차량 위치로든 잡혀요. 차량이 2대 이상이면 운행마다 차량을 정해 주세요.</p>
        </div>
      )}

      {devices && (
        <div className="dev-box">
          <h3>📡 위치 보내는 기기</h3>
          <p className="muted small">운행마다 <b>한 기기</b>의 GPS만 써요. 직접 시작할 땐 차량표에서 <b>[▶ 기기 이름으로 운행 시작]</b>을 고르고, 자동 시작은 <b>⭐ 마지막으로 GPS를 잡았던 기기</b> 기준이에요(그 기기 신호가 3분 넘게 끊기면 위치를 보내는 다른 허용 기기로 넘어가요). 비허용한 기기의 위치는 버려요.</p>
          {mine.length === 0 && <p className="small">아직 등록된 기기가 없어요. 아래에서 추가하세요.</p>}
          <ul className="plain dev-list">
            {mine.map((d) => (
              <li key={d.id} className={d.enabled ? 'on' : ''}>
                <div className="row">
                  <div className="grow">
                    <b>{d.name}</b>{myToken === d.token && <span className="chip">이 폰</span>}{d.id === vehicle.last_device_id && <span className="chip live">⭐ 마지막 GPS 기기</span>}
                    <div className="muted tiny">{d.kind === 'app' ? 'Traccar 앱 · 화면 꺼져도 됨' : '강철노트 화면 · 운행 화면을 켜 둬야 함'} · 마지막 위치 {ago(d.last_at)}</div>
                  </div>
                  <button className={d.enabled ? 'dev-on' : 'dev-off'} onClick={() => toggle(d)}>{d.enabled ? '● 위치 허용 (비허용으로)' : '○ 비허용 (허용으로)'}</button>
                </div>
                <div className="row dev-actions">
                  {d.kind === 'app' && <button className="ghost small-btn" onClick={() => setShown(shown === d.id ? null : d.id)}>{shown === d.id ? '설정값 닫기' : 'Traccar 설정값 보기'}</button>}
                  {d.kind === 'web' && myToken !== d.token && <button className="ghost small-btn" onClick={() => { try { localStorage.setItem('kc-device-token', d.token) } catch { /* 없음 */ } setMsg(`✅ 이 폰을 "${d.name}"으로 지정했어요.`) }}>이 폰으로 지정</button>}
                  <button className="ghost small-btn danger" onClick={() => remove(d)}>삭제</button>
                </div>
                {shown === d.id && d.kind === 'app' && (
                  <ol className="gps-steps">
                    <li>그 폰의 Traccar Client → <b>설정 변경</b></li>
                    <li><b>서버 URL</b> <code>{GPS_URL}</code> <button className="small-btn" onClick={() => copy(GPS_URL)}>복사</button></li>
                    <li><b>기기 식별자</b> <code>{d.token}</code> <button className="small-btn" onClick={() => copy(d.token)}>복사</button></li>
                    <li>위치 정확도 높음 · 간격 10초 · 폰 설정에서 위치 "항상" 허용</li>
                    <li>앱 첫 화면 <b>연속 추적</b> 켜기</li>
                  </ol>
                )}
              </li>
            ))}
          </ul>
          <div className="row wrap">
            <input className="grow" placeholder="기기 이름 (예: 기사님 갤럭시)" value={newName} onChange={(e) => setNewName(e.target.value)} />
            <button onClick={() => addDevice('app')}>+ Traccar 앱 폰</button>
            <button onClick={() => addDevice('web')}>+ 지금 이 폰 (웹 화면)</button>
          </div>
          <p className="muted tiny">Traccar 앱은 화면이 꺼져도 위치를 보내요(추천). 웹 화면은 운행 화면을 켜 둔 동안만 보내요. 식별자는 비밀번호 같은 값이라 다른 사람에게 알려 주지 마세요.</p>
        </div>
      )}
      {msg && <div className={msg.startsWith('✅') || msg.startsWith('📋') ? 'notice-ok small' : 'error'}>{msg}</div>}
    </div>
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

/* ---------------- 운행 구역 표시 (차량 > 운행 구역 소메뉴, 큰 화면) ---------------- */

export function ShuttleAreasPage({ member }: { member: Member }): JSX.Element {
  const [data, setData] = useState<ShuttleData | null>(null)
  const place = usePlace()
  const load = useCallback(async () => setData(await loadShuttle()), [])
  useEffect(() => { load() }, [load])
  if (!data) return <p className="center muted">불러오는 중…</p>
  return (
    <div className="page areas-page">
      {data.areasOk ? <AreaEditor data={data} place={place} orgId={member.org_id} onSaved={load} big />
        : <p className="notice">운행 구역 표시는 Supabase에서 <b>schema-v17-shuttle-areas.sql</b> 을 실행한 뒤 쓸 수 있어요.</p>}
    </div>
  )
}
