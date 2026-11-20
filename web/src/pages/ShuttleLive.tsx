import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useKeep } from '../keep'
import { addressQuery, createMap, drawArea, geocode, onMapFallback, type Area, type LL, type MapAdapter, type MarkerH } from '../mapAdapter'
import { supabase, errText } from '../supabase'
import { useI18n } from '../i18n'
import { activeRide, describeRequest, stopLabel, type RideView, hm, loadShuttle, ridersView, stopsOn, type RideRequest, type Run, type RunStop, type ShuttleData, type Stop } from './Shuttle'

/* 강철셔틀 실시간: 노선도 · 지도 경로 · 기사님 운행 모드 */

export interface Trip {
  id: string; run_id: string; day: string; started_at: string; ended_at: string | null
  lat: number | null; lng: number | null; speed: number | null; pos_at: string | null
  passed: Record<string, string>
  kid_done?: boolean   // 학부모: 우리 아이 정류장을 다 지남 → 차량 위치 안 보여 줌
  manual?: boolean     // 관리자가 직접 시작한 운행
  device_id?: string | null   // 이 운행 위치를 받는 기기
}
export interface Place { name: string; lat: number | null; lng: number | null }

export const kstDate = (): string => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)
const atToday = (time: string): number => Date.parse(`${kstDate()}T${time.slice(0, 5)}:00+09:00`)
const clock = (ms: number): string => new Date(ms + 9 * 3600_000).toISOString().slice(11, 16)

/** 오늘 운행 기록 (실시간) */
/** 오늘 운행 기록. 관리자는 전체(실시간), 학부모는 우리 아이 타는 운행의 진행 상황만(좌표 없음, 15초마다) */
export function useTrips(parent = false): { trips: Trip[]; v9: boolean } {
  const [trips, setTrips] = useState<Trip[]>([])
  const [ok, setOk] = useState(true)
  const load = useCallback(async () => {
    if (parent) {
      const { data, error } = await supabase.rpc('parent_trips')
      if (error) { setTrips([]); return }
      setTrips(((data as Omit<Trip, 'id' | 'day' | 'lat' | 'lng' | 'speed' | 'pos_at'>[]) ?? []).map((x) => ({
        ...x, id: 'p-' + x.run_id, day: kstDate(), lat: null, lng: null, speed: null, pos_at: null
      })))
      return
    }
    const { data, error } = await supabase.from('shuttle_trips').select('*').eq('day', kstDate())
    if (error) setOk(false)
    else setTrips((data as Trip[]) ?? [])
  }, [parent])
  useEffect(() => {
    load()
    const ch = parent ? null : supabase.channel('shuttle-trips-' + Math.random().toString(36).slice(2))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shuttle_trips' }, () => load())
      .subscribe()
    const iv = window.setInterval(load, parent ? 15_000 : 30_000)
    return () => { if (ch) void supabase.removeChannel(ch); clearInterval(iv) }
  }, [load, parent])
  return { trips, v9: ok }
}

export function usePlace(): Place | null {
  const [p, setP] = useState<Place | null>(null)
  useEffect(() => {
    supabase.rpc('org_place').then(({ data }) => setP(((data as Place[]) ?? [])[0] ?? null))
  }, [])
  return p
}

/** 남은 정류장 예상 시각: 마지막으로 지난 정류장이 예정보다 늦은(빠른) 만큼 밀어서 계산 */
function etaOf(list: RunStop[], trip: Trip | undefined): Map<string, number> {
  const m = new Map<string, number>()
  if (!trip || trip.ended_at) return m
  const now = Date.now()
  // 아직 한 곳도 안 지났는데 첫 정류장 시간이 지났으면 그만큼 늦는 중
  let delay = list.some((rs) => trip.passed[rs.id]) ? 0 : Math.max(0, now - atToday(list[0]?.at_time ?? '23:59'))
  for (const rs of list) {
    const p = trip.passed[rs.id]
    if (p) delay = Date.parse(p) - atToday(rs.at_time)
  }
  for (const rs of list) if (!trip.passed[rs.id]) m.set(rs.id, Math.max(now, atToday(rs.at_time) + Math.max(-5 * 60_000, delay)))
  return m
}

/* ---------------- 노선도 + 지도 ---------------- */

export function RouteView({ data, run, day, trip, place, names, mineOnly, onEditStop, onUndo }: {
  data: ShuttleData; run: Run; day: string; trip?: Trip; place: Place | null
  names: (id: string) => string | null   // 우리 아이(또는 관리자는 전체) 이름, 아니면 null
  mineOnly?: boolean
  onEditStop?: (rs: RunStop) => void       // 관리자: 정류장 눌러 고치기
  onUndo?: (v: RideView, rsId: string) => void  // 관리자: 하루 변경 되돌리기
}): JSX.Element {
  const { t } = useI18n()
  const [tab, setTab] = useKeep<'route' | 'map'>('sh-view', 'route')
  const date = kstDate()
  const list = stopsOn(data, run, day, date)
  const stopOf = (id: string): Stop | undefined => data.stops.find((s) => s.id === id)
  const eta = etaOf(list, trip)
  const lastPassed = list.reduce((n, rs, i) => (trip?.passed[rs.id] ? i : n), -1)
  const arrived = run.kind !== 'from' ? trip?.passed.dojang_arrived : undefined   // 태권도장 도착 (GPS)
  const running = !!trip && !trip.ended_at && !trip.kid_done
  const now = Date.now()

  return (
    <div className="rv">
      <div className="rv-tabs">
        <button className={tab === 'route' ? 'on' : ''} onClick={() => setTab('route')}>{t.shRoute}</button>
        <button className={tab === 'map' ? 'on' : ''} onClick={() => setTab('map')}>{t.shMap}</button>
      </div>
      {running && trip?.pos_at && (
        <p className="muted tiny rv-sig">📡 {t.shUpdated.replace('{n}', String(Math.max(0, Math.round((now - Date.parse(trip.pos_at)) / 1000))))}</p>
      )}
      {running && !trip?.pos_at && !mineOnly && <p className="muted tiny rv-sig">📡 {t.shNoGps}</p>}
      {trip?.kid_done && !trip.ended_at && mineOnly && <p className="muted tiny rv-sig">✓ {t.shKidDone}</p>}

      {tab === 'route' ? (
        <ol className="rv-line">
          {run.kind !== 'to' && (
            <li className={`rv-stop dojang ${trip ? 'done' : ''}`}>
              <span className="rv-dot">🥋</span>
              <div className="grow"><b>{t.shDojangStart}</b>{trip && <div className="muted tiny">{clock(Date.parse(trip.started_at))}</div>}</div>
            </li>
          )}
          {running && lastPassed === -1 && list.length > 0 && <li className="rv-bus-top">🚐 {t.shBusHere}</li>}
          {list.map((rs, i) => {
            const st = stopOf(rs.stop_id)
            const passedAt = trip?.passed[rs.id]
            const kids = ridersView(data, rs, run, day, date).map((v) => ({ v, n: names(v.student_id) })).filter((x) => x.n)
            const mine = kids.some(({ v }) => activeRide(v))
            const e = eta.get(rs.id)
            return (
              <li key={rs.id} className={`rv-stop ${passedAt ? 'done' : ''} ${mine && mineOnly ? 'mine' : ''} ${onEditStop ? 'editable' : ''}`}
                onClick={onEditStop ? () => onEditStop(rs) : undefined}>
                <span className="rv-dot">{passedAt ? '✓' : String(i + 1).padStart(2, '0')}</span>
                <div className="grow">
                  <b>{stopLabel(st, mineOnly) || '?'}</b>
                  {st?.wait_note && <div className="muted tiny">{st.wait_note}</div>}
                  {kids.length > 0 && (
                    <div className="riders">
                      {kids.map(({ v, n }) => (
                        <span key={v.key} className={`rider ${v.action} ${v.tag ? 'tag-' + v.tag : ''}`} title={v.note}>
                          {v.action === 'board' ? '⬆' : '⬇'} {(v.action === 'board' ? t.shBoard : t.shAlight).replace('{name}', n!)}
                          {v.tag === 'skip' && <em>{t.rqTagSkip}</em>}
                          {v.tag === 'add' && <em>{t.rqTagAdd}</em>}
                          {v.tag === 'moved' && <em>{v.to ? `→ ${mineOnly && v.toRs ? (() => { const r = data.runStops.find((x) => x.id === v.toRs); return r ? `${hm(r.at_time)} ${stopLabel(stopOf(r.stop_id), true)}` : v.to })() : v.to}` : t.rqTagStopped}</em>}
                          {v.tag === 'new' && <em>{t.rqTagNew}</em>}
                          {onEditStop && v.note && v.tag && <small> · {v.note}</small>}
                          {onUndo && (v.tag === 'skip' || v.tag === 'add') && (
                            <button className="undo" title="하루 변경 취소" onClick={(e) => { e.stopPropagation(); onUndo(v, rs.id) }}>↩</button>
                          )}
                        </span>
                      ))}
                    </div>
                  )}
                  {onEditStop && kids.length === 0 && <div className="muted tiny">이날 타는 아이 없음</div>}
                  {onEditStop && <button className="rv-edit" onClick={(e) => { e.stopPropagation(); onEditStop(rs) }}>✏️ 수정</button>}
                </div>
                <div className="rv-time">
                  {passedAt ? <><b>{clock(Date.parse(passedAt))}</b><div className="muted tiny">{t.shPassed}</div></>
                    : e ? <><b>{clock(e)}</b><div className="muted tiny">{e > now ? t.shMinLater.replace('{n}', String(Math.max(1, Math.round((e - now) / 60000)))) : t.shEta}</div></>
                      : <><b>{hm(rs.at_time)}</b><div className="muted tiny">{t.shScheduled}</div></>}
                </div>
                {running && !arrived && i === lastPassed && <div className="rv-bus">🚐 {t.shBusHere}</div>}
              </li>
            )
          })}
          {run.kind !== 'from' && (
            <li className={`rv-stop dojang ${arrived ? 'done' : ''}`}>
              <span className="rv-dot">🥋</span>
              <div className="grow"><b>{t.shDojangEnd}</b>{run.class_start && <div className="muted tiny">{hm(run.class_start)}</div>}</div>
              {arrived && <div className="rv-time"><b>{clock(Date.parse(arrived))}</b><div className="muted tiny">{t.shArrived}</div></div>}
              {running && arrived && <div className="rv-bus">🚐 {t.shBusHere}</div>}
            </li>
          )}
        </ol>
      ) : (
        <RouteMap data={data} run={run} list={list} trip={trip} place={place} parent={!!mineOnly} mineIds={!mineOnly ? new Set() : new Set(list.filter((rs) => ridersView(data, rs, run, day, date).some((v) => activeRide(v) && names(v.student_id))).map((rs) => rs.id))} />
      )}
    </div>
  )
}

const pinHtml = (n: number | string, cls: string): string => `<div class="map-pin ${cls}">${n}</div>`

/** 지도 하나 만들고(네이버 → 안 되면 OSM), 네이버 인증이 늦게 실패하면 다시 만듦 */
export function useMapAdapter(box: React.RefObject<HTMLDivElement>, center: LL, zoom: number): MapAdapter | null {
  const [m, setM] = useState<MapAdapter | null>(null)
  const [ver, setVer] = useState(0)
  useEffect(() => onMapFallback(() => setVer((v) => v + 1)), [])
  useEffect(() => {
    if (!box.current) return
    let alive = true
    let made: MapAdapter | null = null
    createMap(box.current, center, zoom).then((a) => { if (alive) { made = a; setM(a) } else a.destroy() })
    return () => { alive = false; made?.destroy(); setM(null); if (box.current) box.current.innerHTML = '' }
  }, [ver]) // eslint-disable-line react-hooks/exhaustive-deps
  return m
}

function RouteMap({ data, run, list, trip, place, mineIds, parent }: {
  data: ShuttleData; run: Run; list: RunStop[]; trip?: Trip; place: Place | null; mineIds: Set<string>; parent?: boolean
}): JSX.Element {
  const { t } = useI18n()
  const box = useRef<HTMLDivElement>(null)
  const map = useMapAdapter(box, [37.32, 126.83], 14)

  const pts = useMemo(() => {
    const out: { ll: LL; label: string; id: string; name: string }[] = []
    const dojang = place?.lat != null && place.lng != null ? { ll: [place.lat, place.lng] as LL, label: '🥋', id: 'dojang', name: place.name } : null
    if (dojang && run.kind !== 'to') out.push(dojang)
    list.forEach((rs, i) => {
      const s = data.stops.find((x) => x.id === rs.stop_id)
      if (s?.lat != null && s.lng != null) out.push({ ll: [s.lat, s.lng], label: String(i + 1), id: rs.id, name: stopLabel(s, parent) })
    })
    if (dojang && run.kind !== 'from') out.push({ ...dojang, id: 'dojang-end' })
    return out
  }, [data, run, list, place, parent])


  // 차량은 실시간으로 움직이지 않고, 마지막으로 도착한 정류장에 표시
  const running = !!trip && !trip.ended_at && !trip.kid_done
  let at = -1
  if (trip) {
    pts.forEach((p, i) => { if (trip.passed[p.id] || (p.id === 'dojang-end' && trip.passed.dojang_arrived)) at = i })
    if (at === -1 && pts[0]?.id === 'dojang') at = 0           // 도장에서 출발함
    if (trip.ended_at) at = pts.length - 1
    if (trip.kid_done && !trip.ended_at) at = -1   // 학부모: 우리 아이 끝난 뒤엔 위치 숨김
  }
  const busLL = running && at >= 0 ? pts[at].ll : null

  const fitAll = useCallback(() => { map?.fit(pts.map((p) => p.ll)) }, [map, pts])

  useEffect(() => {
    if (!map) return
    const made: { remove(): void }[] = []
    pts.forEach((p, i) => {
      const passed = trip && i <= at
      const cls = `${passed ? 'passed' : ''} ${mineIds.has(p.id) ? 'mine' : ''} ${p.id.startsWith('dojang') ? 'dojang' : ''}`
      const html = `<div class="map-stop ${cls}"><span class="num">${p.label}</span><span class="nm">${p.name.replace(/[<>&]/g, '')}</span></div>`
      made.push(map.marker(p.ll, html, 26, p.name, mineIds.has(p.id) ? 300 : 200, [13, 13]))
    })
    if (busLL) made.push(map.marker(busLL, '<div class="map-bus">🚐</div>', 36, '', 1000, [18, 46]))
    return () => made.forEach((x) => x.remove())
  }, [map, pts, mineIds, at, busLL?.join(',')]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (map) fitAll() }, [map, pts.length]) // eslint-disable-line react-hooks/exhaustive-deps
  // 운행 구역 (갈 수 있는 곳 연초록 / 못 가는 곳 빨간 빗금) — 정류장 아래에 깔림
  useEffect(() => {
    if (!map) return
    const made = data.areas.filter((a) => !parent || a.show_parents).flatMap((a) => drawArea(map, a))
    return () => made.forEach((x) => x.remove())
  }, [map, data.areas, parent])

  const noCoords = pts.filter((p) => !p.id.startsWith('dojang')).length === 0
  return (
    <div className="rv-map-wrap">
      <div ref={box} className="rv-map" />
      <div className="rv-map-btns">
        <button onClick={fitAll}>{t.shFitAll}</button>
        {busLL && <button onClick={() => map?.setView(busLL, 16)}>🚐 {t.shBusPos}</button>}
      </div>
      <div className="rv-legend">
        <span><i className="lg-stop" /> {t.shPassed}</span>
        {mineIds.size > 0 && <span><i className="lg-mine" /> {t.shLegendMine}</span>}
      </div>
      <p className="muted tiny">{t.shBusNote}</p>
      {noCoords && <p className="muted small center">{t.shNoCoords}</p>}
    </div>
  )
}

/* ---------------- 기사님 운행 모드 (휴대폰 GPS로 위치 보내기) ---------------- */

export function DriverMode({ data, run, day, place, orgId, onExit }: { data: ShuttleData; run: Run; day: string; place: Place | null; orgId: string; onExit(): void }): JSX.Element {
  const [trip, setTrip] = useState<Trip | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [gps, setGps] = useState<{ lat: number; lng: number; acc: number; speed: number | null; at: number } | null>(null)
  const [sent, setSent] = useState<number | null>(null)
  const lastSend = useRef(0)
  const list = stopsOn(data, run, day)

  // 이 폰이 이 차량의 위치 기기인지 (v22: 차량별 기기 켬/끔)
  const vehicleId = run.vehicle_id ?? data.vehicles[0]?.id ?? null
  const vehicleName = data.vehicles.find((v) => v.id === vehicleId)?.name ?? '차량'
  const [dev, setDev] = useState<{ state: 'loading' | 'legacy' | 'none' | 'other' | 'off' | 'on'; id?: string; name?: string; token?: string }>({ state: 'loading' })
  const [devName, setDevName] = useState('')
  const checkDevice = useCallback(async () => {
    let token: string | null = null
    try { token = localStorage.getItem('kc-device-token') } catch { /* 없음 */ }
    const { data: rows, error } = await supabase.from('vehicle_devices').select('id,vehicle_id,name,token,enabled').eq('kind', 'web')
    if (error) return setDev({ state: 'legacy' })                  // v22 전: 예전 방식으로 보냄
    const mine = ((rows as { id: string; vehicle_id: string; name: string; token: string; enabled: boolean }[]) ?? []).find((r) => r.token === token)
    if (!mine) return setDev({ state: 'none' })
    if (mine.vehicle_id !== vehicleId) return setDev({ state: 'other', id: mine.id, name: mine.name, token: mine.token })
    setDev({ state: mine.enabled ? 'on' : 'off', id: mine.id, name: mine.name, token: mine.token })
  }, [vehicleId])
  useEffect(() => { checkDevice() }, [checkDevice])
  const registerHere = async (): Promise<void> => {
    if (!vehicleId) return setErr('차량이 없어요. 차량 · 위치 기기에서 차량을 먼저 만들어 주세요.')
    let token: string | null = null
    try { token = localStorage.getItem('kc-device-token') } catch { /* 없음 */ }
    if (dev.state === 'other' && dev.id) {
      await supabase.from('vehicle_devices').update({ vehicle_id: vehicleId }).eq('id', dev.id)
      await supabase.rpc('set_device_enabled', { p_device: dev.id, p_on: true })
      return checkDevice()
    }
    const tk = token && token.length >= 12 ? token : 'kc' + Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 18)
    const { data: d, error } = await supabase.from('vehicle_devices').insert({ org_id: orgId, vehicle_id: vehicleId, name: devName.trim() || '운행 폰 (웹 화면)', kind: 'web', token: tk, enabled: true }).select('id').single()
    if (error) return setErr('등록 실패: ' + errText(error))
    try { localStorage.setItem('kc-device-token', tk) } catch { /* 없음 */ }
    await supabase.rpc('set_device_enabled', { p_device: (d as { id: string }).id, p_on: true })
    checkDevice()
  }
  const turnOn = async (): Promise<void> => {
    if (!dev.id) return
    await supabase.rpc('set_device_enabled', { p_device: dev.id, p_on: true })
    checkDevice()
  }

  // 운행 시작 (직접 시작 · 이 폰이 위치 기기면 이 폰 GPS로 · 오늘 이미 시작했으면 이어서)
  const startDev = dev.state === 'on' ? dev.id ?? null : null
  useEffect(() => {
    if (dev.state === 'loading') return
    (async () => {
      const today = kstDate()
      let { error: e1 } = await supabase.rpc('trip_start', startDev ? { p_run: run.id, p_device: startDev } : { p_run: run.id })
      if (e1 && startDev) ({ error: e1 } = await supabase.rpc('trip_start', { p_run: run.id }))   // v23 전
      if (e1) {
        // v19 전: 예전 방식
        const { data: ex } = await supabase.from('shuttle_trips').select('*').eq('run_id', run.id).eq('day', today).maybeSingle()
        if (ex) {
          const { data: up } = await supabase.from('shuttle_trips').update({ ended_at: null }).eq('id', (ex as Trip).id).select().single()
          setTrip((up as Trip) ?? (ex as Trip))
          return
        }
        const { data: created, error } = await supabase.from('shuttle_trips').insert({ org_id: orgId, run_id: run.id, day: today }).select().single()
        if (error) setErr('운행을 시작하지 못했어요: ' + errText(error))
        else setTrip(created as Trip)
        return
      }
      const { data: t } = await supabase.from('shuttle_trips').select('*').eq('run_id', run.id).eq('day', today).maybeSingle()
      setTrip(t as Trip)
    })()
  }, [run.id, startDev, dev.state === 'loading']) // eslint-disable-line react-hooks/exhaustive-deps

  // 화면 꺼짐 방지
  useEffect(() => {
    let lock: { release(): Promise<void> } | null = null
    const nav = navigator as Navigator & { wakeLock?: { request(t: 'screen'): Promise<{ release(): Promise<void> }> } }
    const get = (): void => { nav.wakeLock?.request('screen').then((l) => { lock = l }).catch(() => {}) }
    get()
    const vis = (): void => { if (!document.hidden) get() }
    document.addEventListener('visibilitychange', vis)
    return () => { document.removeEventListener('visibilitychange', vis); lock?.release().catch(() => {}) }
  }, [])

  // GPS
  const devRef = useRef(dev)
  devRef.current = dev
  useEffect(() => {
    if (!trip) return
    if (!('geolocation' in navigator)) { setErr('이 기기에서는 위치를 쓸 수 없어요.'); return }
    const id = navigator.geolocation.watchPosition(
      async (p) => {
        const g = { lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, speed: p.coords.speed == null ? null : p.coords.speed * 3.6, at: Date.now() }
        setGps(g)
        setErr(null)
        if (Date.now() - lastSend.current < 5000 || g.acc > 150) return
        lastSend.current = Date.now()
        if (devRef.current.state !== 'on' && devRef.current.state !== 'legacy') return   // 이 폰은 위치 기기가 아님(또는 꺼짐)
        const { data: r, error } = devRef.current.state === 'on'
          ? await supabase.rpc('shuttle_web_ping', { p_token: devRef.current.token, p_lat: g.lat, p_lng: g.lng, p_speed: g.speed })
          : await supabase.rpc('shuttle_ping', { p_trip: trip.id, p_lat: g.lat, p_lng: g.lng, p_speed: g.speed })
        if (error) setErr('위치 전송 실패: ' + errText(error))
        else if ((r as { ignored?: string })?.ignored === 'device_off') { setErr('이 폰은 위치 비허용 상태예요.'); checkDevice() }
        else if ((r as { ignored?: string })?.ignored === 'other_device') setErr('이 운행은 다른 기기 GPS로 시작돼 있어요. 이 폰 위치는 쓰지 않아요. (이 폰으로 바꾸려면 운행을 끝내고 이 화면에서 다시 시작)')
        else {
          setSent(Date.now())
          const passed = (r as { passed?: Record<string, string> })?.passed
          if (passed) setTrip((t) => (t ? { ...t, passed } : t))
        }
      },
      (e) => setErr(e.code === 1 ? 'PERM' : '위치를 찾는 중이에요… (' + e.message + ')'),
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 }
    )
    return () => navigator.geolocation.clearWatch(id)
  }, [trip?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const togglePassed = async (rs: RunStop | 'dojang_arrived'): Promise<void> => {
    if (!trip) return
    const key = rs === 'dojang_arrived' ? rs : rs.id
    const passed = { ...trip.passed }
    if (passed[key]) delete passed[key]
    else passed[key] = new Date().toISOString()
    setTrip({ ...trip, passed })
    await supabase.from('shuttle_trips').update({ passed }).eq('id', trip.id)
  }
  const end = async (): Promise<void> => {
    if (trip && !window.confirm('운행을 끝낼까요? 학부모 화면에 "운행 끝"으로 바뀌어요.')) return
    if (trip) {
      const { error } = await supabase.rpc('trip_end', { p_run: run.id })
      if (error) await supabase.from('shuttle_trips').update({ ended_at: new Date().toISOString() }).eq('id', trip.id)
    }
    onExit()
  }

  return (
    <div className="driver">
      <div className="driver-head">
        <div>
          <div className="muted small">🚐 운행 중</div>
          <h2>{run.name}</h2>
        </div>
        <button className="danger-btn" onClick={end}>운행 종료</button>
      </div>
      <div className={`driver-gps ${sent && Date.now() - sent < 20000 ? 'ok' : 'wait'}`}>
        {gps ? (
          <>
            <b>{sent ? `📡 ${Math.round((Date.now() - sent) / 1000)}초 전 위치 전송` : '📡 위치 보내는 중…'}</b>
            <span className="small">정확도 ±{Math.round(gps.acc)}m{gps.speed != null ? ` · ${Math.round(gps.speed)}km/h` : ''}</span>
          </>
        ) : <b>📡 위치를 찾는 중… (위치 권한을 "허용"해 주세요)</b>}
      </div>
      {dev.state === 'on' && <p className="small ok">✅ 이 운행은 이 폰({dev.name}) GPS로 위치를 보내요. 다른 기기 위치는 이 운행에 안 써요.</p>}
      {(dev.state === 'none' || dev.state === 'other') && (
        <div className="dev-ask">
          <b>📱 이 폰을 {vehicleName} 위치 기기로 쓸까요?</b>
          <span className="small muted">{dev.state === 'other' ? `이 폰은 다른 차량(${dev.name})에 등록돼 있어요.` : '등록하면 이 운행은 이 폰 GPS로 위치를 보내요. (이 화면을 켜 둔 동안)'}</span>
          {dev.state === 'none' && <input placeholder="이 폰 이름 (예: 기사님 아이폰)" value={devName} onChange={(e) => setDevName(e.target.value)} />}
          <button className="primary" onClick={registerHere}>{dev.state === 'other' ? `이 폰을 ${vehicleName}로 옮기고 켜기` : '등록하고 위치 보내기'}</button>
          <span className="tiny muted">위치를 다른 폰(Traccar 앱 등)에서 받고 있다면 등록하지 않아도 돼요. 정류장은 아래에서 직접 눌러 표시할 수 있어요.</span>
        </div>
      )}
      {dev.state === 'off' && (
        <div className="dev-ask">
          <b>📴 이 폰({dev.name})은 위치 비허용 상태예요</b>
          <span className="small muted">허용하면 이 운행을 이 폰 GPS로 보내요.</span>
          <button className="primary" onClick={turnOn}>허용하고 이 폰으로 운행</button>
        </div>
      )}
      {err === 'PERM' ? (
        <div className="error">
          <b>위치 권한이 꺼져 있어요.</b><br />
          아이폰: 설정 → 개인정보 보호 및 보안 → 위치 서비스(켬) → <b>Safari 웹사이트</b> → "앱을 사용하는 동안" + <b>정확한 위치 켬</b><br />
          안드로이드: 주소창 왼쪽 자물쇠 → 권한 → 위치 → 허용<br />
          바꾼 뒤 이 화면을 새로고침해 주세요.
        </div>
      ) : err && <div className="error">{err}</div>}
      <p className="notice small">⚠️ 운행 중에는 <b>이 화면을 켜 둔 채로</b> 두세요. 아이폰은 화면이 꺼지거나 다른 앱으로 가면 위치 전송이 멈춰요. 정류장 70m 안에 들어가면 자동으로 "지남" 표시돼요. 안 되면 정류장을 눌러 직접 표시하세요.</p>
      <ol className="driver-stops">
        {list.map((rs, i) => {
          const st = data.stops.find((s) => s.id === rs.stop_id)
          const passed = trip?.passed[rs.id]
          const kids = ridersView(data, rs, run, day, kstDate()).filter(activeRide)
          return (
            <li key={rs.id} className={passed ? 'done' : ''} onClick={() => togglePassed(rs)}>
              <span className="rv-dot">{passed ? '✓' : i + 1}</span>
              <div className="grow">
                <b>{st?.name}</b> <span className="muted small">{hm(rs.at_time)}</span>
                {st?.lat == null && <span className="chip">지도 위치 없음</span>}
                <div className="small">
                  {kids.filter((r) => r.action === 'board').length > 0 && <>⬆ {kids.filter((r) => r.action === 'board').length}명 </>}
                  {kids.filter((r) => r.action === 'alight').length > 0 && <>⬇ {kids.filter((r) => r.action === 'alight').length}명</>}
                </div>
              </div>
              <span className="small">{passed ? clock(Date.parse(passed)) : ''}</span>
            </li>
          )
        })}
        {run.kind !== 'from' && (
          <li className={trip?.passed.dojang_arrived ? 'done' : ''} onClick={() => togglePassed('dojang_arrived')}>
            <span className="rv-dot">{trip?.passed.dojang_arrived ? '✓' : '🥋'}</span>
            <div className="grow"><b>태권도장 도착</b> <span className="muted small">도장 80m 안에 오면 자동 표시</span></div>
            <span className="small">{trip?.passed.dojang_arrived ? clock(Date.parse(trip.passed.dojang_arrived)) : ''}</span>
          </li>
        )}
      </ol>
      {place?.lat == null && <p className="muted small">도장 위치가 지도에 없어요. 📍 정류장 화면에서 도장 위치를 정해 주세요.</p>}
    </div>
  )
}

/* ---------------- 지도에서 위치 고르기 (정류장·도장) ---------------- */

export interface PlaceHit { name: string; address: string; category?: string; lat: number; lng: number }
/** 장소 이름 검색 (네이버 지역 검색, 서버 함수 place-search). 아직 설정 전이면 'unavailable' */
export async function placeSearch(query: string): Promise<PlaceHit[] | 'unavailable'> {
  const { data, error } = await supabase.functions.invoke('place-search', { body: { query } })
  if (error) return 'unavailable'
  const items = (data as { items?: PlaceHit[]; error?: string })?.items
  return items ?? 'unavailable'
}

export function PickMap({ lat, lng, onPick, onAddress }: { lat: number | null; lng: number | null; onPick(lat: number, lng: number): void; onAddress?(address: string): void }): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const map = useMapAdapter(box, lat != null && lng != null ? [lat, lng] : [37.318, 126.835], lat != null ? 17 : 14)
  const pin = useRef<MarkerH | null>(null)
  const cb = useRef(onPick)
  cb.current = onPick
  const [q, setQ] = useState('')
  const [hits, setHits] = useState<PlaceHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => {
    if (!map) return
    map.onClick((a, b) => cb.current(a, b))
    return () => { pin.current = null }
  }, [map])
  useEffect(() => {
    if (!map) return
    if (lat == null || lng == null) { pin.current?.remove(); pin.current = null; return }
    if (pin.current) pin.current.setPos([lat, lng])
    else pin.current = map.marker([lat, lng], pinHtml('📍', 'pick'), 26, '', 500)
  }, [map, lat, lng])
  const here = (): void => navigator.geolocation?.getCurrentPosition(
    (p) => { cb.current(p.coords.latitude, p.coords.longitude); map?.setView([p.coords.latitude, p.coords.longitude], 17) },
    () => alert('현재 위치를 가져오지 못했어요. 위치 권한을 확인해 주세요.'),
    { enableHighAccuracy: true, timeout: 15000 }
  )
  // 검색: 장소 이름(네이버 지역 검색) + 주소(네이버 Geocoding) 같이
  const search = async (): Promise<void> => {
    const text = q.trim()
    if (!text) return
    setSearching(true); setNote(null)
    const addr = addressQuery(text, '') ?? (/[로길]\s?\d/.test(text) ? `경기도 안산시 단원구 ${text}` : null)
    const [places, g] = await Promise.all([placeSearch(text), addr ? geocode(addr) : Promise.resolve(null)])
    const out: PlaceHit[] = []
    if (Array.isArray(g)) out.push({ name: `📮 ${addr}`, address: addr!, lat: g[0], lng: g[1], category: '주소' })
    if (Array.isArray(places)) out.push(...places)
    setHits(out)
    if (!out.length) setNote(places === 'unavailable' ? '장소 이름 검색은 아직 설정 전이에요. 주소(예: 원곡로 28)로 검색하거나 지도에서 직접 찍어 주세요.' : '찾는 곳이 없어요. 다르게 써 보거나 지도에서 직접 찍어 주세요.')
    setSearching(false)
  }
  const choose = (h: PlaceHit): void => {
    cb.current(h.lat, h.lng)
    map?.setView([h.lat, h.lng], 17)
    if (onAddress && h.address && h.category !== '주소') onAddress(h.address.replace(/^경기도?\s*안산시\s*(단원구|상록구)?\s*/, ''))
    setHits(null)
  }
  return (
    <div className="pickmap">
      <div className="row map-search">
        <input className="grow" value={q} placeholder="🔍 장소·주소 검색 (예: 롯데캐슬, 원곡로 28)" onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); search() } }} />
        <button type="button" className="small-btn" disabled={searching} onClick={search}>{searching ? '…' : '검색'}</button>
      </div>
      {hits && hits.length > 0 && (
        <ul className="plain map-hits">
          {hits.map((h, i) => (
            <li key={i} onClick={() => choose(h)}>
              <b>{h.name}</b> {h.category && <span className="muted tiny">{h.category}</span>}
              <div className="muted tiny">{h.address}</div>
            </li>
          ))}
        </ul>
      )}
      {note && <p className="muted tiny">{note}</p>}
      <div ref={box} className="rv-map small-map" />
      <div className="row">
        <span className="muted small grow">검색하거나 지도를 눌러 위치를 찍어 주세요.</span>
        <button type="button" className="ghost small-btn" onClick={here}>📍 지금 내 위치</button>
      </div>
    </div>
  )
}

/* ---------------- 학부모: 오늘 우리 아이가 타는 차량 + 변경 신청 ---------------- */

export function ParentShuttle({ kids }: { kids: { id: string; name: string }[] }): JSX.Element | null {
  const { t } = useI18n()
  const [data, setData] = useState<ShuttleData | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const { trips } = useTrips(true)
  const place = usePlace()
  const load = useCallback(async () => setData(await loadShuttle()), [])
  useEffect(() => {
    load()
    const ch = supabase.channel('parent-rides-' + Math.random().toString(36).slice(2))
    for (const tb of ['ride_requests', 'ride_exceptions', 'ride_assignments', 'run_stops']) ch.on('postgres_changes', { event: '*', schema: 'public', table: tb }, () => load())
    ch.subscribe()
    return () => void supabase.removeChannel(ch)
  }, [load])
  if (!data) return null
  const day = '일월화수목금토'[new Date(Date.now() + 9 * 3600_000).getUTCDay()]
  const date = kstDate()
  const kidName = (id: string): string | null => kids.find((k) => k.id === id)?.name ?? null
  const runs = data.runs
    .filter((r) => r.active)
    .map((run) => ({ run, list: stopsOn(data, run, day, date) }))
    .filter(({ run, list }) => list.some((rs) => ridersView(data, rs, run, day, date).some((v) => kidName(v.student_id))))
    .sort((a, b) => (a.list[0]?.at_time ?? '').localeCompare(b.list[0]?.at_time ?? ''))
  const usesShuttle = data.rides.some((r) => kidName(r.student_id))
  const myReq = data.requests.filter((q) => kidName(q.student_id) && q.status !== 'canceled').slice(0, 6)
  if (!runs.length && !usesShuttle && !myReq.length) return null
  const firstOpen = open ?? (runs.find(({ run }) => trips.some((x) => x.run_id === run.id && !x.ended_at))?.run.id ?? runs[0]?.run.id)

  return (
    <section className="card pshuttle">
      <div className="row">
        <h3 className="grow">🚐 {t.shTitle}</h3>
        {data.requestsOk && <button className="small-btn" onClick={() => setAsking(true)}>✏️ {t.rqButton}</button>}
      </div>
      <details className="sh-notice">
        <summary>{t.shNoticeTitle}</summary>
        {t.shNotice.split('\n').map((line, i) => <p key={i}>{line}</p>)}
      </details>
      {runs.length === 0 ? <p className="muted small">{t.rqNoRideToday}</p> : <p className="muted tiny">🔒 {t.shPrivacy}</p>}
      {runs.map(({ run, list }) => {
        const trip = trips.find((x) => x.run_id === run.id)
        const st = !trip ? t.shBefore : trip.ended_at ? t.shEnded : trip.kid_done ? t.shKidDoneShort : t.shRunning
        const isOpen = firstOpen === run.id
        return (
          <div key={run.id} className={`ps-run ${isOpen ? 'open' : ''}`}>
            <button className="ps-head" onClick={() => setOpen(isOpen ? '' : run.id)}>
              <span className="rv-time"><b>{hm(list[0]?.at_time ?? null)}</b></span>
              <span className="grow"><b>{run.name}</b></span>
              <span className={`chip ${trip && !trip.ended_at && !trip.kid_done ? 'live' : ''}`}>{trip && !trip.ended_at && !trip.kid_done ? '● ' : ''}{st}</span>
              <span className="muted">{isOpen ? '▲' : '▼'}</span>
            </button>
            {isOpen && <RouteView data={data} run={run} day={day} trip={trip} place={place} names={kidName} mineOnly />}
          </div>
        )
      })}
      {myReq.length > 0 && (
        <div className="my-req">
          <div className="small"><b>{t.rqMine}</b></div>
          <ul className="plain">
            {myReq.map((q) => <ReqLine key={q.id} data={data} q={q} name={kidName(q.student_id)!} onCancel={load} />)}
          </ul>
        </div>
      )}
      {asking && <RequestSheet data={data} kids={kids.filter((k) => data.rides.some((r) => r.student_id === k.id)).length ? kids.filter((k) => data.rides.some((r) => r.student_id === k.id)) : kids}
        onClose={() => setAsking(false)} onDone={() => { setAsking(false); load() }} />}
    </section>
  )
}

function ReqLine({ data, q, name, onCancel }: { data: ShuttleData; q: RideRequest; name: string; onCancel(): void }): JSX.Element {
  const { t } = useI18n()
  const d = describeRequest(data, q, true)
  const kind = q.kind === 'skip' ? t.rqSkip : q.kind === 'add' ? t.rqAdd : t.rqChange
  const when = q.scope === 'once' ? (q.date ?? '').slice(5).replace('-', '/') : t.rqAlways
  const st = { pending: t.rqPending, approved: t.rqApproved, rejected: t.rqRejected, canceled: '' }[q.status]
  return (
    <li className={`req-line st-${q.status}`}>
      <div className="grow">
        <b>{name}</b> · {kind} · {when}
        <div className="tiny muted">{d.from}{d.from && d.to ? ' → ' : ''}{d.to}</div>
        {q.status === 'rejected' && q.decide_note && <div className="tiny danger">{q.decide_note}</div>}
      </div>
      <span className={`chip rq-${q.status}`}>{st}</span>
      {q.status === 'pending' && (
        <button className="ghost small-btn" onClick={async () => { await supabase.rpc('cancel_ride_request', { p_id: q.id }); onCancel() }}>{t.rqCancel}</button>
      )}
    </li>
  )
}

/** 신청서 (학부모) / 변경 입력 (관리자: 바로 반영, 마감 없음, 학부모 신청 고쳐서 승인) */
export function RequestSheet({ data, kids, onClose, onDone, admin, initial, orgId }: {
  data: ShuttleData; kids: { id: string; name: string }[]; onClose(): void; onDone(): void
  admin?: boolean; initial?: RideRequest; orgId?: string
}): JSX.Element {
  const { t } = useI18n()
  const [extra, setExtra] = useState<{ id: string; name: string }[]>([])   // 방금 등록한 신입생
  const allKids = [...kids, ...extra]
  const [nw, setNw] = useState({ group: '초등부', session: '', phone: '', relation: '어머니' })
  const initRun = initial?.to_run_stop_id ? data.runStops.find((x) => x.id === initial.to_run_stop_id)?.run_id ?? '' : ''
  const [kid, setKid] = useState(initial?.student_id ?? (admin ? '' : kids[0]?.id ?? ''))
  const [kidQ, setKidQ] = useState(initial ? kids.find((k) => k.id === initial.student_id)?.name ?? '' : '')
  const [scope, setScope] = useState<'once' | 'always'>(initial?.scope ?? 'once')
  const [date, setDate] = useState(initial?.date ?? kstDate())
  const [kind, setKind] = useState<'skip' | 'add' | 'change'>(initial?.kind ?? 'skip')
  const [from, setFrom] = useState(initial?.from_run_stop_id ?? '')
  const [runId, setRunId] = useState(initRun)
  const [to, setTo] = useState(initial?.to_run_stop_id ?? '')
  const [action, setAction] = useState<'board' | 'alight'>(initial?.action ?? 'board')
  const [reason, setReason] = useState(initial?.reason ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const d = scope === 'once' ? dayOfDateLocal(date) : ''
  const rsLabel = (rsId: string): string => {
    const rs = data.runStops.find((x) => x.id === rsId)
    const run = rs && data.runs.find((r) => r.id === rs.run_id)
    return rs ? `${run?.name ?? ''} · ${hm(rs.at_time)} ${stopLabel(data.stops.find((s) => s.id === rs.stop_id), !admin)}` : ''
  }
  // 지금 타는 곳 (그날 / 계속이면 전체)
  const current = data.rides
    .filter((r) => r.student_id === kid)
    .map((r) => ({ r, rs: data.runStops.find((x) => x.id === r.run_stop_id)! }))
    .filter(({ r, rs }) => {
      if (!rs) return false
      if (scope === 'always') return true
      const run = data.runs.find((x) => x.id === rs.run_id)
      const wd = (r.weekdays ?? rs.weekdays ?? run?.weekdays ?? '').split(',')
      return wd.includes(d)
    })
    .sort((a, b) => a.rs.at_time.localeCompare(b.rs.at_time))
  const fromRs = data.runStops.find((x) => x.id === from)
  const runs = data.runs.filter((r) => r.active && (scope === 'always' || r.weekdays.split(',').includes(d)))
  const targetRun = kind === 'change' ? (runId || fromRs?.run_id || '') : runId
  const targetStops = data.runStops.filter((rs) => rs.run_id === targetRun && rs.id !== from && (scope === 'always' || !rs.weekdays || rs.weekdays.split(',').includes(d)))
    .sort((a, b) => a.at_time.localeCompare(b.at_time))

  // 마감 안내 (하루 신청)
  const depRs = data.runStops.filter((rs) => rs.run_id === (kind === 'add' ? runId : fromRs?.run_id) && (!rs.weekdays || rs.weekdays.split(',').includes(d)))
    .sort((a, b) => a.at_time.localeCompare(b.at_time))[0]
  const depRun = depRs && data.runs.find((r) => r.id === depRs.run_id)
  const dep = scope === 'once' && depRs ? Date.parse(`${date}T${depRs.at_time.slice(0, 5)}:00+09:00`) : null
  const cut = dep && depRun ? dep - depRun.cutoff_minutes * 60_000 : null
  const late = !admin && !!cut && Date.now() > cut
  const departed = !admin && !!dep && Date.now() > dep

  const ready = kid && (kind === 'add' ? !!to : !!from) && (kind !== 'change' || !!to) && (!late || reason.trim()) && !departed
  const send = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    const fields = {
      student_id: kid, kind, scope, date: scope === 'once' ? date : null,
      from_run_stop_id: kind === 'add' ? null : from, to_run_stop_id: kind === 'skip' ? null : to,
      action: kind === 'add' ? action : current.find((c) => c.rs.id === from)?.r.action ?? 'board', reason: reason.trim()
    }
    let id = initial?.id
    let e: string | undefined
    if (initial) {
      // 학부모 신청을 고쳐서 승인
      const { error } = await supabase.from('ride_requests').update(fields).eq('id', initial.id)
      if (error) e = errText(error)
    } else {
      const { data: r, error } = await supabase.rpc('submit_ride_request', {
        p_student: fields.student_id, p_kind: kind, p_scope: scope, p_date: fields.date,
        p_from: fields.from_run_stop_id, p_to: fields.to_run_stop_id, p_action: fields.action, p_weekdays: null, p_reason: fields.reason
      })
      e = error ? errText(error) : (r as { error?: string })?.error
      id = (r as { id?: string })?.id
    }
    if (!e && admin && id) {
      // 관리자가 넣은 건 바로 반영
      const { data: r, error } = await supabase.rpc('decide_ride_request', { p_id: id, p_ok: true, p_note: initial ? '관리자가 수정해서 반영' : '' })
      e = error ? errText(error) : (r as { error?: string })?.error
    }
    setBusy(false)
    if (e) setErr(e === 'departed' ? t.rqDeparted : e === 'reason_required' ? t.rqReasonNeeded : `${t.error} (${e})`)
    else onDone()
  }

  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head"><h2>✏️ {admin ? (initial ? '신청 고쳐서 승인' : '차량 변경 입력') : t.rqButton}</h2><button className="ghost" onClick={onClose}>✕</button></div>
        {admin && <p className="muted small" style={{ marginTop: 0 }}>저장하면 바로 차량표에 반영되고, 바뀐 자리에 표시돼요. 관리자는 마감 시간 제한이 없어요.</p>}
        <div className="form">
          {admin ? (
            <label>학생
              <input list="rq-kids" value={kidQ} placeholder="이름 입력" onChange={(e) => {
                setKidQ(e.target.value)
                const k = allKids.find((x) => x.name === e.target.value.trim())
                setKid(k?.id ?? ''); setFrom(''); setTo('')
              }} />
              <datalist id="rq-kids">{allKids.map((k) => <option key={k.id} value={k.name} />)}</datalist>
              {kidQ && !kid && <span className="hint">목록에서 정확한 이름을 고르거나, 아래에서 신입생으로 등록하세요.</span>}
            </label>
          ) : null}
          {admin && kidQ.trim().length >= 2 && !kid && orgId && (
            <div className="new-kid">
              <b>🆕 "{kidQ.trim()}" 신입생으로 등록</b>
              <div className="row">
                <select value={nw.group} onChange={(e) => setNw({ ...nw, group: e.target.value })}>
                  {['초등부', '유치부', '중고등', '선수단', '입시반', '일반부'].map((g) => <option key={g}>{g}</option>)}
                </select>
                <select value={nw.session} onChange={(e) => setNw({ ...nw, session: e.target.value })}>
                  <option value="">부 미정</option>{[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}부</option>)}
                </select>
              </div>
              <div className="row">
                <input className="grow" inputMode="tel" placeholder="보호자 전화번호 (학부모 로그인용)" value={nw.phone} onChange={(e) => setNw({ ...nw, phone: e.target.value })} />
                <input style={{ width: 90 }} placeholder="관계" value={nw.relation} onChange={(e) => setNw({ ...nw, relation: e.target.value })} />
              </div>
              <button disabled={busy} onClick={async () => {
                setBusy(true); setErr(null)
                const name = kidQ.trim()
                let id: string | undefined; let lastErr = ''
                for (let i = 0; i < 6 && !id; i++) {
                  const code = String(Math.floor(1000 + Math.random() * 9000))
                  const { data: row, error } = await supabase.from('students').insert({ org_id: orgId, name, code, group_name: nw.group, session_no: nw.session ? Number(nw.session) : null, active: true }).select('id').single()
                  if (error) lastErr = errText(error); else id = (row as { id: string }).id
                }
                if (id && nw.phone.replace(/\D/g, '').length >= 9) {
                  await supabase.from('student_contacts').insert({ student_id: id, name: '', phone: nw.phone.trim(), relation: nw.relation.trim(), sort: 0 })
                }
                setBusy(false)
                if (!id) { setErr('신입생 등록 실패: ' + lastErr); return }
                setExtra([...extra, { id, name }]); setKid(id); setKind('add'); setScope('always')
              }}>+ 신입생 등록하고 차량 배정하기</button>
              <span className="hint">출석번호는 자동으로 정해져요. 자세한 정보는 나중에 🥋 학생 탭에서 채우세요.</span>
            </div>
          )}
          {admin ? null : (<>
          {kids.length > 1 && (
            <div className="pills">{kids.map((k) => <button key={k.id} className={kid === k.id ? 'pill on' : 'pill'} onClick={() => { setKid(k.id); setFrom(''); setTo('') }}>{k.name}</button>)}</div>
          )}
          </>)}
          <label>{t.rqWhen}
            <div className="seg">
              <button className={scope === 'once' ? 'on' : ''} onClick={() => setScope('once')}>{t.rqOnce}</button>
              <button className={scope === 'always' ? 'on' : ''} onClick={() => setScope('always')}>{t.rqAlways}</button>
            </div>
          </label>
          {scope === 'once' && (
            <div className="row">
              <button className={date === kstDate() ? 'pill on' : 'pill'} onClick={() => setDate(kstDate())}>{t.rqToday}</button>
              <button className={date === addDay(kstDate(), 1) ? 'pill on' : 'pill'} onClick={() => setDate(addDay(kstDate(), 1))}>{t.rqTomorrow}</button>
              <input type="date" className="grow" value={date} min={kstDate()} onChange={(e) => e.target.value && setDate(e.target.value)} />
            </div>
          )}
          <div className="pay-opts">
            {([['skip', '🚫', t.rqSkip], ['add', '✅', t.rqAdd], ['change', '🔄', t.rqChange]] as const).map(([k, ic, label]) => (
              <button key={k} className={kind === k ? 'pay-opt on' : 'pay-opt'} onClick={() => { setKind(k); setTo(''); setRunId('') }}>
                <span className="radio" /> <span className="pay-ico">{ic}</span> {label}
              </button>
            ))}
          </div>

          {kind !== 'add' && (
            <label>{t.rqFrom}
              <select value={from} onChange={(e) => { setFrom(e.target.value); setTo(''); setRunId('') }}>
                <option value="">{current.length ? t.rqPick : t.rqNone}</option>
                {current.map(({ r, rs }) => <option key={r.id} value={rs.id}>{rsLabel(rs.id)} {r.action === 'board' ? t.rqBoard : t.rqAlight}</option>)}
              </select>
            </label>
          )}
          {kind !== 'skip' && (kind === 'add' || from) && (
            <>
              {!admin && <p className="sh-stop-note">ℹ️ {t.rqStopNote}</p>}
              <label>{t.rqRun}
                <select value={targetRun} onChange={(e) => { setRunId(e.target.value); setTo('') }}>
                  <option value="">{t.rqPick}</option>
                  {runs.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </label>
              {targetRun && (
                <label>{t.rqTo}
                  <select value={to} onChange={(e) => setTo(e.target.value)}>
                    <option value="">{t.rqPick}</option>
                    {targetStops.map((rs) => <option key={rs.id} value={rs.id}>{hm(rs.at_time)} {stopLabel(data.stops.find((s) => s.id === rs.stop_id), !admin)}</option>)}
                  </select>
                </label>
              )}
              {kind === 'add' && (
                <div className="seg">
                  <button className={action === 'board' ? 'on' : ''} onClick={() => setAction('board')}>{t.rqBoard}</button>
                  <button className={action === 'alight' ? 'on' : ''} onClick={() => setAction('alight')}>{t.rqAlight}</button>
                </div>
              )}
            </>
          )}

          {cut && !departed && <p className={`small ${late ? 'danger' : 'muted'}`}>⏰ {(late ? t.rqLate : t.rqDeadline).replace('{time}', clock(cut))}</p>}
          {departed && <p className="small danger">{t.rqDeparted}</p>}
          <label>{t.rqReason}{late ? ' *' : ''}
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t.rqReasonHint} />
          </label>
          {scope === 'always' && <p className="muted small">{t.rqAlwaysHint}</p>}
          {err && <div className="error">{err}</div>}
          <button className="primary big" disabled={busy || !ready} onClick={send}>{busy ? t.loading : admin ? '✓ 저장하고 바로 반영' : t.rqSend}</button>
        </div>
      </div>
    </div>
  )
}
const addDay = (d: string, n: number): string => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400_000).toISOString().slice(0, 10)
const dayOfDateLocal = (d: string): string => '일월화수목금토'[new Date(d + 'T00:00:00Z').getUTCDay()]

/* ---------------- 관리자: 운행 구역 그리기 ---------------- */

type DrawMode = { kind: 'ok' | 'no'; shape: 'line' | 'area' }
const MODE_LABEL = (m: DrawMode): string => `${m.kind === 'ok' ? '갈 수 있는' : '못 가는'} ${m.shape === 'line' ? '길' : '동네'}`

export function AreaEditor({ data, place, orgId, onSaved, big }: { data: ShuttleData; place: Place | null; orgId: string; onSaved(): Promise<void>; big?: boolean }): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const map = useMapAdapter(box, place?.lat != null && place.lng != null ? [place.lat, place.lng] : [37.318, 126.835], 16)
  const [mode, setMode] = useState<DrawMode | null>(null)
  const [pts, setPts] = useState<LL[]>([])
  const [name, setName] = useState('')
  const [showParents, setShowParents] = useState(true)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const modeRef = useRef<DrawMode | null>(null)
  modeRef.current = mode

  // 지도 누르면 점 추가 (그리는 중일 때만)
  useEffect(() => {
    if (!map) return
    map.onClick((a, b) => { if (modeRef.current) setPts((p) => [...p, [a, b]]) })
  }, [map])

  // 저장된 구역 + 정류장 이름표(참고용)
  useEffect(() => {
    if (!map) return
    const made = data.areas.flatMap((a) => drawArea(map, a))
    for (const st of data.stops) {
      if (st.lat == null || st.lng == null) continue
      made.push(map.marker([st.lat, st.lng], `<div class="map-stop small"><span class="num">●</span><span class="nm">${st.name.replace(/[<>&]/g, '')}</span></div>`, 26, st.name, 100, [13, 13]))
    }
    if (place?.lat != null && place.lng != null) made.push(map.marker([place.lat, place.lng], pinHtml('🥋', 'dojang'), 26, place.name, 150))
    return () => made.forEach((x) => x.remove())
  }, [map, data.areas, data.stops, place])

  // 그리는 중인 모양
  useEffect(() => {
    if (!map || !mode) return
    const made = pts.length >= 2 ? drawArea(map, { id: 'draft', name: '', kind: mode.kind, shape: mode.shape, points: pts, show_parents: true }) : []
    pts.forEach((p) => made.push(map.marker(p, '<div class="map-vertex"></div>', 12, '', 900)))
    return () => made.forEach((x) => x.remove())
  }, [map, pts, mode])

  const start = (m: DrawMode): void => { setMode(m); setPts([]); setName(''); setErr(null) }
  const cancel = (): void => { setMode(null); setPts([]) }
  const save = async (): Promise<void> => {
    if (!mode) return
    const need = mode.shape === 'line' ? 2 : 3
    if (pts.length < need) return setErr(`점을 ${need}개 이상 찍어 주세요.`)
    setBusy(true); setErr(null)
    const { error } = await supabase.from('shuttle_areas').insert({ org_id: orgId, name: name.trim() || MODE_LABEL(mode), kind: mode.kind, shape: mode.shape, points: pts, show_parents: showParents })
    setBusy(false)
    if (error) return setErr('저장 실패: ' + errText(error))
    cancel()
    await onSaved()
  }
  const remove = async (a: Area): Promise<void> => {
    if (!window.confirm(`"${a.name}" 표시를 지울까요?`)) return
    await supabase.from('shuttle_areas').delete().eq('id', a.id)
    await onSaved()
  }
  const toggleParents = async (a: Area): Promise<void> => {
    await supabase.from('shuttle_areas').update({ show_parents: !a.show_parents }).eq('id', a.id)
    await onSaved()
  }

  return (
    <div className="form area-editor">
      {!mode ? (
        <>
          <p className="muted small">그릴 종류를 고르고 지도를 콕콕 눌러 점을 찍으세요. <b>길</b>은 선으로, <b>동네</b>는 둘러싸는 모양으로 그려요.</p>
          <div className="area-modes">
            <button className="am ok" onClick={() => start({ kind: 'ok', shape: 'line' })}>🟩 갈 수 있는 길</button>
            <button className="am no" onClick={() => start({ kind: 'no', shape: 'line' })}>🟥 못 가는 길</button>
            <button className="am ok" onClick={() => start({ kind: 'ok', shape: 'area' })}>🟩 갈 수 있는 동네</button>
            <button className="am no" onClick={() => start({ kind: 'no', shape: 'area' })}>▨ 못 가는 동네</button>
          </div>
        </>
      ) : (
        <div className="area-drawing">
          <b>✏️ {MODE_LABEL(mode)} 그리는 중</b> <span className="muted small">· 점 {pts.length}개 (지도를 눌러 추가)</span>
          <input placeholder={`이름 (예: ${mode.kind === 'ok' ? '원곡로 큰길' : '원곡동 다세대 골목'})`} value={name} onChange={(e) => setName(e.target.value)} />
          <label className="check small"><input type="checkbox" checked={showParents} onChange={(e) => setShowParents(e.target.checked)} /><span>학부모 지도에도 보이기</span></label>
          <div className="row">
            <button className="ghost small-btn" disabled={!pts.length} onClick={() => setPts(pts.slice(0, -1))}>↩ 점 하나 취소</button>
            <button className="ghost small-btn" onClick={cancel}>그만 그리기</button>
            <button className="primary small-btn grow" disabled={busy} onClick={save}>✓ 완료하고 저장</button>
          </div>
        </div>
      )}
      {err && <div className="error">{err}</div>}
      <div ref={box} className={`rv-map area-map ${big ? 'big' : ''} ${mode ? 'drawing' : ''}`} />
      <div className="rv-legend">
        <span><i className="lg-ok" /> 갈 수 있음</span>
        <span><i className="lg-no" /> 못 감 (빗금)</span>
      </div>
      {data.areas.length > 0 && (
        <ul className="plain area-list">
          {data.areas.map((a) => (
            <li key={a.id} className="item-row">
              <span className={`chip ${a.kind === 'ok' ? 'live' : 'danger'}`}>{a.kind === 'ok' ? '갈 수 있음' : '못 감'}</span>
              <span className="grow"><b>{a.name}</b> <span className="muted tiny">{a.shape === 'line' ? '길' : '동네'}</span></span>
              <button className="ghost small-btn" title="학부모 지도 표시" onClick={() => toggleParents(a)}>{a.show_parents ? '👪 보임' : '👪 숨김'}</button>
              <button className="ghost small-btn" onClick={() => map?.fit(a.points)}>보기</button>
              <button className="ghost small-btn danger" onClick={() => remove(a)}>삭제</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
