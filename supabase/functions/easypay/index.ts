// 강철노트 이지페이(KICC) 온라인 결제 (Supabase Edge Function "easypay")
//  ※ 배포할 때 "Verify JWT" 는 끄세요 — 이지페이 결제창·노티가 로그인 없이 이 주소로 돌아옵니다. (로그인 확인은 아래에서 직접 함)
//
//  ① POST {action:'register', invoiceIds, method:'card'|'vbank', back}  (학부모 로그인 토큰 필요)
//     → 청구서가 그 학부모 아이 것인지·금액 확인 → 이지페이 거래등록 → 결제창 주소(authPageUrl) 돌려줌
//  ② ?a=return  : 결제창에서 카드 입력/은행 선택이 끝나면 이지페이가 학부모 폰을 이 주소로 보냄
//     → 이지페이 승인 요청 → 카드: 청구서 "납부" / 가상계좌: 계좌 발급("입금 대기") → 강철노트 화면으로 돌려보냄
//  ③ ?a=noti    : 이지페이 서버가 보내는 알림(가상계좌 입금 등). 가맹점 관리자에서 노티 URL 로 등록
//
//  상점ID(MID)는 강철노트 수납 설정에서 저장(orgs.easypay_mid). 비밀키는 필요 없음.
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
const SB_URL = Deno.env.get('SUPABASE_URL')!
const db = createClient(SB_URL, serviceKey(), { auth: { persistSession: false } })
const SELF = `${SB_URL}/functions/v1/easypay`
const APP = 'https://algns6188-afk.github.io/hoonssi-note/'
// 돌아갈 화면 주소는 이 주소들로만 (아무 사이트로나 보내지 않게)
const BACK_OK = [/^https:\/\/algns6188-afk\.github\.io\/hoonssi-note\//, /^http:\/\/localhost(:\d+)?\//]

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
}
const json = (v: unknown, status = 200): Response =>
  new Response(JSON.stringify(v), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })
const api = (live: boolean): string => (live ? 'https://pgapi.easypay.co.kr' : 'https://testpgapi.easypay.co.kr')
const kstDate = (): string => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '')
const rid = (n: number): string => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => (b % 36).toString(36)).join('')

/** 화면으로 돌려보내기 (주소 이동 페이지) */
function goBack(back: string | null, q: Record<string, string>): Response {
  const base = back && BACK_OK.some((r) => r.test(back)) ? back : APP
  const u = new URL(base)
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v)
  const to = u.toString()
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>강철노트</title>` +
    `<p style="font:16px sans-serif;padding:24px">강철노트로 돌아가는 중…</p><script>location.replace(${JSON.stringify(to)})</script>`,
    { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  if (req.method === 'GET') return Object.fromEntries(new URL(req.url).searchParams)
  const ct = req.headers.get('content-type') ?? ''
  const text = await req.text()
  if (ct.includes('json') || /^\s*\{/.test(text)) { try { return JSON.parse(text) } catch { /* 아래 */ } }
  return Object.fromEntries(new URLSearchParams(text))
}

/** 응답 안에서 가상계좌 정보 찾기 (은행·계좌·입금기한) */
function findVbank(o: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (v: unknown): void => {
    if (!v || typeof v !== 'object') return
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x && typeof x === 'object') { walk(x); continue }
      if (x == null || x === '') continue
      const s = String(x)
      if (/bankName/i.test(k)) out.bank ??= s
      else if (/bankCode/i.test(k)) out.bankCode ??= s
      else if (/(account|vacct).*(No|Num)/i.test(k)) out.account ??= s
      else if (/(expir|deadline|due|limit).*(Date|Time)?/i.test(k)) out.due ??= s
      else if (/(depositor|holder|accountName|vacctName)/i.test(k)) out.holder ??= s
    }
  }
  walk(o)
  return out
}

async function markPaid(order: { invoice_ids: string[]; method: string }, pgCno: string, via: string): Promise<void> {
  const { data: invs } = await db.from('invoices').select('*').in('id', order.invoice_ids)
  for (const inv of invs ?? []) {
    if (inv.status === 'paid' || inv.status === 'canceled') continue
    await db.from('invoices').update({
      status: 'paid', paid_amount: inv.amount, paid_method: order.method === 'card' ? 'card' : 'transfer', paid_at: new Date().toISOString(),
      paid_via: via, payment_key: pgCno,
      memo: [inv.memo, `이지페이${order.invoice_ids.length > 1 ? ` (${order.invoice_ids.length}건 함께)` : ''}`].filter(Boolean).join(' · ')
    }).eq('id', inv.id)
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const a = new URL(req.url).searchParams.get('a')
  try {
    /* ③ 노티: 이지페이 서버 → 기록. 가상계좌 입금이면 납부 처리 */
    if (a === 'noti') {
      const b = await readBody(req)
      const orderNo = String(b.shopOrderNo ?? '')
      let handled = 'logged'
      const { data: order } = orderNo ? await db.from('easypay_orders').select('*').eq('order_no', orderNo).maybeSingle() : { data: null }
      // 가상계좌 입금 알림: 결제수단 22 + 입금 금액/입금일시가 들어 있을 때만 (발급 알림과 구분)
      const flat = JSON.stringify(b)
      const isDeposit = String(b.payMethodTypeCode ?? '') === '22' && /deposit|입금/i.test(flat) && !/cancel|취소|refund|환불/i.test(String(b.notiType ?? '') + String(b.resMsg ?? ''))
      if (order && order.method === 'vbank' && order.status === 'waiting' && String(b.resCd ?? '0000') === '0000' && isDeposit) {
        const amt = Number(b.amount ?? b.depositAmount ?? order.amount)
        if (amt === order.amount) {
          await markPaid(order, String(b.pgCno ?? order.pg_cno ?? ''), '가상계좌(이지페이)')
          await db.from('easypay_orders').update({ status: 'paid', paid_at: new Date().toISOString() }).eq('id', order.id)
          handled = 'paid'
        } else handled = 'amount_mismatch'
      }
      await db.from('easypay_notis').insert({ order_no: orderNo || null, body: b, handled })
      return new Response(JSON.stringify({ resCd: '0000', resMsg: 'Success' }), { headers: { 'Content-Type': 'application/json' } })
    }

    /* ② 결제창에서 돌아옴 → 승인 */
    if (a === 'return') {
      const b = await readBody(req)
      const orderNo = String(b.shopOrderNo ?? new URL(req.url).searchParams.get('o') ?? '')
      const { data: order } = await db.from('easypay_orders').select('*').eq('order_no', orderNo).maybeSingle()
      if (!order) return goBack(null, { ep: 'fail', m: '주문을 찾지 못했어요' })
      if (order.status !== 'ready') return goBack(order.back_url, { ep: order.status === 'waiting' ? 'vbank' : order.status === 'paid' ? 'ok' : 'fail', o: orderNo })
      if (String(b.resCd ?? '') !== '0000' || !b.authorizationId) {
        await db.from('easypay_orders').update({ status: 'failed', message: String(b.resMsg ?? '결제 취소'), raw: b }).eq('id', order.id)
        return goBack(order.back_url, { ep: 'fail', m: String(b.resMsg ?? '') })
      }
      const { data: org } = await db.from('orgs').select('easypay_mid, easypay_live').eq('id', order.org_id).single()
      const r = await fetch(`${api(!!org?.easypay_live)}/api/ep9/trades/approval`, {
        method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ mallId: org?.easypay_mid, shopTransactionId: 'kca' + Date.now().toString(36) + rid(6), authorizationId: String(b.authorizationId), shopOrderNo: orderNo, approvalReqDate: kstDate() })
      })
      const p = await r.json().catch(() => ({}))
      if (p.resCd !== '0000') {
        await db.from('easypay_orders').update({ status: 'failed', message: String(p.resMsg ?? '승인 실패'), raw: p }).eq('id', order.id)
        return goBack(order.back_url, { ep: 'fail', m: String(p.resMsg ?? '') })
      }
      const amount = Number(p.amount ?? p.paymentInfo?.amount ?? order.amount)
      if (amount !== order.amount) {
        await db.from('easypay_orders').update({ status: 'check', pg_cno: p.pgCno ?? null, message: `금액 다름 (${amount})`, raw: p }).eq('id', order.id)
        return goBack(order.back_url, { ep: 'fail', m: '금액이 달라요. 도장에 문의해 주세요' })
      }
      if (order.method === 'vbank') {
        await db.from('easypay_orders').update({ status: 'waiting', pg_cno: p.pgCno ?? null, vbank: findVbank(p), raw: p }).eq('id', order.id)
        return goBack(order.back_url, { ep: 'vbank', o: orderNo })
      }
      await markPaid(order, String(p.pgCno ?? ''), '카드(이지페이)')
      await db.from('easypay_orders').update({ status: 'paid', pg_cno: p.pgCno ?? null, paid_at: new Date().toISOString(), raw: p }).eq('id', order.id)
      return goBack(order.back_url, { ep: 'ok', o: orderNo })
    }

    /* ① 결제 등록 (학부모 화면에서) */
    if (req.method !== 'POST') return json({ error: 'bad_request' }, 400)
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    const { data: u } = await db.auth.getUser(token)
    if (!u?.user) return json({ error: 'login_required' }, 401)
    const { invoiceIds, method, back, mobile } = await req.json()
    const ids: string[] = Array.isArray(invoiceIds) ? invoiceIds.filter((x: unknown) => typeof x === 'string' && /^[0-9a-f-]{36}$/.test(x as string)) : []
    if (!ids.length || ids.length > 50 || (method !== 'card' && method !== 'vbank')) return json({ error: 'bad_request' }, 400)

    const { data: invs } = await db.from('invoices').select('*').in('id', ids)
    if (!invs || invs.length !== ids.length) return json({ error: 'no_invoice' }, 404)
    const orgId = invs[0].org_id
    if (invs.some((i: { org_id: string }) => i.org_id !== orgId)) return json({ error: 'bad_request' }, 400)
    const { data: mem } = await db.from('members').select('role,org_id').eq('user_id', u.user.id).maybeSingle()
    const { data: gs } = await db.from('guardians').select('student_id').eq('user_id', u.user.id)
    const mine = new Set((gs ?? []).map((g: { student_id: string }) => g.student_id))
    for (const inv of invs) {
      const staff = mem && mem.org_id === inv.org_id && mem.role !== 'parent'
      if (!mine.has(inv.student_id) && !staff) return json({ error: 'not_allowed' }, 403)
    }
    if (invs.some((i: { status: string }) => i.status === 'paid' || i.status === 'canceled')) return json({ error: 'already_paid' }, 409)
    const amount = invs.reduce((s: number, i: { amount: number }) => s + i.amount, 0)
    if (amount <= 0) return json({ error: 'bad_amount' }, 400)

    const { data: org } = await db.from('orgs').select('easypay_mid, easypay_live, easypay_vbank').eq('id', orgId).single()
    if (!org?.easypay_mid) return json({ error: 'easypay_off' }, 400)
    if (method === 'vbank' && !org.easypay_vbank) return json({ error: 'vbank_off' }, 400)

    const orderNo = 'KC' + kstDate().slice(2) + rid(10).toUpperCase()
    const { data: names } = await db.from('students').select('name').in('id', [...new Set(invs.map((i: { student_id: string }) => i.student_id))])
    const goods = `${(names ?? []).map((n: { name: string }) => n.name).join(',')} ${invs[0].item_name}${invs.length > 1 ? ` 외 ${invs.length - 1}건` : ''}`.slice(0, 50)
    const backUrl = typeof back === 'string' && BACK_OK.some((r) => r.test(back)) ? back : APP
    await db.from('easypay_orders').insert({ org_id: orgId, order_no: orderNo, invoice_ids: ids, amount, method, back_url: backUrl, created_by: u.user.id })

    const r = await fetch(`${api(!!org.easypay_live)}/api/ep9/trades/webpay`, {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        mallId: org.easypay_mid, payMethodTypeCode: method === 'card' ? '11' : '22', currency: '00', amount,
        clientTypeCode: '00', returnUrl: `${SELF}?a=return`, shopOrderNo: orderNo,
        deviceTypeCode: mobile ? 'mobile' : 'pc', orderInfo: { goodsName: goods }
      })
    })
    const p = await r.json().catch(() => ({}))
    if (p.resCd !== '0000' || !p.authPageUrl) {
      await db.from('easypay_orders').update({ status: 'failed', message: String(p.resMsg ?? '등록 실패'), raw: p }).eq('order_no', orderNo)
      return json({ error: p.resMsg ?? 'register_failed' }, 400)
    }
    return json({ ok: true, url: p.authPageUrl, orderNo })
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})
