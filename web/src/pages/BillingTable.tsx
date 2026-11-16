import { useEffect, useMemo, useState } from 'react'
import { supabase, errText, type Member } from '../supabase'
import { itemLabel, periodLabel, won, type FeeItem, type Invoice } from '../billing'
import type { StudentFull } from './StudentForm'

/** v9 컬럼까지 포함한 청구서 */
type Inv = Invoice & { paid_via?: string; receipt_no?: string; receipt_issued?: boolean }
interface PayMethod { id?: string; name: string; kind: 'transfer' | 'cash' | 'card' | 'other'; sort: number; active: boolean }
interface Contact { student_id: string; name: string; phone: string; relation: string; sort: number }
interface Draft { status: Invoice['status']; paid: string; via: string; receiptNo: string; issued: boolean; date: string; memo: string }

const DEFAULT_METHODS: PayMethod[] = [
  { name: '계좌이체', kind: 'transfer', sort: 1, active: true },
  { name: '카드', kind: 'card', sort: 2, active: true },
  { name: '현금', kind: 'cash', sort: 3, active: true },
  { name: '바우처+카드', kind: 'card', sort: 4, active: true }
]
const KIND_NAME: Record<PayMethod['kind'], string> = { transfer: '계좌이체', cash: '현금', card: '카드', other: '기타' }
const ST_LABEL: Record<Invoice['status'], string> = { unpaid: '미납', reported: '확인대기', paid: '완납', canceled: '취소' }
const kstDate = (iso: string | null): string => (iso ? new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 10) : '')
const today = (): string => kstDate(new Date().toISOString())
const num = (s: string): number => Number(s.replace(/[^0-9]/g, '')) || 0
const fmt = (n: number): string => n.toLocaleString('ko-KR')

type Sort = 'name' | 'no' | 'session' | 'amount' | 'status'

/** 에듀패밀리 납부처리처럼: 한 줄에 한 청구, 바로 고치고 저장 */
export default function BillingTable({ invoices, period, students, items, member }: {
  invoices: Inv[]; period: string; students: StudentFull[]; items: FeeItem[]; member: Member
}): JSX.Element {
  const [contacts, setContacts] = useState<Contact[]>([])
  const [methods, setMethods] = useState<PayMethod[]>(DEFAULT_METHODS)
  const [v9, setV9] = useState(true) // schema-v9 실행 여부
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [status, setStatus] = useState<'all' | 'open' | Invoice['status']>('all')
  const [kind, setKind] = useState<'all' | 'base' | 'etc'>('all')
  const [method, setMethod] = useState('all')
  const [session, setSession] = useState('all')
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<Sort>('session')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [methodSheet, setMethodSheet] = useState(false)

  const loadMethods = async (): Promise<void> => {
    const { data, error } = await supabase.from('pay_methods').select('*').order('sort')
    if (error) setV9(false)
    else if (data?.length) setMethods(data as PayMethod[])
  }
  useEffect(() => {
    supabase.from('student_contacts').select('student_id,name,phone,relation,sort').order('sort').then(({ data }) => setContacts((data as Contact[]) ?? []))
    loadMethods()
  }, [])

  const stu = useMemo(() => new Map(students.map((s) => [s.id, s])), [students])
  const parentOf = (sid: string): Contact | undefined => contacts.find((c) => c.student_id === sid)
  const isBase = (i: Inv): boolean => items.find((f) => f.name === i.item_name)?.monthly ?? i.item_name === '수련비'
  const inPeriod = (i: Inv): boolean => (i.period ? i.period === period : kstDate(i.created_at).slice(0, 7) === period)
  const methodKind = (name: string): PayMethod['kind'] => methods.find((m) => m.name === name)?.kind ?? 'other'

  const draftOf = (i: Inv): Draft => drafts[i.id] ?? {
    status: i.status,
    paid: i.status === 'paid' ? String(i.paid_amount ?? i.amount) : '',
    via: i.paid_via || (i.paid_method ? KIND_NAME[i.paid_method] : ''),
    receiptNo: i.receipt_no ?? '',
    issued: !!i.receipt_issued,
    date: i.status === 'paid' ? kstDate(i.paid_at) : '',
    memo: i.memo
  }
  const edit = (i: Inv, patch: Partial<Draft>): void => {
    const d = { ...draftOf(i), ...patch }
    if (patch.status === 'paid') {
      if (!d.paid) d.paid = String(i.amount)
      if (!d.date) d.date = today()
      if (!d.via) d.via = methods.find((m) => m.active)?.name ?? '계좌이체'
    }
    if (patch.status === 'unpaid') { d.paid = ''; d.date = '' }
    setDrafts({ ...drafts, [i.id]: d })
  }

  const rows = invoices
    .filter(inPeriod)
    .filter((i) => (status === 'all' ? i.status !== 'canceled' : status === 'open' ? i.status === 'unpaid' || i.status === 'reported' : i.status === status))
    .filter((i) => kind === 'all' || (kind === 'base') === isBase(i))
    .filter((i) => method === 'all' || draftOf(i).via === method)
    .filter((i) => {
      if (session === 'all') return true
      const s = stu.get(i.student_id)
      return session === 'none' ? !s?.session_no : String(s?.session_no ?? '') === session
    })
    .filter((i) => {
      if (!q) return true
      const s = stu.get(i.student_id)
      const p = contacts.filter((c) => c.student_id === i.student_id).map((c) => c.name + c.phone).join(' ')
      return (s?.name ?? '').includes(q) || p.includes(q) || i.item_name.includes(q)
    })
    .sort((a, b) => {
      const sa = stu.get(a.student_id), sb = stu.get(b.student_id)
      const byName = (sa?.name ?? '').localeCompare(sb?.name ?? '', 'ko')
      if (sort === 'no') return (sa?.student_no || sa?.code || '').localeCompare(sb?.student_no || sb?.code || '', 'ko', { numeric: true }) || byName
      if (sort === 'session') return (sa?.session_no ?? 99) - (sb?.session_no ?? 99) || byName
      if (sort === 'amount') return b.amount - a.amount || byName
      if (sort === 'status') return a.status.localeCompare(b.status) || byName
      return byName
    })

  const paidOf = (i: Inv): number => { const d = draftOf(i); return d.status === 'paid' ? num(d.paid) : 0 }
  const restOf = (i: Inv): number => (draftOf(i).status === 'canceled' ? 0 : Math.max(0, i.amount - paidOf(i)))
  const totals = { amount: rows.reduce((s, i) => s + (i.status === 'canceled' ? 0 : i.amount), 0), paid: rows.reduce((s, i) => s + paidOf(i), 0), rest: rows.reduce((s, i) => s + restOf(i), 0) }
  const allOn = rows.length > 0 && rows.every((i) => sel.has(i.id))
  const toggle = (id: string): void => { const n = new Set(sel); n.has(id) ? n.delete(id) : n.add(id); setSel(n) }
  const picked = rows.filter((i) => sel.has(i.id))

  const patchOf = (i: Inv, d: Draft): Record<string, unknown> => {
    const p: Record<string, unknown> = { memo: d.memo }
    if (d.status === 'paid') {
      Object.assign(p, {
        status: 'paid', paid_amount: num(d.paid) || i.amount, paid_method: methodKind(d.via),
        paid_at: d.date ? `${d.date}T12:00:00+09:00` : new Date().toISOString(),
        confirmed_by: i.status === 'paid' ? undefined : member.user_id
      })
      if (p.confirmed_by === undefined) delete p.confirmed_by
    } else if (d.status === 'unpaid') {
      Object.assign(p, { status: 'unpaid', paid_amount: null, paid_method: null, paid_at: null })
      if (i.status === 'reported') Object.assign(p, { reported_at: null, reported_payer: null })
    } else if (d.status === 'canceled') p.status = 'canceled'
    if (v9) Object.assign(p, { paid_via: d.status === 'paid' ? d.via : '', receipt_no: d.receiptNo, receipt_issued: d.issued })
    return p
  }
  const save = async (list: Inv[]): Promise<void> => {
    const dirty = list.filter((i) => drafts[i.id])
    if (!dirty.length) { setMsg('바뀐 내용이 없어요.'); return }
    setBusy(true); setMsg(null)
    let ok = 0; const fail: string[] = []
    const rest = { ...drafts }
    for (const i of dirty) {
      const { error } = await supabase.from('invoices').update(patchOf(i, drafts[i.id])).eq('id', i.id)
      if (error) fail.push(`${stu.get(i.student_id)?.name}: ${errText(error)}`)
      else { ok++; delete rest[i.id] }
    }
    setDrafts(rest); setBusy(false)
    setMsg(`✔ ${ok}건 저장${fail.length ? ` · ✘ ${fail.length}건 실패 (${fail[0]})` : ''}`)
  }
  const markPaid = (): void => {
    const n = { ...drafts }
    for (const i of picked.filter((x) => x.status !== 'paid' && x.status !== 'canceled')) {
      const d = { ...draftOf(i), status: 'paid' as const }
      if (!d.paid) d.paid = String(i.amount)
      if (!d.date) d.date = today()
      if (!d.via) d.via = methods.find((m) => m.active)?.name ?? '계좌이체'
      n[i.id] = d
    }
    setDrafts(n); setMsg('완납으로 바꿨어요. [선택저장]을 눌러야 반영돼요.')
  }
  const cancelSel = async (): Promise<void> => {
    const targets = picked.filter((i) => i.status !== 'paid' && i.status !== 'canceled')
    if (!targets.length) { setMsg('취소할 미납 청구를 선택해 주세요. (완납은 취소할 수 없어요)'); return }
    if (!window.confirm(`선택한 미납 청구 ${targets.length}건을 취소(삭제)할까요?`)) return
    setBusy(true)
    const { error } = await supabase.from('invoices').update({ status: 'canceled' }).in('id', targets.map((i) => i.id))
    setBusy(false); setSel(new Set())
    setMsg(error ? '실패: ' + errText(error) : `🗑 ${targets.length}건 취소했어요.`)
  }
  const remind = async (): Promise<void> => {
    const targets = picked.filter((i) => i.status === 'unpaid' || i.status === 'reported')
    if (!targets.length) { setMsg('알림 보낼 미납 청구를 선택해 주세요.'); return }
    if (!v9) { setMsg('납부알림 발송은 SQL v9 실행 후 쓸 수 있어요.'); return }
    if (!window.confirm(`미납 ${targets.length}건 학부모에게 납부 알림을 보낼까요?\n(앱 가입·알림 허용한 학부모에게만 갑니다)`)) return
    setBusy(true)
    const { data, error } = await supabase.rpc('remind_invoices', { p_ids: targets.map((i) => i.id) })
    setBusy(false)
    setMsg(error ? '실패: ' + errText(error) : `🔔 ${data}건 납부 알림을 보냈어요.`)
  }
  const exportCsv = (): void => {
    const head = ['NO', '학생번호', '이름', '부', '반', '부모1', '부모1 연락처', '종류', '수납항목', '납부할금액', '수납액', '수납상태', '미납액', '현금영수증번호', '현금영수증발행', '결제방법', '수납일', '비고']
    const body = rows.map((i, n) => {
      const s = stu.get(i.student_id); const p = parentOf(i.student_id); const d = draftOf(i)
      return [n + 1, s?.student_no || s?.code || '', s?.name ?? '', s?.session_no ? `${s.session_no}부` : '', s?.class_name ?? '', p ? `${p.name}${p.relation ? `(${p.relation})` : ''}` : '', p?.phone ?? '',
        isBase(i) ? '기본' : '기타', itemLabel(i.item_name, i.period), i.amount, paidOf(i), ST_LABEL[d.status], restOf(i), d.receiptNo, d.issued ? '발행완료' : '', d.status === 'paid' ? d.via : '', d.date, d.memo]
    })
    const csv = [head, ['', '', '합계', '', '', '', '', '', '', totals.amount, totals.paid, '', totals.rest], ...body]
      .map((r) => r.map((c) => { const t = String(c ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t }).join(',')).join('\r\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }))
    a.download = `강철노트_수납_${period}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  const sessions = [...new Set(students.map((s) => s.session_no).filter((x): x is number => !!x))].sort()
  const activeMethods = methods.filter((m) => m.active)

  return (
    <div className="bt">
      {!v9 && <div className="notice">ℹ️ 결제방법 이름·현금영수증·납부알림을 쓰려면 Supabase에서 <b>schema-v9-billing-table.sql</b> 을 한 번 실행해 주세요. (그 전에도 수납상태·수납액·수납일·비고는 저장돼요)</div>}

      <div className="bt-filters">
        <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} title="정렬">
          <option value="session">정렬: 부(시간)순</option><option value="name">정렬: 이름순</option><option value="no">정렬: 학생번호순</option>
          <option value="amount">정렬: 금액순</option><option value="status">정렬: 상태순</option>
        </select>
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} title="회비종류">
          <option value="all">회비종류: 전체</option><option value="base">기본 (수련비)</option><option value="etc">기타 (심사비 등)</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} title="수납상태">
          <option value="all">수납상태: 전체</option><option value="open">미납+확인대기</option><option value="unpaid">미납</option>
          <option value="reported">확인대기</option><option value="paid">완납</option><option value="canceled">취소</option>
        </select>
        <select value={method} onChange={(e) => setMethod(e.target.value)} title="결제방법">
          <option value="all">결제방법: 전체</option>
          {methods.map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
        </select>
        <select value={session} onChange={(e) => setSession(e.target.value)} title="반">
          <option value="all">반: 전체</option>
          {sessions.map((n) => <option key={n} value={String(n)}>{n}부</option>)}
          <option value="none">미지정</option>
        </select>
        <input className="bt-search" placeholder="원생·부모 이름, 전화번호" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <div className="bt-actions">
        <span className="muted small">{periodLabel(period)} · {rows.length}건{picked.length ? ` · ${picked.length}건 선택` : ''}</span>
        <button disabled={busy} onClick={() => save(picked.length ? picked : rows)}>💾 {picked.length ? '선택저장' : '전체저장'}</button>
        <button disabled={busy || !picked.length} onClick={markPaid}>✓ 선택 완납</button>
        <button disabled={busy || !picked.length} onClick={remind}>🔔 납부알림발송</button>
        <button disabled={busy || !picked.length} className="ghost danger" onClick={cancelSel}>🗑 선택삭제</button>
        <button onClick={exportCsv}>📥 엑셀출력</button>
        <button onClick={() => window.print()}>🖨 수납인쇄</button>
        <button className="ghost" onClick={() => setMethodSheet(true)}>⚙️ 결제방법</button>
      </div>
      {msg && <div className="bt-msg">{msg}</div>}

      <div className="bt-wrap">
        <table className="bt-table">
          <thead>
            <tr>
              <th><input type="checkbox" checked={allOn} onChange={() => setSel(allOn ? new Set() : new Set(rows.map((i) => i.id)))} /></th>
              <th>NO</th><th>학생번호</th><th>이름</th><th>반</th><th>부모1</th><th>종류</th><th>수납항목</th>
              <th>납부할금액</th><th>수납액</th><th>수납상태</th><th>미납액</th><th>현금영수증 번호</th><th>발행</th>
              <th>결제방법</th><th>수납일</th><th>비고</th><th>저장</th>
            </tr>
            <tr className="bt-total">
              <td colSpan={8}>합계</td>
              <td>{fmt(totals.amount)}</td><td>{fmt(totals.paid)}</td><td /><td className={totals.rest ? 'danger' : ''}>{fmt(totals.rest)}</td>
              <td colSpan={6} />
            </tr>
          </thead>
          <tbody>
            {rows.map((i, n) => {
              const s = stu.get(i.student_id); const p = parentOf(i.student_id); const d = draftOf(i)
              const locked = i.status === 'canceled'
              return (
                <tr key={i.id} className={`${drafts[i.id] ? 'dirty' : ''} st-row-${d.status}`}>
                  <td><input type="checkbox" checked={sel.has(i.id)} onChange={() => toggle(i.id)} /></td>
                  <td>{n + 1}</td>
                  <td>{s?.student_no || s?.code || ''}</td>
                  <td className="bt-name">{s?.name ?? '(삭제된 학생)'}</td>
                  <td>{[s?.session_no ? `${s.session_no}부` : '', s?.class_name].filter(Boolean).join(' ')}</td>
                  <td title={p?.phone}>{p ? `${p.name || p.relation}` : ''}<div className="muted tiny">{p?.phone}</div></td>
                  <td>{isBase(i) ? '기본' : '기타'}</td>
                  <td>{itemLabel(i.item_name, i.period)}</td>
                  <td className="num">{fmt(i.amount)}</td>
                  <td><input className="num" disabled={locked || d.status !== 'paid'} inputMode="numeric" value={d.paid ? fmt(num(d.paid)) : ''} onChange={(e) => edit(i, { paid: e.target.value })} /></td>
                  <td>
                    <select className={`st-sel st-${d.status}`} disabled={locked} value={d.status} onChange={(e) => edit(i, { status: e.target.value as Invoice['status'] })}>
                      <option value="unpaid">미납</option>
                      {i.status === 'reported' && <option value="reported">확인대기</option>}
                      <option value="paid">완납</option>
                      <option value="canceled">취소</option>
                    </select>
                    {i.status === 'reported' && i.reported_payer && <div className="muted tiny">입금자 {i.reported_payer}</div>}
                  </td>
                  <td className={`num ${restOf(i) ? 'danger' : ''}`}>{fmt(restOf(i))}</td>
                  <td><input disabled={locked || !v9} placeholder={p?.phone ?? ''} value={d.receiptNo} onChange={(e) => edit(i, { receiptNo: e.target.value })} /></td>
                  <td>
                    <button className={`small-btn ${d.issued ? 'issued' : 'ghost'}`} disabled={locked || !v9} onClick={() => edit(i, { issued: !d.issued, receiptNo: d.receiptNo || (!d.issued ? p?.phone ?? '' : '') })}>
                      {d.issued ? '발행완료' : '발행'}
                    </button>
                  </td>
                  <td>
                    <select disabled={locked || d.status !== 'paid'} value={d.via} onChange={(e) => edit(i, { via: e.target.value })}>
                      <option value="">-</option>
                      {(activeMethods.some((m) => m.name === d.via) || !d.via ? activeMethods : [...activeMethods, { name: d.via } as PayMethod]).map((m) => <option key={m.name} value={m.name}>{m.name}</option>)}
                    </select>
                  </td>
                  <td><input type="date" disabled={locked || d.status !== 'paid'} value={d.date} onChange={(e) => edit(i, { date: e.target.value })} /></td>
                  <td><input className="bt-memo" disabled={locked} value={d.memo} onChange={(e) => edit(i, { memo: e.target.value })} /></td>
                  <td><button className={drafts[i.id] ? 'primary small-btn' : 'ghost small-btn'} disabled={busy || !drafts[i.id]} onClick={() => save([i])}>저장</button></td>
                </tr>
              )
            })}
            {!rows.length && <tr><td colSpan={18} className="muted center">{periodLabel(period)}에 해당하는 청구가 없습니다.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="muted small">노란 줄 = 아직 저장 안 한 줄 · 현금영수증 번호가 비어 있으면 [발행]을 누를 때 부모1 번호로 채워져요.</p>

      {methodSheet && <MethodSheet methods={methods} v9={v9} member={member} onClose={() => { setMethodSheet(false); loadMethods() }} />}
    </div>
  )
}

/** 결제방법 목록 (국민은행_건요, 신한은행_박장, 카드 …) */
function MethodSheet({ methods, v9, member, onClose }: { methods: PayMethod[]; v9: boolean; member: Member; onClose(): void }): JSX.Element {
  const [rows, setRows] = useState(methods)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<PayMethod['kind']>('transfer')
  const [msg, setMsg] = useState<string | null>(null)
  const add = async (): Promise<void> => {
    if (!name.trim()) return
    const row = { org_id: member.org_id, name: name.trim(), kind, sort: rows.length + 1, active: true }
    const { data, error } = await supabase.from('pay_methods').insert(row).select().single()
    if (error) { setMsg(/duplicate|unique/.test(error.message) ? '이미 있는 이름이에요.' : '실패: ' + errText(error)); return }
    setRows([...rows, data as PayMethod]); setName(''); setMsg(null)
  }
  const toggle = async (m: PayMethod): Promise<void> => {
    const { error } = await supabase.from('pay_methods').update({ active: !m.active }).eq('id', m.id!)
    if (error) setMsg('실패: ' + errText(error))
    else setRows(rows.map((r) => (r.id === m.id ? { ...r, active: !r.active } : r)))
  }
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head"><h3>⚙️ 결제방법 목록</h3><button className="ghost" onClick={onClose}>✕</button></div>
        {!v9 ? <p className="notice">schema-v9-billing-table.sql 실행 후 계좌별 결제방법을 등록할 수 있어요.</p> : (
          <div className="form">
            <p className="muted small">계좌가 여러 개면 <b>은행_예금주</b>처럼 계좌마다 하나씩 만들어 두세요. 끈 항목은 새로 고를 때만 안 보여요.</p>
            <ul className="plain">
              {rows.map((m) => (
                <li key={m.name} className="row">
                  <span className="grow" style={{ opacity: m.active ? 1 : 0.4 }}>{m.name} <span className="muted small">({KIND_NAME[m.kind]})</span></span>
                  <button className="ghost small-btn" onClick={() => toggle(m)}>{m.active ? '끄기' : '켜기'}</button>
                </li>
              ))}
            </ul>
            <div className="row">
              <input className="grow" placeholder="예: 국민은행_건요" value={name} onChange={(e) => setName(e.target.value)} />
              <select value={kind} onChange={(e) => setKind(e.target.value as PayMethod['kind'])}>
                {Object.entries(KIND_NAME).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
              <button className="primary" onClick={add}>추가</button>
            </div>
            {msg && <div className="error">{msg}</div>}
          </div>
        )}
      </div>
    </div>
  )
}
