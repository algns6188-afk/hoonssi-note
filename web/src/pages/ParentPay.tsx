import { useCallback, useEffect, useState } from 'react'
import { supabase, errText, type Student } from '../supabase'
import { useI18n } from '../i18n'
import { accountFor, copyText, isMobile, isTuition, itemLabel, tossLink, won, type BankAccount, type Invoice, type OrgBank } from '../billing'

/** 학부모 화면: 납부할 내역 · 도장 계좌 · 토스/계좌 복사 · "입금했어요" */
export function ParentPayments({ kids }: { kids: Student[] }): JSX.Element | null {
  const { t, lang } = useI18n()
  const [invoices, setInvoices] = useState<Invoice[] | null>(null)
  const [bank, setBank] = useState<OrgBank | null>(null)
  const [payers, setPayers] = useState<string[]>([])
  const [reporting, setReporting] = useState<Invoice | null>(null)
  const [paying, setPaying] = useState<Invoice | null>(null)
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

  // 카드·토스페이 결제창에서 돌아왔을 때 (…?pay=success&paymentKey=…&orderId=…&amount=…)
  useEffect(() => {
    const u = new URL(location.href)
    const r = u.searchParams.get('pay')
    if (!r) return
    const clean = (): void => history.replaceState(null, '', u.pathname)
    if (r === 'fail') { setToast(t.payFailed); clean(); return }
    const paymentKey = u.searchParams.get('paymentKey'), orderId = u.searchParams.get('orderId'), amount = Number(u.searchParams.get('amount'))
    clean()
    if (!paymentKey || !orderId) return
    setToast(t.payChecking)
    supabase.functions.invoke('pay', { body: { paymentKey, orderId, amount } }).then(async ({ error }) => {
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
  const unpaidTotal = open.filter((i) => i.status === 'unpaid').reduce((s, i) => s + i.amount, 0)
  const paid = invoices.filter((i) => i.status === 'paid')
  const unpaid = open.filter((i) => i.status === 'unpaid')
  const accOf = (i: Invoice): BankAccount | null => accountFor(bank, i.item_name)
  // 미납 청구에 필요한 계좌들 (수련비용 / 그 외용). 같은 계좌면 하나로
  const accounts: { label: string; acc: BankAccount }[] = []
  for (const [tuition, label] of [[true, t.payAccountTuition], [false, t.payAccountOther]] as const) {
    const inv = unpaid.find((i) => isTuition(i.item_name) === tuition)
    const acc = inv && accOf(inv)
    if (acc && !accounts.some((a) => a.acc.bank_account === acc.bank_account)) accounts.push({ label, acc })
  }
  const split = !!bank?.bank2_account && bank.bank2_account !== bank.bank_account
  if (accounts.length === 1 && !split) accounts[0].label = t.payAccount
  const missing = unpaid.some((i) => !accOf(i))

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
          {accounts.length > 0 && (
            <div className="account">
              {accounts.map(({ label, acc }) => (
                <AccountCard key={acc.bank_account} label={label} acc={acc} onCopied={() => flash(t.payCopied)} />
              ))}
              {/* 계좌가 둘이면 어느 걸 보낼지 몰라서 자동 복사 안 함 → 위 카드에서 먼저 복사 */}
              <BankApps acc={accounts.length === 1 ? accounts[0].acc : null} onCopied={() => flash(t.payCopied)} />
              <div className="muted small">{t.payHowTo}</div>
            </div>
          )}
          {missing && <p className="notify-warn">{t.payNoAccount}</p>}

          <ul className="bills">
            {open.map((i) => (
              <li key={i.id} className={i.status}>
                <div className="bill-main">
                  <div>
                    <b>{itemLabel(i.item_name, i.period, lang)}</b>
                    <div className="muted small">
                      {kidName(i.student_id)}
                      {i.due_date && ` · ${t.payDue} ${i.due_date.slice(5).replace('-', '/')}`}
                    </div>
                    {split && i.status === 'unpaid' && accOf(i) && (
                      <div className="small bill-acc">🏦 {t.payAccountFor}: {accOf(i)!.bank_name} {accOf(i)!.bank_account}</div>
                    )}
                  </div>
                  <b className="bill-amount">{won(i.amount, lang)}</b>
                </div>
                {i.status === 'reported' ? (
                  <div className="bill-status">⏳ {t.payReported} · {t.payReportedBody}</div>
                ) : (
                  <div className="bill-actions">
                    {bank?.toss_client_key || bank?.local_pay ? (
                      <button className="primary" onClick={() => setPaying(i)}>💳 {t.payNow}</button>
                    ) : (
                      <>
                        {accOf(i) && isMobile() && (
                          <a className="btn toss" href={tossLink(accOf(i)!, i.amount)}>{t.payToss}</a>
                        )}
                        <button className="primary" onClick={() => setReporting(i)}>{t.payReport}</button>
                      </>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>

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
        <PaySheet invoice={paying} bank={bank} acc={accOf(paying)} kidName={kidName(paying.student_id)}
          onClose={() => setPaying(null)} onReport={() => { setReporting(paying); setPaying(null) }} onCopied={() => flash(t.payCopied)}
          onLocalDone={() => { setPaying(null); flash(t.payLocalSent); load() }} />
      )}
      {reporting && (
        <ReportSheet
          invoice={reporting}
          payers={payers}
          onClose={() => setReporting(null)}
          onDone={() => {
            setReporting(null)
            load()
          }}
        />
      )}
    </section>
  )
}

function ReportSheet({ invoice, payers, onClose, onDone }: {
  invoice: Invoice
  payers: string[]
  onClose(): void
  onDone(): void
}): JSX.Element {
  const { t, lang } = useI18n()
  const [payer, setPayer] = useState(payers[payers.length - 1] ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const send = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    const { error } = await supabase.rpc('report_payment', { p_invoice: invoice.id, p_payer: payer })
    setBusy(false)
    if (error) setErr(`${t.error} (${errText(error)})`)
    else onDone()
  }
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>{t.payReportTitle}</h2>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>
        <div className="form">
          <div className="report-sum">
            <span>{itemLabel(invoice.item_name, invoice.period, lang)}</span>
            <b>{won(invoice.amount, lang)}</b>
          </div>
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

/* ---------------- 결제 수단 고르기: 카드 · 토스페이 · 무통장 ---------------- */

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

function PaySheet({ invoice, bank, acc, kidName, onClose, onReport, onCopied, onLocalDone }: {
  invoice: Invoice; bank: OrgBank; acc: BankAccount | null; kidName: string
  onClose(): void; onReport(): void; onCopied(): void; onLocalDone(): void
}): JSX.Element {
  const { t, lang } = useI18n()
  const online = !!bank.toss_client_key
  const local = bank.local_pay ?? ''
  const [kind, setKind] = useState<PayKind>(online ? 'card' : 'bank')

  /** 지역화폐: 도장에서 결제하겠다고 알림 → 관리자 화면 "확인 대기" → 단말기 결제 후 관장님이 확인 */
  const sendLocal = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    const { error } = await supabase.rpc('report_payment', { p_invoice: invoice.id, p_payer: `${local}(방문결제)` })
    setBusy(false)
    if (error) setErr(`${t.error} (${errText(error)})`)
    else onLocalDone()
  }
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const name = `${kidName} ${itemLabel(invoice.item_name, invoice.period, lang)}`.trim().slice(0, 90)

  const go = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      await loadTossSdk()
      const TP = window.TossPayments as unknown as ((k: string) => { payment(o: { customerKey: string }): { requestPayment(o: Record<string, unknown>): Promise<void> } }) & { ANONYMOUS: string }
      const back = location.origin + location.pathname
      const payment = TP(bank.toss_client_key!).payment({ customerKey: TP.ANONYMOUS })
      await payment.requestPayment({
        method: 'CARD',
        amount: { currency: 'KRW', value: invoice.amount },
        orderId: `inv-${invoice.id}-${Date.now().toString(36)}`,
        orderName: name,
        customerName: kidName || undefined,
        successUrl: back + '?pay=success',
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
          <div className="report-sum">
            <span>{name}</span>
            <b>{won(invoice.amount, lang)}</b>
          </div>
          <div className="pay-opts">
            {opts.map(([k, icon, label]) => (
              <button key={k} className={kind === k ? 'pay-opt on' : 'pay-opt'} onClick={() => setKind(k)}>
                <span className="radio" /> <span className="pay-ico">{icon}</span> {label}
              </button>
            ))}
          </div>
          {kind === 'bank' ? (
            acc ? (
              <>
                <AccountCard acc={acc} label={t.payAccountFor} onCopied={onCopied} />
                <BankApps acc={acc} onCopied={onCopied} />
                <p className="muted small">{t.payBankHint}</p>
                {isMobile() && <a className="btn toss" href={tossLink(acc, invoice.amount)}>{t.payToss}</a>}
                <button className="primary big" onClick={onReport}>{t.payReport}</button>
              </>
            ) : <p className="notify-warn">{t.payNoAccount}</p>
          ) : kind === 'local' ? (
            <>
              <div className="account-card">
                <b>🏪 {local}</b>
                <div className="small">{t.payLocalHint.replace('{name}', local)}</div>
              </div>
              <button className="primary big" disabled={busy} onClick={sendLocal}>{busy ? t.loading : t.payLocalBtn.replace('{name}', local)}</button>
            </>
          ) : (
            <button className="primary big" disabled={busy} onClick={go}>{busy ? t.loading : `${won(invoice.amount, lang)} ${t.payGo} →`}</button>
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
