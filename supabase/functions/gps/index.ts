// 강철노트 GPS 수신 (Supabase Edge Function "gps")
//  Traccar Client 앱(아이폰·안드로이드)이 화면이 꺼져 있어도 보내는 위치를 받아서
//  지금 시간표에 맞는 운행을 자동으로 시작하고, 정류장 도착(70m 안)을 처리합니다.
//  ⚠️ 이 함수는 앱이 로그인 없이 부르므로 대시보드에서 "Verify JWT"(JWT 검증)를 꺼 주세요.
//     대신 차량마다 길고 무작위인 "기기 식별자"로 확인합니다.
//  받는 형식: ① 예전 OsmAnd 방식  ?id=식별자&lat=..&lon=..&speed=..(노트)
//            ② 새 Traccar Client JSON  { device_id, location: { coords: { latitude, longitude, speed } } }
import { createClient } from 'npm:@supabase/supabase-js@2'

function serviceKey(): string {
  try {
    const m = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS') ?? '')
    const v = m?.default ?? Object.values(m ?? {})[0]
    if (typeof v === 'string' && v) return v
  } catch {
    // 없음
  }
  return Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
}
const db = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey(), { auth: { persistSession: false } })
const ok = (v: unknown = { ok: true }): Response => new Response(JSON.stringify(v), { status: 200, headers: { 'Content-Type': 'application/json' } })

interface Fix { id: string; lat: number; lng: number; speed: number | null }

function fromParams(p: URLSearchParams): Fix | null {
  const id = p.get('id') ?? p.get('deviceid') ?? p.get('device_id')
  const lat = Number(p.get('lat')), lng = Number(p.get('lon') ?? p.get('lng'))
  if (!id || !Number.isFinite(lat) || !Number.isFinite(lng)) return null
  const sp = p.get('speed')
  // OsmAnd 의 speed 는 노트(knot) → km/h
  return { id, lat, lng, speed: sp != null && sp !== '' ? Number(sp) * 1.852 : null }
}

function fromJson(j: Record<string, unknown>): Fix[] {
  const id = String(j.device_id ?? j.deviceId ?? j.id ?? '')
  const locs = Array.isArray(j.location) ? j.location : j.location ? [j.location] : []
  const out: Fix[] = []
  for (const l of locs as Record<string, any>[]) {
    const c = l?.coords ?? l
    const lat = Number(c?.latitude), lng = Number(c?.longitude)
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lng)) continue
    const sp = Number(c?.speed)
    // 새 앱의 speed 는 m/s (모르면 -1)
    out.push({ id, lat, lng, speed: Number.isFinite(sp) && sp >= 0 ? sp * 3.6 : null })
  }
  return out
}

Deno.serve(async (req) => {
  try {
    const url = new URL(req.url)
    let fixes: Fix[] = []
    const q = fromParams(url.searchParams)
    if (q) fixes = [q]
    if (!fixes.length && req.method === 'POST') {
      const text = await req.text()
      try {
        fixes = fromJson(JSON.parse(text))
      } catch {
        const f = fromParams(new URLSearchParams(text))   // 폼 형식으로 온 경우
        if (f) fixes = [f]
      }
    }
    // 여러 개가 한꺼번에 오면(신호 끊겼다 다시 연결) 마지막 위치만 처리
    const last = fixes[fixes.length - 1]
    if (!last) return ok({ ok: false, error: 'no_location' })
    if (Math.abs(last.lat) > 90 || Math.abs(last.lng) > 180) return ok({ ok: false, error: 'bad_location' })
    const { data, error } = await db.rpc('shuttle_device_ping', { p_token: last.id, p_lat: last.lat, p_lng: last.lng, p_speed: last.speed })
    // 앱이 계속 다시 보내지 않도록 항상 200 으로 답함
    return ok(error ? { ok: false, error: error.message } : data)
  } catch (e) {
    return ok({ ok: false, error: String((e as Error)?.message ?? e) })
  }
})
