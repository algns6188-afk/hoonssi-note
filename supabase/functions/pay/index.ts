// 강철노트 학부모 카드·토스페이 결제 승인 (Supabase Edge Function "pay")
//  학부모 폰에서 토스페이먼츠 결제창 → 결제 성공 → 앱이 { paymentKey, orderId, amount } 를 보내면
//  1) 로그인한 학부모가 그 아이 보호자인지, 2) 금액이 청구 금액과 같은지 확인하고
//  3) 토스페이먼츠에 승인 요청 → 성공하면 청구서를 "납부 완료" 로 바꿉니다.
//  필요한 비밀값: TOSS_SECRET_KEY (토스페이먼츠 개발자센터의 시크릿 키, test_sk_… 또는 live_sk_…)
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

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}
const json = (v: unknown, status = 200): Response =>
  new Response(JSON.stringify(v), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  try {
    const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '')
    const { data: u } = await db.auth.getUser(token)
    if (!u?.user) return json({ error: 'login_required' }, 401)

    const { paymentKey, orderId, amount } = await req.json()
    if (typeof paymentKey !== 'string' || typeof orderId !== 'string' || typeof amount !== 'number') return json({ error: 'bad_request' }, 400)
    // orderId = "inv-<청구서 id>-<임의값>"
    const m = /^inv-([0-9a-f-]{36})-[A-Za-z0-9]+$/.exec(orderId)
    if (!m) return json({ error: 'bad_order' }, 400)

    const { data: inv } = await db.from('invoices').select('*').eq('id', m[1]).maybeSingle()
    if (!inv) return json({ error: 'no_invoice' }, 404)
    const { data: g } = await db.from('guardians').select('user_id').eq('student_id', inv.student_id).eq('user_id', u.user.id).maybeSingle()
    const { data: mem } = await db.from('members').select('role,org_id').eq('user_id', u.user.id).maybeSingle()
    if (!g && !(mem && mem.org_id === inv.org_id && mem.role !== 'parent')) return json({ error: 'not_allowed' }, 403)
    if (inv.status === 'paid') return json({ ok: true, already: true })
    if (inv.status === 'canceled') return json({ error: 'canceled' }, 409)
    if (amount !== inv.amount) return json({ error: 'amount_mismatch' }, 400)

    const secret = Deno.env.get('TOSS_SECRET_KEY')
    if (!secret) return json({ error: 'no_secret' }, 500)
    const r = await fetch('https://api.tosspayments.com/v1/payments/confirm', {
      method: 'POST',
      headers: { Authorization: 'Basic ' + btoa(secret + ':'), 'Content-Type': 'application/json', 'Idempotency-Key': orderId },
      body: JSON.stringify({ paymentKey, orderId, amount })
    })
    const p = await r.json()
    if (!r.ok || p.status !== 'DONE') return json({ error: p.message ?? p.code ?? 'confirm_failed', code: p.code }, 400)

    const via = p.easyPay?.provider ? `${p.easyPay.provider}(온라인)` : p.card?.issuerCode ? '카드(온라인)' : `${p.method ?? '온라인'}(온라인)`
    await db.from('invoices').update({
      status: 'paid', paid_amount: p.totalAmount ?? amount, paid_method: 'card', paid_at: p.approvedAt ?? new Date().toISOString(),
      paid_via: via, payment_key: paymentKey, memo: [inv.memo, `온라인결제 ${p.orderName ?? ''}`.trim()].filter(Boolean).join(' · ')
    }).eq('id', inv.id)
    return json({ ok: true, via, receipt: p.receipt?.url ?? null })
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})
