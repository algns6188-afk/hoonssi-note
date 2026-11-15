// 강철노트 알림 발송 (Supabase Edge Function)
//  1) 출석 기록이 생기면 DB 트리거가 { attendance_id } 로 호출 → 그 아이 보호자 폰으로 알림
//  2) 앱의 "테스트 알림" 버튼 → { test: true } + 로그인 토큰 → 본인 폰으로 알림
import { createClient } from 'npm:@supabase/supabase-js@2'
import * as webpush from 'jsr:@negrel/webpush@0.3.0'

const SB_URL = Deno.env.get('SUPABASE_URL')!
// 새 방식 키(SUPABASE_SECRET_KEYS)가 있으면 그것을, 없으면 예전 방식 키를 사용
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
const SERVICE_KEY = serviceKey()
const NOTIFY_SECRET = Deno.env.get('NOTIFY_SECRET') ?? ''
const db = createClient(SB_URL, SERVICE_KEY, { auth: { persistSession: false } })

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}
const json = (v: unknown, status = 200): Response =>
  new Response(JSON.stringify(v), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

type Lang = 'ko' | 'zh' | 'ru' | 'en'
const MSG: Record<Lang, { in: (n: string) => string; out: (n: string) => string; testTitle: string; testBody: string }> = {
  ko: { in: (n) => `✅ ${n} 등원했어요`, out: (n) => `👋 ${n} 하원했어요`, testTitle: '🔔 알림이 켜졌어요', testBody: '아이가 등원·하원하면 이렇게 알려드려요.' },
  zh: { in: (n) => `✅ ${n} 已到馆`, out: (n) => `👋 ${n} 已离馆`, testTitle: '🔔 通知已开启', testBody: '孩子到馆、离馆时会这样通知您。' },
  ru: { in: (n) => `✅ ${n}: приход`, out: (n) => `👋 ${n}: уход`, testTitle: '🔔 Уведомления включены', testBody: 'Так мы сообщим, когда ребёнок придёт или уйдёт.' },
  en: { in: (n) => `✅ ${n} checked in`, out: (n) => `👋 ${n} checked out`, testTitle: '🔔 Notifications are on', testBody: "We'll let you know like this when your child checks in or out." }
}
const lang = (l: string | null | undefined): Lang => (l && l in MSG ? (l as Lang) : 'ko')
const hhmm = (iso: string): string =>
  new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul' })

let appServer: webpush.ApplicationServer | null = null
async function server(): Promise<webpush.ApplicationServer> {
  if (!appServer) {
    const vapidKeys = await webpush.importVapidKeys(JSON.parse(Deno.env.get('VAPID_KEYS')!), { extractable: false })
    appServer = await webpush.ApplicationServer.new({ contactInformation: 'mailto:admin@kangcheol.app', vapidKeys })
  }
  return appServer
}

interface Sub { endpoint: string; user_id: string; p256dh: string; auth: string; lang: string }

/** 기기 목록으로 보내고, 없어진 기기(404/410)는 지움 */
async function sendAll(subs: Sub[], make: (s: Sub) => Record<string, unknown>) {
  const app = await server()
  let sent = 0, failed = 0, removed = 0
  const errors: string[] = []
  await Promise.all(
    subs.map(async (s) => {
      try {
        await app
          .subscribe({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } })
          .pushTextMessage(JSON.stringify(make(s)), { ttl: 6 * 3600, urgency: webpush.Urgency.High })
        sent++
        await db.from('push_subscriptions').update({ last_ok_at: new Date().toISOString() }).eq('endpoint', s.endpoint)
      } catch (e) {
        failed++
        const status = e instanceof webpush.PushMessageError ? e.response.status : 0
        if (status === 404 || status === 410) {
          await db.from('push_subscriptions').delete().eq('endpoint', s.endpoint)
          removed++
        } else errors.push(status ? `HTTP ${status}` : String(e).slice(0, 120))
      }
    })
  )
  return { sent, failed, removed, errors }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const body = await req.json().catch(() => ({}))

  // 2) 테스트 알림: 로그인한 본인 기기로
  if (body.test) {
    const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
    const { data, error } = await db.auth.getUser(token)
    if (error || !data.user) return json({ error: 'login required' }, 401)
    const { data: subs } = await db.from('push_subscriptions').select('*').eq('user_id', data.user.id)
    if (!subs?.length) return json({ error: 'no device' }, 400)
    const r = await sendAll(subs as Sub[], (s) => ({ title: MSG[lang(s.lang)].testTitle, body: MSG[lang(s.lang)].testBody, tag: 'test' }))
    return json(r)
  }

  // 1) 출석 알림: DB 트리거만 호출할 수 있음
  if (!NOTIFY_SECRET || req.headers.get('x-notify-secret') !== NOTIFY_SECRET) return json({ error: 'forbidden' }, 403)
  const id = String(body.attendance_id ?? '')
  const { data: a, error: aErr } = await db.from('attendance').select('id,student_id,kind,at,org_id').eq('id', id).maybeSingle()
  if (aErr) return json({ error: 'db', detail: aErr.message }, 500)
  if (!a) return json({ error: 'not found' }, 404)
  const [{ data: student }, { data: org }, { data: guardians }] = await Promise.all([
    db.from('students').select('name').eq('id', a.student_id).maybeSingle(),
    db.from('orgs').select('name').eq('id', a.org_id).maybeSingle(),
    db.from('guardians').select('user_id').eq('student_id', a.student_id)
  ])
  const userIds = (guardians ?? []).map((g) => g.user_id as string)
  if (!userIds.length) return json({ sent: 0, reason: 'no guardians' })
  const [{ data: subs }, { data: members }] = await Promise.all([
    db.from('push_subscriptions').select('*').in('user_id', userIds),
    db.from('members').select('user_id,lang').in('user_id', userIds)
  ])
  if (!subs?.length) return json({ sent: 0, reason: 'no devices' })
  const langOf = new Map((members ?? []).map((m) => [m.user_id as string, m.lang as string]))
  const name = student?.name ?? ''
  const r = await sendAll(subs as Sub[], (s) => {
    const m = MSG[lang(langOf.get(s.user_id) ?? s.lang)]
    return {
      title: a.kind === 'in' ? m.in(name) : m.out(name),
      body: `${hhmm(a.at)} · ${org?.name ?? ''}`,
      tag: `att-${a.student_id}`
    }
  })
  return json(r)
})
