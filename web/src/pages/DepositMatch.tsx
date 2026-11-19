import { useEffect, useMemo, useState } from 'react'
import { supabase, errText, type Member, type Student } from '../supabase'
import { itemLabel, won, type Invoice } from '../billing'

/* 입금 확인 도우미: 은행에 찍힌 입금자명으로 어느 아이 수납인지 찾기 + 은행 거래내역 엑셀로 한 번에 맞추기
   한 번 맞춘 입금자명은 기억해 두고(payer_names) 다음부터 자동으로 찾음 */

interface Payer { student_id: string; name: string }
interface Contact { student_id: string; name: string }
interface Cand { s: Student; why: string; score: number; open: Invoice[]; pick: Invoice[] }
interface Row { key: string; date: string; name: string; amount: number; cands: Cand[]; chosen: string; on: boolean }

/** 이름 비교용: 공백·기호 빼고, 소문자, 끝의 "엄마/아빠/님" 등 빼기 */
export const norm = (x: string): string =>
  x.normalize('NFKC').toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, '')
    .replace(/[\s\-_.,·*/'"`~!@#$%^&+=:;|\\]/g, '')
    .replace(/(어머니|엄마|아버지|아빠|할머니|할아버지|이모|고모|님|맘|대디)$/g, '')
    .replace(/\d+$/, '')

const like = (a: string, b: string): boolean => {
  const x = norm(a), y = norm(b)
  if (x.length < 2 || y.length < 2) return false
  return x === y || x.includes(y) || y.includes(x)
}

/** 미납 청구 중에서 입금액과 맞는 조합 찾기 (1건, 전부, 또는 2~4건 조합) */
function pickByAmount(open: Invoice[], amount: number): Invoice[] {
  if (!amount) return []
  const one = open.find((i) => i.amount === amount)
  if (one) return [one]
  const all = open.reduce((s, i) => s + i.amount, 0)
  if (all === amount) return open
  const list = open.slice(0, 10)
  for (let mask = 1; mask < 1 << list.length; mask++) {
    let sum = 0; const sel: Invoice[] = []
    for (let b = 0; b < list.length; b++) if (mask & (1 << b)) { sum += list[b].amount; sel.push(list[b]) }
    if (sel.length <= 4 && sum === amount) return sel
  }
  return []
}

export default function DepositMatch({ invoices, students, member, onClose }: { invoices: Invoice[]; students: Student[]; member: Member; onClose(): void }): JSX.Element {
  const [tab, setTab] = useState<'name' | 'bank'>('name')
  const [payers, setPayers] = useState<Payer[]>([])
  const [contacts, setContacts] = useState<Contact[]>([])
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    supabase.from('payer_names').select('student_id,name').then(({ data }) => setPayers((data as Payer[]) ?? []))
    supabase.from('student_contacts').select('student_id,name').then(({ data }) => setContacts((data as Contact[]) ?? []))
  }, [])

  const openOf = useMemo(() => {
    const m = new Map<string, Invoice[]>()
    for (const i of invoices) if (i.status === 'unpaid' || i.status === 'reported') {
      if (!m.has(i.student_id)) m.set(i.student_id, [])
      m.get(i.student_id)!.push(i)
    }
    for (const l of m.values()) l.sort((a, b) => (a.period ?? a.created_at).localeCompare(b.period ?? b.created_at))
    return m
  }, [invoices])

  /** 이름(·금액)으로 후보 아이 찾기 */
  const candidates = (name: string, amount = 0): Cand[] => {
    if (norm(name).length < 2) return []
    const out = new Map<string, Cand>()
    const add = (sid: string, why: string, score: number): void => {
      const s = students.find((x) => x.id === sid && x.active); if (!s) return
      const prev = out.get(sid)
      if (prev && prev.score >= score) return
      const open = openOf.get(sid) ?? []
      out.set(sid, { s, why, score, open, pick: pickByAmount(open, amount) })
    }
    for (const p of payers) if (like(p.name, name)) add(p.student_id, `기억한 입금자명 "${p.name}"`, 3)
    for (const s of students) if (like(s.name, name)) add(s.id, '아이 이름', 3)
    for (const c of contacts) if (c.name && like(c.name, name)) add(c.student_id, `보호자 이름 "${c.name}"`, 2)
    // 금액이 맞으면 점수 올림, 미납이 있는 아이 먼저
    return [...out.values()]
      .map((c) => ({ ...c, score: c.score + (c.pick.length ? 2 : 0) + (c.open.length ? 1 : 0) }))
      .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name, 'ko'))
  }

  /** 납부 처리 + 입금자명 기억 */
  const settle = async (sid: string, list: Invoice[], payer: string, date?: string): Promise<string | null> => {
    const at = date && /^\d{4}-\d{2}-\d{2}/.test(date) ? `${date.slice(0, 10)}T12:00:00+09:00` : new Date().toISOString()
    for (const i of list) {
      const { error } = await supabase.from('invoices').update({
        status: 'paid', paid_amount: i.amount, paid_method: 'transfer', paid_at: at, confirmed_by: member.user_id,
        memo: [i.memo, payer ? `입금자 ${payer}` : ''].filter(Boolean).join(' · ')
      }).eq('id', i.id)
      if (error) return errText(error)
    }
    const nm = payer.trim()
    if (nm && !payers.some((p) => p.student_id === sid && norm(p.name) === norm(nm))) {
      await supabase.from('payer_names').insert({ student_id: sid, name: nm })
      setPayers((ps) => [...ps, { student_id: sid, name: nm }])
    }
    return null
  }

  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet wide-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head"><h2>🏦 입금 확인 도우미</h2><button className="ghost" onClick={onClose}>✕</button></div>
        <div className="seg">
          <button className={tab === 'name' ? 'on' : ''} onClick={() => { setTab('name'); setMsg(null) }}>🔍 입금자명으로 찾기</button>
          <button className={tab === 'bank' ? 'on' : ''} onClick={() => { setTab('bank'); setMsg(null) }}>📄 은행 거래내역 엑셀</button>
        </div>
        {tab === 'name'
          ? <NameTab students={students} openOf={openOf} candidates={candidates} settle={settle} busy={busy} setBusy={setBusy} setMsg={setMsg} />
          : <BankTab candidates={candidates} settle={settle} busy={busy} setBusy={setBusy} setMsg={setMsg} />}
        {msg && <div className={msg.startsWith('✅') ? 'notice-ok' : 'error'} style={{ marginTop: 10 }}>{msg}</div>}
        <p className="muted tiny">한 번 맞춘 입금자명(예: ZHANG WEI, 장웨이, IVANOVA)은 기억해 두고 다음부터 자동으로 찾아요.</p>
      </div>
    </div>
  )
}

type Settle = (sid: string, list: Invoice[], payer: string, date?: string) => Promise<string | null>

function NameTab({ students, openOf, candidates, settle, busy, setBusy, setMsg }: {
  students: Student[]; openOf: Map<string, Invoice[]>; candidates(n: string, a?: number): Cand[]; settle: Settle
  busy: boolean; setBusy(b: boolean): void; setMsg(m: string | null): void
}): JSX.Element {
  const [name, setName] = useState('')
  const [amount, setAmount] = useState('')
  const [manual, setManual] = useState('')
  const [sel, setSel] = useState<Record<string, boolean>>({})
  const amt = Number(amount.replace(/\D/g, '')) || 0
  const list = candidates(name, amt)
  const manualList = manual.trim().length >= 1 && !list.length ? students.filter((s) => s.active && s.name.includes(manual.trim())).slice(0, 8) : []

  const card = (s: Student, why: string, open: Invoice[], pick: Invoice[]): JSX.Element => {
    const picked = open.filter((i) => sel[i.id] ?? pick.some((p) => p.id === i.id))
    const total = picked.reduce((t, i) => t + i.amount, 0)
    return (
      <li key={s.id} className="dm-cand">
        <div className="row"><b className="grow">{s.name} <span className="muted small">{s.group_name} · {s.code}</span></b><span className="chip">{why}</span></div>
        {open.length === 0 ? <p className="muted small">미납 청구가 없어요.</p> : (
          <>
            <ul className="plain">
              {open.map((i) => (
                <li key={i.id}><label className="check small">
                  <input type="checkbox" checked={sel[i.id] ?? pick.some((p) => p.id === i.id)} onChange={(e) => setSel({ ...sel, [i.id]: e.target.checked })} />
                  <span>{itemLabel(i.item_name, i.period)} <b>{won(i.amount)}</b>{i.status === 'reported' ? <span className="chip">확인 대기{i.reported_payer ? ` · ${i.reported_payer}` : ''}</span> : null}</span>
                </label></li>
              ))}
            </ul>
            <button className="primary" disabled={busy || !picked.length} onClick={async () => {
              setBusy(true)
              const e = await settle(s.id, picked, name.trim())
              setBusy(false)
              setMsg(e ? '처리 실패: ' + e : `✅ ${s.name} ${picked.length}건(${won(total)}) 납부 처리했어요.${name.trim() ? ` 입금자명 "${name.trim()}"을 기억해 둘게요.` : ''}`)
              setSel({})
            }}>✓ {picked.length}건 {won(total)} 납부 처리{amt && total !== amt ? ` (입금액 ${won(amt)}와 다름)` : ''}</button>
          </>
        )}
      </li>
    )
  }

  return (
    <div className="form" style={{ marginTop: 10 }}>
      <div className="row wrap">
        <input className="grow" placeholder="은행에 찍힌 입금자명 (예: ZHANG WEI, 장웨이)" value={name} onChange={(e) => { setName(e.target.value); setSel({}) }} autoFocus />
        <input style={{ width: 140 }} inputMode="numeric" placeholder="입금액 (선택)" value={amount ? Number(amount.replace(/\D/g, '') || 0).toLocaleString('ko-KR') : ''} onChange={(e) => setAmount(e.target.value.replace(/\D/g, ''))} />
      </div>
      {name.trim().length >= 2 && (
        list.length ? <ul className="plain dm-list">{list.map((c) => card(c.s, c.why, c.open, c.pick))}</ul> : (
          <div className="dm-none">
            <p className="small">"{name}"(으)로 찾은 아이가 없어요. 누구 수납인지 아시면 아이 이름으로 골라 주세요. 다음부터는 이 입금자명으로 자동으로 찾아요.</p>
            <input placeholder="아이 이름으로 찾기" value={manual} onChange={(e) => setManual(e.target.value)} />
            <ul className="plain dm-list">{manualList.map((s) => card(s, '직접 고름', openOf.get(s.id) ?? [], pickByAmount(openOf.get(s.id) ?? [], amt)))}</ul>
          </div>
        )
      )}
    </div>
  )
}

function BankTab({ candidates, settle, busy, setBusy, setMsg }: {
  candidates(n: string, a?: number): Cand[]; settle: Settle; busy: boolean; setBusy(b: boolean): void; setMsg(m: string | null): void
}): JSX.Element {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [fileName, setFileName] = useState('')

  const read = async (f: File): Promise<void> => {
    setMsg(null); setFileName(f.name)
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await f.arrayBuffer(), { type: 'array', cellDates: true })
      const sh = wb.Sheets[wb.SheetNames[0]]
      const grid = XLSX.utils.sheet_to_json<unknown[]>(sh, { header: 1, raw: false, defval: '' }) as string[][]
      // 머리줄 찾기: "입금" 금액 칸과 이름 칸이 같이 있는 줄
      const hi = grid.findIndex((r) => r.some((c) => /입금|맡기신/.test(String(c))) && r.some((c) => /(입금자|보낸|의뢰인|적요|내용|기재|성명|거래처)/.test(String(c))))
      if (hi < 0) { setMsg('엑셀에서 "입금액"과 "입금자(적요·내용)" 칸을 못 찾았어요. 은행 인터넷뱅킹 → 거래내역 조회 → 엑셀 저장한 파일을 올려 주세요.'); setRows(null); return }
      const h = grid[hi].map((c) => String(c))
      const col = (re: RegExp, not?: RegExp): number => h.findIndex((c) => re.test(c) && !(not && not.test(c)))
      const inCol = col(/입금|맡기신/, /입금자|입금처/)
      // 입금자명 칸 후보(우선순위): 입금자/보낸분 → 기재내용/내용 → 성명/거래처 → 적요. '타행이체' 같은 거래 종류는 건너뜀
      const nameCols = [/입금자|보낸|의뢰인/, /기재내용|받는.*표시|내용/, /성명|거래처|상대/, /적요/]
        .map((re) => col(re)).filter((x, i, a) => x >= 0 && a.indexOf(x) === i)
      const GENERIC = /^(타행|당행|인터넷|모바일|스마트|폰뱅킹|펌뱅킹|이체|입금|대체|CMS|ATM|창구|자동|오픈뱅킹|타행이체|타행환|인터넷뱅킹|모바일뱅킹|전자금융|토스|카카오페이)+$/i
      const dateCol = col(/거래일|일자|날짜|일시/)
      const out: Row[] = []
      grid.slice(hi + 1).forEach((r, n) => {
        const amount = Number(String(r[inCol] ?? '').replace(/[^\d.-]/g, '')) || 0
        const name = nameCols.map((c) => String(r[c] ?? '').trim()).find((v) => v && !GENERIC.test(v.replace(/\s/g, ''))) ?? ''
        if (amount <= 0 || !name) return
        const raw = String(r[dateCol] ?? '')
        const m = /(\d{4})[.\-/년 ]+(\d{1,2})[.\-/월 ]+(\d{1,2})/.exec(raw)
        const date = m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : ''
        const cands = candidates(name, amount)
        const best = cands[0]
        out.push({ key: `${n}`, date, name, amount, cands, chosen: best?.s.id ?? '', on: !!(best && best.pick.length && best.score >= 5) })
      })
      setRows(out)
      if (!out.length) setMsg('입금 내역이 없어요.')
    } catch (e) {
      setMsg('엑셀을 읽지 못했어요: ' + errText(e)); setRows(null)
    }
  }

  const sum = (l: Invoice[]): number => l.reduce((t, i) => t + i.amount, 0)
  const doAll = async (): Promise<void> => {
    if (!rows) return
    const todo = rows.filter((r) => r.on && r.chosen)
    setBusy(true)
    let ok = 0; const fails: string[] = []
    const used = new Set<string>()
    for (const r of todo) {
      const c = r.cands.find((x) => x.s.id === r.chosen)
      const pick = (c?.pick ?? []).filter((i) => !used.has(i.id))
      if (!c || !pick.length) { fails.push(`${r.name} ${won(r.amount)}: 금액이 맞는 청구 없음`); continue }
      const e = await settle(c.s.id, pick, r.name, r.date)
      if (e) fails.push(`${r.name}: ${e}`); else { ok++; pick.forEach((i) => used.add(i.id)) }
    }
    setBusy(false)
    setMsg(`✅ ${ok}건 납부 처리했어요.${fails.length ? ` 못 한 것 ${fails.length}건: ${fails.slice(0, 3).join(' / ')}` : ''}`)
    setRows(rows.map((r) => (todo.includes(r) ? { ...r, on: false } : r)))
  }

  return (
    <div className="form" style={{ marginTop: 10 }}>
      <p className="muted small">은행 인터넷뱅킹(국민·신한 등) → <b>거래내역 조회 → 엑셀 저장</b>한 파일을 올려 주세요. 입금자명과 금액으로 아이와 청구를 짝지어 드려요. 파일은 이 화면에서만 읽고 어디에도 저장하지 않아요.</p>
      <label className="file-btn">📄 엑셀 파일 고르기 {fileName && <span className="muted small">({fileName})</span>}
        <input type="file" accept=".xlsx,.xls,.csv" onChange={(e) => { const f = e.target.files?.[0]; if (f) void read(f) }} />
      </label>
      {rows && rows.length > 0 && (
        <>
          <div className="bt-wrap">
            <table className="bt-table dm-table">
              <thead><tr><th></th><th>날짜</th><th>입금자명</th><th>입금액</th><th>누구 수납?</th><th>맞춘 청구</th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const c = r.cands.find((x) => x.s.id === r.chosen)
                  const ok = !!c && c.pick.length > 0
                  return (
                    <tr key={r.key} className={ok ? '' : 'dm-miss'}>
                      <td><input type="checkbox" checked={r.on} disabled={!ok} onChange={(e) => setRows(rows.map((x) => (x.key === r.key ? { ...x, on: e.target.checked } : x)))} /></td>
                      <td>{r.date.slice(5)}</td>
                      <td className="bt-name">{r.name}</td>
                      <td className="num">{r.amount.toLocaleString('ko-KR')}</td>
                      <td>
                        {r.cands.length ? (
                          <select value={r.chosen} onChange={(e) => setRows(rows.map((x) => (x.key === r.key ? { ...x, chosen: e.target.value, on: !!x.cands.find((y) => y.s.id === e.target.value)?.pick.length } : x)))}>
                            {r.cands.map((x) => <option key={x.s.id} value={x.s.id}>{x.s.name} ({x.why})</option>)}
                          </select>
                        ) : <span className="muted small">못 찾음 → 🔍 입금자명으로 찾기에서 직접</span>}
                      </td>
                      <td>{ok ? `${c!.pick.map((i) => itemLabel(i.item_name, i.period)).join(', ')} (${won(sum(c!.pick))})` : c ? <span className="muted small">금액 맞는 미납 없음</span> : ''}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <button className="primary big" disabled={busy || !rows.some((r) => r.on)} onClick={doAll}>✓ 선택한 {rows.filter((r) => r.on).length}건 납부 처리</button>
        </>
      )}
    </div>
  )
}
