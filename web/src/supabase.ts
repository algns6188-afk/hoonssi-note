import { createClient } from '@supabase/supabase-js'

// 공개용 주소·키 (로그인한 사람만 자기 권한만큼 데이터를 볼 수 있음)
export const SUPABASE_URL = 'https://gqgeduyjicntceotatku.supabase.co'
export const SUPABASE_KEY = 'sb_publishable_2kbeU_c-SYoC8Bz5Jrxucw_qJwEAq8Y'

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true }
})

/** 학부모는 이메일 대신 아이디로 가입 → 내부적으로 이메일 모양으로 바꿔 저장 */
export const PARENT_DOMAIN = 'parent.kangcheol.invalid'
export const loginEmail = (id: string): string => {
  const v = id.trim().toLowerCase()
  return v.includes('@') ? v : `${v}@${PARENT_DOMAIN}`
}

export type Role = 'admin' | 'staff' | 'parent' | 'kiosk'
export interface Member {
  user_id: string
  org_id: string
  role: Role
  display_name: string
  lang: string
}
export interface Student {
  id: string
  org_id: string
  name: string
  code: string
  group_name: string
  active: boolean
  created_at: string
}
export interface Attendance {
  id: string
  student_id: string
  kind: 'in' | 'out'
  at: string
  source: 'kiosk' | 'staff'
}
export interface TimelineItem {
  id: string
  kind: string
  summary: string
  student_id: string | null
  at: string
}
export interface Invite {
  code: string
  role: 'staff' | 'parent' | 'kiosk'
  student_ids: string[]
  label: string
  max_uses: number
  use_count: number
  expires_at: string
  created_at: string
}

/** 한국 시간 기준 오늘 0시 */
export function todayStartIso(): string {
  const now = new Date()
  const kst = new Date(now.getTime() + 9 * 3600_000)
  const d = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate()) - 9 * 3600_000
  return new Date(d).toISOString()
}

export const hhmm = (iso: string): string =>
  new Date(iso).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul' })

/** 헷갈리는 글자(0,O,1,I) 뺀 초대 코드 */
export function makeCode(len = 8): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const buf = new Uint32Array(len)
  crypto.getRandomValues(buf)
  return Array.from(buf, (n) => chars[n % chars.length]).join('')
}

export function errText(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message)
  return String(e)
}
