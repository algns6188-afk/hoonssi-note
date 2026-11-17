import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createMap, onMapFallback, roadPath, type LL, type MapAdapter, type MarkerH } from '../mapAdapter'
import { supabase, errText } from '../supabase'
import { useI18n } from '../i18n'
import { activeRide, describeRequest, type RideView, hm, loadShuttle, ridersView, stopsOn, type RideRequest, type Run, type RunStop, type ShuttleData, type Stop } from './Shuttle'

/* 강철셔틀 실시간: 노선도 · 지도 경로 · 기사님 운행 모드 */

export interface Trip {
  id: string; run_id: string; day: string; started_at: string; ended_at: string | null
  lat: number | null; lng: number | null; speed: number | null; pos_at: string | null
  passed: Record<string, string>
  kid_done?: boolean   // 학부모: 우리 아이 정류장을 다 지남 → 차량 위치 안 보여 줌
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
  const [tab, setTab] = useState<'route' | 'map'>('route')
  const date = kstDate()
  const list = stopsOn(data, run, day, date)
  const stopOf = (id: string): Stop | undefined => data.stops.find((s) => s.id === id)
  const eta = etaOf(list, trip)
  const lastPassed = list.reduce((n, rs, i) => (trip?.passed[rs.id] ? i : n), -1)
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
                  <b>{st?.name ?? '?'}</b>
                  {st?.wait_note && <div className="muted tiny">{st.wait_note}</div>}
                  {kids.length > 0 && (
                    <div className="riders">
                      {kids.map(({ v, n }) => (
                        <span key={v.key} className={`rider ${v.action} ${v.tag ? 'tag-' + v.tag : ''}`} title={v.note}>
                          {v.action === 'board' ? '⬆' : '⬇'} {(v.action === 'board' ? t.shBoard : t.shAlight).replace('{name}', n!)}
                          {v.tag === 'skip' && <em>{t.rqTagSkip}</em>}
                          {v.tag === 'add' && <em>{t.rqTagAdd}</em>}
                          {v.tag === 'moved' && <em>{v.to ? `→ ${v.to}` : t.rqTagStopped}</em>}
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
                </div>
                <div className="rv-time">
                  {passedAt ? <><b>{clock(Date.parse(passedAt))}</b><div className="muted tiny">{t.shPassed}</div></>
                    : e ? <><b>{clock(e)}</b><div className="muted tiny">{e > now ? t.shMinLater.replace('{n}', String(Math.max(1, Math.round((e - now) / 60000)))) : t.shEta}</div></>
                      : <><b>{hm(rs.at_time)}</b><div className="muted tiny">{t.shScheduled}</div></>}
                </div>
                {running && i === lastPassed && <div className="rv-bus">🚐 {t.shBusHere}</div>}
              </li>
            )
          })}
          {run.kind !== 'from' && (
            <li className="rv-stop dojang">
              <span className="rv-dot">🥋</span>
              <div className="grow"><b>{t.shDojangEnd}</b>{run.class_start && <div className="muted tiny">{hm(run.class_start)}</div>}</div>
            </li>
          )}
        </ol>
      ) : (
        <RouteMap data={data} run={run} list={list} trip={trip} place={place} mineIds={!mineOnly ? new Set() : new Set(list.filter((rs) => ridersView(data, rs, run, day, date).some((v) => activeRide(v) && names(v.student_id))).map((rs) => rs.id))} />
      )}
    </div>
  )
}

const pinHtml = (n: number | string, cls: string): string => `<div class="map-pin ${cls}">${n}</div>`

/** 지도 하나 만들고(네이버 → 안 되면 OSM), 네이버 인증이 늦게 실패하면 다시 만듦 */
function useMapAdapter(box: React.RefObject<HTMLDivElement>, center: LL, zoom: number): MapAdapter | null {
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

function RouteMap({ data, run, list, trip, place, mineIds }: {
  data: ShuttleData; run: Run; list: RunStop[]; trip?: Trip; place: Place | null; mineIds: Set<string>
}): JSX.Element {
  const { t } = useI18n()
  const box = useRef<HTMLDivElement>(null)
  const map = useMapAdapter(box, [37.32, 126.83], 14)
  const [road, setRoad] = useState<{ path: LL[]; idx: number[] } | null>(null)

  const pts = useMemo(() => {
    const out: { ll: LL; label: string; id: string; name: string }[] = []
    const dojang = place?.lat != null && place.lng != null ? { ll: [place.lat, place.lng] as LL, label: '🥋', id: 'dojang', name: place.name } : null
    if (dojang && run.kind !== 'to') out.push(dojang)
    list.forEach((rs, i) => {
      const s = data.stops.find((x) => x.id === rs.stop_id)
      if (s?.lat != null && s.lng != null) out.push({ ll: [s.lat, s.lng], label: String(i + 1), id: rs.id, name: s.name })
    })
    if (dojang && run.kind !== 'from') out.push({ ...dojang, id: 'dojang-end' })
    return out
  }, [data, run, list, place])
  const ptsKey = pts.map((p) => p.ll.join(',')).join(';')

  // 도로 경로 (안 되면 직선)
  useEffect(() => {
    let alive = true
    setRoad(null)
    roadPath(pts.map((p) => p.ll)).then((r) => { if (alive) setRoad(r ?? { path: pts.map((p) => p.ll), idx: pts.map((_, i) => i) }) })
    return () => { alive = false }
  }, [ptsKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // 차량은 실시간으로 움직이지 않고, 마지막으로 도착한 정류장에 표시
  const running = !!trip && !trip.ended_at && !trip.kid_done
  let at = -1
  if (trip) {
    pts.forEach((p, i) => { if (trip.passed[p.id]) at = i })
    if (at === -1 && pts[0]?.id === 'dojang') at = 0           // 도장에서 출발함
    if (trip.ended_at) at = pts.length - 1
    if (trip.kid_done && !trip.ended_at) at = -1   // 학부모: 우리 아이 끝난 뒤엔 위치 숨김
  }
  const busLL = running && at >= 0 ? pts[at].ll : null

  const fitAll = useCallback(() => { map?.fit(road?.path.length ? road.path : pts.map((p) => p.ll)) }, [map, road, pts])

  useEffect(() => {
    if (!map || !road) return
    const made: { remove(): void }[] = []
    if (road.path.length > 1) {
      made.push(map.polyline(road.path, { color: '#9bbf95', weight: 6 }))
      if (at > 0) made.push(map.polyline(road.path.slice(0, road.idx[at] + 1), { color: '#1f5b45', weight: 7 }))
    }
    pts.forEach((p, i) => {
      const passed = trip && i <= at
      const cls = `${passed ? 'passed' : ''} ${mineIds.has(p.id) ? 'mine' : ''} ${p.id.startsWith('dojang') ? 'dojang' : ''}`
      const html = `<div class="map-stop ${cls}"><span class="num">${p.label}</span><span class="nm">${p.name.replace(/[<>&]/g, '')}</span></div>`
      made.push(map.marker(p.ll, html, 26, p.name, mineIds.has(p.id) ? 300 : 200, [13, 13]))
    })
    if (busLL) made.push(map.marker(busLL, '<div class="map-bus">🚐</div>', 36, '', 1000, [18, 46]))
    return () => made.forEach((x) => x.remove())
  }, [map, road, pts, mineIds, at, busLL?.join(',')]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (map && road) fitAll() }, [map, road]) // eslint-disable-line react-hooks/exhaustive-deps

  const noCoords = pts.filter((p) => !p.id.startsWith('dojang')).length === 0
  return (
    <div className="rv-map-wrap">
      <div ref={box} className="rv-map" />
      <div className="rv-map-btns">
        <button onClick={fitAll}>{t.shFitAll}</button>
        {busLL && <button onClick={() => map?.setView(busLL, 16)}>🚐 {t.shBusPos}</button>}
      </div>
      <div className="rv-legend">
        <span><i className="lg-route" /> {t.shLegendRoute}</span>
        <span><i className="lg-passed" /> {t.shLegendPassed}</span>
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

  // 운행 시작 (오늘 이미 시작했으면 이어서)
  useEffect(() => {
    (async () => {
      const today = kstDate()
      const { data: ex } = await supabase.from('shuttle_trips').select('*').eq('run_id', run.id).eq('day', today).maybeSingle()
      if (ex) {
        const { data: up } = await supabase.from('shuttle_trips').update({ ended_at: null }).eq('id', (ex as Trip).id).select().single()
        setTrip((up as Trip) ?? (ex as Trip))
        return
      }
      const { data: created, error } = await supabase.from('shuttle_trips').insert({ org_id: orgId, run_id: run.id, day: today }).select().single()
      if (error) setErr('운행을 시작하지 못했어요: ' + errText(error))
      else setTrip(created as Trip)
    })()
  }, [run.id])

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
        const { data: r, error } = await supabase.rpc('shuttle_ping', { p_trip: trip.id, p_lat: g.lat, p_lng: g.lng, p_speed: g.speed })
        if (error) setErr('위치 전송 실패: ' + errText(error))
        else {
          setSent(Date.now())
          const passed = (r as { passed?: Record<string, string> })?.passed
          if (passed) setTrip((t) => (t ? { ...t, passed } : t))
        }
      },
      (e) => setErr(e.code === 1 ? '위치 권한이 꺼져 있어요. 설정 → 사파리(또는 앱) → 위치 → "허용"으로 바꿔 주세요.' : '위치를 찾는 중이에요… (' + e.message + ')'),
      { enableHighAccuracy: true, maximumAge: 3000, timeout: 20000 }
    )
    return () => navigator.geolocation.clearWatch(id)
  }, [trip?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const togglePassed = async (rs: RunStop): Promise<void> => {
    if (!trip) return
    const passed = { ...trip.passed }
    if (passed[rs.id]) delete passed[rs.id]
    else passed[rs.id] = new Date().toISOString()
    setTrip({ ...trip, passed })
    await supabase.from('shuttle_trips').update({ passed }).eq('id', trip.id)
  }
  const end = async (): Promise<void> => {
    if (trip && !window.confirm('운행을 끝낼까요? 학부모 화면에 "운행 끝"으로 바뀌어요.')) return
    if (trip) await supabase.from('shuttle_trips').update({ ended_at: new Date().toISOString() }).eq('id', trip.id)
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
      {err && <div className="error">{err}</div>}
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
      </ol>
      {place?.lat == null && <p className="muted small">도장 위치가 지도에 없어요. 📍 정류장 화면에서 도장 위치를 정해 주세요.</p>}
    </div>
  )
}

/* ---------------- 지도에서 위치 고르기 (정류장·도장) ---------------- */

export function PickMap({ lat, lng, onPick }: { lat: number | null; lng: number | null; onPick(lat: number, lng: number): void }): JSX.Element {
  const box = useRef<HTMLDivElement>(null)
  const map = useMapAdapter(box, lat != null && lng != null ? [lat, lng] : [37.318, 126.835], lat != null ? 17 : 14)
  const pin = useRef<MarkerH | null>(null)
  const cb = useRef(onPick)
  cb.current = onPick
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
  return (
    <div className="pickmap">
      <div ref={box} className="rv-map small-map" />
      <div className="row">
        <span className="muted small grow">지도를 눌러 위치를 찍어 주세요.</span>
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
  const d = describeRequest(data, q)
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
    return rs ? `${run?.name ?? ''} · ${hm(rs.at_time)} ${data.stops.find((s) => s.id === rs.stop_id)?.name ?? ''}` : ''
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
                    {targetStops.map((rs) => <option key={rs.id} value={rs.id}>{hm(rs.at_time)} {data.stops.find((s) => s.id === rs.stop_id)?.name}</option>)}
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
