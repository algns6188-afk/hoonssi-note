import { useCallback, useEffect, useState } from 'react'
import { supabase, errText, type Student } from '../supabase'
import { useI18n } from '../i18n'
import { accountFor, copyText, isMobile, isTuition, itemLabel, tossLink, won, type BankAccount, type Invoice, type OrgBank } from '../billing'

/** 학부모 화면: 납부할 내역을 골라서 한 번에 결제 (카드·토스페이·무통장·지역화폐) */
export function ParentPayments({ kids }: { kids: Student[] }): JSX.Element | null {
  const { t, lang } = useI18n()
  const [invoices, setInvoices] = useState<Invoice[] | null>(null)
  const [bank, setBank] = useState<OrgBank | null>(null)
  const [payers, setPayers] = useState<string[]>([])
  const [reporting, setReporting] = useState<Invoice[] | null>(null)
  const [paying, setPaying] = useState<Invoice[] | null>(null)
  const [unpicked, setUnpicked] = useState<Set<string>>(new Set())   // 기본은 전부 선택, 뺀 것만 기억
  const [group, setGroup] = useState<'tuition' | 'other' | null>(null) // 수련비 / 그 외는 계좌가 달라 따로 결제
  const [toast, setToast] = useState<string | null>(null)
  const [showHistory, setShowHistory] = useState(false)

  const load = useCallback(async () => {
    const [i, b, p] = await Promise.all([
      supabase.from('invoices').select('*').neq('status', 'canceled').order('created_at', { ascending: false }).limit(200),
      supabase.rpc('org_bank'),
      supabase.from('payer_names').select('name').order('created_at')
    ])
    setInvoices((i.data as Invoice[]) ?? [])
    setBank(((b.data as OrgBank[]) ?? [])[0] ?? null)
    setPayers([...new Set(((p.data as { name: string }[]) ?? []).map((x) => x.name))])
  }, [])

  useEffect(() => {
    load()
    const ch = supabase
      .channel('parent-invoices')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'invoices' }, () => load())
      .subscribe()
    return () => void supabase.removeChannel(ch)
  }, [load])

  // 카드·토스페이 결제창에서 돌아왔을 때 (…?pay=success&inv=…&paymentKey=…&orderId=…&amount=…)
  useEffect(() => {
    const u = new URL(location.href)
    const r = u.searchParams.get('pay')
    if (!r) return
    const clean = (): void => history.replaceState(null, '', u.pathname)
    if (r === 'fail') { setToast(t.payFailed); clean(); return }
    const paymentKey = u.searchParams.get('paymentKey'), orderId = u.searchParams.get('orderId'), amount = Number(u.searchParams.get('amount'))
    const invoiceIds = (u.searchParams.get('inv') ?? '').split(',').filter(Boolean)
    clean()
    if (!paymentKey || !orderId) return
    setToast(t.payChecking)
    supabase.functions.invoke('pay', { body: { paymentKey, orderId, amount, invoiceIds } }).then(async ({ error }) => {
      if (error) {
        const ctx = (error as { context?: Response }).context
        const j = ctx ? await ctx.json().catch(() => null) : null
        setToast(`${t.payFailed} (${j?.error ?? errText(error)})`)
      } else setToast(t.payDone)
      window.setTimeout(() => setToast(null), 4000)
      load()
    })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  if (!invoices) return null
  const kidName = (id: string): string => kids.find((k) => k.id === id)?.name ?? ''
  const open = invoices.filter((i) => i.status === 'unpaid' || i.status === 'reported')
  const unpaid = open.filter((i) => i.status === 'unpaid')
  const unpaidTotal = unpaid.reduce((s, i) => s + i.amount, 0)
  const paid = invoices.filter((i) => i.status === 'paid')
  const gOf = (i: Invoice): 'tuition' | 'other' => (isTuition(i.item_name) ? 'tuition' : 'other')
  const cur = group && unpaid.some((i) => gOf(i) === group) ? group : unpaid.some((i) => gOf(i) === 'tuition') ? 'tuition' : 'other'
  const inGroup = unpaid.filter((i) => gOf(i) === cur)
  const picked = inGroup.filter((i) => !unpicked.has(i.id))
  const pickedSum = picked.reduce((s, i) => s + i.amount, 0)
  const toggle = (i: Invoice): void => {
    if (gOf(i) !== cur) {
      // 다른 묶음을 누르면 그 묶음으로 바꾸고, 누른 것만 선택
      setGroup(gOf(i))
      setUnpicked(new Set(unpaid.filter((x) => gOf(x) === gOf(i) && x.id !== i.id).map((x) => x.id)))
      return
    }
    const n = new Set(unpicked); n.has(i.id) ? n.delete(i.id) : n.add(i.id); setUnpicked(n)
  }
  const sections = (['tuition', 'other'] as const)
    .map((g) => ({ g, items: open.filter((i) => gOf(i) === g) }))
    .filter((x) => x.items.length)

  const flash = (m: string): void => {
    setToast(m)
    window.setTimeout(() => setToast(null), 2500)
  }

  return (
    <section className="card pay">
      <div className="pay-head">
        <h3>💳 {t.payTitle}</h3>
        {unpaidTotal > 0 && <span className="pay-total">{t.payTotal} <b>{won(unpaidTotal, lang)}</b></span>}
      </div>

      {open.length === 0 ? (
        <p className="muted">{t.payNone}</p>
      ) : (
        <>
          {sections.map(({ g, items }) => {
            const gUnpaid = items.filter((i) => i.status === 'unpaid')
            const active = g === cur
            const allOn = active && gUnpaid.length > 0 && gUnpaid.every((i) => !unpicked.has(i.id))
            return (
              <div key={g} className={`pay-group ${active ? 'active' : ''}`}>
                <div className="pay-group-head">
                  {gUnpaid.length > 0 && (
                    <input type="checkbox" checked={allOn} onChange={() => {
                      if (!active) { setGroup(g); setUnpicked(new Set()) } else setUnpicked(allOn ? new Set(gUnpaid.map((i) => i.id)) : new Set())
                    }} />
                  )}
                  <b>{g === 'tuition' ? t.payGroupTuition : t.payGroupOther}</b>
                  {sections.length > 1 && <span className="muted tiny">{t.paySeparate}</span>}
                </div>
                <ul className="bills">
                  {items.map((i) => {
                    const on = active && i.status === 'unpaid' && !unpicked.has(i.id)
                    return (
                      <li key={i.id} className={`${i.status} ${on ? 'picked' : ''}`} onClick={i.status === 'unpaid' ? () => toggle(i) : undefined}>
                        <div className="bill-main">
                          {i.status === 'unpaid' && <input type="checkbox" className="bill-check" checked={on} onChange={() => toggle(i)} onClick={(e) => e.stopPropagation()} />}
                          <div className="grow">
                            <b>{itemLabel(i.item_name, i.period, lang)}</b>
                            <div className="muted small">
                              {kidName(i.student_id)}
                              {i.due_date && ` · ${t.payDue} ${i.due_date.slice(5).replace('-', '/')}`}
                            </div>
                          </div>
                          <b className="bill-amount">{won(i.amount, lang)}</b>
                        </div>
                        {i.status === 'reported' && <div className="bill-status">⏳ {t.payReported} · {t.payReportedBody}</div>}
                      </li>
                    )
                  })}
                </ul>
              </div>
            )
          })}
          {unpaid.length > 0 && (
            <div className="pay-bar">
              <div className="grow">
                <div className="small muted">{cur === 'tuition' ? t.payGroupTuition : t.payGroupOther} · {t.paySelected.replace('{n}', String(picked.length))}</div>
                <b>{won(pickedSum, lang)}</b>
              </div>
              <button className="primary big" disabled={!picked.length} onClick={() => setPaying(picked)}>💳 {t.payNow}</button>
            </div>
          )}
        </>
      )}

      {paid.length > 0 && (
        <>
          <button className="ghost small-btn" onClick={() => setShowHistory(!showHistory)}>
            {showHistory ? '▲' : '▼'} {t.payHistory} ({paid.length})
          </button>
          {showHistory && (
            <ul className="days">
              {paid.slice(0, 24).map((i) => (
                <li key={i.id}>
                  <span>{itemLabel(i.item_name, i.period, lang)} <span className="muted small">{kidName(i.student_id)}</span></span>
                  <span className="ok">✓ {won(i.paid_amount ?? i.amount, lang)}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {toast && <div className="toast">{toast}</div>}
      {paying && bank && (
        <PaySheet invoices={paying} bank={bank} kidName={kidName}
          onClose={() => setPaying(null)} onReport={() => { setReporting(paying); setPaying(null) }} onCopied={() => flash(t.payCopied)}
          onLocalDone={() => { setPaying(null); setUnpicked(new Set()); flash(t.payLocalSent); load() }} />
      )}
      {reporting && (
        <ReportSheet
          invoices={reporting}
          payers={payers}
          onClose={() => setReporting(null)}
          onDone={() => {
            setReporting(null)
            setUnpicked(new Set())
            load()
          }}
        />
      )}
    </section>
  )
}

/** 선택한 것들의 이름: "김민준 11월 수련비 외 2건" */
function namesOf(list: Invoice[], kidName: (id: string) => string, lang: Parameters<typeof itemLabel>[2], others: string): string {
  const first = `${kidName(list[0].student_id)} ${itemLabel(list[0].item_name, list[0].period, lang)}`.trim()
  return list.length > 1 ? `${first} ${others.replace('{n}', String(list.length - 1))}` : first
}

function ReportSheet({ invoices, payers, onClose, onDone }: {
  invoices: Invoice[]
  payers: string[]
  onClose(): void
  onDone(): void
}): JSX.Element {
  const { t, lang } = useI18n()
  const [payer, setPayer] = useState(payers[payers.length - 1] ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const sum = invoices.reduce((s, i) => s + i.amount, 0)
  const send = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    for (const inv of invoices) {
      const { error } = await supabase.rpc('report_payment', { p_invoice: inv.id, p_payer: payer })
      if (error) { setBusy(false); setErr(`${t.error} (${errText(error)})`); return }
    }
    setBusy(false)
    onDone()
  }
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>{t.payReportTitle}</h2>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>
        <div className="form">
          <ul className="plain pay-items">
            {invoices.map((i) => <li key={i.id}><span>{itemLabel(i.item_name, i.period, lang)}</span><span>{won(i.amount, lang)}</span></li>)}
          </ul>
          <div className="report-sum"><span>{t.payTotal}</span><b>{won(sum, lang)}</b></div>
          <label>
            {t.payPayer}
            <input value={payer} onChange={(e) => setPayer(e.target.value)} list="payer-list" autoFocus />
            <datalist id="payer-list">{payers.map((p) => <option key={p} value={p} />)}</datalist>
            <span className="hint">{t.payPayerHint}</span>
          </label>
          {payers.length > 0 && (
            <div className="pills">
              {payers.map((p) => (
                <button key={p} className={p === payer ? 'pill on' : 'pill'} onClick={() => setPayer(p)}>{p}</button>
              ))}
            </div>
          )}
          {err && <div className="error">{err}</div>}
          <button className="primary big" disabled={busy || !payer.trim()} onClick={send}>{busy ? t.loading : t.payReportSend}</button>
        </div>
      </div>
    </div>
  )
}

/* ---------------- 결제 수단 고르기: 카드 · 토스페이 · 무통장 · 지역화폐 ---------------- */

type PayKind = 'card' | 'tosspay' | 'bank' | 'local'
declare global { interface Window { TossPayments?: unknown } }

function loadTossSdk(): Promise<void> {
  if (window.TossPayments) return Promise.resolve()
  return new Promise((ok, fail) => {
    const sc = document.createElement('script')
    sc.src = 'https://js.tosspayments.com/v2/standard'
    sc.onload = () => ok()
    sc.onerror = () => fail(new Error('sdk_load_failed'))
    document.head.appendChild(sc)
  })
}

function PaySheet({ invoices, bank, kidName, onClose, onReport, onCopied, onLocalDone }: {
  invoices: Invoice[]; bank: OrgBank; kidName(id: string): string
  onClose(): void; onReport(): void; onCopied(): void; onLocalDone(): void
}): JSX.Element {
  const { t, lang } = useI18n()
  const online = !!bank.toss_client_key
  const local = bank.local_pay ?? ''
  const [kind, setKind] = useState<PayKind>(online ? 'card' : 'bank')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const total = invoices.reduce((s, i) => s + i.amount, 0)
  const name = namesOf(invoices, kidName, lang, t.payOthers).slice(0, 90)

  // 무통장: 계좌별로 묶기 (수련비 계좌 / 기타 계좌)
  const groups: { acc: BankAccount; label: string; sum: number; items: Invoice[] }[] = []
  let noAcc = false
  for (const i of invoices) {
    const acc = accountFor(bank, i.item_name)
    if (!acc) { noAcc = true; continue }
    const g = groups.find((x) => x.acc.bank_account === acc.bank_account)
    if (g) { g.sum += i.amount; g.items.push(i) } else groups.push({ acc, label: isTuition(i.item_name) ? t.payAccountTuition : t.payAccountOther, sum: i.amount, items: [i] })
  }
  if (groups.length === 1) groups[0].label = t.payAccountFor

  /** 지역화폐: 도장에서 결제하겠다고 알림 → 관리자 화면 "확인 대기" → 단말기 결제 후 관장님이 확인 */
  const sendLocal = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    for (const inv of invoices) {
      const { error } = await supabase.rpc('report_payment', { p_invoice: inv.id, p_payer: `${local}(방문결제)` })
      if (error) { setBusy(false); setErr(`${t.error} (${errText(error)})`); return }
    }
    setBusy(false)
    onLocalDone()
  }

  const go = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      await loadTossSdk()
      const TP = window.TossPayments as unknown as ((k: string) => { payment(o: { customerKey: string }): { requestPayment(o: Record<string, unknown>): Promise<void> } }) & { ANONYMOUS: string }
      const back = location.origin + location.pathname
      const ids = invoices.map((i) => i.id).join(',')
      const payment = TP(bank.toss_client_key!).payment({ customerKey: TP.ANONYMOUS })
      await payment.requestPayment({
        method: 'CARD',
        amount: { currency: 'KRW', value: total },
        orderId: `kc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
        orderName: name,
        customerName: kidName(invoices[0].student_id) || undefined,
        successUrl: `${back}?pay=success&inv=${ids}`,
        failUrl: back + '?pay=fail',
        card: kind === 'tosspay'
          ? { flowMode: 'DIRECT', easyPay: 'TOSSPAY', useEscrow: false }
          : { flowMode: 'DEFAULT', useEscrow: false, useCardPoint: false, useAppCardOnly: false }
      })
    } catch (e) {
      const m = errText(e)
      if (!/USER_CANCEL|취소/.test(m)) setErr(`${t.payFailed} (${m})`)
    } finally {
      setBusy(false)
    }
  }

  const opts: [PayKind, string, string][] = [
    ...(online ? [['card', '💳', t.payCard], ['tosspay', '🔵', t.payTossPay]] as [PayKind, string, string][] : []),
    ['bank', '🏦', t.payBank],
    ...(local ? [['local', '🏪', t.payLocal.replace('{name}', local)]] as [PayKind, string, string][] : [])
  ]
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>{t.payMethod}</h2>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>
        <div className="form">
          <ul className="plain pay-items">
            {invoices.map((i) => <li key={i.id}><span>{kidName(i.student_id)} · {itemLabel(i.item_name, i.period, lang)}</span><span>{won(i.amount, lang)}</span></li>)}
          </ul>
          <div className="report-sum"><span>{t.payTotal}</span><b>{won(total, lang)}</b></div>
          <div className="pay-opts">
            {opts.map(([k, icon, label]) => (
              <button key={k} className={kind === k ? 'pay-opt on' : 'pay-opt'} onClick={() => setKind(k)}>
                <span className="radio" /> <span className="pay-ico">{icon}</span> {label}
              </button>
            ))}
          </div>
          {kind === 'bank' ? (
            <>
              {groups.map((g) => (
                <div key={g.acc.bank_account}>
                  <AccountCard acc={g.acc} label={groups.length > 1 ? `${g.label} · ${won(g.sum, lang)}` : g.label} onCopied={onCopied} />
                  {isMobile() && <a className="btn toss" href={tossLink(g.acc, g.sum)}>{t.payToss}{groups.length > 1 ? ` (${won(g.sum, lang)})` : ''}</a>}
                </div>
              ))}
              {groups.length > 0 && <BankApps acc={groups.length === 1 ? groups[0].acc : null} onCopied={onCopied} />}
              {noAcc && <p className="notify-warn">{t.payNoAccount}</p>}
              <p className="muted small">{t.payBankHint}</p>
              <button className="primary big" disabled={!groups.length} onClick={onReport}>{t.payReport}</button>
            </>
          ) : kind === 'local' ? (
            <>
              <div className="account-card">
                <b>🏪 {local}</b>
                <div className="small">{t.payLocalHint.replace('{name}', local)}</div>
              </div>
              <button className="primary big" disabled={busy} onClick={sendLocal}>{busy ? t.loading : t.payLocalBtn.replace('{name}', local)}</button>
            </>
          ) : (
            <button className="primary big" disabled={busy} onClick={go}>{busy ? t.loading : `${won(total, lang)} ${t.payGo} →`}</button>
          )}
          {err && <div className="error">{err}</div>}
        </div>
      </div>
    </div>
  )
}

/* ---------------- 계좌 카드 · 은행 앱 바로가기 ---------------- */

function AccountCard({ label, acc, onCopied }: { label: string; acc: BankAccount; onCopied(): void }): JSX.Element {
  const { t } = useI18n()
  return (
    <div className="account-card">
      <div className="small muted">{label}</div>
      <div className="acc-num">{acc.bank_name} <b>{acc.bank_account}</b></div>
      <div className="small">{t.payHolder}: {acc.account_holder}</div>
      <button className="primary acc-copy" onClick={() => copyText(acc.bank_account.replace(/[^0-9]/g, '')).then(onCopied)}>📋 {t.payCopy}</button>
    </div>
  )
}

/** 앱 바로 열기: 확실한 앱은 앱 주소로, 나머지는 스토어의 그 앱 화면(설치돼 있으면 [열기])으로 */
const BANK_APPS: { name: string; ios?: string; android: string; color: string }[] = [
  { name: '토스', ios: 'supertoss://', android: 'viva.republica.toss', color: '#0064ff' },
  { name: '카카오뱅크', ios: 'kakaobank://', android: 'com.kakaobank.channel', color: '#f5c400' },
  { name: 'KB스타뱅킹', ios: 'kbbank://', android: 'com.kbstar.kbbank', color: '#ffbc00' },
  { name: '신한 SOL뱅크', android: 'com.shinhan.sbanking', color: '#0046ff' },
  { name: '우리WON뱅킹', android: 'com.wooribank.smart.npib', color: '#0067ac' },
  { name: '하나원큐', android: 'com.kebhana.hanapush', color: '#009490' },
  { name: 'NH올원뱅크', android: 'nh.smart.nhallonepay', color: '#04a54f' },
  { name: 'IBK i-ONE뱅크', android: 'com.ibk.android.ionebank', color: '#0d4ea3' },
  { name: '케이뱅크', android: 'com.kbankwith.smartbank', color: '#1b1b6f' },
  { name: '새마을금고', android: 'com.kfcc.mgsmartbank', color: '#2e7bd6' }
]
type BankApp = (typeof BANK_APPS)[number]
const isIOS = (): boolean => /iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

function openBankApp(app: BankApp): void {
  const store = (): void => {
    location.href = `itms-apps://search.itunes.apple.com/WebObjects/MZSearch.woa/wa/search?media=software&term=${encodeURIComponent(app.name)}`
  }
  if (isIOS()) {
    if (!app.ios) return store()
    // 앱이 열리면 화면이 숨겨짐 → 1.5초 뒤에도 그대로면 앱이 없는 것 → 앱스토어
    const timer = window.setTimeout(() => { if (!document.hidden) store() }, 1500)
    document.addEventListener('visibilitychange', () => { if (document.hidden) clearTimeout(timer) }, { once: true })
    location.href = app.ios
    return
  }
  // 안드로이드: 앱이 있으면 실행, 없으면 플레이스토어
  const fallback = encodeURIComponent(`https://play.google.com/store/apps/details?id=${app.android}`)
  location.href = `intent://#Intent;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;package=${app.android};S.browser_fallback_url=${fallback};end`
}

function BankApps({ acc, onCopied }: { acc: BankAccount | null; onCopied(): void }): JSX.Element | null {
  const { t } = useI18n()
  if (!isMobile()) return null
  const apps = BANK_APPS
  const go = async (app: BankApp): Promise<void> => {
    if (acc) {
      await copyText(acc.bank_account.replace(/[^0-9]/g, ''))
      onCopied()
      window.setTimeout(() => openBankApp(app), 400)
    } else openBankApp(app)
  }
  return (
    <div className="bank-apps">
      <div className="small"><b>{t.payOpenApp}</b> <span className="muted">{acc ? t.payOpenAppHint : t.payOpenAppHint2}</span></div>
      <div className="bank-grid">
        {apps.map((a) => (
          <button key={a.name} onClick={() => go(a)}>
            <span className="bank-dot" style={{ background: a.color }}>{a.name.slice(0, 1)}</span>
            {a.name}
          </button>
        ))}
      </div>
    </div>
  )
}
