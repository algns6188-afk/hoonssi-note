import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)

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

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(() => {})
}
