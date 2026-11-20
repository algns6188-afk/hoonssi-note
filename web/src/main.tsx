import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'
import { keepScroll } from './keep'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

keepScroll()

/* 휴대폰 "뒤로가기"(아이폰 왼쪽 밀기·안드로이드 뒤로 버튼)로 열린 창 닫기 */
{
  let pushed = false
  new MutationObserver(() => {
    const open = !!document.querySelector('.sheet-bg')
    if (open && !pushed) {
      history.pushState({ sheet: true }, '')
      pushed = true
    } else if (!open && pushed) {
      pushed = false
      if (history.state?.sheet) history.back() // ✕로 닫았으면 쌓아 둔 기록 정리
    }
  }).observe(document.body, { childList: true, subtree: true })
  window.addEventListener('popstate', () => {
    if (!pushed) return
    pushed = false
    const close = document.querySelectorAll<HTMLButtonElement>('.sheet-bg .sheet-head > button')
    close[close.length - 1]?.click()
  })
}

/* 새 버전 확인: 배포된 index.html 의 스크립트 이름이 지금 것과 다르면 새로고침 안내 */
{
  const mine = (document.querySelector('script[type="module"][src*="assets/"]') as HTMLScriptElement | null)?.src.split('/').pop()
  let shown = false
  const check = async (): Promise<void> => {
    if (!mine || shown) return
    try {
      const html = await (await fetch(`./?v=${Date.now()}`, { cache: 'no-store' })).text()
      const latest = /assets\/(index-[^"']+\.js)/.exec(html)?.[1]
      if (!latest || latest === mine) return
      // 입력 중이거나 창이 열려 있으면 안내만, 아니면 바로 새로고침
      const busy = !!document.querySelector('.sheet-bg') || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName ?? '')
      let tried = ''
      try { tried = sessionStorage.getItem('kc-reloaded-for') ?? '' } catch { /* 없음 */ }
      if (!busy && document.visibilityState === 'visible' && tried !== latest) {
        try { sessionStorage.setItem('kc-reloaded-for', latest) } catch { /* 없음 */ }
        location.reload()
        return
      }
      shown = true
      const bar = document.createElement('button')
      bar.className = 'update-bar'
      bar.textContent = '🔄 새 버전이 있어요 · 눌러서 새로고침'
      bar.onclick = () => location.reload()
      document.body.appendChild(bar)
    } catch { /* 오프라인 */ }
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void check() })
  window.addEventListener('focus', () => void check())
  window.setInterval(() => void check(), 5 * 60_000)
  window.setTimeout(() => void check(), 3000)
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {})
}
