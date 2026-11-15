// 강철노트 서비스 워커: 홈 화면 앱 + 출석 알림 표시
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', () => {})

// 서버에서 온 알림을 화면에 띄움
self.addEventListener('push', (e) => {
  let d = {}
  try {
    d = e.data ? e.data.json() : {}
  } catch {
    d = { title: '강철노트', body: e.data ? e.data.text() : '' }
  }
  e.waitUntil(
    self.registration.showNotification(d.title || '강철노트', {
      body: d.body || '',
      icon: './icon-192.png',
      badge: './icon-192.png',
      tag: d.tag || undefined,
      renotify: !!d.tag,
      data: { url: self.registration.scope }
    })
  )
})

// 알림을 누르면 앱을 열거나 열려 있는 앱으로 이동
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) if ('focus' in c) return c.focus()
      return self.clients.openWindow((e.notification.data && e.notification.data.url) || './')
    })
  )
})
