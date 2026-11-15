import { supabase } from './supabase'

/** 알림 서버 공개키 (비밀키는 서버에만 있음) */
export const VAPID_PUBLIC = 'BJkSNbFzp01b2CKUEH1QG0UyC73e09-6z21K_spZgFCyPh29QjEg2B0vxkLIO8QFpJzB1Dvh9flG14v4N7v3BJQ'

export type PushState = 'loading' | 'unsupported' | 'ios-needs-install' | 'kakao' | 'denied' | 'off' | 'on'

const isIos = (): boolean => /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
const isStandalone = (): boolean =>
  window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true

function keyBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4)
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
}

export async function getPushState(): Promise<PushState> {
  if (/KAKAOTALK/i.test(navigator.userAgent)) return 'kakao'
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
  if (!supported) return isIos() && !isStandalone() ? 'ios-needs-install' : 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  return sub && Notification.permission === 'granted' ? 'on' : 'off'
}

async function save(sub: PushSubscription, userId: string, lang: string): Promise<void> {
  const j = sub.toJSON()
  const { error } = await supabase.from('push_subscriptions').upsert(
    { endpoint: sub.endpoint, user_id: userId, p256dh: j.keys?.p256dh, auth: j.keys?.auth, lang, user_agent: navigator.userAgent.slice(0, 200) },
    { onConflict: 'endpoint' }
  )
  if (error) throw error
}

/** "알림 받기": 권한 묻기 → 이 기기 등록 → 서버에 저장 */
export async function enablePush(userId: string, lang: string): Promise<void> {
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') throw new Error('denied')
  const reg = await navigator.serviceWorker.ready
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC) }))
  await save(sub, userId, lang)
}

/** 앱을 열 때마다: 이미 켜져 있으면 서버 정보를 최신으로 (언어 바뀐 경우 등) */
export async function refreshPush(userId: string, lang: string): Promise<void> {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window) || Notification.permission !== 'granted') return
    const reg = await navigator.serviceWorker.ready
    const sub = await reg.pushManager.getSubscription()
    if (sub) await save(sub, userId, lang)
  } catch {
    // 조용히 넘어감
  }
}

export async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker.ready
  const sub = await reg.pushManager.getSubscription()
  if (sub) {
    await supabase.from('push_subscriptions').delete().eq('endpoint', sub.endpoint)
    await sub.unsubscribe()
  }
}

/** 본인 기기로 테스트 알림 */
export async function sendTestPush(): Promise<{ sent: number }> {
  const { data, error } = await supabase.functions.invoke('notify', { body: { test: true } })
  if (error) throw error
  return data as { sent: number }
}
