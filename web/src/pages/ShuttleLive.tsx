import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { supabase, errText } from '../supabase'
import { useI18n } from '../i18n'
import { hm, loadShuttle, ridersAt, stopsOn, type Run, type RunStop, type ShuttleData, type Stop } from './Shuttle'

/* 강철셔틀 실시간: 노선도 · 지도 경로 · 기사님 운행 모드 */

export interface Trip {
  id: string; run_id: string; day: string; started_at: string; ended_at: string | null
  lat: number | null; lng: number | null; speed: number | null; pos_at: string | null
  passed: Record<string, string>
}
export interface Place { name: string; lat: number | null; lng: number | null }

export const kstDate = (): string => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)
const atToday = (time: string): number => Date.parse(`${kstDate()}T${time.slice(0, 5)}:00+09:00`)
const clock = (ms: number): string => new Date(ms + 9 * 3600_000).toISOString().slice(11, 16)

/** 오늘 운행 기록 (실시간) */
export function useTrips(): { trips: Trip[]; v9: boolean } {
  const [trips, setTrips] = useState<Trip[]>([])
  const [ok, setOk] = useState(true)
  const load = useCallback(async () => {
    const { data, error } = await supabase.from('shuttle_trips').select('*').eq('day', kstDate())
    if (error) setOk(false)
    else setTrips((data as Trip[]) ?? [])
  }, [])
  useEffect(() => {
    load()
    const ch = supabase.channel('shuttle-trips-' + Math.random().toString(36).slice(2))
      .on('postgres_changes', { event: '*', schema: 'public', table: 'shuttle_trips' }, () => load())
      .subscribe()
    const iv = window.setInterval(load, 30_000) // 실시간이 끊겨도 30초마다
    return () => { void supabase.removeChannel(ch); clearInterval(iv) }
  }, [load])
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

export function RouteView({ data, run, day, trip, place, names, mineOnly }: {
  data: ShuttleData; run: Run; day: string; trip?: Trip; place: Place | null
  names: (id: string) => string | null   // 우리 아이(또는 관리자는 전체) 이름, 아니면 null
  mineOnly?: boolean
}): JSX.Element {
  const { t } = useI18n()
  const [tab, setTab] = useState<'route' | 'map'>('route')
  const list = stopsOn(data, run, day)
  const stopOf = (id: string): Stop | undefined => data.stops.find((s) => s.id === id)
  const eta = etaOf(list, trip)
  const lastPassed = list.reduce((n, rs, i) => (trip?.passed[rs.id] ? i : n), -1)
  const running = !!trip && !trip.ended_at
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
      {running && !trip?.pos_at && <p className="muted tiny rv-sig">📡 {t.shNoGps}</p>}

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
            const kids = ridersAt(data, rs, run, day).map((r) => ({ r, n: names(r.student_id) })).filter((x) => x.n)
            const mine = kids.length > 0
            const e = eta.get(rs.id)
            return (
              <li key={rs.id} className={`rv-stop ${passedAt ? 'done' : ''} ${mine && mineOnly ? 'mine' : ''}`}>
                <span className="rv-dot">{passedAt ? '✓' : String(i + 1).padStart(2, '0')}</span>
                <div className="grow">
                  <b>{st?.name ?? '?'}</b>
                  {st?.wait_note && <div className="muted tiny">{st.wait_note}</div>}
                  {kids.map(({ r, n }) => (
                    <div key={r.id} className={`rv-kid ${r.action}`}>{(r.action === 'board' ? t.shBoard : t.shAlight).replace('{name}', n!)}</div>
                  ))}
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
        <RouteMap data={data} run={run} list={list} trip={trip} place={place} mineIds={!mineOnly ? new Set() : new Set(list.filter((rs) => ridersAt(data, rs, run, day).some((r) => names(r.student_id))).map((rs) => rs.id))} />
      )}
    </div>
  )
}

const numIcon = (n: number | string, cls: string): L.DivIcon =>
  L.divIcon({ className: '', html: `<div class="map-pin ${cls}">${n}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] })

function RouteMap({ data, run, list, trip, place, mineIds }: {
  data: ShuttleData; run: Run; list: RunStop[]; trip?: Trip; place: Place | null; mineIds: Set<string>
}): JSX.Element {
  const { t } = useI18n()
  const box = useRef<HTMLDivElement>(null)
  const map = useRef<L.Map | null>(null)
  const layer = useRef<L.LayerGroup | null>(null)
  const bus = useRef<L.Marker | null>(null)
  const trail = useRef<L.Polyline | null>(null)
  const [trailPts, setTrailPts] = useState<[number, number][]>([])

  const pts = useMemo(() => {
    const out: { ll: [number, number]; label: string; id: string; name: string }[] = []
    const dojang = place?.lat != null && place.lng != null ? { ll: [place.lat, place.lng] as [number, number], label: '🥋', id: 'dojang', name: place.name } : null
    if (dojang && run.kind !== 'to') out.push(dojang)
    list.forEach((rs, i) => {
      const s = data.stops.find((x) => x.id === rs.stop_id)
      if (s?.lat != null && s.lng != null) out.push({ ll: [s.lat, s.lng], label: String(i + 1), id: rs.id, name: s.name })
    })
    if (dojang && run.kind !== 'from') out.push({ ...dojang, id: 'dojang-end' })
    return out
  }, [data, run, list, place])

  // 지나온 길 불러오기
  useEffect(() => {
    if (!trip) { setTrailPts([]); return }
    supabase.from('shuttle_points').select('lat,lng').eq('trip_id', trip.id).order('at').limit(2000)
      .then(({ data: d }) => setTrailPts(((d as { lat: number; lng: number }[]) ?? []).map((p) => [p.lat, p.lng])))
  }, [trip?.id])
  useEffect(() => {
    if (trip?.lat != null && trip.lng != null) setTrailPts((p) => [...p, [trip.lat!, trip.lng!]])
  }, [trip?.lat, trip?.lng])

  useEffect(() => {
    if (!box.current || map.current) return
    map.current = L.map(box.current, { zoomControl: true, attributionControl: true }).setView([37.32, 126.83], 14)
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map.current)
    layer.current = L.layerGroup().addTo(map.current)
    return () => { map.current?.remove(); map.current = null }
  }, [])

  const fitAll = useCallback(() => {
    const all: [number, number][] = pts.map((p) => p.ll)
    if (trip?.lat != null && trip.lng != null) all.push([trip.lat, trip.lng])
    if (all.length) map.current?.fitBounds(L.latLngBounds(all), { padding: [30, 30], maxZoom: 16 })
  }, [pts, trip?.lat, trip?.lng])

  useEffect(() => {
    const g = layer.current
    if (!g) return
    g.clearLayers()
    if (pts.length > 1) L.polyline(pts.map((p) => p.ll), { color: '#9bbf95', weight: 5, dashArray: '8 8' }).addTo(g)
    for (const p of pts) {
      const passed = !!trip?.passed[p.id]
      L.marker(p.ll, { icon: numIcon(p.label, `${passed ? 'passed' : ''} ${mineIds.has(p.id) ? 'mine' : ''} ${p.id.startsWith('dojang') ? 'dojang' : ''}`) })
        .bindTooltip(p.name).addTo(g)
    }
    fitAll()
  }, [pts, mineIds]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!map.current) return
    if (trail.current) trail.current.setLatLngs(trailPts)
    else trail.current = L.polyline(trailPts, { color: '#1f5b45', weight: 6 }).addTo(map.current)
  }, [trailPts])

  useEffect(() => {
    if (!map.current) return
    if (trip?.lat != null && trip.lng != null && !trip.ended_at) {
      const ll: [number, number] = [trip.lat, trip.lng]
      if (bus.current) bus.current.setLatLng(ll)
      else bus.current = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="map-bus">🚐</div>', iconSize: [36, 36], iconAnchor: [18, 18] }), zIndexOffset: 1000 }).addTo(map.current)
    } else if (bus.current) { bus.current.remove(); bus.current = null }
  }, [trip?.lat, trip?.lng, trip?.ended_at])

  const noCoords = pts.filter((p) => !p.id.startsWith('dojang')).length === 0
  return (
    <div className="rv-map-wrap">
      <div ref={box} className="rv-map" />
      <div className="rv-map-btns">
        <button onClick={fitAll}>{t.shFitAll}</button>
        {trip?.lat != null && <button onClick={() => map.current?.setView([trip.lat!, trip.lng!], 16)}>🚐 {t.shBusPos}</button>}
      </div>
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
          const kids = ridersAt(data, rs, run, day)
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
  const map = useRef<L.Map | null>(null)
  const pin = useRef<L.Marker | null>(null)
  const cb = useRef(onPick)
  cb.current = onPick
  useEffect(() => {
    if (!box.current) return
    const m = L.map(box.current).setView(lat != null && lng != null ? [lat, lng] : [37.318, 126.835], lat != null ? 17 : 14)
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(m)
    m.on('click', (e: L.LeafletMouseEvent) => cb.current(e.latlng.lat, e.latlng.lng))
    map.current = m
    return () => { m.remove(); map.current = null; pin.current = null }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!map.current) return
    if (lat == null || lng == null) { pin.current?.remove(); pin.current = null; return }
    if (pin.current) pin.current.setLatLng([lat, lng])
    else pin.current = L.marker([lat, lng], { icon: numIcon('📍', 'pick') }).addTo(map.current)
  }, [lat, lng])
  const here = (): void => navigator.geolocation?.getCurrentPosition(
    (p) => { cb.current(p.coords.latitude, p.coords.longitude); map.current?.setView([p.coords.latitude, p.coords.longitude], 17) },
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

/* ---------------- 학부모: 오늘 우리 아이가 타는 차량 ---------------- */

export function ParentShuttle({ kids }: { kids: { id: string; name: string }[] }): JSX.Element | null {
  const { t } = useI18n()
  const [data, setData] = useState<ShuttleData | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const { trips } = useTrips()
  const place = usePlace()
  useEffect(() => {
    loadShuttle().then(setData)
  }, [])
  if (!data) return null
  const day = '일월화수목금토'[new Date(Date.now() + 9 * 3600_000).getUTCDay()]
  const kidName = (id: string): string | null => kids.find((k) => k.id === id)?.name ?? null
  const runs = data.runs
    .filter((r) => r.active)
    .map((run) => ({ run, list: stopsOn(data, run, day) }))
    .filter(({ run, list }) => list.some((rs) => ridersAt(data, rs, run, day).some((r) => kidName(r.student_id))))
    .sort((a, b) => (a.list[0]?.at_time ?? '').localeCompare(b.list[0]?.at_time ?? ''))
  if (!runs.length) return null
  const firstOpen = open ?? (runs.find(({ run }) => trips.some((x) => x.run_id === run.id && !x.ended_at))?.run.id ?? runs[0].run.id)

  return (
    <section className="card pshuttle">
      <h3>🚐 {t.shTitle}</h3>
      {runs.map(({ run, list }) => {
        const trip = trips.find((x) => x.run_id === run.id)
        const st = !trip ? t.shBefore : trip.ended_at ? t.shEnded : t.shRunning
        const isOpen = firstOpen === run.id
        return (
          <div key={run.id} className={`ps-run ${isOpen ? 'open' : ''}`}>
            <button className="ps-head" onClick={() => setOpen(isOpen ? '' : run.id)}>
              <span className="rv-time"><b>{hm(list[0]?.at_time ?? null)}</b></span>
              <span className="grow"><b>{run.name}</b></span>
              <span className={`chip ${trip && !trip.ended_at ? 'live' : ''}`}>{trip && !trip.ended_at ? '● ' : ''}{st}</span>
              <span className="muted">{isOpen ? '▲' : '▼'}</span>
            </button>
            {isOpen && <RouteView data={data} run={run} day={day} trip={trip} place={place} names={kidName} mineOnly />}
          </div>
        )
      })}
    </section>
  )
}
