import { useCallback, useEffect, useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase, type Member } from './supabase'
import { DICTS, LangContext, detectLang, type Lang } from './i18n'
import AuthScreen, { JoinScreen } from './pages/Auth'
import AdminApp from './pages/Admin'
import ParentApp from './pages/Parent'
import KioskScreen from './pages/Kiosk'

export default function App(): JSX.Element {
  const [lang, setLangState] = useState<Lang>(detectLang())
  const [session, setSession] = useState<Session | null | undefined>(undefined)
  const [member, setMember] = useState<Member | null | undefined>(undefined)

  const setLang = useCallback(
    (l: Lang) => {
      setLangState(l)
      try {
        localStorage.setItem('lang', l)
      } catch {
        // 무시
      }
      document.documentElement.lang = l
      // 로그인한 사람의 언어도 서버에 저장 (나중에 알림을 그 언어로 보내기 위해)
      if (member) supabase.from('members').update({ lang: l }).eq('user_id', member.user_id).then(() => {})
    },
    [member]
  )

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => data.subscription.unsubscribe()
  }, [])

  const loadMember = useCallback(async () => {
    if (!session) {
      setMember(null)
      return
    }
    const { data } = await supabase.from('members').select('*').eq('user_id', session.user.id).maybeSingle()
    setMember((data as Member) ?? null)
    if (data?.lang && data.lang in DICTS) setLangState(data.lang as Lang)
  }, [session])

  useEffect(() => {
    setMember(undefined)
    loadMember()
  }, [loadMember])

  const t = DICTS[lang]
  let screen: JSX.Element
  if (session === undefined || (session && member === undefined)) screen = <div className="center muted">{t.loading}</div>
  else if (!session) screen = <AuthScreen />
  else if (!member) screen = <JoinScreen onJoined={loadMember} />
  else if (member.role === 'kiosk') screen = <KioskScreen />
  else if (member.role === 'parent') screen = <ParentApp member={member} />
  else screen = <AdminApp member={member} />

  return <LangContext.Provider value={{ lang, t, setLang }}>{screen}</LangContext.Provider>
}
