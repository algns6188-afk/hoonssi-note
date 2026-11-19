// 강철노트 현금영수증 발급·취소 (Supabase Edge Function "cash-receipt")
//  관리자·선생님이 수납 표에서 [발급]을 누르면 토스페이먼츠 현금영수증 API로 국세청에 발급하고
//  승인번호·영수증 주소를 청구서에 저장합니다.
//  필요한 비밀값: TOSS_SECRET_KEY (토스페이먼츠 시크릿 키 — 카드 결제와 같은 키)
//  수련비 등 교육비는 면세라서 금액 전체를 면세(taxFreeAmount)로 보냅니다. (과세 사업자면 CASH_RECEIPT_TAXABLE=1)
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
    const { data: me } = await db.from('members').select('org_id, role').eq('user_id', u.user.id).maybeSingle()
    if (!me || !['admin', 'staff'].includes(me.role)) return json({ error: 'not_allowed' }, 403)

    const { invoiceId, action, identity, type } = await req.json()
    const { data: inv } = await db.from('invoices').select('*').eq('id', invoiceId).maybeSingle()
    if (!inv || inv.org_id !== me.org_id) return json({ error: 'no_invoice' }, 404)

    const secret = Deno.env.get('TOSS_SECRET_KEY')
    if (!secret) return json({ error: 'no_secret' }, 500)
    const auth = { Authorization: 'Basic ' + btoa(secret.trim() + ':'), 'Content-Type': 'application/json' }

    if (action === 'cancel') {
      if (!inv.receipt_key) return json({ error: 'not_auto' }, 400)   // 단말기·홈택스로 발급한 건 거기서 취소
      const r = await fetch(`https://api.tosspayments.com/v1/cash-receipts/${encodeURIComponent(inv.receipt_key)}/cancel`, { method: 'POST', headers: auth, body: '{}' })
      const j = await r.json().catch(() => ({}))
      if (!r.ok) return json({ error: j?.message ?? 'cancel_failed', code: j?.code }, 400)
      await db.from('invoices').update({ receipt_issued: false, receipt_approval: '', receipt_key: null, receipt_url: null, receipt_at: null, receipt_how: '' }).eq('id', inv.id)
      return json({ ok: true })
    }

    // 발급
    if (inv.status !== 'paid') return json({ error: 'not_paid' }, 400)
    if (inv.receipt_issued) return json({ error: 'already' }, 409)
    const id = String(identity ?? '').replace(/\D/g, '')
    if (!(id.length >= 10 && id.length <= 19)) return json({ error: 'bad_identity' }, 400)   // 휴대폰 10~11, 사업자번호 10, 현금영수증카드 13~19
    const kind = type === '지출증빙' ? '지출증빙' : '소득공제'
    const amount = Number(inv.paid_amount ?? inv.amount)
    const month = inv.period ? `${Number(String(inv.period).slice(5, 7))}월 ` : ''
    const body: Record<string, unknown> = {
      amount, orderId: `cr-${String(inv.id).slice(0, 8)}-${Date.now().toString(36)}`,
      orderName: `${month}${inv.item_name}`.slice(0, 100), customerIdentityNumber: id, type: kind
    }
    if (Deno.env.get('CASH_RECEIPT_TAXABLE') !== '1') body.taxFreeAmount = amount
    const r = await fetch('https://api.tosspayments.com/v1/cash-receipts', { method: 'POST', headers: auth, body: JSON.stringify(body) })
    const j = await r.json().catch(() => ({}))
    if (!r.ok) return json({ error: j?.message ?? 'issue_failed', code: j?.code }, 400)
    await db.from('invoices').update({
      receipt_issued: true, receipt_no: id, receipt_type: kind,
      receipt_approval: j.issueNumber ?? j.approvalNumber ?? '', receipt_key: j.receiptKey ?? null,
      receipt_url: j.receiptUrl ?? null, receipt_at: new Date().toISOString(), receipt_how: '자동(강철노트)'
    }).eq('id', inv.id)
    return json({ ok: true, approval: j.issueNumber ?? '', url: j.receiptUrl ?? null, status: j.issueStatus ?? null })
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500)
  }
})
