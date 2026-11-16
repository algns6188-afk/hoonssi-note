import { useEffect, useState } from 'react'
import { supabase, errText, type Student } from '../supabase'

/** 수련생 상세 정보 (원생 명단 엑셀의 항목들) */
export interface StudentFull extends Student {
  student_no: string
  birth: string | null
  gender: string
  phone: string
  address: string
  school: string
  grade: string
  class_name: string
  session_no: number | null
  session_label: string
  temp_class: string
  instructor: string
  notes: string
  attend_days: string
  joined_on: string | null
  left_on: string | null
  belt_poom: number | null
  belt_level: number | null
  belt_date: string | null
  shuttle_use: boolean
  shuttle_note: string
  siblings_note: string
  monthly_fee: number | null
  auto_bill: boolean
}
interface Contact { id?: string; name: string; phone: string; relation: string }

export const SESSION_TIMES: Record<number, string> = {
  1: '14:00~15:00', 2: '15:30~16:30', 3: '17:00~18:00', 4: '18:00~19:00', 5: '19:00~21:00', 6: '21:00~22:00'
}
const DAYS = ['월', '화', '수', '목', '금', '토']
const RELATIONS = ['어머니', '아버지', '할머니', '할아버지', '보호자']

const EMPTY: Omit<StudentFull, 'id' | 'org_id' | 'created_at'> = {
  name: '', code: '', group_name: '초등부', active: true, student_no: '', birth: null, gender: '', phone: '', address: '',
  school: '', grade: '', class_name: '', session_no: null, session_label: '', temp_class: '', instructor: '', notes: '',
  attend_days: '월,화,수,목,금', joined_on: null, left_on: null, belt_poom: null, belt_level: null, belt_date: null,
  shuttle_use: false, shuttle_note: '', siblings_note: '', monthly_fee: null, auto_bill: true
}

/** 한 줄 요약: 초4 · 안산서초 · 2부 */
export function studentLine(s: Partial<StudentFull>): string {
  return [s.grade, s.school?.replace(/등학교$|학교$/, ''), s.session_no ? `${s.session_no}부` : '', s.class_name].filter(Boolean).join(' · ')
}

export function StudentForm({ student, codeHint, groups, onSaved, onError }: {
  student: StudentFull | null
  codeHint: string
  groups: string[]
  onSaved(saved: { id: string; name: string; isNew: boolean }): void
  onError(msg: string): void
}): JSX.Element {
  const [f, setF] = useState(() => ({ ...EMPTY, ...(student ?? {}), code: student?.code ?? codeHint }))
  const [contacts, setContacts] = useState<Contact[]>([])
  const [loadedContacts, setLoadedContacts] = useState<Contact[]>([])
  const [busy, setBusy] = useState(false)
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]): void => setF((p) => ({ ...p, [k]: v }))

  useEffect(() => {
    if (!student) {
      setF((p) => ({ ...p, code: p.code || codeHint }))
      return
    }
    supabase.from('student_contacts').select('id,name,phone,relation').eq('student_id', student.id).order('sort').then(({ data }) => {
      const c = (data as Contact[]) ?? []
      setContacts(c)
      setLoadedContacts(c)
    })
  }, [student, codeHint])

  const days = f.attend_days.split(',').filter(Boolean)
  const toggleDay = (d: string): void => {
    const next = days.includes(d) ? days.filter((x) => x !== d) : [...days, d]
    set('attend_days', DAYS.filter((x) => next.includes(x)).join(','))
  }
  const setSession = (n: number | null): void => setF((p) => ({ ...p, session_no: n, session_label: n ? `${n}부 ${SESSION_TIMES[n] ?? ''}`.trim() : '' }))
  const num = (v: string): number | null => (v.trim() === '' ? null : Number(v.replace(/\D/g, '')) || 0)

  const save = async (): Promise<void> => {
    if (!f.name.trim()) return onError('이름을 입력하세요.')
    if (!/^\d{4,6}$/.test(f.code)) return onError('출석번호는 숫자 4~6자리로 정해 주세요.')
    setBusy(true)
    const { data: org } = await supabase.rpc('my_org')
    const row = {
      name: f.name.trim(), code: f.code, group_name: f.group_name.trim(), active: f.active, birth: f.birth || null, gender: f.gender,
      phone: f.phone.trim(), address: f.address.trim(), school: f.school.trim(), grade: f.grade.trim(), class_name: f.class_name.trim(),
      session_no: f.session_no, session_label: f.session_label, temp_class: f.temp_class.trim(), instructor: f.instructor.trim(),
      notes: f.notes, attend_days: f.attend_days, joined_on: f.joined_on || null, left_on: f.active ? null : f.left_on || new Date().toISOString().slice(0, 10),
      belt_poom: f.belt_poom, belt_level: f.belt_level, belt_date: f.belt_date || null, shuttle_use: f.shuttle_use,
      shuttle_note: f.shuttle_note.trim(), siblings_note: f.siblings_note.trim(), student_no: f.student_no || f.code
    }
    const res = student
      ? await supabase.from('students').update(row).eq('id', student.id).select('id').single()
      : await supabase.from('students').insert({ ...row, org_id: org }).select('id').single()
    if (res.error) {
      setBusy(false)
      return onError(/duplicate|unique/i.test(res.error.message) ? '이미 다른 학생이 쓰는 출석번호입니다.' : errText(res.error))
    }
    const id = res.data.id as string
    // 보호자 연락처: 바뀐 것만 반영
    const keep = contacts.filter((c) => c.name.trim() || c.phone.trim())
    const removed = loadedContacts.filter((o) => !keep.some((c) => c.id === o.id))
    if (removed.length) await supabase.from('student_contacts').delete().in('id', removed.map((c) => c.id!))
    for (const [i, c] of keep.entries()) {
      const r = { student_id: id, name: c.name.trim(), phone: c.phone.trim(), relation: c.relation.trim(), sort: i + 1 }
      if (c.id) await supabase.from('student_contacts').update(r).eq('id', c.id)
      else await supabase.from('student_contacts').insert(r)
    }
    setBusy(false)
    onSaved({ id, name: row.name, isNew: !student })
  }

  return (
    <div className="form sform">
      <h3>기본 정보</h3>
      <div className="grid2">
        <label>이름<input value={f.name} onChange={(e) => set('name', e.target.value)} autoFocus={!student} /></label>
        <label>출석번호 <span className="hint">(태블릿에 누르는 번호)</span>
          <input inputMode="numeric" value={f.code} onChange={(e) => set('code', e.target.value.replace(/\D/g, '').slice(0, 6))} /></label>
        <label>성별<select value={f.gender} onChange={(e) => set('gender', e.target.value)}><option value="">-</option><option>남</option><option>여</option></select></label>
        <label>생년월일<input type="date" value={f.birth ?? ''} onChange={(e) => set('birth', e.target.value || null)} /></label>
        <label>학교<input value={f.school} onChange={(e) => set('school', e.target.value)} placeholder="안산서초등학교" /></label>
        <label>학년<input value={f.grade} onChange={(e) => set('grade', e.target.value)} placeholder="초4" /></label>
        <label>학생 휴대폰<input inputMode="tel" value={f.phone} onChange={(e) => set('phone', e.target.value)} /></label>
        <label>가입일<input type="date" value={f.joined_on ?? ''} onChange={(e) => set('joined_on', e.target.value || null)} /></label>
      </div>
      <label>주소<input value={f.address} onChange={(e) => set('address', e.target.value)} /></label>

      <h3>수업</h3>
      <div className="grid2">
        <label>시간대 (부)
          <select value={f.session_no ?? ''} onChange={(e) => setSession(e.target.value ? Number(e.target.value) : null)}>
            <option value="">-</option>
            {[1, 2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}부 {SESSION_TIMES[n]}</option>)}
          </select>
        </label>
        <label>구분<input list="groups" value={f.group_name} onChange={(e) => set('group_name', e.target.value)} placeholder="초등부·선수단·입시반" /></label>
        <label>반<input value={f.class_name} onChange={(e) => set('class_name', e.target.value)} placeholder="입시반·선수단" /></label>
        <label>임시 반 <span className="hint">(예: 국기원)</span><input value={f.temp_class} onChange={(e) => set('temp_class', e.target.value)} placeholder="잠깐 다니는 반" /></label>
      </div>
      <datalist id="groups">{groups.map((g) => <option key={g} value={g} />)}</datalist>
      <div className="days">
        <span className="small muted">출석 요일</span>
        {DAYS.map((d) => <button key={d} type="button" className={days.includes(d) ? 'pill on' : 'pill'} onClick={() => toggleDay(d)}>{d}</button>)}
      </div>
      <div className="grid3">
        <label>품·단<input inputMode="numeric" value={f.belt_poom ?? ''} onChange={(e) => set('belt_poom', num(e.target.value))} /></label>
        <label>급<input inputMode="numeric" value={f.belt_level ?? ''} onChange={(e) => set('belt_level', num(e.target.value))} /></label>
        <label>품증 획득일<input type="date" value={f.belt_date ?? ''} onChange={(e) => set('belt_date', e.target.value || null)} /></label>
      </div>

      <h3>보호자 연락처</h3>
      {contacts.map((c, i) => (
        <div key={c.id ?? `n${i}`} className="contact-row">
          <input className="c-rel" list="relations" value={c.relation} placeholder="관계" onChange={(e) => setContacts(contacts.map((x, j) => (j === i ? { ...x, relation: e.target.value } : x)))} />
          <input className="c-name" value={c.name} placeholder="이름" onChange={(e) => setContacts(contacts.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
          <input className="c-phone" inputMode="tel" value={c.phone} placeholder="010-0000-0000" onChange={(e) => setContacts(contacts.map((x, j) => (j === i ? { ...x, phone: e.target.value } : x)))} />
          {c.phone && <a className="btn call" href={`tel:${c.phone.replace(/\D/g, '')}`}>📞</a>}
          <button type="button" className="ghost small-btn danger" onClick={() => setContacts(contacts.filter((_, j) => j !== i))}>✕</button>
        </div>
      ))}
      <datalist id="relations">{RELATIONS.map((r) => <option key={r} value={r} />)}</datalist>
      <button type="button" onClick={() => setContacts([...contacts, { name: '', phone: '', relation: contacts.length ? '아버지' : '어머니' }])}>+ 보호자 추가</button>

      <h3>차량</h3>
      <label className="check"><input type="checkbox" checked={f.shuttle_use} onChange={(e) => set('shuttle_use', e.target.checked)} /> 차량 이용</label>
      <label>차량 메모<input value={f.shuttle_note} onChange={(e) => set('shuttle_note', e.target.value)} placeholder="예: 원곡초(승차) / 집(하차)" /></label>

      <h3>기타</h3>
      <label>특이사항<textarea rows={3} value={f.notes} onChange={(e) => set('notes', e.target.value)} /></label>
      <label>형제자매<input value={f.siblings_note} onChange={(e) => set('siblings_note', e.target.value)} /></label>
      {student && (
        <label className="check"><input type="checkbox" checked={!f.active} onChange={(e) => set('active', !e.target.checked)} /> 퇴관 (출석 화면·명단·자동 청구에서 빠짐)</label>
      )}
      <button className="primary big" disabled={busy} onClick={save}>{busy ? '저장 중…' : '저장'}</button>
    </div>
  )
}
