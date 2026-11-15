import { useCallback, useEffect, useState } from 'react'
import { supabase, errText, type Student } from '../supabase'
import { useI18n } from '../i18n'
import { copyText, isMobile, itemLabel, tossLink, won, type Invoice, type OrgBank } from '../billing'

/** 학부모 화면: 납부할 내역 · 도장 계좌 · 토스/계좌 복사 · "입금했어요" */
export function ParentPayments({ kids }: { kids: Student[] }): JSX.Element | null {
  const { t, lang } = useI18n()
  const [invoices, setInvoices] = useState<Invoice[] | null>(null)
  const [bank, setBank] = useState<OrgBank | null>(null)
  const [payers, setPayers] = useState<string[]>([])
  const [reporting, setReporting] = useState<Invoice | null>(null)
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

  if (!invoices) return null
  const kidName = (id: string): string => kids.find((k) => k.id === id)?.name ?? ''
  const open = invoices.filter((i) => i.status === 'unpaid' || i.status === 'reported')
  const unpaidTotal = open.filter((i) => i.status === 'unpaid').reduce((s, i) => s + i.amount, 0)
  const paid = invoices.filter((i) => i.status === 'paid')
  const hasBank = !!bank?.bank_account

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
                  </div>
                  <b className="bill-amount">{won(i.amount, lang)}</b>
                </div>
                {i.status === 'reported' ? (
                  <div className="bill-status">⏳ {t.payReported} · {t.payReportedBody}</div>
                ) : (
                  <div className="bill-actions">
                    {hasBank && isMobile() && (
                      <a className="btn toss" href={tossLink(bank!, i.amount)}>{t.payToss}</a>
                    )}
                    <button className="primary" onClick={() => setReporting(i)}>{t.payReport}</button>
                  </div>
                )}
              </li>
            ))}
          </ul>

          {hasBank ? (
            <div className="account">
              <div className="muted small">{t.payHowTo}</div>
              <div className="account-box">
                <div>
                  <div className="small muted">{t.payAccount}</div>
                  <b>{bank!.bank_name} {bank!.bank_account}</b>
                  <div className="small">{bank!.account_holder}</div>
                </div>
                <button onClick={() => copyText(bank!.bank_account.replace(/[^0-9]/g, '')).then(() => flash(t.payCopied))}>{t.payCopy}</button>
              </div>
            </div>
          ) : (
            <p className="notify-warn">{t.payNoAccount}</p>
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
