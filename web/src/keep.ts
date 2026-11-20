import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'

/* 화면 상태 기억: 창을 내렸다 오거나 다른 앱에 다녀와서 앱이 새로 열려도
   보던 탭·하위 메뉴·달·스크롤 위치로 돌아가게. 오늘(한국 날짜) 저장한 것만 되살림 */

const PREFIX = 'kc-keep:'
const kstDay = (t = Date.now()): string => new Date(t + 9 * 3600_000).toISOString().slice(0, 10)

export function readKeep<T>(key: string, init: T): T {
  try {
    const raw = localStorage.getItem(PREFIX + key)
    if (!raw) return init
    const { v, at } = JSON.parse(raw) as { v: T; at: number }
    return kstDay(at) === kstDay() ? v : init
  } catch { return init }
}
export function writeKeep(key: string, v: unknown): void {
  try { localStorage.setItem(PREFIX + key, JSON.stringify({ v, at: Date.now() })) } catch { /* 없음 */ }
}

/** useState 와 같지만 값을 기억해 둠. key 가 null 이면 기억 안 함 */
export function useKeep<T>(key: string | null, init: T): [T, Dispatch<SetStateAction<T>>] {
  const [v, setV] = useState<T>(() => (key ? readKeep(key, init) : init))
  useEffect(() => { if (key) writeKeep(key, v) }, [key, v])
  return [v, setV]
}

/** 스크롤 위치 기억 (화면 제목별) */
export function keepScroll(): void {
  const screenKey = (): string => 'scroll:' + (document.querySelector('.m-title')?.textContent ?? document.querySelector('.mobile')?.className ?? '')
  let timer = 0
  const save = (): void => { if (document.querySelector('.mobile')) writeKeep(screenKey(), window.scrollY) }
  window.addEventListener('scroll', () => { window.clearTimeout(timer); timer = window.setTimeout(save, 300) }, { passive: true })
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save() })
  window.addEventListener('pagehide', save)

  // 처음 열릴 때: 화면이 그려지고 내용이 다 불러와질 때까지 잠깐 기다렸다가 되돌림 (사용자가 먼저 움직이면 멈춤)
  let stop = false
  const halt = (): void => { stop = true }
  for (const ev of ['touchstart', 'wheel', 'keydown', 'mousedown']) window.addEventListener(ev, halt, { once: true, passive: true })
  const started = Date.now()
  const tick = (): void => {
    if (stop || Date.now() - started > 5000) return
    if (!document.querySelector('.mobile')) { window.setTimeout(tick, 150); return }
    const y = readKeep<number>(screenKey(), 0)
    if (y <= 0) return
    if (document.documentElement.scrollHeight >= y + window.innerHeight - 10) { window.scrollTo(0, y); return }
    window.setTimeout(tick, 150)
  }
  window.setTimeout(tick, 300)
}
