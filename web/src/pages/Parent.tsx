import { useCallback, useEffect, useMemo, useState } from 'react'
import { supabase, hhmm, todayStartIso, type Attendance, type Member, type Student } from '../supabase'
import { dayLabel, useI18n } from '../i18n'
import { LangPicker } from './Auth'
import { InstallBanner } from '../install'
import { NotifyCard } from '../notifyCard'
import { ParentPayments } from './ParentPay'
import { ParentShuttle } from './ShuttleLive'

export default function ParentApp({ member }: { member: Member }): JSX.Element {
  const { t } = useI18n()
  const [kids, setKids] = useState<Student[] | null>(null)
  const [records, setRecords] = useState<Attendance[]>([])
  const [absences, setAbsences] = useState<{ student_id: string; date: string; reason: string; kind?: string }[]>([])

  const load = useCallback(async () => {
    const since = new Date(Date.now() - 14 * 86400_000).toISOString()
    const [s, a] = await Promise.all([
      supabase.from('students').select('*').order('name'),
      supabase.from('attendance').select('id,student_id,kind,at,source').gte('at', since).order('at', { ascending: false })
    ])
    setKids((s.data as Student[]) ?? [])
    setRecords((a.data as Attendance[]) ?? [])
    const from = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)
    const { data: ab } = await supabase.from('absences').select('*').gte('date', from).order('date')
    setAbsences((ab as { student_id: string; date: string; reason: string }[]) ?? [])
  }, [])

  useEffect(() => {
    load()
    // 아이가 출석하면 화면이 바로 바뀜 (권한상 우리 아이 기록만 들어옴)
    const ch = supabase
      .channel('parent-attendance')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'attendance' }, () => load())
      .subscribe()
    const onFocus = (): void => void load()
    window.addEventListener('focus', onFocus)
    return () => {
      supabase.removeChannel(ch)
      window.removeEventListener('focus', onFocus)
    }
  }, [load])

  return (
    <div className="mobile parent">
      <header className="m-head">
        <div className="logo">강</div>
        <div className="grow">
          <div className="m-title">{t.myChildren}</div>
          <div className="muted small">{member.display_name}</div>
        </div>
        <LangPicker />
      </header>

      <InstallBanner />
      <NotifyCard userId={member.user_id} />
      {kids && kids.length > 0 && <ParentShuttle kids={kids} />}
      {kids && kids.length > 0 && <ParentPayments kids={kids} />}

      {kids === null ? (
        <p className="center muted">{t.loading}</p>
      ) : kids.length === 0 ? (
        <p className="center muted">{t.noRecords}</p>
      ) : (
        <div className="kids">
          {kids.map((k) => <KidCard key={k.id} kid={k} records={records.filter((r) => r.student_id === k.id)} absences={absences.filter((a) => a.student_id === k.id)} />)}
        </div>
      )}

      <button className="ghost center-btn" onClick={() => supabase.auth.signOut()}>{t.logout}</button>
    </div>
  )
}

function KidCard({ kid, records, absences }: { kid: Student; records: Attendance[]; absences: { date: string; reason: string; kind?: string }[] }): JSX.Element {
  const { t } = useI18n()
  const start = todayStartIso()
  const today = records.filter((r) => r.at >= start)
  const lastIn = today.find((r) => r.kind === 'in')
  const lastOut = today.find((r) => r.kind === 'out')
  const status = lastOut && (!lastIn || lastOut.at > lastIn.at) ? 'out' : lastIn ? 'in' : 'none'

  // 날짜별로 묶기 (오늘 제외)
  const days = useMemo(() => {
    const map = new Map<string, Attendance[]>()
    for (const r of records.filter((x) => x.at < start)) {
      const key = dayLabel(r.at, t)
      map.set(key, [...(map.get(key) ?? []), r])
    }
    return [...map.entries()]
  }, [records, start, t])

  return (
    <section className="card kid">
      <div className="kid-head">
        <span className="kid-av" aria-hidden="true">{kid.name.length >= 3 ? kid.name.slice(1, 2) : kid.name.slice(0, 1)}</span>
        <div className="kid-name">{kid.name}</div>
        <span className={`status ${status}`}>
          {status === 'none' ? t.notArrived : status === 'in' ? `${t.arrived} ${hhmm(lastIn!.at)}` : `${t.left} ${hhmm(lastOut!.at)}`}
        </span>
      </div>
      {absences.length > 0 && (
        <div className="absence-list">
          {absences.map((a) => (
            <div key={a.date}>{a.kind === 'sick' ? `🤒 ${t.absSick}` : a.kind === 'trip' ? `🎒 ${t.absTrip}` : a.kind === 'early' ? `🏃 ${t.absEarly}` : `🚫 ${t.absent}`} {Number(a.date.slice(5, 7))}/{Number(a.date.slice(8, 10))}{a.reason ? ` · ${a.reason}` : ''}</div>
          ))}
        </div>
      )}
      <div className="today-row">
        <div><span className="muted small">{t.arrived}</span><b>{lastIn ? hhmm(lastIn.at) : '–'}</b></div>
        <div><span className="muted small">{t.left}</span><b>{lastOut ? hhmm(lastOut.at) : '–'}</b></div>
      </div>
      <h3>{t.recent}</h3>
      {days.length === 0 ? (
        <p className="muted small">{t.noRecords}</p>
      ) : (
        <ul className="days">
          {days.map(([day, rs]) => {
            const i = [...rs].reverse().find((r) => r.kind === 'in')
            const o = rs.find((r) => r.kind === 'out')
            return (
              <li key={day}>
                <span>{day}</span>
                <span className="muted">{i ? hhmm(i.at) : '–'} → {o ? hhmm(o.at) : '–'}</span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
