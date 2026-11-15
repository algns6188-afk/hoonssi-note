import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  supabase, errText, hhmm, makeCode, todayStartIso,
  type Attendance, type Invite, type Member, type Student, type TimelineItem
} from '../supabase'
import { dayLabel, useI18n } from '../i18n'
import KioskScreen from './Kiosk'

type Tab = 'today' | 'students' | 'timeline' | 'more'
const APP_URL = location.origin + location.pathname

/** 관리자·선생님 화면 (한국어) */
export default function AdminApp({ member }: { member: Member }): JSX.Element {
  const [tab, setTab] = useState<Tab>('today')
  const [kiosk, setKiosk] = useState(false)
  const [students, setStudents] = useState<Student[]>([])
  const [today, setToday] = useState<Attendance[]>([])

  const load = useCallback(async () => {
    const [s, a] = await Promise.all([
      supabase.from('students').select('*').order('name'),
      supabase.from('attendance').select('id,student_id,kind,at,source').gte('at', todayStartIso()).order('at', { ascending: false })
    ])
    setStudents((s.data as Student[]) ?? [])
    setToday((a.data as Attendance[]) ?? [])
  }, [])

  useEffect(() => {
    load()
    const ch = supabase
      .channel('admin-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'attendance' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'students' }, () => load())
      .subscribe()
    return () => void supabase.removeChannel(ch)
  }, [load])

  if (kiosk) return <KioskScreen onExit={() => setKiosk(false)} />

  return (
    <div className="mobile admin">
      <header className="m-head">
        <div className="logo">강</div>
        <div className="grow">
          <div className="m-title">{{ today: '오늘 출석', students: '학생 관리', timeline: '타임라인', more: '더보기' }[tab]}</div>
          <div className="muted small">{member.display_name} · {member.role === 'admin' ? '관리자' : '선생님'}</div>
        </div>
      </header>

      {tab === 'today' && <TodayTab students={students} today={today} onKiosk={() => setKiosk(true)} />}
      {tab === 'students' && <StudentsTab students={students} reload={load} />}
      {tab === 'timeline' && <TimelineTab />}
      {tab === 'more' && <MoreTab member={member} onKiosk={() => setKiosk(true)} />}

      <nav className="tabbar">
        {([['today', '✅', '출석'], ['students', '🥋', '학생'], ['timeline', '🕒', '타임라인'], ['more', '⋯', '더보기']] as const).map(([id, icon, label]) => (
          <button key={id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>
            <span>{icon}</span>{label}
          </button>
        ))}
      </nav>
    </div>
  )
}

/* ---------------- 오늘 출석 ---------------- */

function statusOf(id: string, today: Attendance[]): { s: 'none' | 'in' | 'out'; inAt?: string; outAt?: string } {
  const rs = today.filter((r) => r.student_id === id)
  const lastIn = rs.find((r) => r.kind === 'in')
  const lastOut = rs.find((r) => r.kind === 'out')
  const s = lastOut && (!lastIn || lastOut.at > lastIn.at) ? 'out' : lastIn ? 'in' : 'none'
  return { s, inAt: lastIn?.at, outAt: lastOut?.at }
}

function TodayTab({ students, today, onKiosk }: { students: Student[]; today: Attendance[]; onKiosk(): void }): JSX.Element {
  const [q, setQ] = useState('')
  const [group, setGroup] = useState('전체')
  const [open, setOpen] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const active = students.filter((s) => s.active)
  const groups = ['전체', ...new Set(active.map((s) => s.group_name).filter(Boolean))]
  const list = active
    .filter((s) => group === '전체' || s.group_name === group)
    .filter((s) => !q || s.name.includes(q) || s.code.includes(q))
  const counts = { in: 0, out: 0, none: 0 }
  for (const s of active) counts[statusOf(s.id, today).s]++

  const check = async (s: Student, kind: 'in' | 'out'): Promise<void> => {
    setBusy(true)
    const { error } = await supabase.rpc('kiosk_check', { p_code: s.code, p_kind: kind })
    setBusy(false)
    if (error) alert('저장 실패: ' + errText(error))
    setOpen(null)
  }

  return (
    <div className="page">
      <div className="stats3">
        <div><b>{counts.in}</b><span>수련 중</span></div>
        <div><b>{counts.out}</b><span>하원</span></div>
        <div><b>{counts.none}</b><span>미등원</span></div>
      </div>
      <button className="primary big wide" onClick={onKiosk}>📟 출석 태블릿 화면 열기</button>
      <input className="search" placeholder="이름 또는 출석번호 검색" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="pills">
        {groups.map((g) => <button key={g} className={g === group ? 'pill on' : 'pill'} onClick={() => setGroup(g)}>{g}</button>)}
      </div>
      {list.length === 0 && <p className="muted center">학생이 없습니다. 학생 탭에서 등록하세요.</p>}
      <ul className="list">
        {list.map((s) => {
          const st = statusOf(s.id, today)
          return (
            <li key={s.id}>
              <button className="row-btn" onClick={() => setOpen(open === s.id ? null : s.id)}>
                <span className="grow">
                  <b>{s.name}</b> <span className="muted small">{s.group_name} · {s.code}</span>
                </span>
                <span className={`status ${st.s}`}>
                  {st.s === 'none' ? '미등원' : st.s === 'in' ? `등원 ${hhmm(st.inAt!)}` : `하원 ${hhmm(st.outAt!)}`}
                </span>
              </button>
              {open === s.id && (
                <div className="row-actions">
                  <button className="choice-sm in" disabled={busy} onClick={() => check(s, 'in')}>등원 체크</button>
                  <button className="choice-sm out" disabled={busy} onClick={() => check(s, 'out')}>하원 체크</button>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/* ---------------- 학생 관리 ---------------- */

function StudentsTab({ students, reload }: { students: Student[]; reload(): Promise<void> }): JSX.Element {
  const [q, setQ] = useState('')
  const [showInactive, setShowInactive] = useState(false)
  const [editing, setEditing] = useState<Student | 'new' | null>(null)
  const list = students
    .filter((s) => showInactive || s.active)
    .filter((s) => !q || s.name.includes(q) || s.code.includes(q) || s.group_name.includes(q))

  return (
    <div className="page">
      <button className="primary big wide" onClick={() => setEditing('new')}>+ 학생 등록</button>
      <input className="search" placeholder="이름·출석번호·부 검색" value={q} onChange={(e) => setQ(e.target.value)} />
      <label className="check"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> 퇴관한 학생도 보기</label>
      <ul className="list">
        {list.map((s) => (
          <li key={s.id}>
            <button className="row-btn" onClick={() => setEditing(s)}>
              <span className="grow"><b>{s.name}</b> {!s.active && <span className="chip">퇴관</span>}<br /><span className="muted small">{s.group_name || '부 없음'}</span></span>
              <span className="code-chip">{s.code}</span>
            </button>
          </li>
        ))}
      </ul>
      {editing && (
        <StudentSheet
          student={editing === 'new' ? null : editing}
          all={students}
          onClose={() => setEditing(null)}
          reload={reload}
        />
      )}
    </div>
  )
}

async function uniqueCode(existing: string[]): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const c = String(Math.floor(1000 + Math.random() * 9000))
    if (!existing.includes(c)) return c
  }
  return String(Math.floor(10000 + Math.random() * 90000))
}

function StudentSheet({ student, all, onClose, reload }: {
  student: Student | null
  all: Student[]
  onClose(): void
  reload(): Promise<void>
}): JSX.Element {
  const [name, setName] = useState(student?.name ?? '')
  const [group, setGroup] = useState(student?.group_name ?? '일반부')
  const [code, setCode] = useState(student?.code ?? '')
  const [active, setActive] = useState(student?.active ?? true)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const groups = [...new Set(['일반부', '입시부', ...all.map((s) => s.group_name).filter(Boolean)])]

  useEffect(() => {
    if (!student) uniqueCode(all.map((s) => s.code)).then(setCode)
  }, [student, all])

  const save = async (): Promise<void> => {
    if (!name.trim()) return setErr('이름을 입력하세요.')
    if (!/^\d{4,6}$/.test(code)) return setErr('출석번호는 숫자 4~6자리로 정해 주세요.')
    setBusy(true)
    setErr(null)
    const { data: org } = await supabase.rpc('my_org')
    const row = { name: name.trim(), group_name: group.trim(), code, active }
    const { error } = student
      ? await supabase.from('students').update(row).eq('id', student.id)
      : await supabase.from('students').insert({ ...row, org_id: org })
    setBusy(false)
    if (error) return setErr(/duplicate|unique/i.test(error.message) ? '이미 다른 학생이 쓰는 출석번호입니다.' : errText(error))
    if (!student) {
      await supabase.from('timeline').insert({ org_id: org, kind: 'student', summary: `${name.trim()} 학생 등록 (${group} · 출석번호 ${code})` })
    }
    await reload()
    onClose()
  }

  const remove = async (): Promise<void> => {
    if (!student || !confirm(`${student.name} 학생을 완전히 삭제할까요?\n출석 기록도 함께 지워집니다. 그만둔 학생은 '퇴관'으로 두는 것을 권장합니다.`)) return
    await supabase.from('students').delete().eq('id', student.id)
    await reload()
    onClose()
  }

  return (
    <Sheet title={student ? student.name : '새 학생'} onClose={onClose}>
      <div className="form">
        <label>이름<input value={name} onChange={(e) => setName(e.target.value)} autoFocus={!student} /></label>
        <label>부<input list="groups" value={group} onChange={(e) => setGroup(e.target.value)} /></label>
        <datalist id="groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
        <label>출석번호 <span className="hint">(아이가 태블릿에 누르는 번호)</span>
          <input inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
        </label>
        {student && (
          <label className="check"><input type="checkbox" checked={!active} onChange={(e) => setActive(!e.target.checked)} /> 퇴관 (출석 화면·명단에서 숨김)</label>
        )}
        {err && <div className="error">{err}</div>}
        <button className="primary big" disabled={busy} onClick={save}>{busy ? '저장 중…' : '저장'}</button>
      </div>
      {student && <FamilySection student={student} all={all} />}
      {student && <button className="ghost danger" onClick={remove}>학생 삭제</button>}
    </Sheet>
  )
}

/** 보호자 목록 + 학부모 초대 코드 */
function FamilySection({ student, all }: { student: Student; all: Student[] }): JSX.Element {
  const { t } = useI18n()
  const [guardians, setGuardians] = useState<{ user_id: string; name: string; lang: string }[]>([])
  const [invites, setInvites] = useState<Invite[]>([])
  const [siblings, setSiblings] = useState<string[]>([])
  const [made, setMade] = useState<Invite | null>(null)

  const load = useCallback(async () => {
    const { data: g } = await supabase.from('guardians').select('user_id').eq('student_id', student.id)
    const ids = (g ?? []).map((x) => x.user_id as string)
    const { data: m } = ids.length
      ? await supabase.from('members').select('user_id,display_name,lang').in('user_id', ids)
      : { data: [] }
    setGuardians((m ?? []).map((x) => ({ user_id: x.user_id, name: x.display_name, lang: x.lang })))
    const { data: inv } = await supabase.from('invites').select('*').eq('role', 'parent').contains('student_ids', [student.id]).order('created_at', { ascending: false })
    setInvites((inv as Invite[]) ?? [])
  }, [student.id])
  useEffect(() => {
    load()
  }, [load])

  const create = async (): Promise<void> => {
    const { data: org } = await supabase.rpc('my_org')
    const ids = [student.id, ...siblings]
    const names = all.filter((s) => ids.includes(s.id)).map((s) => s.name)
    const inv = { code: makeCode(), org_id: org, role: 'parent' as const, student_ids: ids, label: `${names.join('·')} 가족` }
    const { data, error } = await supabase.from('invites').insert(inv).select().single()
    if (error) return alert('만들기 실패: ' + errText(error))
    await supabase.from('timeline').insert({ org_id: org, kind: 'invite', summary: `${inv.label} 학부모 초대 코드 발급 (${inv.code})`, student_id: student.id })
    setMade(data as Invite)
    setSiblings([])
    load()
  }

  const LANG_NAME: Record<string, string> = { ko: '한국어', zh: '中文', ru: 'Русский', en: 'English' }

  return (
    <div className="family">
      <h3>보호자</h3>
      {guardians.length === 0 ? <p className="muted small">아직 연결된 보호자가 없습니다.</p> : (
        <ul className="plain">{guardians.map((g) => <li key={g.user_id}>👤 {g.name || '(이름 없음)'} <span className="muted small">· {LANG_NAME[g.lang] ?? g.lang}</span></li>)}</ul>
      )}

      <h3>학부모 초대 코드</h3>
      <details>
        <summary className="muted small">형제·자매도 같이 연결하려면 선택</summary>
        <div className="sibs">
          {all.filter((s) => s.id !== student.id && s.active).map((s) => (
            <label key={s.id} className="check">
              <input type="checkbox" checked={siblings.includes(s.id)} onChange={(e) => setSiblings(e.target.checked ? [...siblings, s.id] : siblings.filter((x) => x !== s.id))} />
              {s.name}
            </label>
          ))}
        </div>
      </details>
      <button className="wide" onClick={create}>+ 초대 코드 만들기</button>
      {made && <ShareBox invite={made} studentName={student.name} />}
      {invites.length > 0 && (
        <ul className="plain small">
          {invites.map((i) => (
            <li key={i.code}>
              <code>{i.code}</code> · {i.use_count}/{i.max_uses}회 사용 · {new Date(i.expires_at) < new Date() ? '만료' : `~${dayLabel(i.expires_at, t)}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** 학부모에게 보낼 안내문 (4개 언어 함께) */
function ShareBox({ invite, studentName }: { invite: Invite; studentName: string }): JSX.Element {
  const text = shareText(invite.code, studentName)
  const [copied, setCopied] = useState(false)
  return (
    <div className="share">
      <div className="share-code">{invite.code}</div>
      <textarea readOnly value={text} rows={8} />
      <div className="row">
        <button className="primary grow" onClick={() => navigator.clipboard.writeText(text).then(() => setCopied(true))}>
          {copied ? '복사됨 ✓' : '안내문 복사 (카톡에 붙여넣기)'}
        </button>
        {'share' in navigator && <button onClick={() => navigator.share({ text }).catch(() => {})}>공유</button>}
      </div>
    </div>
  )
}

export function shareText(code: string, studentName: string): string {
  return [
    `[강철노트] ${studentName} 학부모님 안녕하세요.`,
    `아래 링크를 열고 "초대 코드로 가입"을 눌러 주세요.`,
    ``,
    `🔗 ${APP_URL}`,
    `🔑 초대 코드 / 邀请码 / Код / Invite code: ${code}`,
    ``,
    `[中文] 请打开上面的链接，点击“用邀请码注册”，输入邀请码。`,
    `[Русский] Откройте ссылку выше, нажмите «Регистрация по коду» и введите код.`,
    `[English] Open the link above, tap "Sign up with invite code" and enter the code.`
  ].join('\n')
}

/* ---------------- 타임라인 ---------------- */

const KIND_ICON: Record<string, string> = { attendance: '✅', member: '👤', invite: '🔑', student: '🥋', payment: '💳' }

function TimelineTab(): JSX.Element {
  const { t } = useI18n()
  const [items, setItems] = useState<TimelineItem[] | null>(null)
  const load = useCallback(async () => {
    const { data } = await supabase.from('timeline').select('id,kind,summary,student_id,at').order('at', { ascending: false }).limit(200)
    setItems((data as TimelineItem[]) ?? [])
  }, [])
  useEffect(() => {
    load()
    const ch = supabase.channel('timeline-live').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'timeline' }, () => load()).subscribe()
    return () => void supabase.removeChannel(ch)
  }, [load])

  const grouped = useMemo(() => {
    const map = new Map<string, TimelineItem[]>()
    for (const i of items ?? []) map.set(dayLabel(i.at, t), [...(map.get(dayLabel(i.at, t)) ?? []), i])
    return [...map.entries()]
  }, [items, t])

  if (!items) return <p className="center muted">불러오는 중…</p>
  return (
    <div className="page">
      {grouped.length === 0 && <p className="muted center">아직 기록이 없습니다.</p>}
      {grouped.map(([day, list]) => (
        <section key={day}>
          <h3 className="day-head">{day}</h3>
          <ul className="timeline">
            {list.map((i) => (
              <li key={i.id}>
                <span className="tl-time">{hhmm(i.at)}</span>
                <span className="tl-icon">{KIND_ICON[i.kind] ?? '•'}</span>
                <span className="grow">{i.summary}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/* ---------------- 더보기 ---------------- */

function MoreTab({ member, onKiosk }: { member: Member; onKiosk(): void }): JSX.Element {
  const [made, setMade] = useState<{ code: string; role: string } | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  useEffect(() => {
    supabase.from('members').select('*').order('created_at').then(({ data }) => setMembers((data as Member[]) ?? []))
  }, [made])

  const create = async (role: 'staff' | 'kiosk'): Promise<void> => {
    const { data: org } = await supabase.rpc('my_org')
    const code = makeCode()
    const label = role === 'staff' ? '선생님' : '출석 태블릿'
    const { error } = await supabase.from('invites').insert({ code, org_id: org, role, label, max_uses: 1, expires_at: new Date(Date.now() + 7 * 86400_000).toISOString() })
    if (error) return alert('만들기 실패: ' + errText(error))
    await supabase.from('timeline').insert({ org_id: org, kind: 'invite', summary: `${label} 초대 코드 발급 (${code})` })
    setMade({ code, role: label })
  }

  const ROLE: Record<string, string> = { admin: '관리자', staff: '선생님', parent: '학부모', kiosk: '출석 태블릿' }
  const count = (r: string): number => members.filter((m) => m.role === r).length

  return (
    <div className="page">
      <section className="card">
        <h3>출석 태블릿</h3>
        <p className="muted small">이 기기를 출석 화면으로 쓰거나, 입구 태블릿 전용 계정을 만드세요. 전용 계정은 학생 명단을 볼 수 없어 더 안전합니다.</p>
        <button className="wide" onClick={onKiosk}>📟 이 기기를 출석 화면으로</button>
        {member.role === 'admin' && <button className="wide" onClick={() => create('kiosk')}>🔑 태블릿 전용 가입 코드 만들기</button>}
      </section>

      {member.role === 'admin' && (
        <section className="card">
          <h3>선생님 추가</h3>
          <button className="wide" onClick={() => create('staff')}>🔑 선생님 가입 코드 만들기</button>
        </section>
      )}
      {made && (
        <div className="share">
          <div className="muted small">{made.role} 가입 코드 (1회용, 7일)</div>
          <div className="share-code">{made.code}</div>
          <p className="small">그 기기에서 <b>{APP_URL}</b> 접속 → "초대 코드로 가입" → 코드 입력</p>
        </div>
      )}

      <section className="card">
        <h3>사용자</h3>
        <p className="small">관리자 {count('admin')} · 선생님 {count('staff')} · 학부모 {count('parent')} · 태블릿 {count('kiosk')}</p>
        <ul className="plain small">
          {members.filter((m) => m.role !== 'parent').map((m) => <li key={m.user_id}>{ROLE[m.role]} · {m.display_name || '(이름 없음)'}</li>)}
        </ul>
      </section>

      <section className="card">
        <h3>앱 주소</h3>
        <p className="small"><code>{APP_URL}</code></p>
        <p className="muted small">휴대폰에서 열고 "홈 화면에 추가"하면 앱처럼 쓸 수 있어요.</p>
      </section>

      <button className="ghost wide" onClick={() => supabase.auth.signOut()}>로그아웃</button>
    </div>
  )
}

/* ---------------- 공통: 아래에서 올라오는 창 ---------------- */

function Sheet({ title, onClose, children }: { title: string; onClose(): void; children: React.ReactNode }): JSX.Element {
  return (
    <div className="sheet-bg" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  )
}
