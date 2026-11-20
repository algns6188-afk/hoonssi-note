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

  // 1) 출석·청구 알림: DB 트리거만 호출할 수 있음
  if (!NOTIFY_SECRET || req.headers.get('x-notify-secret') !== NOTIFY_SECRET) return json({ error: 'forbidden' }, 403)
  if (body.invoice_id) return json(await invoiceNotice(String(body.invoice_id), String(body.event ?? '')))

  const id = String(body.attendance_id ?? '')
  const { data: a, error: aErr } = await db.from('attendance').select('id,student_id,kind,at,org_id').eq('id', id).maybeSingle()
  if (aErr) return json({ error: 'db', detail: aErr.message }, 500)
  if (!a) return json({ error: 'not found' }, 404)
  const [{ data: student }, { data: org }] = await Promise.all([
    db.from('students').select('name').eq('id', a.student_id).maybeSingle(),
    db.from('orgs').select('name').eq('id', a.org_id).maybeSingle()
  ])
  const target = await guardianDevices(a.student_id)
  if ('reason' in target) return json({ sent: 0, reason: target.reason })
  const name = student?.name ?? ''
  const r = await sendAll(target.subs, (s) => {
    const m = MSG[lang(target.langOf.get(s.user_id) ?? s.lang)]
    return {
      title: a.kind === 'in' ? m.in(name) : m.out(name),
      body: `${hhmm(a.at)} · ${org?.name ?? ''}`,
      tag: `att-${a.student_id}`
    }
  })
  return json(r)
})

/** 학생 보호자들의 알림 기기 + 각자 언어 */
async function guardianDevices(studentId: string): Promise<{ subs: Sub[]; langOf: Map<string, string> } | { reason: string }> {
  const { data: guardians } = await db.from('guardians').select('user_id').eq('student_id', studentId)
  const userIds = (guardians ?? []).map((g) => g.user_id as string)
  if (!userIds.length) return { reason: 'no guardians' }
  const [{ data: subs }, { data: members }] = await Promise.all([
    db.from('push_subscriptions').select('*').in('user_id', userIds),
    db.from('members').select('user_id,lang').in('user_id', userIds)
  ])
  if (!subs?.length) return { reason: 'no devices' }
  return { subs: subs as Sub[], langOf: new Map((members ?? []).map((m) => [m.user_id as string, m.lang as string])) }
}

/* ---------------- 청구·납부 알림 ---------------- */

const ITEM: Record<string, Record<Exclude<Lang, 'ko'>, string>> = {
  수련비: { zh: '学费', ru: 'плата за обучение', en: 'tuition' },
  심사비: { zh: '考级费', ru: 'аттестация', en: 'belt test fee' },
  '대회 참가비': { zh: '比赛报名费', ru: 'взнос за соревнования', en: 'competition fee' },
  도복비: { zh: '道服费', ru: 'форма (добок)', en: 'uniform (dobok)' },
  체험학습비: { zh: '体验学习费', ru: 'экскурсия', en: 'field trip fee' }
}
const RU_MONTH = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь']
const EN_MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** "12월 수련비" 를 각 언어로 */
export function itemLabel(item: string, period: string | null, l: Lang): string {
  const m = period ? Number(period.slice(5, 7)) : 0
  if (l === 'ko') return (m ? `${m}월 ` : '') + item
  const name = ITEM[item]?.[l] ?? item
  if (!m) return name
  if (l === 'zh') return `${m}月${name}`
  if (l === 'ru') return `${name} (${RU_MONTH[m - 1]})`
  return `${EN_MONTH[m - 1]} ${name}`
}
const money = (n: number, l: Lang): string => (l === 'ko' ? `${n.toLocaleString('ko-KR')}원` : `₩${n.toLocaleString('en-US')}`)
const md = (d: string | null, l: Lang): string => {
  if (!d) return ''
  const [, mm, dd] = d.split('-').map(Number)
  return l === 'ko' ? `${mm}월 ${dd}일` : l === 'ru' ? `${String(dd).padStart(2, '0')}.${String(mm).padStart(2, '0')}` : `${mm}/${dd}`
}
const BILL: Record<Lang, { created: (n: string, x: string) => string; paid: (n: string, x: string) => string; due: (d: string) => string }> = {
  ko: { created: (n, x) => `💳 ${n} ${x} 청구`, paid: (n, x) => `✅ ${n} ${x} 납부 확인됐어요`, due: (d) => `납부 기한 ${d}` },
  zh: { created: (n, x) => `💳 ${n} ${x}账单`, paid: (n, x) => `✅ ${n} ${x}已确认缴费`, due: (d) => `截止 ${d}` },
  ru: { created: (n, x) => `💳 ${n}: счёт — ${x}`, paid: (n, x) => `✅ ${n}: оплата подтверждена — ${x}`, due: (d) => `оплатить до ${d}` },
  en: { created: (n, x) => `💳 ${n}: ${x} bill`, paid: (n, x) => `✅ ${n}: payment confirmed — ${x}`, due: (d) => `due ${d}` }
}

const REFUND: Record<Lang, (n: string, x: string) => string> = {
  ko: (n, x) => `↩️ ${n} ${x} 카드 결제가 취소(환불)됐어요`,
  zh: (n, x) => `↩️ ${n} ${x}刷卡付款已取消（退款）`,
  ru: (n, x) => `↩️ ${n}: оплата картой отменена (возврат) — ${x}`,
  en: (n, x) => `↩️ ${n}: card payment canceled (refunded) — ${x}`
}

/** 도장 직원(관리자·선생님)들의 알림 기기 */
async function staffDevices(orgId: string): Promise<Sub[]> {
  const { data: ms } = await db.from('members').select('user_id,role').eq('org_id', orgId)
  const ids = (ms ?? []).filter((m) => m.role !== 'parent' && m.role !== 'kiosk').map((m) => m.user_id as string)
  if (!ids.length) return []
  const { data: subs } = await db.from('push_subscriptions').select('*').in('user_id', ids)
  return (subs as Sub[]) ?? []
}

async function invoiceNotice(id: string, event: string) {
  if (!['created', 'paid', 'reported', 'refund'].includes(event)) return { sent: 0, reason: 'event' }
  const { data: inv, error } = await db.from('invoices').select('id,org_id,student_id,item_name,period,amount,due_date,paid_amount,paid_via,reported_payer').eq('id', id).maybeSingle()
  if (error) return { error: 'db', detail: error.message }
  if (!inv) return { error: 'not found' }
  const { data: student } = await db.from('students').select('name').eq('id', inv.student_id).maybeSingle()
  const name = student?.name ?? ''
  const out: Record<string, unknown> = {}

  // 도장 폰: 학부모가 온라인 결제·입금 신고했을 때, 카드 결제 취소됐을 때
  const online = event === 'paid' && String(inv.paid_via ?? '').includes('이지페이')
  if (online || event === 'reported' || event === 'refund') {
    const staff = await staffDevices(inv.org_id)
    const x = itemLabel(inv.item_name, inv.period, 'ko')
    const amt = money(inv.paid_amount ?? inv.amount, 'ko')
    out.staff = staff.length ? await sendAll(staff, () => (
      event === 'reported' ? { title: `🏦 ${name} ${x} 입금했어요`, body: `${money(inv.amount, 'ko')}${inv.reported_payer ? ` · 입금자 ${inv.reported_payer}` : ''} · 확인해 주세요`, tag: `staff-bill-${inv.id}` }
        : event === 'refund' ? { title: `↩️ ${name} ${x} 카드 결제 취소`, body: `${money(inv.amount, 'ko')} 환불 · 다시 미납이에요`, tag: `staff-bill-${inv.id}` }
          : { title: `💳 ${name} ${x} 결제됐어요`, body: `${amt} · ${inv.paid_via}`, tag: `staff-bill-${inv.id}` }
    )) : { sent: 0, reason: 'no staff devices' }
  }

  // 학부모 폰: 청구됐을 때, 납부 확인됐을 때, 카드 결제 취소됐을 때
  if (event !== 'reported') {
    const target = await guardianDevices(inv.student_id)
    out.parents = 'reason' in target ? { sent: 0, reason: target.reason } : await sendAll(target.subs, (s) => {
      const l = lang(target.langOf.get(s.user_id) ?? s.lang)
      const x = itemLabel(inv.item_name, inv.period, l)
      const amount = money(event === 'paid' ? inv.paid_amount ?? inv.amount : inv.amount, l)
      return event === 'created'
        ? { title: BILL[l].created(name, x), body: amount + (inv.due_date ? ` · ${BILL[l].due(md(inv.due_date, l))}` : ''), tag: `bill-${inv.id}` }
        : event === 'refund' ? { title: REFUND[l](name, x), body: amount, tag: `bill-${inv.id}` }
          : { title: BILL[l].paid(name, x), body: amount, tag: `bill-${inv.id}` }
    })
  }
  return out
}
