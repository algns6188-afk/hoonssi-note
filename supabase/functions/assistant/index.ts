// 강철노트 관리자 자동 입력 (Supabase Edge Function)
//  POST { text }                 → Claude 가 무슨 일인지 해석해서 "할 일 목록"(미리보기)만 돌려줌
//  POST { text, execute: [...] } → 관리자가 [반영]을 누르면 실제로 처리 + 타임라인 기록
import Anthropic from 'npm:@anthropic-ai/sdk@1.6.0'
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

type ActionType = 'record_payment' | 'create_invoice' | 'attendance' | 'absence' | 'add_payer' | 'note'
interface Action {
  type: ActionType
  student_ids: string[]
  item_name: string | null
  period: string | null
  amount: number | null
  method: 'transfer' | 'cash' | 'card' | 'other' | null
  payer_name: string | null
  kind: 'in' | 'out' | null
  date: string | null
  time: string | null
  reason: string | null
  note: string | null
  summary: string
}

const nullable = (schema: Record<string, unknown>) => ({ anyOf: [schema, { type: 'null' }] })
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'question', 'actions'],
  properties: {
    reply: { type: 'string', description: '관리자에게 보여줄 한두 문장 요약 (한국어)' },
    question: nullable({ type: 'string', description: '누구인지·무엇인지 확실하지 않을 때만 되묻는 질문. 이때 actions 는 빈 배열' }),
    actions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['type', 'student_ids', 'item_name', 'period', 'amount', 'method', 'payer_name', 'kind', 'date', 'time', 'reason', 'note', 'summary'],
        properties: {
          type: { type: 'string', enum: ['record_payment', 'create_invoice', 'attendance', 'absence', 'add_payer', 'note'] },
          student_ids: { type: 'array', items: { type: 'string' } },
          item_name: nullable({ type: 'string' }),
          period: nullable({ type: 'string', description: 'YYYY-MM (수련비처럼 달이 있는 항목만)' }),
          amount: nullable({ type: 'integer' }),
          method: nullable({ type: 'string', enum: ['transfer', 'cash', 'card', 'other'] }),
          payer_name: nullable({ type: 'string' }),
          kind: nullable({ type: 'string', enum: ['in', 'out'] }),
          date: nullable({ type: 'string', description: 'YYYY-MM-DD' }),
          time: nullable({ type: 'string', description: 'HH:MM (24시간)' }),
          reason: nullable({ type: 'string' }),
          note: nullable({ type: 'string' }),
          summary: { type: 'string', description: '이 작업 한 줄 설명. 예: 김민준 11월 수련비 150,000원 납부 완료 (계좌이체)' }
        }
      }
    }
  }
}

const SYSTEM = `당신은 태권도장 관리 프로그램 "강철노트"의 입력 도우미입니다.
관장님·선생님이 짧게 쓴 메모를 읽고, 프로그램에서 처리할 작업 목록(actions)으로 바꿉니다. 직접 처리하지 않고 목록만 만듭니다. 관리자가 확인한 뒤 반영합니다.

작업 종류:
- record_payment: 입금·납부 완료. "김민준 11월 수련비 입금완료", "서연이 심사비 현금으로 받음". item_name 은 청구 항목 이름(수련비·심사비 등), 달이 있으면 period. method 는 말이 없으면 transfer(계좌이체), "현금"이면 cash, "카드"면 card. 금액을 말했으면 amount, 아니면 null(청구서 금액 사용). 입금자 이름을 말했으면 payer_name.
- create_invoice: 새로 청구. "민준이 도복비 3만원 청구". amount 필수(말 안 했으면 청구 항목 기본 금액). 기한을 말했으면 date.
- attendance: 출석 체크를 대신 기록. "민준이 어제 4시에 왔는데 체크 못함" → kind=in, date, time.
- absence: 결석. "서연이 내일 결석 (감기)" → date, reason.
- add_payer: 예금주명(입금자 이름) 등록. "민준이 아빠 이름 김철수로 입금함" → payer_name.
- note: 위에 해당하지 않거나 아직 프로그램에 없는 기능(차량 코스 변경 등)은 note 로 그대로 기록만. reply 에서 "아직 자동 처리하지 않는 내용이라 타임라인에 메모로 남겨요"라고 알려 주세요.

규칙:
- 학생은 아래 목록의 id 로 지정합니다. "민준이"처럼 이름 일부·애칭도 맞추고, 입금자 이름(예금주명)으로도 찾습니다.
- 같은 이름이 여러 명이거나 누군지 확실하지 않으면 추측하지 말고 question 으로 되묻고 actions 는 빈 배열로 둡니다.
- 날짜(오늘·내일·어제·요일)는 아래 '오늘'을 기준으로 YYYY-MM-DD 로 계산합니다. "11월 수련비"의 연도는 오늘과 가장 가까운 해입니다.
- "15만" = 150000, "3만5천" = 35000 처럼 금액을 숫자로 바꿉니다.
- 한 메모에 여러 일이 있으면 여러 작업으로 나눕니다. 여러 학생이면 student_ids 에 모두 넣습니다.
- 각 작업의 summary 는 학생 이름이 들어간 한국어 한 줄로 씁니다. 쓰지 않는 칸은 null 로 둡니다.`

const KDAY = ['일', '월', '화', '수', '목', '금', '토']
const kstNow = () => new Date(Date.now() + 9 * 3600_000)
const kstDate = () => kstNow().toISOString().slice(0, 10)

async function staffOf(req: Request) {
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const { data } = await db.auth.getUser(token)
  if (!data.user) return null
  const { data: m } = await db.from('members').select('user_id,org_id,role,display_name').eq('user_id', data.user.id).maybeSingle()
  return m && (m.role === 'admin' || m.role === 'staff') ? m : null
}

async function loadContext(org: string) {
  const [s, p, i, f] = await Promise.all([
    db.from('students').select('id,name,group_name,code,monthly_fee,active').eq('org_id', org).order('name'),
    db.from('payer_names').select('student_id,name'),
    db.from('invoices').select('id,student_id,item_name,period,amount,status').eq('org_id', org).in('status', ['unpaid', 'reported']).order('created_at'),
    db.from('fee_items').select('name,default_amount,monthly').eq('org_id', org).eq('active', true).order('sort')
  ])
  return { students: s.data ?? [], payers: p.data ?? [], invoices: i.data ?? [], items: f.data ?? [] }
}

/* ---------------- 1) 해석 (미리보기) ---------------- */

/**
 * AI 키 고르기: 키 모양을 보고 Claude(sk-ant-…) / GPT(OpenAI, sk-proj-… · sk-…) 를 자동 선택.
 * Supabase 비밀값 이름은 ANTHROPIC_API_KEY 또는 OPENAI_API_KEY 아무거나 써도 됨.
 */
function pickAi(): { provider: 'claude' | 'openai'; key: string } | null {
  const a = (Deno.env.get('ANTHROPIC_API_KEY') ?? '').trim()
  const o = (Deno.env.get('OPENAI_API_KEY') ?? '').trim()
  if (a.startsWith('sk-ant-')) return { provider: 'claude', key: a }
  if (o) return { provider: 'openai', key: o }
  if (a) return { provider: a.startsWith('sk-') ? 'openai' : 'claude', key: a }
  return null
}

/** GPT(OpenAI)로 해석 — 같은 JSON 형식으로 받음 */
async function askOpenAI(key: string, system: string, user: string): Promise<string> {
  const res = await fetch((Deno.env.get('OPENAI_BASE_URL') ?? 'https://api.openai.com/v1') + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: Deno.env.get('OPENAI_MODEL') ?? 'gpt-4.1-mini',
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      response_format: { type: 'json_schema', json_schema: { name: 'plan', strict: true, schema: SCHEMA } }
    })
  })
  const body = await res.text()
  if (!res.ok) throw new Error(`openai ${res.status} ${body.slice(0, 300)}`)
  const j = JSON.parse(body)
  const msg = j.choices?.[0]?.message
  if (msg?.refusal) throw new Error('refusal')
  if (!msg?.content) throw new Error('empty')
  return msg.content as string
}

async function plan(text: string, org: string) {
  const ai = pickAi()
  if (!ai) return { error: 'no_api_key' }
  const ctx = await loadContext(org)
  const ids = new Set(ctx.students.map((s) => s.id))
  const payersOf = (id: string) => ctx.payers.filter((p) => p.student_id === id).map((p) => p.name)
  const nameOf = (id: string) => ctx.students.find((s) => s.id === id)?.name ?? ''
  const label = (it: { item_name: string; period: string | null }) => (it.period ? `${Number(it.period.slice(5, 7))}월 ` : '') + it.item_name
  const now = kstNow()

  const context = [
    `오늘: ${kstDate()} (${KDAY[now.getUTCDay()]}요일) ${now.toISOString().slice(11, 16)}`,
    '',
    '학생 목록 (id | 이름 | 부 | 출석번호 | 예금주명 | 상태):',
    ...ctx.students.map((s) => `${s.id} | ${s.name} | ${s.group_name || '-'} | ${s.code} | ${payersOf(s.id).join(', ') || '-'} | ${s.active ? '재원' : '퇴관'}`),
    '',
    '미납 청구 (학생 | 항목 | 금액 | 상태):',
    ...(ctx.invoices.length ? ctx.invoices.map((v) => `${nameOf(v.student_id)} | ${label(v)} | ${v.amount} | ${v.status === 'reported' ? '학부모 입금 신고' : '미납'}`) : ['(없음)']),
    '',
    '청구 항목 (이름 | 기본 금액 | 매달):',
    ...ctx.items.map((i) => `${i.name} | ${i.default_amount} | ${i.monthly ? '예' : '아니오'}`)
  ].join('\n')

  const userMsg = `${context}\n\n관리자 메모:\n<memo>\n${text}\n</memo>`
  let raw: string
  if (ai.provider === 'openai') {
    raw = await askOpenAI(ai.key, SYSTEM, userMsg)
  } else {
    raw = await askClaude(ai.key, userMsg)
  }
  const out = JSON.parse(raw) as { reply: string; question: string | null; actions: Action[] }
  // 목록에 없는 학생 id 는 버림 (안전장치)
  out.actions = out.actions
    .map((a) => ({ ...a, student_ids: a.student_ids.filter((id) => ids.has(id)) }))
    .filter((a) => a.type === 'note' || a.student_ids.length > 0)
  return { ...out, ai: ai.provider, students: Object.fromEntries(ctx.students.map((s) => [s.id, s.name])) }
}

async function askClaude(key: string, userMsg: string): Promise<string> {
  const client = new Anthropic({ apiKey: key })
  const res = await client.beta.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 8000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content: userMsg }]
  } as Parameters<typeof client.beta.messages.create>[0])

  if ((res as { stop_reason?: string }).stop_reason === 'refusal') throw new Error('refusal')
  const block = (res as { content: { type: string; text?: string }[] }).content.find((c) => c.type === 'text')
  if (!block?.text) throw new Error('empty')
  return block.text
}

/* ---------------- 2) 반영 ---------------- */

const KST_ISO = (date: string | null, time: string | null) => {
  const d = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : kstDate()
  const t = time && /^\d{1,2}:\d{2}$/.test(time) ? time.padStart(5, '0') : kstNow().toISOString().slice(11, 16)
  return new Date(`${d}T${t}:00+09:00`).toISOString()
}

async function run(actions: Action[], text: string, member: { user_id: string; org_id: string; display_name: string }) {
  const org = member.org_id
  const ctx = await loadContext(org)
  const ids = new Set(ctx.students.map((s) => s.id))
  const results: { summary: string; ok: boolean; detail?: string }[] = []

  for (const a of actions) {
    const sids = a.student_ids.filter((id) => ids.has(id))
    try {
      if (a.type !== 'note' && !sids.length) throw new Error('학생을 찾지 못했어요')
      for (const sid of sids) await one(a, sid)
      if (a.type === 'note') {
        await db.from('timeline').insert({ org_id: org, kind: 'note', summary: `📝 ${a.note ?? a.summary}`, student_id: sids[0] ?? null, actor: member.user_id })
      }
      results.push({ summary: a.summary, ok: true })
    } catch (e) {
      results.push({ summary: a.summary, ok: false, detail: e instanceof Error ? e.message : String(e) })
    }
  }

  const done = results.filter((r) => r.ok).map((r) => r.summary)
  if (done.length) {
    await db.from('timeline').insert({
      org_id: org, kind: 'assistant', actor: member.user_id,
      summary: `🤖 "${text.slice(0, 80)}" → ${done.join(' / ')}${member.display_name ? ` — ${member.display_name}` : ''}`
    })
  }
  return { results }

  async function one(a: Action, sid: string) {
    const st = ctx.students.find((s) => s.id === sid)!
    const item = (a.item_name ?? '').trim()
    const defaultFor = (name: string) =>
      name === '수련비' ? st.monthly_fee ?? ctx.items.find((i) => i.name === '수련비')?.default_amount ?? 0 : ctx.items.find((i) => i.name === name)?.default_amount ?? 0

    switch (a.type) {
      case 'record_payment': {
        if (!item) throw new Error('어떤 항목인지 몰라요')
        let { data: inv } = await db.from('invoices').select('*').eq('student_id', sid).in('status', ['unpaid', 'reported'])
          .eq('item_name', item).order('created_at').limit(20)
        let target = (inv ?? []).find((v) => !a.period || v.period === a.period)
        if (!target) {
          const amount = a.amount ?? defaultFor(item)
          if (!amount) throw new Error('청구서가 없고 금액도 몰라요')
          const r = await db.from('invoices').insert({
            org_id: org, student_id: sid, item_name: item, period: a.period, amount, created_by: member.user_id
          }).select().single()
          if (r.error) throw new Error(r.error.message)
          target = r.data
        }
        const u = await db.from('invoices').update({
          status: 'paid', paid_at: new Date().toISOString(), paid_amount: a.amount ?? target.amount,
          paid_method: a.method ?? 'transfer', confirmed_by: member.user_id,
          reported_payer: a.payer_name ?? target.reported_payer
        }).eq('id', target.id)
        if (u.error) throw new Error(u.error.message)
        if (a.payer_name) await db.from('payer_names').upsert({ student_id: sid, name: a.payer_name }, { onConflict: 'student_id,name', ignoreDuplicates: true })
        return
      }
      case 'create_invoice': {
        if (!item) throw new Error('어떤 항목인지 몰라요')
        const amount = a.amount ?? defaultFor(item)
        if (!amount) throw new Error('금액을 몰라요')
        const r = await db.from('invoices').insert({
          org_id: org, student_id: sid, item_name: item, period: a.period, amount,
          due_date: a.date && /^\d{4}-\d{2}-\d{2}$/.test(a.date) ? a.date : null, created_by: member.user_id
        })
        if (r.error) throw new Error(/duplicate|unique/i.test(r.error.message) ? '이미 청구된 항목이에요' : r.error.message)
        return
      }
      case 'attendance': {
        const r = await db.from('attendance').insert({
          org_id: org, student_id: sid, kind: a.kind ?? 'in', at: KST_ISO(a.date, a.time), source: 'staff', created_by: member.user_id
        })
        if (r.error) throw new Error(r.error.message)
        return
      }
      case 'absence': {
        const r = await db.from('absences').upsert({
          org_id: org, student_id: sid, date: a.date && /^\d{4}-\d{2}-\d{2}$/.test(a.date) ? a.date : kstDate(),
          reason: a.reason ?? '', created_by: member.user_id
        }, { onConflict: 'student_id,date' })
        if (r.error) throw new Error(r.error.message)
        return
      }
      case 'add_payer': {
        if (!a.payer_name) throw new Error('이름이 없어요')
        const r = await db.from('payer_names').upsert({ student_id: sid, name: a.payer_name.trim() }, { onConflict: 'student_id,name', ignoreDuplicates: true })
        if (r.error) throw new Error(r.error.message)
        return
      }
      case 'note':
        return
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })
  const member = await staffOf(req)
  if (!member) return json({ error: 'staff only' }, 403)
  const body = await req.json().catch(() => ({}))
  const text = String(body.text ?? '').trim().slice(0, 1000)
  if (!text) return json({ error: 'empty' }, 400)
  try {
    if (Array.isArray(body.execute)) return json(await run(body.execute as Action[], text, member))
    return json(await plan(text, member.org_id))
  } catch (e) {
    return json({ error: e instanceof Error ? e.message : String(e) }, 500)
  }
})
