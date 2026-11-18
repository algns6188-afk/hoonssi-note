// 강철노트 장소 검색 (Supabase Edge Function "place-search")
//  POST { query } → 네이버 검색 API(지역 검색)로 "롯데캐슬", "도원약국" 같은 장소 이름을 찾아 위치를 돌려줌
//  비밀값 (둘 중 하나만 있으면 됨):
//   - 카카오: KAKAO_REST_KEY (developers.kakao.com 앱의 REST API 키)
//   - 네이버: NAVER_SEARCH_ID, NAVER_SEARCH_SECRET (developers.naver.com 애플리케이션의 Client ID / Client Secret)
import { createClient } from 'npm:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}
const json = (v: unknown, status = 200): Response =>
  new Response(JSON.stringify(v), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY') ?? '', { auth: { persistSession: false } })
const strip = (s: string): string => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').trim()

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    // 로그인한 사람만
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    const { data: u } = await db.auth.getUser(token)
    if (!u?.user) return json({ error: 'login_required' }, 401)

    const { query, area } = await req.json()
    if (typeof query !== 'string' || !query.trim() || query.length > 80) return json({ error: 'bad_request' }, 400)
    const region = typeof area === 'string' && area ? area : '안산'
    const q = query.includes(region) ? query.trim() : `${region} ${query.trim()}`
    const ok = (x: { lat: number; lng: number }): boolean => x.lat > 30 && x.lat < 40 && x.lng > 120 && x.lng < 135
    let items: { name: string; category: string; address: string; lat: number; lng: number }[] = []

    const kakao = Deno.env.get('KAKAO_REST_KEY')
    const nid = Deno.env.get('NAVER_SEARCH_ID'), nsecret = Deno.env.get('NAVER_SEARCH_SECRET')
    if (kakao) {
      // 카카오 키워드 장소 검색 (안산 원곡동 근처 우선)
      const r = await fetch(`https://dapi.kakao.com/v2/local/search/keyword.json?query=${encodeURIComponent(q)}&size=8&x=126.83&y=37.32&sort=accuracy`, {
        headers: { Authorization: `KakaoAK ${kakao.trim()}` }
      })
      const j = await r.json()
      if (!r.ok) return json({ error: j?.message ?? 'search_failed', code: j?.errorType }, 400)
      items = (j.documents ?? []).map((d: Record<string, string>) => ({
        name: d.place_name ?? '', category: (d.category_name ?? '').split('>').pop()?.trim() ?? '',
        address: d.road_address_name || d.address_name || '', lat: Number(d.y), lng: Number(d.x)
      })).filter(ok)
    } else if (nid && nsecret) {
      const r = await fetch(`https://openapi.naver.com/v1/search/local.json?query=${encodeURIComponent(q)}&display=5&sort=random`, {
        headers: { 'X-Naver-Client-Id': nid.trim(), 'X-Naver-Client-Secret': nsecret.trim() }
      })
      const j = await r.json()
      if (!r.ok) return json({ error: j?.errorMessage ?? 'search_failed', code: j?.errorCode }, 400)
      items = (j.items ?? []).map((i: Record<string, string>) => ({
        name: strip(i.title ?? ''), category: i.category ?? '', address: i.roadAddress || i.address || '',
        // 네이버 지역 검색 좌표: 경도·위도 × 10,000,000
        lat: Number(i.mapy) / 1e7, lng: Number(i.mapx) / 1e7
      })).filter(ok)
    } else return json({ error: 'no_key' }, 500)
    return json({ items })
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})
