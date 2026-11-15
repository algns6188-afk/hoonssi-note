import { useEffect, useState } from 'react'
import { useI18n } from './i18n'
import { disablePush, enablePush, getPushState, refreshPush, sendTestPush, type PushState } from './push'
import { InstallLink, openInBrowser } from './install'
import { errText } from './supabase'

/** 학부모 화면: 출석 알림 켜기/끄기/테스트 */
export function NotifyCard({ userId }: { userId: string }): JSX.Element {
  const { t, lang } = useI18n()
  const [state, setState] = useState<PushState>('loading')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    getPushState().then(setState).catch(() => setState('unsupported'))
  }, [])
  // 켜져 있으면 언어 등 최신 정보로
  useEffect(() => {
    if (state === 'on') refreshPush(userId, lang)
  }, [state, userId, lang])

  const run = async (fn: () => Promise<unknown>, after?: () => void): Promise<void> => {
    setBusy(true)
    setMsg(null)
    try {
      await fn()
      after?.()
    } catch (e) {
      const m = errText(e)
      setMsg({ ok: false, text: m === 'denied' ? t.notifyDenied : `${t.notifyFail} (${m})` })
    } finally {
      setBusy(false)
      setState(await getPushState().catch(() => 'unsupported' as PushState))
    }
  }

  if (state === 'loading') return <></>
  return (
    <section className={state === 'on' ? 'card notify on' : 'card notify'}>
      <div className="notify-head">
        <span className="notify-icon">{state === 'on' ? '🔔' : '🔕'}</span>
        <div className="grow">
          <b>{t.notifyTitle}</b>
          <div className="small muted">{state === 'on' ? t.notifyOn : t.notifyOffBody}</div>
        </div>
      </div>

      {state === 'off' && (
        <button className="primary big wide" disabled={busy} onClick={() => run(() => enablePush(userId, lang))}>{t.notifyEnable}</button>
      )}
      {state === 'on' && (
        <div className="row">
          <button className="grow" disabled={busy} onClick={() => run(sendTestPush, () => setMsg({ ok: true, text: t.notifyTestSent }))}>{t.notifyTest}</button>
          <button className="ghost" disabled={busy} onClick={() => run(disablePush)}>{t.notifyDisable}</button>
        </div>
      )}
      {state === 'denied' && <p className="notify-warn">{t.notifyDenied}</p>}
      {state === 'ios-needs-install' && (
        <>
          <p className="notify-warn">{t.notifyIosInstall}</p>
          <InstallLink />
        </>
      )}
      {state === 'kakao' && (
        <>
          <p className="notify-warn">{t.notifyKakao}</p>
          <button className="primary wide" onClick={openInBrowser}>🌐</button>
        </>
      )}
      {state === 'unsupported' && <p className="notify-warn">{t.notifyUnsupported}</p>}
      {msg && <div className={msg.ok ? 'notice-ok' : 'error'}>{msg.text}</div>}
    </section>
  )
}
