// 홈 화면에 추가할 수 있게 해 주는 최소한의 서비스 워커 (다음 단계에서 앱 알림을 여기에 붙임)
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', () => {})
