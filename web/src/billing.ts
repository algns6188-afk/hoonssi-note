import type { Lang } from './i18n'

export interface Invoice {
  id: string
  org_id: string
  student_id: string
  item_name: string
  period: string | null
  amount: number
  due_date: string | null
  status: 'unpaid' | 'reported' | 'paid' | 'canceled'
  memo: string
  created_at: string
  reported_at: string | null
  reported_payer: string | null
  paid_at: string | null
  paid_amount: number | null
  paid_method: 'transfer' | 'cash' | 'card' | 'other' | null
}
export interface FeeItem {
  id: string
  name: string
  default_amount: number
  monthly: boolean
  sort: number
  active: boolean
}
export interface OrgBank {
  name: string
  bank_name: string
  bank_account: string
  account_holder: string
  bank2_name?: string
  bank2_account?: string
  account2_holder?: string
  toss_client_key?: string
  local_pay?: string
}
export interface BankAccount { bank_name: string; bank_account: string; account_holder: string }

/** 수강료(수련비)인지: 수강료 계좌로 받는 청구 */
export const isTuition = (item: string): boolean => item === '수련비'

/** 이 청구를 받을 계좌: 수련비 → 1번(수강료 계좌), 나머지 → 2번(없으면 1번) */
export function accountFor(bank: OrgBank | null, item: string): BankAccount | null {
  if (!bank) return null
  const one = { bank_name: bank.bank_name, bank_account: bank.bank_account, account_holder: bank.account_holder }
  const two = { bank_name: bank.bank2_name ?? '', bank_account: bank.bank2_account ?? '', account_holder: bank.account2_holder ?? '' }
  const pick = !isTuition(item) && two.bank_account ? two : one
  return pick.bank_account ? pick : null
}

const ITEM: Record<string, Record<Exclude<Lang, 'ko'>, string>> = {
  수련비: { zh: '学费', ru: 'плата за обучение', en: 'tuition' },
  심사비: { zh: '考级费', ru: 'аттестация', en: 'belt test fee' },
  '대회 참가비': { zh: '比赛报名费', ru: 'взнос за соревнования', en: 'competition fee' },
  도복비: { zh: '道服费', ru: 'форма (добок)', en: 'uniform (dobok)' },
  체험학습비: { zh: '体验学习费', ru: 'экскурсия', en: 'field trip fee' }
}
const RU_MONTH = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь']
const EN_MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** "12월 수련비" → 각 언어 */
export function itemLabel(item: string, period: string | null, l: Lang = 'ko'): string {
  const m = period ? Number(period.slice(5, 7)) : 0
  if (l === 'ko') return (m ? `${m}월 ` : '') + item
  const name = ITEM[item]?.[l] ?? item
  if (!m) return name
  if (l === 'zh') return `${m}月${name}`
  if (l === 'ru') return `${name} (${RU_MONTH[m - 1]})`
  return `${EN_MONTH[m - 1]} ${name}`
}

export const won = (n: number, l: Lang = 'ko'): string =>
  l === 'ko' ? `${n.toLocaleString('ko-KR')}원` : `₩${n.toLocaleString('en-US')}`

export const thisPeriod = (): string => {
  const k = new Date(Date.now() + 9 * 3600_000)
  return `${k.getUTCFullYear()}-${String(k.getUTCMonth() + 1).padStart(2, '0')}`
}
export const shiftPeriod = (p: string, d: number): string => {
  const [y, m] = p.split('-').map(Number)
  const t = new Date(Date.UTC(y, m - 1 + d, 1))
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}`
}
export const periodLabel = (p: string): string => `${p.slice(0, 4)}년 ${Number(p.slice(5, 7))}월`

/** 토스 송금 화면을 도장 계좌·금액이 채워진 상태로 열기 (토스 앱이 있을 때) */
export function tossLink(bank: BankAccount, amount: number): string {
  const acct = bank.bank_account.replace(/[^0-9]/g, '')
  return `supertoss://send?amount=${amount}&bank=${encodeURIComponent(bank.bank_name)}&accountNo=${acct}&origin=qr`
}

export const isMobile = (): boolean => /Android|iPhone|iPad|iPod/i.test(navigator.userAgent)

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // 오래된 브라우저
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  }
}
