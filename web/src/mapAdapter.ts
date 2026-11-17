import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

/* 지도 공통 모듈: 네이버 지도를 먼저 쓰고, 안 되면(키·네트워크 문제) OpenStreetMap(Leaflet)으로 자동 전환 */

// 네이버 클라우드 Maps Client ID (공개용 값. 등록된 주소 https://algns6188-afk.github.io 에서만 작동)
const NAVER_CLIENT_ID = 'zc0mshtqki'

export type LL = [number, number]
export interface MarkerH { setPos(ll: LL): void; remove(): void }
export interface LineH { setPath(lls: LL[]): void; remove(): void }
export interface MapAdapter {
  kind: 'naver' | 'osm'
  setView(ll: LL, zoom: number): void
  fit(lls: LL[]): void
  marker(ll: LL, html: string, size: number, title?: string, z?: number): MarkerH
  polyline(lls: LL[], o: { color: string; weight: number; dashed?: boolean }): LineH
  onClick(cb: (lat: number, lng: number) => void): void
  destroy(): void
}

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global { interface Window { naver?: any; navermap_authFailure?: () => void } }

let naverState: Promise<boolean> | null = null
function loadNaver(): Promise<boolean> {
  if (naverState) return naverState
  naverState = new Promise<boolean>((ok) => {
    if (window.naver?.maps) return ok(true)
    let done = false
    const finish = (v: boolean): void => { if (!done) { done = true; ok(v) } }
    // 키가 안 맞거나 주소 미등록: 지도를 이미 만들었으면 OpenStreetMap 으로 다시 그리게 알림
    window.navermap_authFailure = () => { naverFailed = true; finish(false); fallbackSubs.forEach((f) => f()) }
    const sc = document.createElement('script')
    sc.src = `https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=${NAVER_CLIENT_ID}&submodules=geocoder`
    sc.onload = () => finish(!!window.naver?.maps)
    sc.onerror = () => finish(false)
    document.head.appendChild(sc)
    window.setTimeout(() => finish(!!window.naver?.maps), 8000)
  })
  return naverState
}
let naverFailed = false
const fallbackSubs = new Set<() => void>()
/** 네이버 인증이 나중에 실패했을 때 다시 그리기 */
export function onMapFallback(cb: () => void): () => void { fallbackSubs.add(cb); return () => fallbackSubs.delete(cb) }

function naverMap(el: HTMLElement, center: LL, zoom: number): MapAdapter {
  const N = window.naver.maps
  const P = (ll: LL): any => new N.LatLng(ll[0], ll[1])
  const map = new N.Map(el, { center: P(center), zoom, zoomControl: true, zoomControlOptions: { position: N.Position.TOP_LEFT, style: N.ZoomControlStyle.SMALL }, scaleControl: false, mapDataControl: false })
  return {
    kind: 'naver',
    setView: (ll, z) => { map.setCenter(P(ll)); map.setZoom(z) },
    fit: (lls) => {
      if (!lls.length) return
      if (lls.length === 1) { map.setCenter(P(lls[0])); map.setZoom(16); return }
      const b = new N.LatLngBounds(P(lls[0]), P(lls[0]))
      for (const ll of lls) b.extend(P(ll))
      map.fitBounds(b, { top: 40, right: 30, bottom: 30, left: 30 })
      if (map.getZoom() > 16) map.setZoom(16)
    },
    marker: (ll, html, size, title, z) => {
      const m = new N.Marker({ position: P(ll), map, title, zIndex: z ?? 100, icon: { content: html, anchor: new N.Point(size / 2, size / 2) } })
      return { setPos: (p) => m.setPosition(P(p)), remove: () => m.setMap(null) }
    },
    polyline: (lls, o) => {
      const l = new N.Polyline({ map, path: lls.map(P), strokeColor: o.color, strokeWeight: o.weight, strokeOpacity: 1, strokeStyle: o.dashed ? 'shortdash' : 'solid', strokeLineCap: 'round', strokeLineJoin: 'round' })
      return { setPath: (p) => l.setPath(p.map(P)), remove: () => l.setMap(null) }
    },
    onClick: (cb) => { N.Event.addListener(map, 'click', (e: any) => cb(e.coord.lat(), e.coord.lng())) },
    destroy: () => { try { map.destroy() } catch { /* 없음 */ } }
  }
}

function osmMap(el: HTMLElement, center: LL, zoom: number): MapAdapter {
  const map = L.map(el, { zoomControl: true, attributionControl: true }).setView(center, zoom)
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap' }).addTo(map)
  return {
    kind: 'osm',
    setView: (ll, z) => map.setView(ll, z),
    fit: (lls) => { if (lls.length) map.fitBounds(L.latLngBounds(lls), { padding: [30, 30], maxZoom: 16 }) },
    marker: (ll, html, size, title, z) => {
      const m = L.marker(ll, { icon: L.divIcon({ className: '', html, iconSize: [size, size], iconAnchor: [size / 2, size / 2] }), zIndexOffset: z ?? 0 }).addTo(map)
      if (title) m.bindTooltip(title)
      return { setPos: (p) => m.setLatLng(p), remove: () => m.remove() }
    },
    polyline: (lls, o) => {
      const l = L.polyline(lls, { color: o.color, weight: o.weight, dashArray: o.dashed ? '8 8' : undefined }).addTo(map)
      return { setPath: (p) => l.setLatLngs(p), remove: () => l.remove() }
    },
    onClick: (cb) => { map.on('click', (e: L.LeafletMouseEvent) => cb(e.latlng.lat, e.latlng.lng)) },
    destroy: () => map.remove()
  }
}

/** 지도 만들기: 네이버 → 안 되면 OpenStreetMap */
export async function createMap(el: HTMLElement, center: LL, zoom: number): Promise<MapAdapter> {
  if (!naverFailed && (await loadNaver()) && !naverFailed) {
    try { return naverMap(el, center, zoom) } catch { naverFailed = true }
  }
  el.innerHTML = ''
  return osmMap(el, center, zoom)
}

/** 주소 → 위치 (네이버 Geocoding). 못 찾으면 null, 네이버 주소검색을 못 쓰면 'unavailable' */
export async function geocode(query: string): Promise<LL | null | 'unavailable'> {
  if (!(await loadNaver()) || !window.naver?.maps?.Service) return 'unavailable'
  const S = window.naver.maps.Service
  return new Promise((ok) => {
    const timer = window.setTimeout(() => ok('unavailable'), 8000)
    try {
      S.geocode({ query }, (status: unknown, res: any) => {
        clearTimeout(timer)
        if (status !== S.Status.OK) return ok('unavailable')
        const a = res?.v2?.addresses?.[0]
        ok(a ? [Number(a.y), Number(a.x)] : null)
      })
    } catch { clearTimeout(timer); ok('unavailable') }
  })
}

/** "원초로9 안산8차푸르지오" → "경기도 안산시 단원구 원초로 9" 처럼 검색용 주소 만들기 */
export function addressQuery(address: string, name: string): string | null {
  const src = `${address} ${name}`
  if (/경기|안산시/.test(address)) return address.trim()
  const m = /([가-힣][가-힣0-9]*?(?:로|길)(?:[0-9]+(?:번|안)?길)?)\s?([0-9]+(?:-[0-9]+)?)/.exec(src)
  return m ? `경기도 안산시 단원구 ${m[1]} ${m[2]}` : null
}
