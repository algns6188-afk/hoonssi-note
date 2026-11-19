import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase, errText, type Member, type Student } from '../supabase'
import BillingTable from './BillingTable'
import type { StudentFull } from './StudentForm'
import { itemLabel, periodLabel, shiftPeriod, thisPeriod, won, type FeeItem, type Invoice } from '../billing'

type StudentB = Student & { monthly_fee: number | null; auto_bill: boolean }
type Filter = 'open' | 'reported' | 'paid' | 'all'

const STATUS: Record<Invoice['status'], [string, string]> = {
  unpaid: ['미납', 'st-unpaid'],
  reported: ['확인 대기', 'st-reported'],
  paid: ['납부', 'st-paid'],
  canceled: ['취소', 'st-canceled']
}
const METHOD: Record<string, string> = { transfer: '계좌이체', cash: '현금', card: '카드', other: '기타' }
const kstMonth = (iso: string): string => new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 7)
const plusDays = (n: number): string => new Date(Date.now() + 9 * 3600_000 + n * 86400_000).toISOString().slice(0, 10)
/** 수련비 기본 기한: 그달 10일, 이미 지났으면 오늘부터 7일 뒤 */
const defaultDue = (period: string): string => (`${period}-10` < plusDays(0) ? plusDays(7) : `${period}-10`)

/** 관리자: 수납 탭 */
export default function BillingTab({ students, member }: { students: Student[]; member: Member }): JSX.Element {
  const [period, setPeriod] = useState(thisPeriod())
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [items, setItems] = useState<FeeItem[]>([])
  const [filter, setFilter] = useState<Filter>('open')
  const [sheet, setSheet] = useState<'bill' | 'monthly' | 'settings' | null>(null)
  const [detail, setDetail] = useState<Invoice | null>(null)
  const [q, setQ] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [view, setView] = useState<'table' | 'card'>(() => {
    try { const v = localStorage.getItem('billing-view'); if (v === 'table' || v === 'card') return v } catch { /* 무시 */ }
    return window.innerWidth >= 900 ? 'table' : 'card'
  })
  const changeView = (v: 'table' | 'card'): void => { setView(v); try { localStorage.setItem('billing-view', v) } catch { /* 무시 */ } }
  const studs = students as StudentB[]

  const load = useCallback(async () => {
    const [i, f] = await Promise.all([
      supabase.from('invoices').select('*').order('created_at', { ascending: false }).limit(3000),
      supabase.from('fee_items').select('*').order('sort')
    ])
    setInvoices((i.data as Invoice[]) ?? [])
    setItems((f.data as FeeItem[]) ?? [])
    setLoaded(true)
  }, [])
  useEffect(() => {
    load()
    const ch = supabase.channel('admin-invoices').on('postgres_changes', { event: '*', schema: 'public', table: 'invoices' }, () => load()).subscribe()
    return () => void supabase.removeChannel(ch)
  }, [load])

  const nameOf = (id: string): string => studs.find((s) => s.id === id)?.name ?? '(삭제된 학생)'
  const inPeriod = (i: Invoice): boolean => (i.period ? i.period === period : kstMonth(i.created_at) === period)
  const monthList = invoices.filter((i) => inPeriod(i) && i.status !== 'canceled')
  const sum = (xs: Invoice[], f: (i: Invoice) => number): number => xs.reduce((s, i) => s + f(i), 0)
  const billed = sum(monthList, (i) => i.amount)
  const paidSum = sum(monthList.filter((i) => i.status === 'paid'), (i) => i.paid_amount ?? i.amount)
  const openSum = sum(monthList.filter((i) => i.status !== 'paid'), (i) => i.amount)
  const reported = invoices.filter((i) => i.status === 'reported')

  const list = invoices
    .filter(inPeriod)
    .filter((i) => (filter === 'open' ? i.status === 'unpaid' || i.status === 'reported' : filter === 'all' ? true : i.status === filter))
    .filter((i) => !q || nameOf(i.student_id).includes(q) || i.item_name.includes(q))

  const confirm = async (i: Invoice): Promise<void> => {
    // 학부모가 "지역화폐(방문결제)"를 고른 건 → 단말기 결제로 기록
    const local = i.reported_payer?.match(/^(.+)\(방문결제\)$/)?.[1]
    const { error } = await supabase.from('invoices').update({
      status: 'paid', paid_at: new Date().toISOString(), paid_amount: i.amount, paid_method: local ? 'card' : 'transfer', confirmed_by: member.user_id,
      ...(local ? { paid_via: local } : {})
    }).eq('id', i.id)
    if (error) alert('처리 실패: ' + errText(error))
  }
  const reject = async (i: Invoice): Promise<void> => {
    if (!confirm_(`${nameOf(i.student_id)} ${itemLabel(i.item_name, i.period)} 입금이 확인되지 않아 미납으로 되돌릴까요?`)) return
    await supabase.from('invoices').update({ status: 'unpaid', reported_at: null, reported_payer: null }).eq('id', i.id)
  }

  return (
    <div className="page billing">
      <div className="month-nav">
        <button onClick={() => setPeriod(shiftPeriod(period, -1))}>◀</button>
        <b>{periodLabel(period)}</b>
        <button onClick={() => setPeriod(shiftPeriod(period, 1))}>▶</button>
        <span className="right view-toggle">
          <button className={view === 'card' ? 'pill on' : 'pill'} onClick={() => changeView('card')}>🗂 카드</button>
          <button className={view === 'table' ? 'pill on' : 'pill'} onClick={() => changeView('table')}>📋 표</button>
        </span>
      </div>

      <div className="stats3">
        <div><b>{won(billed)}</b><span>청구</span></div>
        <div><b className="ok">{won(paidSum)}</b><span>납부</span></div>
        <div><b className={openSum ? 'danger' : ''}>{won(openSum)}</b><span>미납</span></div>
      </div>

      <div className="toolbar">
        <button className="primary" disabled={!loaded} onClick={() => setSheet('monthly')}>📅 수련비 일괄 청구</button>
        <button disabled={!loaded} onClick={() => setSheet('bill')}>💳 심사비·대회비 등 청구</button>
        <button className="tool-sub" onClick={() => setSheet('settings')}>⚙️ 수납 설정</button>
      </div>

      {reported.length > 0 && (
        <section className="card reported-box">
          <h3>🔔 입금 확인 대기 {reported.length}건</h3>
          <ul className="plain">
            {reported.map((i) => (
              <li key={i.id} className="reported-row">
                <div className="grow">
                  <b>{nameOf(i.student_id)}</b> {itemLabel(i.item_name, i.period)} <b>{won(i.amount)}</b>
                  <div className="muted small">입금자: {i.reported_payer ?? '-'} · {new Date(i.reported_at!).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' })}</div>
                </div>
                <button className="primary small-btn" onClick={() => confirm(i)}>✓ 확인</button>
                <button className="ghost small-btn" onClick={() => reject(i)}>미확인</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {view === 'table' ? (
        <BillingTable invoices={invoices} period={period} students={students as StudentFull[]} items={items} member={member} />
      ) : (<>
      <input className="search" placeholder="학생 이름·항목 검색" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="pills">
        {([['open', '미납·확인대기'], ['reported', '확인 대기'], ['paid', '납부'], ['all', '전체']] as const).map(([id, label]) => (
          <button key={id} className={filter === id ? 'pill on' : 'pill'} onClick={() => setFilter(id)}>{label}</button>
        ))}
      </div>
      {list.length === 0 ? (
        <p className="muted center">{periodLabel(period)}에 해당하는 청구가 없습니다.</p>
      ) : (
        <ul className="list">
          {list.map((i) => (
            <li key={i.id}>
              <button className="row-btn" onClick={() => setDetail(i)}>
                <span className="grow"><b>{nameOf(i.student_id)}</b> <span className="muted small">{itemLabel(i.item_name, i.period)}</span></span>
                <b>{won(i.amount)}</b>
                <span className={`chip ${STATUS[i.status][1]}`}>{STATUS[i.status][0]}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      </>)}

      {sheet === 'monthly' && <MonthlySheet students={studs} items={items} invoices={invoices} onClose={() => setSheet(null)} />}
      {sheet === 'bill' && <BillSheet students={studs} items={items} onClose={() => setSheet(null)} />}
      {sheet === 'settings' && <SettingsSheet items={items} member={member} onClose={() => setSheet(null)} reload={load} />}
      {detail && <InvoiceSheet invoice={invoices.find((x) => x.id === detail.id) ?? detail} name={nameOf(detail.student_id)} member={member} onClose={() => setDetail(null)} />}
    </div>
  )
}

const confirm_ = (m: string): boolean => window.confirm(m)

/* ---------------- 공통: 학생 고르기 ---------------- */

function StudentPicker({ students, picked, setPicked, extra }: {
  students: StudentB[]
  picked: string[]
  setPicked(v: string[]): void
  extra?(s: StudentB): React.ReactNode
}): JSX.Element {
  const [q, setQ] = useState('')
  const [group, setGroup] = useState('전체')
  const active = students.filter((s) => s.active)
  const groups = ['전체', ...new Set(active.map((s) => s.group_name).filter(Boolean))]
  const list = active.filter((s) => (group === '전체' || s.group_name === group) && (!q || s.name.includes(q) || s.code.includes(q)))
  const all = list.length > 0 && list.every((s) => picked.includes(s.id))
  return (
    <div className="picker">
      <input className="search" placeholder="이름·출석번호 검색" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="pills">
        {groups.map((g) => <button key={g} className={g === group ? 'pill on' : 'pill'} onClick={() => setGroup(g)}>{g}</button>)}
      </div>
      <label className="check select-all">
        <input type="checkbox" checked={all} onChange={(e) => setPicked(e.target.checked ? [...new Set([...picked, ...list.map((s) => s.id)])] : picked.filter((id) => !list.some((s) => s.id === id)))} />
        보이는 학생 전체 선택 ({list.filter((s) => picked.includes(s.id)).length}/{list.length})
      </label>
      <div className="pick-list tall">
        {list.map((s) => (
          <label key={s.id} className="check">
            <input type="checkbox" checked={picked.includes(s.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, s.id] : picked.filter((x) => x !== s.id))} />
            <span className="grow">{s.name} <span className="muted small">{s.group_name}</span></span>
            {extra?.(s)}
          </label>
        ))}
      </div>
    </div>
  )
}

/* ---------------- 수련비 일괄 청구 ---------------- */

function MonthlySheet({ students, items, invoices, onClose }: { students: StudentB[]; items: FeeItem[]; invoices: Invoice[]; onClose(): void }): JSX.Element {
  const [period, setPeriod] = useState(thisPeriod())
  const base = items.find((i) => i.name === '수련비')?.default_amount ?? 0
  const billedIds = new Set(invoices.filter((i) => i.item_name === '수련비' && i.period === period && i.status !== 'canceled').map((i) => i.student_id))
  const [picked, setPicked] = useState<string[]>([])
  const [due, setDue] = useState(defaultDue(period))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const fee = (s: StudentB): number => s.monthly_fee ?? base

  useEffect(() => {
    setPicked(students.filter((s) => s.active && s.auto_bill && !billedIds.has(s.id) && fee(s) > 0).map((s) => s.id))
    setDue(defaultDue(period))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period, invoices.length])

  const targets = picked.filter((id) => !billedIds.has(id))
  const total = targets.reduce((s, id) => s + fee(students.find((x) => x.id === id)!), 0)
  const run = async (): Promise<void> => {
    setBusy(true)
    const { data, error } = await supabase.rpc('bill_month', { p_period: period, p_students: targets, p_due: due })
    setBusy(false)
    if (error) return setMsg('실패: ' + errText(error))
    setMsg(`✅ ${data}명에게 ${periodLabel(period)} 수련비를 청구했어요. 학부모님께 알림이 갔어요.`)
  }

  return (
    <Sheet title="📅 수련비 일괄 청구" onClose={onClose}>
      <div className="form">
        <p className="muted small">매달 1일 오전 9시에 <b>"매달 자동 청구"</b>가 체크된 학생은 자동으로 청구돼요. 지금 바로 청구하거나, 특정 학생만 골라 청구할 때 쓰세요.</p>
        {base === 0 && <div className="error">기본 수련비가 0원이에요. ⚙️ 수납 설정에서 먼저 정해 주세요.</div>}
        <div className="row">
          <label className="grow">청구 월
            <div className="month-nav">
              <button onClick={() => setPeriod(shiftPeriod(period, -1))}>◀</button><b>{periodLabel(period)}</b><button onClick={() => setPeriod(shiftPeriod(period, 1))}>▶</button>
            </div>
          </label>
          <label className="grow">납부 기한<input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
        </div>
        <StudentPicker
          students={students}
          picked={picked}
          setPicked={setPicked}
          extra={(s) => billedIds.has(s.id)
            ? <span className="chip st-paid">이미 청구됨</span>
            : <span className={fee(s) ? 'small' : 'small danger'}>{fee(s) ? won(fee(s)) : '금액 없음'}{s.monthly_fee != null && ' (개별)'}</span>}
        />
        {msg && <div className={msg.startsWith('✅') ? 'notice-ok' : 'error'}>{msg}</div>}
        <button className="primary big" disabled={busy || targets.length === 0} onClick={run}>
          {busy ? '청구 중…' : `${targets.length}명 · ${won(total)} 청구하기`}
        </button>
      </div>
    </Sheet>
  )
}

/* ---------------- 일반 청구 (심사비 · 대회비 · 도복비 …) ---------------- */

function BillSheet({ students, items, onClose }: { students: StudentB[]; items: FeeItem[]; onClose(): void }): JSX.Element {
  const choices = items.filter((i) => i.active && !i.monthly)
  const [itemName, setItemName] = useState(choices[0]?.name ?? '')
  const [custom, setCustom] = useState('')
  const [amount, setAmount] = useState(String(choices[0]?.default_amount || ''))
  const [due, setDue] = useState(plusDays(10))
  const [memo, setMemo] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const name = itemName === '__custom' ? custom.trim() : itemName
  const amt = Number(amount.replace(/[^0-9]/g, '')) || 0

  const pick = (n: string): void => {
    setItemName(n)
    const it = items.find((i) => i.name === n)
    if (it?.default_amount) setAmount(String(it.default_amount))
  }

  const run = async (): Promise<void> => {
    if (!name) return setMsg('항목 이름을 정해 주세요.')
    if (!amt) return setMsg('금액을 입력해 주세요.')
    setBusy(true)
    const { data: org } = await supabase.rpc('my_org')
    const { error } = await supabase.from('invoices').insert(
      picked.map((sid) => ({ org_id: org, student_id: sid, item_name: name, amount: amt, due_date: due || null, memo }))
    )
    setBusy(false)
    if (error) return setMsg('실패: ' + errText(error))
    setMsg(`✅ ${picked.length}명에게 ${name} ${won(amt)}을 청구했어요. 학부모님께 알림이 갔어요.`)
    setPicked([])
  }

  return (
    <Sheet title="💳 청구하기" onClose={onClose}>
      <div className="form">
        <label>항목
          <select value={itemName} onChange={(e) => pick(e.target.value)}>
            {choices.map((i) => <option key={i.id} value={i.name}>{i.name}</option>)}
            <option value="__custom">+ 직접 입력</option>
          </select>
        </label>
        {itemName === '__custom' && <label>항목 이름<input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="예: 겨울캠프비" /></label>}
        <div className="row">
          <label className="grow">금액 (1인)<input inputMode="numeric" value={amount ? Number(amount).toLocaleString('ko-KR') : ''} onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))} placeholder="0" /></label>
          <label className="grow">납부 기한<input type="date" value={due} onChange={(e) => setDue(e.target.value)} /></label>
        </div>
        <label>메모 (학부모에게는 안 보여요)<input value={memo} onChange={(e) => setMemo(e.target.value)} placeholder="예: 12월 승품심사" /></label>
        <StudentPicker students={students} picked={picked} setPicked={setPicked} />
        {msg && <div className={msg.startsWith('✅') ? 'notice-ok' : 'error'}>{msg}</div>}
        <button className="primary big" disabled={busy || !picked.length || !amt || !name} onClick={run}>
          {busy ? '청구 중…' : `${picked.length}명 · ${won(amt * picked.length)} 청구하기`}
        </button>
      </div>
    </Sheet>
  )
}

/* ---------------- 청구서 한 건 ---------------- */

function InvoiceSheet({ invoice: i, name, member, onClose }: { invoice: Invoice; name: string; member: Member; onClose(): void }): JSX.Element {
  const [method, setMethod] = useState<string>(i.paid_method ?? 'transfer')
  const [amount, setAmount] = useState(String(i.paid_amount ?? i.amount))
  const [memo, setMemo] = useState(i.memo)
  const [busy, setBusy] = useState(false)
  const upd = async (patch: Partial<Invoice> & Record<string, unknown>): Promise<void> => {
    setBusy(true)
    const { error } = await supabase.from('invoices').update(patch).eq('id', i.id)
    setBusy(false)
    if (error) alert('실패: ' + errText(error))
    else onClose()
  }
  return (
    <Sheet title={`${name} · ${itemLabel(i.item_name, i.period)}`} onClose={onClose}>
      <div className="form">
        <div className="report-sum"><span>청구 금액</span><b>{won(i.amount)}</b></div>
        <p className="small">
          상태 <span className={`chip ${STATUS[i.status][1]}`}>{STATUS[i.status][0]}</span>
          {i.due_date && <> · 기한 {i.due_date}</>}
          {i.reported_payer && <> · 학부모 신고 입금자 <b>{i.reported_payer}</b></>}
          {i.status === 'paid' && i.paid_at && <> · {new Date(i.paid_at).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul' })} {METHOD[i.paid_method ?? 'other']}</>}
        </p>
        {i.status !== 'paid' && i.status !== 'canceled' && (
          <>
            <div className="row">
              <label className="grow">받은 방법
                <select value={method} onChange={(e) => setMethod(e.target.value)}>
                  {Object.entries(METHOD).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              </label>
              <label className="grow">받은 금액<input inputMode="numeric" value={Number(amount || 0).toLocaleString('ko-KR')} onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))} /></label>
            </div>
            <button className="primary big" disabled={busy} onClick={() => upd({ status: 'paid', paid_method: method as Invoice['paid_method'], paid_amount: Number(amount) || i.amount, paid_at: new Date().toISOString(), confirmed_by: member.user_id })}>✓ 납부 완료 처리</button>
          </>
        )}
        <label>메모<input value={memo} onChange={(e) => setMemo(e.target.value)} onBlur={() => memo !== i.memo && supabase.from('invoices').update({ memo }).eq('id', i.id)} /></label>
        {i.status === 'paid' && <button disabled={busy} onClick={() => upd({ status: 'unpaid', paid_at: null, paid_amount: null, paid_method: null })}>미납으로 되돌리기</button>}
        {i.status !== 'canceled' && i.status !== 'paid' && (
          <button className="ghost danger" disabled={busy} onClick={() => confirm_(`${name} ${itemLabel(i.item_name, i.period)} 청구를 취소할까요?`) && upd({ status: 'canceled' })}>청구 취소</button>
        )}
      </div>
    </Sheet>
  )
}

/* ---------------- 수납 설정: 도장 계좌 · 청구 항목 ---------------- */

const BANKS = ['신한은행', '국민은행', '우리은행', '하나은행', 'NH농협은행', 'IBK기업은행', '카카오뱅크', '토스뱅크', '케이뱅크', 'SC제일은행', '새마을금고', '우체국', '부산은행', '대구은행']

function SettingsSheet({ items, member, onClose, reload }: { items: FeeItem[]; member: Member; onClose(): void; reload(): Promise<void> }): JSX.Element {
  const [bank, setBank] = useState({ bank_name: '', bank_account: '', account_holder: '', bank2_name: '', bank2_account: '', account2_holder: '' })
  const [toss, setToss] = useState<string | null>(null) // null = v10 전
  const [two, setTwo] = useState(true) // v9 실행돼서 2번 계좌 칸이 있는지
  const [local, setLocal] = useState<string | null>(null) // null = v11 전
  const [rows, setRows] = useState(items.map((i) => ({ ...i, amountText: String(i.default_amount || '') })))
  const [newName, setNewName] = useState('')
  const [msg, setMsg] = useState<string | null>(null)
  const admin = member.role === 'admin'

  useEffect(() => {
    supabase.rpc('org_bank').then(({ data }) => {
      const b = (data as Partial<typeof bank>[] | null)?.[0]
      if (!b) return
      if (b.bank2_account === undefined) setTwo(false)
      const tk = (b as { toss_client_key?: string }).toss_client_key
      setToss(tk === undefined ? null : tk)
      const lp = (b as { local_pay?: string }).local_pay
      setLocal(lp === undefined ? null : lp)
      setBank({ bank_name: b.bank_name ?? '', bank_account: b.bank_account ?? '', account_holder: b.account_holder ?? '',
        bank2_name: b.bank2_name ?? '', bank2_account: b.bank2_account ?? '', account2_holder: b.account2_holder ?? '' })
    })
  }, [])
  useEffect(() => setRows(items.map((i) => ({ ...i, amountText: String(i.default_amount || '') }))), [items])

  const saveBank = async (): Promise<void> => {
    const patch = two ? bank : { bank_name: bank.bank_name, bank_account: bank.bank_account, account_holder: bank.account_holder }
    const { error } = await supabase.from('orgs').update(patch).eq('id', member.org_id)
    if (error) return setMsg('저장 실패: ' + errText(error))
    const summary = `도장 계좌 변경: 수강료 ${bank.bank_name} ${bank.bank_account} (${bank.account_holder})` +
      (two && bank.bank2_account ? ` · 기타 ${bank.bank2_name} ${bank.bank2_account} (${bank.account2_holder})` : '')
    await supabase.from('timeline').insert({ org_id: member.org_id, kind: 'payment', summary })
    // 수납 표의 결제방법 목록에도 계좌별 항목 추가 (v9 이후, 이미 있으면 그대로)
    if (two) {
      const add = [
        bank.bank_account && { org_id: member.org_id, name: `수강료계좌_${bank.bank_name}`, kind: 'transfer', sort: 0 },
        bank.bank2_account && { org_id: member.org_id, name: `기타계좌_${bank.bank2_name}`, kind: 'transfer', sort: 0 }
      ].filter(Boolean)
      if (add.length) await supabase.from('pay_methods').upsert(add as object[], { onConflict: 'org_id,name', ignoreDuplicates: true })
    }
    setMsg('✅ 도장 계좌를 저장했어요. 학부모 화면에 바로 반영돼요.')
  }
  const saveItem = async (r: (typeof rows)[number]): Promise<void> => {
    await supabase.from('fee_items').update({ default_amount: Number(r.amountText) || 0, active: r.active }).eq('id', r.id)
    reload()
  }
  const addItem = async (): Promise<void> => {
    if (!newName.trim()) return
    const { error } = await supabase.from('fee_items').insert({ org_id: member.org_id, name: newName.trim(), sort: rows.length + 1 })
    if (error) return setMsg(/duplicate|unique/i.test(error.message) ? '이미 있는 항목이에요.' : errText(error))
    setNewName('')
    reload()
  }

  return (
    <Sheet title="⚙️ 수납 설정" onClose={onClose}>
      <div className="form">
        <h3>① 수강료 계좌 <span className="muted small">수련비만 받는 계좌</span> {!admin && <span className="muted small">(관리자만 바꿀 수 있어요)</span>}</h3>
        <label>은행
          <input list="banks" value={bank.bank_name} disabled={!admin} onChange={(e) => setBank({ ...bank, bank_name: e.target.value })} placeholder="예: 신한은행" />
          <datalist id="banks">{BANKS.map((b) => <option key={b} value={b} />)}</datalist>
        </label>
        <label>계좌번호<input inputMode="numeric" value={bank.bank_account} disabled={!admin} onChange={(e) => setBank({ ...bank, bank_account: e.target.value })} placeholder="110-123-456789" /></label>
        <label>예금주<input value={bank.account_holder} disabled={!admin} onChange={(e) => setBank({ ...bank, account_holder: e.target.value })} placeholder="예: 강철태권도장" /></label>
        <h3>② 기타 계좌 <span className="muted small">심사비·행사비·대회비·도복비 등</span></h3>
        {two ? (
          <>
            <label>은행<input list="banks" value={bank.bank2_name} disabled={!admin} onChange={(e) => setBank({ ...bank, bank2_name: e.target.value })} placeholder="예: 국민은행" /></label>
            <label>계좌번호<input inputMode="numeric" value={bank.bank2_account} disabled={!admin} onChange={(e) => setBank({ ...bank, bank2_account: e.target.value })} placeholder="비워 두면 ① 계좌로 안내" /></label>
            <label>예금주<input value={bank.account2_holder} disabled={!admin} onChange={(e) => setBank({ ...bank, account2_holder: e.target.value })} placeholder="예: 강철태권도장" /></label>
            <p className="muted small">학부모 화면에서 수련비는 ① 계좌, 그 외 청구는 ② 계좌로 자동 안내돼요. 토스 버튼도 각 계좌로 열려요.</p>
          </>
        ) : <p className="notice">두 번째 계좌는 Supabase에서 <b>schema-v9-billing-table.sql</b> 을 실행한 뒤 입력할 수 있어요.</p>}
        {admin && <button className="primary" onClick={saveBank}>계좌 저장</button>}

        <h3>💳 카드·토스페이 결제 <span className="muted small">토스페이먼츠</span></h3>
        {toss === null ? <p className="notice">카드 결제는 Supabase에서 <b>schema-v10-attendance-pay.sql</b> 을 실행한 뒤 설정할 수 있어요.</p> : (
          <>
            <label>클라이언트 키
              <input value={toss} disabled={!admin} onChange={(e) => setToss(e.target.value.trim())} placeholder="test_ck_… 또는 live_ck_…" />
              <span className="hint">토스페이먼츠 개발자센터 → API 키의 <b>클라이언트 키</b>만 여기 넣어요. 시크릿 키(…_sk_…)는 절대 여기·채팅에 넣지 말고 Supabase 비밀값 TOSS_SECRET_KEY 에만 넣으세요.</span>
            </label>
            {toss.includes('_sk_') && <div className="error">이건 시크릿 키예요! 지우고 클라이언트 키(_ck_)를 넣어 주세요.</div>}
            {admin && <button className="primary" disabled={toss.includes('_sk_')} onClick={async () => {
              const { error } = await supabase.from('orgs').update({ toss_client_key: toss }).eq('id', member.org_id)
              setMsg(error ? '저장 실패: ' + errText(error) : toss ? '✅ 카드·토스페이 결제를 켰어요. 학부모 화면에 [결제하기]가 보여요.' : '카드 결제를 껐어요.')
            }}>카드 결제 저장</button>}
            <p className="muted small">비워 두면 학부모 화면은 지금처럼 계좌이체 + "입금했어요"만 보여요.</p>
          </>
        )}

        <h3>🏪 지역화폐 <span className="muted small">도장 카드단말기로 결제</span></h3>
        {local === null ? <p className="notice">지역화폐는 Supabase에서 <b>schema-v11-local-pay.sql</b> 을 실행한 뒤 켤 수 있어요.</p> : (
          <>
            <label className="check">
              <input type="checkbox" checked={!!local} disabled={!admin} onChange={(e) => setLocal(e.target.checked ? '경기지역화폐' : '')} />
              <span>학부모 결제 화면에 지역화폐 보이기 <span className="muted small">(도장이 지역화폐 가맹점일 때만 켜세요)</span></span>
            </label>
            {!!local && <label>표시 이름<input value={local} disabled={!admin} onChange={(e) => setLocal(e.target.value)} placeholder="예: 경기지역화폐, 다온" /></label>}
            {admin && <button className="primary" onClick={async () => {
              const name = local!.trim()
              const { error } = await supabase.from('orgs').update({ local_pay: name }).eq('id', member.org_id)
              if (!error && name) await supabase.from('pay_methods').upsert([{ org_id: member.org_id, name, kind: 'card', sort: 5 }], { onConflict: 'org_id,name', ignoreDuplicates: true })
              setMsg(error ? '저장 실패: ' + errText(error) : name ? `✅ 학부모 화면에 "${name} (도장에서 결제)"가 보여요. 학부모가 고르면 수납 탭 "입금 확인 대기"에 올라와요.` : '✅ 지역화폐를 껐어요.')
            }}>지역화폐 저장</button>}
          </>
        )}

        <h3>청구 항목 · 기본 금액</h3>
        <p className="muted small"><b>수련비</b> 기본 금액이 매달 청구 금액이에요. 형제 할인처럼 학생마다 다르면 학생 화면에서 따로 정하세요.</p>
        <ul className="plain">
          {rows.map((r, idx) => (
            <li key={r.id} className="item-row">
              <span className="grow">{r.name} {r.monthly && <span className="chip">매달</span>}</span>
              <input className="amount" inputMode="numeric" value={r.amountText ? Number(r.amountText).toLocaleString('ko-KR') : ''} placeholder="0"
                onChange={(e) => setRows(rows.map((x, j) => (j === idx ? { ...x, amountText: e.target.value.replace(/[^0-9]/g, '') } : x)))}
                onBlur={() => saveItem(rows[idx])} />
              <span className="small">원</span>
              {!r.monthly && (
                <label className="check small"><input type="checkbox" checked={r.active} onChange={(e) => { const nr = { ...r, active: e.target.checked }; setRows(rows.map((x, j) => (j === idx ? nr : x))); saveItem(nr) }} />사용</label>
              )}
            </li>
          ))}
        </ul>
        <div className="row">
          <input className="grow" value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="새 항목 (예: 겨울캠프비)" />
          <button onClick={addItem}>+ 추가</button>
        </div>
        {msg && <div className={msg.startsWith('✅') ? 'notice-ok' : 'error'}>{msg}</div>}
      </div>
    </Sheet>
  )
}

/* ---------------- 학생 화면에 들어가는 수납 정보 ---------------- */

export function StudentBillingSection({ student, baseFee }: { student: StudentB; baseFee: number }): JSX.Element {
  const [fee, setFee] = useState(student.monthly_fee == null ? '' : String(student.monthly_fee))
  const [auto, setAuto] = useState(student.auto_bill)
  const [payers, setPayers] = useState<{ id: string; name: string }[]>([])
  const [newPayer, setNewPayer] = useState('')
  const [history, setHistory] = useState<Invoice[]>([])

  const loadPayers = useCallback(async () => {
    const { data } = await supabase.from('payer_names').select('id,name').eq('student_id', student.id).order('created_at')
    setPayers((data as { id: string; name: string }[]) ?? [])
  }, [student.id])
  useEffect(() => {
    loadPayers()
    supabase.from('invoices').select('*').eq('student_id', student.id).neq('status', 'canceled').order('created_at', { ascending: false }).limit(12)
      .then(({ data }) => setHistory((data as Invoice[]) ?? []))
  }, [loadPayers, student.id])

  const save = async (patch: Record<string, unknown>): Promise<void> => {
    await supabase.from('students').update(patch).eq('id', student.id)
  }
  const addPayer = async (): Promise<void> => {
    const n = newPayer.trim()
    if (!n) return
    await supabase.from('payer_names').insert({ student_id: student.id, name: n })
    setNewPayer('')
    loadPayers()
  }
  const removePayer = async (id: string): Promise<void> => {
    await supabase.from('payer_names').delete().eq('id', id)
    loadPayers()
  }
  const unpaid = history.filter((h) => h.status !== 'paid').reduce((s, h) => s + h.amount, 0)

  return (
    <div className="family">
      <h3>💳 수납</h3>
      <div className="row">
        <label className="grow">월 수련비
          <input inputMode="numeric" value={fee ? Number(fee).toLocaleString('ko-KR') : ''} placeholder={`기본 ${won(baseFee)}`}
            onChange={(e) => setFee(e.target.value.replace(/[^0-9]/g, ''))}
            onBlur={() => save({ monthly_fee: fee === '' ? null : Number(fee) })} />
          <span className="hint">비워 두면 기본 금액 · 형제 할인 등은 여기에</span>
        </label>
      </div>
      <label className="check"><input type="checkbox" checked={auto} onChange={(e) => { setAuto(e.target.checked); save({ auto_bill: e.target.checked }) }} /> 매달 1일 수련비 자동 청구</label>

      <h3>예금주명 (입금자 이름)</h3>
      <p className="muted small">학부모님이 입금할 때 통장에 찍히는 이름이에요. 엄마·아빠·할머니처럼 여러 개 넣어 두면 입금 확인할 때 누구 돈인지 바로 알 수 있어요.</p>
      <ul className="plain">
        {payers.map((p) => (
          <li key={p.id} className="item-row"><span className="grow">👤 {p.name}</span><button className="ghost small-btn danger" onClick={() => removePayer(p.id)}>삭제</button></li>
        ))}
      </ul>
      <div className="row">
        <input className="grow" value={newPayer} onChange={(e) => setNewPayer(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addPayer()} placeholder="예: 김영희" />
        <button onClick={addPayer}>+ 칸 추가</button>
      </div>

      {history.length > 0 && (
        <>
          <h3>최근 청구 {unpaid > 0 && <span className="danger small">미납 {won(unpaid)}</span>}</h3>
          <ul className="plain small">
            {history.map((h) => (
              <li key={h.id} className="item-row">
                <span className="grow">{itemLabel(h.item_name, h.period)}</span>
                <span>{won(h.amount)}</span>
                <span className={`chip ${STATUS[h.status][1]}`}>{STATUS[h.status][0]}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}

function Sheet({ title, onClose, children }: { title: string; onClose(): void; children: React.ReactNode }): JSX.Element {
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function useBaseFee(): number {
  const [n, setN] = useState(0)
  useEffect(() => {
    supabase.from('fee_items').select('default_amount').eq('name', '수련비').maybeSingle().then(({ data }) => setN(data?.default_amount ?? 0))
  }, [])
  return useMemo(() => n, [n])
}
