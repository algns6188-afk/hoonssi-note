import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  supabase, errText, hhmm, makeCode, todayStartIso,
  type Attendance, type Invite, type Member, type Student, type TimelineItem
} from '../supabase'
import { dayLabel, useI18n } from '../i18n'
import KioskScreen from './Kiosk'
import BillingTab, { StudentBillingSection, useBaseFee } from './AdminBilling'
import AssistantBox from './Assistant'
import { StudentForm, studentLine, type StudentFull } from './StudentForm'
import ShuttleTab, { ShuttleAreasPage } from './Shuttle'
import { DailyBook, MonthlyBook } from './AttendanceBook'
import { InstallBanner, InstallGuide } from '../install'
import { downloadBackup, lastBackupDays } from '../backup'

type Tab = 'today' | 'students' | 'billing' | 'shuttle' | 'timeline' | 'more'
const APP_URL = location.origin + location.pathname

/** 관리자·선생님 화면 (한국어) */
export default function AdminApp({ member }: { member: Member }): JSX.Element {
  const [tab, setTab] = useState<Tab>('today')
  const [kiosk, setKiosk] = useState(false)
  const [att, setAtt] = useState<'today' | 'daily' | 'monthly'>('today')
  const [shv, setShv] = useState<'table' | 'areas'>('table')
  const [dayKey, setDayKey] = useState(0) // 월별에서 날짜 눌렀을 때 일별 새로 열기
  const [openDay, setOpenDay] = useState<string | null>(null)
  const [students, setStudents] = useState<Student[]>([])
  const [today, setToday] = useState<Attendance[]>([])
  const [absent, setAbsent] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    const [s, a] = await Promise.all([
      supabase.from('students').select('*').order('name'),
      supabase.from('attendance').select('id,student_id,kind,at,source').gte('at', todayStartIso()).order('at', { ascending: false })
    ])
    setStudents((s.data as Student[]) ?? [])
    setToday((a.data as Attendance[]) ?? [])
    const kst = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)
    const { data: ab } = await supabase.from('absences').select('*').eq('date', kst)
    const LBL: Record<string, string> = { absent: '결석', sick: '병가', trip: '체험학습', early: '조퇴' }
    setAbsent(Object.fromEntries(((ab as { student_id: string; reason: string; kind?: string }[]) ?? [])
      .filter((x) => x.kind !== 'early')   // 조퇴는 온 학생이라 결석 칸에 안 넣음
      .map((x) => [x.student_id, `${LBL[x.kind ?? 'absent'] ?? '결석'}${x.reason ? ` · ${x.reason}` : ''}`])))
  }, [])

  useEffect(() => {
    load()
    const ch = supabase
      .channel('admin-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'attendance' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'students' }, () => load())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'absences' }, () => load())
      .subscribe()
    return () => void supabase.removeChannel(ch)
  }, [load])

  if (kiosk) return <KioskScreen onExit={() => setKiosk(false)} />

  return (
    <div className="mobile admin">
      <header className="m-head">
        <div className="logo">강</div>
        <div className="grow">
          <div className="m-title">{tab === 'shuttle' && shv === 'areas' ? '운행 구역 표시' : tab === 'today' && att !== 'today' ? (att === 'daily' ? '일별 출석부' : '월별 출석부') : { today: '오늘 출석', students: '학생 관리', billing: '수납 관리', shuttle: '강철셔틀 · 차량표', timeline: '타임라인', more: '더보기' }[tab]}</div>
          <div className="muted small">{member.display_name} · {member.role === 'admin' ? '관리자' : '선생님'}</div>
        </div>
      </header>

      <InstallBanner />
      {tab !== 'more' && !(tab === 'shuttle' && shv === 'areas') && <AssistantBox />}
      {tab === 'today' && (
        <div className="att-subtabs">
          {([['today', '오늘'], ['daily', '일별'], ['monthly', '월별']] as const).map(([id, label]) => (
            <button key={id} className={att === id ? 'pill on' : 'pill'} onClick={() => { setAtt(id); setOpenDay(null) }}>{label}</button>
          ))}
        </div>
      )}
      {tab === 'today' && att === 'today' && <TodayTab students={students} today={today} absent={absent} onKiosk={() => setKiosk(true)} />}
      {tab === 'today' && att === 'daily' && <DailyBook key={dayKey} students={students} initialDate={openDay ?? undefined} />}
      {tab === 'today' && att === 'monthly' && <MonthlyBook students={students} onOpenDay={(d) => { setOpenDay(d); setDayKey(dayKey + 1); setAtt('daily') }} />}
      {tab === 'students' && <StudentsTab students={students} reload={load} />}
      {tab === 'billing' && <BillingTab students={students} member={member} />}
      {tab === 'shuttle' && (
        <div className="att-subtabs">
          {([['table', '차량표'], ['areas', '운행 구역']] as const).map(([id, label]) => (
            <button key={id} className={shv === id ? 'pill on' : 'pill'} onClick={() => setShv(id)}>{label}</button>
          ))}
        </div>
      )}
      {tab === 'shuttle' && shv === 'table' && <ShuttleTab students={students} member={member} />}
      {tab === 'shuttle' && shv === 'areas' && <ShuttleAreasPage member={member} />}
      {tab === 'timeline' && <TimelineTab />}
      {tab === 'more' && <MoreTab member={member} students={students} onKiosk={() => setKiosk(true)} />}

      <nav className="tabbar">
        <div className="side-brand"><div className="logo">강</div>강철노트</div>
        {([['today', '✅', '출석'], ['students', '🥋', '학생'], ['billing', '💳', '수납'], ['shuttle', '🚐', '차량'], ['timeline', '🕒', '기록'], ['more', '⋯', '더보기']] as const).map(([id, icon, label]) => (
          <div key={id} className="tab-group">
            <button className={tab === id ? 'on' : ''} onClick={() => { setTab(id); if (id === 'today') setAtt('today'); if (id === 'shuttle') setShv('table') }}>
              <span>{icon}</span>{label}
            </button>
            {id === 'shuttle' && tab === 'shuttle' && (
              <div className="subnav">
                {([['table', '차량표'], ['areas', '운행 구역']] as const).map(([k, l]) => (
                  <button key={k} className={shv === k ? 'on' : ''} onClick={() => setShv(k)}>{l}</button>
                ))}
              </div>
            )}
            {id === 'today' && tab === 'today' && (
              <div className="subnav">
                {([['today', '오늘'], ['daily', '일별'], ['monthly', '월별']] as const).map(([k, l]) => (
                  <button key={k} className={att === k ? 'on' : ''} onClick={() => { setAtt(k); setOpenDay(null) }}>{l}</button>
                ))}
              </div>
            )}
          </div>
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

function TodayTab({ students, today, absent, onKiosk }: { students: Student[]; today: Attendance[]; absent: Record<string, string>; onKiosk(): void }): JSX.Element {
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
  const absentCount = active.filter((s) => s.id in absent && statusOf(s.id, today).s === 'none').length

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
        <div><b>{counts.none - absentCount}</b><span>미등원{absentCount ? ` (결석 ${absentCount})` : ''}</span></div>
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
                {st.s === 'none' && s.id in absent ? (
                  <span className="status absent" title={absent[s.id]}>{absent[s.id] || '결석'}</span>
                ) : (
                  <span className={`status ${st.s}`}>
                    {st.s === 'none' ? '미등원' : st.s === 'in' ? `등원 ${hhmm(st.inAt!)}` : `하원 ${hhmm(st.outAt!)}`}
                  </span>
                )}
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
  const [session, setSession] = useState<string>('전체')
  const [showInactive, setShowInactive] = useState(false)
  const [editing, setEditing] = useState<Student | 'new' | null>(null)
  const all = students as StudentFull[]
  const base = all.filter((s) => showInactive || s.active)
  const sessions = ['전체', ...[1, 2, 3, 4, 5, 6].filter((n) => base.some((s) => s.session_no === n)).map((n) => `${n}부`), ...(base.some((s) => !s.session_no) ? ['미지정'] : []), '차량', '국기원']
  const list = base
    .filter((s) =>
      session === '전체' ? true : session === '미지정' ? !s.session_no : session === '차량' ? s.shuttle_use : session === '국기원' ? !!s.temp_class : s.session_no === Number(session[0]))
    .filter((s) => !q || [s.name, s.code, s.group_name, s.school, s.grade, s.class_name, s.address].some((x) => x?.includes(q)))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'))

  return (
    <div className="page">
      <div className="row wrap">
        <button className="primary grow" onClick={() => setEditing('new')}>+ 학생 등록</button>
        <span className="muted small">재원 {all.filter((s) => s.active).length}명</span>
      </div>
      <input className="search" placeholder="이름·출석번호·학교·학년·주소 검색" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="pills">
        {sessions.map((g) => (
          <button key={g} className={g === session ? 'pill on' : 'pill'} onClick={() => setSession(g)}>
            {g}<span className="pill-count">{g === '전체' ? base.length : g === '미지정' ? base.filter((s) => !s.session_no).length : g === '차량' ? base.filter((s) => s.shuttle_use).length : g === '국기원' ? base.filter((s) => s.temp_class).length : base.filter((s) => s.session_no === Number(g[0])).length}</span>
          </button>
        ))}
      </div>
      <label className="check"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} /> 퇴관한 학생도 보기</label>
      <ul className="list">
        {list.map((s) => (
          <li key={s.id}>
            <button className="row-btn" onClick={() => setEditing(s)}>
              <span className="grow">
                <b>{s.name}</b> {!s.active && <span className="chip">퇴관</span>}
                {s.temp_class && <span className="chip accent">{s.temp_class}</span>}
                {s.shuttle_use && <span title="차량 이용"> 🚐</span>}
                <br /><span className="muted small">{studentLine(s) || s.group_name || '정보 없음'}</span>
              </span>
              <span className="code-chip">{s.code}</span>
            </button>
          </li>
        ))}
      </ul>
      {list.length === 0 && <p className="muted center">해당하는 학생이 없습니다.</p>}
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
  const baseFee = useBaseFee()
  const [err, setErr] = useState<string | null>(null)
  const [codeHint, setCodeHint] = useState('')
  const groups = [...new Set(['초등부', '유치부', '중고등', '선수단', '입시반', ...all.map((s) => s.group_name).filter(Boolean)])]

  useEffect(() => {
    if (!student) uniqueCode(all.map((s) => s.code)).then(setCodeHint)
  }, [student, all])

  const remove = async (): Promise<void> => {
    if (!student || !confirm(`${student.name} 학생을 완전히 삭제할까요?\n출석·수납 기록도 함께 지워집니다. 그만둔 학생은 '퇴관'으로 두는 것을 권장합니다.`)) return
    await supabase.from('students').delete().eq('id', student.id)
    await reload()
    onClose()
  }

  return (
    <Sheet title={student ? student.name : '새 학생'} onClose={onClose}>
      {student && <p className="muted small sheet-sub">{studentLine(student as StudentFull)}</p>}
      <StudentForm
        student={student as StudentFull | null}
        codeHint={codeHint}
        groups={groups}
        onError={setErr}
        onSaved={async ({ name, isNew }) => {
          setErr(null)
          if (isNew) {
            const { data: org } = await supabase.rpc('my_org')
            await supabase.from('timeline').insert({ org_id: org, kind: 'student', summary: `${name} 학생 등록` })
          }
          await reload()
          onClose()
        }}
      />
      {err && <div className="error">{err}</div>}
      {student && <StudentBillingSection student={student as Parameters<typeof StudentBillingSection>[0]['student']} baseFee={baseFee} />}
      {student && <FamilySection student={student} all={all} />}
      {student && <button className="ghost danger" onClick={remove}>학생 삭제</button>}
    </Sheet>
  )
}

/** 보호자 목록 + 학부모 초대 코드 */
function FamilySection({ student, all }: { student: Student; all: Student[] }): JSX.Element {
  const { t } = useI18n()
  const [guardians, setGuardians] = useState<{ user_id: string; name: string; lang: string; devices: number }[]>([])
  const [invites, setInvites] = useState<Invite[]>([])
  const [siblings, setSiblings] = useState<string[]>([])
  const [made, setMade] = useState<Invite | null>(null)

  const load = useCallback(async () => {
    const { data: g } = await supabase.from('guardians').select('user_id').eq('student_id', student.id)
    const ids = (g ?? []).map((x) => x.user_id as string)
    const { data: m } = ids.length
      ? await supabase.from('members').select('user_id,display_name,lang').in('user_id', ids)
      : { data: [] }
    const { data: ps } = await supabase.rpc('guardian_push_status', { p_student: student.id })
    const dev = new Map(((ps as { user_id: string; devices: number }[]) ?? []).map((p) => [p.user_id, p.devices]))
    setGuardians((m ?? []).map((x) => ({ user_id: x.user_id, name: x.display_name, lang: x.lang, devices: dev.get(x.user_id) ?? 0 })))
    const { data: inv } = await supabase.from('invites').select('*').eq('role', 'parent').contains('student_ids', [student.id]).order('created_at', { ascending: false })
    setInvites((inv as Invite[]) ?? [])
  }, [student.id])
  useEffect(() => {
    load()
  }, [load])

  const create = async (): Promise<void> => {
    const ids = [student.id, ...siblings]
    const inv = await createParentInvite(all.filter((s) => ids.includes(s.id)))
    if (!inv) return
    setMade(inv)
    setSiblings([])
    load()
  }

  const LANG_NAME: Record<string, string> = { ko: '한국어', zh: '中文', ru: 'Русский', en: 'English' }

  return (
    <div className="family">
      <h3>보호자</h3>
      {guardians.length === 0 ? <p className="muted small">아직 연결된 보호자가 없습니다.</p> : (
        <ul className="plain">{guardians.map((g) => <li key={g.user_id}>👤 {g.name || '(이름 없음)'} <span className="muted small">· {LANG_NAME[g.lang] ?? g.lang}</span>{' '}
          {g.devices > 0 ? <span className="chip ok-chip">🔔 알림 켜짐{g.devices > 1 ? ` (${g.devices}대)` : ''}</span> : <span className="chip">🔕 알림 꺼짐</span>}</li>)}</ul>
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

/** 학부모 초대 코드 발급 (형제는 함께) + 타임라인 기록 */
async function createParentInvite(kids: Student[]): Promise<Invite | null> {
  if (!kids.length) return null
  const { data: org } = await supabase.rpc('my_org')
  const inv = { code: makeCode(), org_id: org, role: 'parent' as const, student_ids: kids.map((k) => k.id), label: `${kids.map((k) => k.name).join('·')} 가족` }
  const { data, error } = await supabase.from('invites').insert(inv).select().single()
  if (error) {
    alert('만들기 실패: ' + errText(error))
    return null
  }
  await supabase.from('timeline').insert({ org_id: org, kind: 'invite', summary: `${inv.label} 학부모 초대 코드 발급 (${inv.code})`, student_id: kids[0].id })
  return data as Invite
}

/** 학부모에게 보낼 안내문 (4개 언어 함께) */
function ShareBox({ invite, studentName }: { invite: Invite; studentName: string }): JSX.Element {
  const text = shareText(invite.code, studentName)
  const [copied, setCopied] = useState(false)
  return (
    <div className="share strong">
      <div className="share-label">🔑 {studentName} 가족 초대 코드</div>
      <div className="share-code">{invite.code}</div>
      <div className="share-meta">2명까지 가입 · {new Date(invite.expires_at).toLocaleDateString('ko-KR')}까지 사용 가능</div>
      <ol className="share-steps">
        <li><b>안내문 복사</b>를 누르세요</li>
        <li>학부모님 카톡에 <b>붙여넣어</b> 보내세요 (4개 언어가 함께 들어가요)</li>
      </ol>
      <div className="row">
        <button className="primary grow big" onClick={() => navigator.clipboard.writeText(text).then(() => setCopied(true))}>
          {copied ? '✓ 복사됨 — 카톡에 붙여넣으세요' : '📋 안내문 복사'}
        </button>
        {'share' in navigator && <button className="big" onClick={() => navigator.share({ text }).catch(() => {})}>공유</button>}
      </div>
      <details>
        <summary className="muted small">보낼 안내문 미리 보기</summary>
        <textarea readOnly value={text} rows={14} />
      </details>
    </div>
  )
}

export function shareText(code: string, studentName: string): string {
  const line = '━━━━━━━━━━━━━━━'
  return [
    `[강철노트] ${studentName} 학부모님 안녕하세요.`,
    `출석 알림·수납 확인 앱 가입 안내입니다.`,
    ``,
    line,
    `🔑 초대 코드:  ${code}`,
    line,
    ``,
    `① 아래 링크 열기`,
    `🔗 ${APP_URL}`,
    `② "초대 코드로 가입" 누르기`,
    `③ 위 초대 코드 입력 (영문 대문자+숫자 8자리)`,
    `④ 아이디·비밀번호 만들기`,
    ``,
    `🇨🇳 邀请码: ${code}`,
    `打开上面的链接 → 点击“用邀请码注册” → 输入邀请码 → 设置账号和密码`,
    ``,
    `🇷🇺 Код приглашения: ${code}`,
    `Откройте ссылку → «Регистрация по коду» → введите код → создайте логин и пароль`,
    ``,
    `🇺🇸 Invite code: ${code}`,
    `Open the link → "Sign up with invite code" → enter the code → create your ID and password`
  ].join('\n')
}

/* ---------------- 타임라인 ---------------- */

const KIND_ICON: Record<string, string> = { attendance: '✅', member: '👤', invite: '🔑', student: '🥋', payment: '💳', shuttle: '🚐', absence: '🚫', assistant: '🤖', note: '📝' }

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

/** 더보기 → 학부모 가입 코드: 학생 고르기 → 코드 + 안내문, 최근 발급한 코드 목록 */
function ParentInviteSection({ students }: { students: Student[] }): JSX.Element {
  const [q, setQ] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [made, setMade] = useState<{ invite: Invite; names: string } | null>(null)
  const [recent, setRecent] = useState<Invite[]>([])
  const [busy, setBusy] = useState(false)

  const loadRecent = useCallback(async () => {
    const { data } = await supabase.from('invites').select('*').eq('role', 'parent').order('created_at', { ascending: false }).limit(10)
    setRecent((data as Invite[]) ?? [])
  }, [])
  useEffect(() => {
    loadRecent()
  }, [loadRecent])

  const active = students.filter((s) => s.active)
  const list = q ? active.filter((s) => s.name.includes(q) || s.code.includes(q)) : active
  const pickedKids = active.filter((s) => picked.includes(s.id))
  const nameOf = (inv: Invite): string =>
    students.filter((s) => inv.student_ids.includes(s.id)).map((s) => s.name).join('·') || inv.label.replace(/ 가족$/, '')

  const revoke = async (i: Invite): Promise<void> => {
    if (!confirm(`${i.code} 코드를 취소할까요?\n이미 가입한 학부모는 그대로 유지되고, 이 코드로는 더 가입할 수 없게 됩니다.`)) return
    await supabase.from('invites').delete().eq('code', i.code)
    const { data: org } = await supabase.rpc('my_org')
    await supabase.from('timeline').insert({ org_id: org, kind: 'invite', summary: `${nameOf(i)} 가족 초대 코드 취소 (${i.code})` })
    if (made?.invite.code === i.code) setMade(null)
    loadRecent()
  }

  const create = async (): Promise<void> => {
    setBusy(true)
    const inv = await createParentInvite(pickedKids)
    setBusy(false)
    if (!inv) return
    setMade({ invite: inv, names: pickedKids.map((k) => k.name).join('·') })
    setPicked([])
    setQ('')
    loadRecent()
  }

  return (
    <section className="card">
      <h3>👨‍👩‍👧 학부모 가입 코드 만들기</h3>
      <p className="muted small">아이를 고르고 코드를 만드세요. 형제·자매는 같이 고르면 코드 하나로 연결돼요. 코드 하나로 2명(엄마·아빠)까지 가입할 수 있고 30일 동안 쓸 수 있어요.</p>
      {active.length === 0 ? (
        <p className="muted small">먼저 학생 탭에서 학생을 등록해 주세요.</p>
      ) : (
        <>
          {pickedKids.length > 0 && (
            <div className="picked">
              {pickedKids.map((k) => (
                <button key={k.id} className="chip-btn" onClick={() => setPicked(picked.filter((x) => x !== k.id))}>{k.name} ✕</button>
              ))}
            </div>
          )}
          <input className="search" placeholder="학생 이름·출석번호 검색" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="pick-list">
            {list.map((s) => (
              <label key={s.id} className="check">
                <input type="checkbox" checked={picked.includes(s.id)} onChange={(e) => setPicked(e.target.checked ? [...picked, s.id] : picked.filter((x) => x !== s.id))} />
                {s.name} <span className="muted small">{s.group_name}</span>
              </label>
            ))}
            {list.length === 0 && <p className="muted small">검색 결과가 없습니다.</p>}
          </div>
          <button className="primary wide" disabled={busy || pickedKids.length === 0} onClick={create}>
            {pickedKids.length ? `🔑 ${pickedKids.map((k) => k.name).join('·')} 가족 코드 만들기` : '아이를 먼저 골라 주세요'}
          </button>
        </>
      )}
      {made && <ShareBox invite={made.invite} studentName={made.names} />}

      {recent.length > 0 && (
        <>
          <h3>최근 발급한 코드</h3>
          <ul className="plain small">
            {recent.map((i) => {
              const expired = new Date(i.expires_at) < new Date()
              const full = i.use_count >= i.max_uses
              return (
                <li key={i.code} className="recent-code">
                  <code>{i.code}</code>
                  <span className="grow">{nameOf(i)}</span>
                  <span className={expired || full ? 'muted' : ''}>{expired ? '만료' : full ? '사용 완료' : `${i.use_count}/${i.max_uses}회`}</span>
                  {!expired && !full && (
                    <button className="ghost small-btn" onClick={() => setMade({ invite: i, names: nameOf(i) })}>안내문</button>
                  )}
                  <button className="ghost small-btn danger" onClick={() => revoke(i)}>취소</button>
                </li>
              )
            })}
          </ul>
        </>
      )}
    </section>
  )
}

function MoreTab({ member, students, onKiosk }: { member: Member; students: Student[]; onKiosk(): void }): JSX.Element {
  const [made, setMade] = useState<{ code: string; role: string } | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  useEffect(() => {
    supabase.from('members').select('*').order('created_at').then(({ data }) => setMembers((data as Member[]) ?? []))
  }, [made])

  const create = async (role: 'staff' | 'kiosk'): Promise<void> => {
    const { data: org } = await supabase.rpc('my_org')
    const code = makeCode()
    const label = role === 'staff' ? '선생님' : '출석 태블릿'
    const { error } = await supabase.from('invites').insert({ code, org_id: org, role, label: '', max_uses: 1, expires_at: new Date(Date.now() + 7 * 86400_000).toISOString() })
    if (error) return alert('만들기 실패: ' + errText(error))
    await supabase.from('timeline').insert({ org_id: org, kind: 'invite', summary: `${label} 초대 코드 발급 (${code})` })
    setMade({ code, role: label })
  }

  const ROLE: Record<string, string> = { admin: '관리자', staff: '선생님', parent: '학부모', kiosk: '출석 태블릿' }
  const count = (r: string): number => members.filter((m) => m.role === r).length

  return (
    <div className="page">
      <ParentInviteSection students={students} />

      <section className="card">
        <h3>출석 태블릿</h3>
        <p className="muted small">이 기기를 출석 화면으로 쓰거나, 입구 태블릿 전용 계정을 만드세요. 전용 계정은 학생 명단을 볼 수 없어 더 안전합니다.</p>
        <button className="wide" onClick={onKiosk}>📟 이 기기를 출석 화면으로</button>
        {member.role === 'admin' && <button className="wide" onClick={() => create('kiosk')}>🔑 태블릿 전용 가입 코드 만들기</button>}
      </section>

      {member.role === 'admin' && <BackupSection />}

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
      </section>

      <section className="card">
        <h3>📲 홈 화면에 추가하는 법</h3>
        <p className="muted small">학부모님이 물어보시면 이 화면을 보여 주세요. 학부모 화면에서는 각자 언어로 나와요.</p>
        <InstallGuide compact />
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

/* ---------------- 전체 백업 (PC에 파일로 저장) ---------------- */

function BackupSection(): JSX.Element {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [days, setDays] = useState(lastBackupDays())
  const run = async (): Promise<void> => {
    setBusy(true); setMsg('백업 준비 중…')
    try {
      const counts = await downloadBackup((m) => setMsg(`읽는 중 ${m}`))
      const total = Object.values(counts).reduce((a, b) => a + b, 0)
      setMsg(`✅ 백업 파일 2개를 받았어요 (모두 ${total.toLocaleString('ko-KR')}건). 다운로드 폴더를 확인해 주세요.`)
      setDays(0)
    } catch (e) {
      setMsg('백업 실패: ' + errText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className={`card backup ${days == null || days >= 7 ? 'due' : ''}`}>
      <h3>💾 전체 데이터 백업</h3>
      <p className="muted small">학생·보호자·출결·수납·차량표·기록 전부를 이 PC(폰)에 파일로 저장해요. 무료예요. <b>일주일에 한 번</b> 받아 두는 걸 추천해요.</p>
      <p className="small">{days == null ? '⚠️ 이 기기에서 아직 백업한 적이 없어요.' : days === 0 ? '마지막 백업: 오늘' : `마지막 백업: ${days}일 전${days >= 7 ? ' — 백업할 때가 됐어요!' : ''}`}</p>
      <button className="primary wide" disabled={busy} onClick={run}>{busy ? '백업 중…' : '💾 지금 백업 받기'}</button>
      {msg && <div className={msg.startsWith('✅') ? 'notice-ok small' : msg.startsWith('백업 실패') ? 'error' : 'muted small'}>{msg}</div>}
      <details className="small">
        <summary>받은 파일은 어떻게 하나요?</summary>
        <ul>
          <li><b>강철노트_백업_날짜.json</b> — 전체 데이터(복원용). 지우지 말고 보관하세요.</li>
          <li><b>강철노트_학생명단_날짜.csv</b> — 엑셀로 바로 열리는 학생·보호자 명단.</li>
          <li>PC의 <b>구글 드라이브·네이버 MYBOX 폴더</b>에 넣어 두면 클라우드에도 자동으로 한 번 더 보관돼요(무료 용량 안에서).</li>
          <li>개인정보가 들어 있으니 USB·메일로 함부로 보내지 마세요.</li>
        </ul>
      </details>
    </section>
  )
}
