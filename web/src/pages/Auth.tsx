import { useState } from 'react'
import { supabase, loginEmail, errText } from '../supabase'
import { LANGS, useI18n, type Lang } from '../i18n'
import { InstallBanner, InstallLink } from '../install'

export function LangPicker(): JSX.Element {
  const { lang, setLang } = useI18n()
  return (
    <select className="lang-pick" value={lang} onChange={(e) => setLang(e.target.value as Lang)} aria-label="language">
      {LANGS.map((l) => (
        <option key={l.id} value={l.id}>🌐 {l.label}</option>
      ))}
    </select>
  )
}

/** 서버 오류 문구를 각 언어 안내로 바꿈 */
function useErr(): (e: unknown) => string {
  const { t } = useI18n()
  return (e) => {
    const m = errText(e)
    for (const k of ['invalid_code', 'expired_code', 'used_code', 'other_org'] as const) if (m.includes(k)) return t[k]
    if (/invalid login/i.test(m)) return t.wrongLogin
    if (/already registered|already exists/i.test(m)) return t.idTaken
    return `${t.error} (${m})`
  }
}

export default function AuthScreen(): JSX.Element {
  const { t } = useI18n()
  const [mode, setMode] = useState<'login' | 'signup'>('login')
  return (
    <div className="auth">
      <div className="auth-top">
        <LangPicker />
      </div>
      <InstallBanner />
      <div className="auth-brand">
        <div className="logo big">강</div>
        <h1>{t.appName}</h1>
      </div>
      <div className="seg">
        <button className={mode === 'login' ? 'on' : ''} onClick={() => setMode('login')}>{t.login}</button>
        <button className={mode === 'signup' ? 'on' : ''} onClick={() => setMode('signup')}>{t.signup}</button>
      </div>
      {mode === 'login' ? <LoginForm /> : <SignupForm />}
      <InstallLink />
    </div>
  )
}

function LoginForm(): JSX.Element {
  const { t } = useI18n()
  const toErr = useErr()
  const [id, setId] = useState('')
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const submit = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    const { error } = await supabase.auth.signInWithPassword({ email: loginEmail(id), password: pw })
    if (error) setErr(toErr(error))
    setBusy(false)
  }
  return (
    <form className="card form" onSubmit={(e) => (e.preventDefault(), submit())}>
      <label>{t.idOrEmail}<input autoCapitalize="none" autoComplete="username" value={id} onChange={(e) => setId(e.target.value)} /></label>
      <label>{t.password}<input type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} /></label>
      {err && <div className="error">{err}</div>}
      <button className="primary big" disabled={busy || !id || !pw}>{busy ? t.loading : t.login}</button>
    </form>
  )
}

function SignupForm(): JSX.Element {
  const { t, lang } = useI18n()
  const toErr = useErr()
  const [step, setStep] = useState<1 | 2>(1)
  const [code, setCode] = useState('')
  const [id, setId] = useState('')
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const checkCode = async (): Promise<void> => {
    setBusy(true)
    setErr(null)
    const { data, error } = await supabase.rpc('check_invite', { p_code: code })
    setBusy(false)
    if (error) return setErr(toErr(error))
    const r = (data as { valid: boolean; reason: string | null }[])[0]
    if (!r?.valid) return setErr(toErr(r?.reason ?? 'invalid_code'))
    setStep(2)
  }

  const signup = async (): Promise<void> => {
    if (!/^[a-zA-Z0-9]{4,20}$/.test(id)) return setErr(t.idInvalid)
    if (pw.length < 6) return setErr(t.pwShort)
    if (pw !== pw2) return setErr(t.pwMismatch)
    setBusy(true)
    setErr(null)
    try {
      const { data, error } = await supabase.auth.signUp({ email: loginEmail(id), password: pw })
      if (error) throw error
      if (!data.session) {
        // 이메일 인증이 켜져 있는 경우: 바로 로그인 시도
        const r = await supabase.auth.signInWithPassword({ email: loginEmail(id), password: pw })
        if (r.error) throw r.error
      }
      const { error: e2 } = await supabase.rpc('redeem_invite', { p_code: code, p_name: name, p_lang: lang })
      if (e2) throw e2
      location.reload()
    } catch (e) {
      setErr(toErr(e))
      setBusy(false)
    }
  }

  return step === 1 ? (
    <form className="card form" onSubmit={(e) => (e.preventDefault(), checkCode())}>
      <label>
        {t.inviteCode}
        <input className="code-input" autoCapitalize="characters" maxLength={8} value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} placeholder="ABCD2345" />
        <span className="hint">{t.inviteCodeHint}</span>
      </label>
      {err && <div className="error">{err}</div>}
      <button className="primary big" disabled={busy || code.length < 6}>{busy ? t.loading : t.next}</button>
    </form>
  ) : (
    <form className="card form" onSubmit={(e) => (e.preventDefault(), signup())}>
      <label>{t.name}<input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.nameHint} /></label>
      <label>{t.id}<input autoCapitalize="none" autoComplete="username" value={id} onChange={(e) => setId(e.target.value.trim())} /><span className="hint">{t.idHint}</span></label>
      <label>{t.password}<input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /><span className="hint">{t.passwordHint}</span></label>
      <label>{t.passwordConfirm}<input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></label>
      <label>{t.language}<LangPicker /></label>
      {err && <div className="error">{err}</div>}
      <div className="row">
        <button type="button" onClick={() => setStep(1)}>{t.back}</button>
        <button className="primary big grow" disabled={busy || !id || !pw || !name}>{busy ? t.loading : t.done}</button>
      </div>
    </form>
  )
}

/** 로그인은 됐는데 도장과 연결 안 된 경우 (예: 코드 입력 전에 창을 닫음) */
export function JoinScreen({ onJoined }: { onJoined(): void }): JSX.Element {
  const { t, lang } = useI18n()
  const toErr = useErr()
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const submit = async (): Promise<void> => {
    setErr(null)
    const { error } = await supabase.rpc('redeem_invite', { p_code: code, p_name: name, p_lang: lang })
    if (error) setErr(toErr(error))
    else onJoined()
  }
  return (
    <div className="auth">
      <div className="auth-top"><LangPicker /></div>
      <form className="card form" onSubmit={(e) => (e.preventDefault(), submit())}>
        <h2>{t.needCodeTitle}</h2>
        <p className="muted">{t.needCodeBody}</p>
        <label>{t.inviteCode}<input className="code-input" maxLength={8} value={code} onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} /></label>
        <label>{t.name}<input value={name} onChange={(e) => setName(e.target.value)} placeholder={t.nameHint} /></label>
        {err && <div className="error">{err}</div>}
        <button className="primary big" disabled={code.length < 6}>{t.connect}</button>
        <button type="button" className="ghost" onClick={() => supabase.auth.signOut()}>{t.logout}</button>
      </form>
    </div>
  )
}
