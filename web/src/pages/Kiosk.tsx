import { useEffect, useRef, useState } from 'react'
import { supabase, hhmm } from '../supabase'
import { useI18n } from '../i18n'
import { LangPicker } from './Auth'

interface Found {
  student_id: string
  name: string
  suggested: 'in' | 'out'
  last_at: string | null
}

/**
 * 도장 입구 태블릿용 출석 화면.
 * 번호 입력 → 이름 확인 → 등원/하원 → 완료 화면(3초) → 처음으로
 * onExit 가 있으면(선생님 폰에서 연 경우) 끝내기 버튼을 길게 눌러 나갈 수 있음.
 */
export default function KioskScreen({ onExit }: { onExit?(): void }): JSX.Element {
  const { t } = useI18n()
  const [code, setCode] = useState('')
  const [found, setFound] = useState<Found | null>(null)
  const [result, setResult] = useState<{ name: string; kind: 'in' | 'out'; at: string; dup: boolean } | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [clock, setClock] = useState(new Date())
  const resetTimer = useRef<number | null>(null)

  useEffect(() => {
    const i = window.setInterval(() => setClock(new Date()), 10_000)
    return () => window.clearInterval(i)
  }, [])

  const reset = (): void => {
    if (resetTimer.current) window.clearTimeout(resetTimer.current)
    setCode('')
    setFound(null)
    setResult(null)
    setMsg(null)
  }
  const resetLater = (ms: number): void => {
    if (resetTimer.current) window.clearTimeout(resetTimer.current)
    resetTimer.current = window.setTimeout(reset, ms)
  }

  const press = (k: string): void => {
    if (found || result) return
    setMsg(null)
    if (k === 'del') setCode((c) => c.slice(0, -1))
    else if (code.length < 6) setCode((c) => c + k)
  }

  const lookup = async (): Promise<void> => {
    if (!code || busy) return
    setBusy(true)
    const { data, error } = await supabase.rpc('kiosk_lookup', { p_code: code })
    setBusy(false)
    const row = (data as Found[] | null)?.[0]
    if (error || !row) {
      setMsg(error ? t.error : t.kioskNotFound)
      setCode('')
      return
    }
    setFound(row)
    resetLater(20_000) // 확인을 안 누르고 가 버리면 20초 뒤 처음으로
  }

  const check = async (kind: 'in' | 'out'): Promise<void> => {
    if (busy) return
    setBusy(true)
    const { data, error } = await supabase.rpc('kiosk_check', { p_code: code, p_kind: kind })
    setBusy(false)
    const row = (data as { name: string; kind: 'in' | 'out'; at: string; duplicate: boolean }[] | null)?.[0]
    if (error || !row) {
      setMsg(t.error)
      resetLater(3000)
      return
    }
    setFound(null)
    setResult({ name: row.name, kind: row.kind, at: row.at, dup: row.duplicate })
    resetLater(3500)
  }

  // 키보드로도 입력 (태블릿에 키보드 연결한 경우)
  useEffect(() => {
    const h = (e: KeyboardEvent): void => {
      if (/^[0-9]$/.test(e.key)) press(e.key)
      else if (e.key === 'Backspace') press('del')
      else if (e.key === 'Enter') lookup()
      else if (e.key === 'Escape') reset()
    }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  })

  return (
    <div className="kiosk">
      <div className="kiosk-top">
        <span className="kiosk-clock">
          {clock.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short', timeZone: 'Asia/Seoul' })}{' '}
          {clock.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Seoul' })}
        </span>
        <LangPicker />
        <ExitButton label={t.kioskExit} onExit={onExit ?? (() => supabase.auth.signOut())} />
      </div>

      {result ? (
        <div className={`kiosk-result ${result.kind}`} onClick={reset}>
          <div className="kiosk-name">{result.name}</div>
          <div className="kiosk-big">{result.dup ? t.kioskDup : result.kind === 'in' ? t.kioskDoneIn : t.kioskDoneOut}</div>
          <div className="kiosk-time">{hhmm(result.at)}</div>
        </div>
      ) : found ? (
        <div className="kiosk-confirm">
          <div className="kiosk-name">{found.name}</div>
          <div className="muted">{t.kioskWhich}</div>
          <div className="kiosk-choices">
            <button className={found.suggested === 'in' ? 'choice in on' : 'choice in'} disabled={busy} onClick={() => check('in')}>{t.kioskIn}</button>
            <button className={found.suggested === 'out' ? 'choice out on' : 'choice out'} disabled={busy} onClick={() => check('out')}>{t.kioskOut}</button>
          </div>
          <button className="ghost" onClick={reset}>{t.back}</button>
        </div>
      ) : (
        <div className="kiosk-pad">
          <h1>{t.kioskTitle}</h1>
          <div className="kiosk-display">{code.replace(/./g, '●') || ' '}</div>
          {msg && <div className="kiosk-msg">{msg}</div>}
          <div className="pad">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'].map((k) =>
              k === 'ok' ? (
                <button key={k} className="key ok" disabled={!code || busy} onClick={lookup}>{t.kioskConfirm}</button>
              ) : k === 'del' ? (
                <button key={k} className="key fn" onClick={() => press('del')}>⌫</button>
              ) : (
                <button key={k} className="key" onClick={() => press(k)}>{k}</button>
              )
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/** 아이들이 실수로 끄지 않게 2초 길게 눌러야 나가짐 */
function ExitButton({ label, onExit }: { label: string; onExit(): void }): JSX.Element {
  const timer = useRef<number | null>(null)
  const [holding, setHolding] = useState(false)
  const start = (): void => {
    setHolding(true)
    timer.current = window.setTimeout(() => {
      setHolding(false)
      if (confirm(label + '?')) onExit()
    }, 2000)
  }
  const stop = (): void => {
    setHolding(false)
    if (timer.current) window.clearTimeout(timer.current)
  }
  return (
    <button className={holding ? 'kiosk-exit holding' : 'kiosk-exit'} onPointerDown={start} onPointerUp={stop} onPointerLeave={stop} title={label}>
      ⏻
    </button>
  )
}
