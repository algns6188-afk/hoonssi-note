import { supabase } from './supabase'

/* 전체 백업: 우리 도장 데이터를 한 파일(JSON)로 PC에 저장. 무료, 서버 설정 필요 없음 */

// 백업할 표 (위치 기록·알림 구독·초대 코드처럼 다시 만들 수 있거나 민감한 건 뺌)
const TABLES = [
  'orgs', 'members', 'students', 'student_contacts', 'guardians',
  'attendance', 'absences',
  'fee_items', 'invoices', 'payer_names', 'pay_methods',
  'vehicles', 'stops', 'runs', 'run_stops', 'ride_assignments', 'ride_requests', 'ride_exceptions', 'shuttle_areas', 'shuttle_trips',
  'timeline',
  'notes', 'tasks', 'athletes', 'growth_records'      // PC 프로그램(회의·업무·선수 기록)
] as const

const SECRET_COLS: Record<string, string[]> = { vehicles: ['gps_token'] }

async function readAll(table: string): Promise<Record<string, unknown>[] | null> {
  const out: Record<string, unknown>[] = []
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select('*').range(from, from + 999)
    if (error) return out.length ? out : null       // 표가 없거나 권한 없음
    out.push(...((data as Record<string, unknown>[]) ?? []))
    if (!data || data.length < 1000) break
  }
  for (const col of SECRET_COLS[table] ?? []) for (const r of out) if (col in r) r[col] = r[col] ? '(백업에서 제외)' : null
  return out
}

function save(name: string, text: string, type: string): void {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([text], { type }))
  a.download = name
  a.style.display = 'none'
  document.body.appendChild(a)   // 일부 브라우저는 화면에 붙어 있어야 파일 이름이 지켜짐
  a.click()
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove() }, 4000)
}

const today = (): string => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10)

export async function downloadBackup(onProgress: (msg: string) => void): Promise<Record<string, number>> {
  const tables: Record<string, unknown[]> = {}
  const counts: Record<string, number> = {}
  for (let i = 0; i < TABLES.length; i++) {
    const t = TABLES[i]
    onProgress(`${i + 1}/${TABLES.length} · ${t}`)
    const rows = await readAll(t)
    if (rows) { tables[t] = rows; counts[t] = rows.length }
  }
  const file = { app: '강철노트', kind: 'full-backup', version: 1, exported_at: new Date().toISOString(), counts, tables }
  save(`강철노트_백업_${today()}.json`, JSON.stringify(file), 'application/json')
  await new Promise((r) => setTimeout(r, 800))   // 두 파일이 연달아 받아지도록

  // 엑셀로 바로 볼 수 있는 학생 명단 (보호자 연락처 포함)
  const st = (tables.students ?? []) as Record<string, string>[]
  const ct = (tables.student_contacts ?? []) as Record<string, string>[]
  const head = ['이름', '출석번호', '반', '부', '학교', '학년', '생년월일', '성별', '학생 전화', '주소', '재원', '등록일', '보호자1', '관계1', '연락처1', '보호자2', '관계2', '연락처2', '메모']
  const rows = st.map((s) => {
    const c = ct.filter((x) => x.student_id === s.id)
    return [s.name, s.code, s.group_name, s.session_no ? `${s.session_no}부` : '', s.school, s.grade, s.birth, s.gender, s.phone, s.address,
      s.active ? '재원' : '퇴관', s.joined_on, c[0]?.name, c[0]?.relation, c[0]?.phone, c[1]?.name, c[1]?.relation, c[1]?.phone, s.notes]
  })
  const csv = [head, ...rows].map((r) => r.map((v) => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t }).join(',')).join('\r\n')
  save(`강철노트_학생명단_${today()}.csv`, '﻿' + csv, 'text/csv;charset=utf-8')

  try { localStorage.setItem('kc-last-backup', new Date().toISOString()) } catch { /* 없음 */ }
  return counts
}

export function lastBackupDays(): number | null {
  try {
    const v = localStorage.getItem('kc-last-backup')
    return v ? Math.floor((Date.now() - Date.parse(v)) / 86400_000) : null
  } catch { return null }
}
