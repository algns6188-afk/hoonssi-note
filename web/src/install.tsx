import { useEffect, useState } from 'react'
import { useI18n, type Lang } from './i18n'

/**
 * "홈 화면에 추가" 안내.
 * 접속한 기기·브라우저를 알아내서 그에 맞는 순서를 보여주고,
 * 안드로이드·PC 크롬/엣지는 버튼 한 번으로 설치까지 해 줌.
 */

export type Platform =
  | 'installed' | 'kakao' | 'inapp'
  | 'ios-safari' | 'ios-other' | 'android' | 'samsung'
  | 'desktop-chromium' | 'mac-safari' | 'desktop-other'

export function detectPlatform(): Platform {
  const ua = navigator.userAgent
  const standalone =
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  if (standalone) return 'installed'
  if (/KAKAOTALK/i.test(ua)) return 'kakao'
  if (/NAVER\(|Instagram|FBAN|FBAV|Line\/|DaumApps|everytimeApp/i.test(ua)) return 'inapp'
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  if (ios) return /CriOS|FxiOS|EdgiOS|Whale/.test(ua) ? 'ios-other' : 'ios-safari'
  if (/SamsungBrowser/i.test(ua)) return 'samsung'
  if (/Android/i.test(ua)) return 'android'
  if (/Macintosh/.test(ua) && /Safari/.test(ua) && !/Chrome|Chromium|Edg/.test(ua)) return 'mac-safari'
  if (/Chrome|Chromium|Edg/.test(ua)) return 'desktop-chromium'
  return 'desktop-other'
}

/* ----- 안드로이드·PC 크롬/엣지: 브라우저가 주는 "설치" 기능 붙잡아 두기 ----- */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}
let deferred: BeforeInstallPromptEvent | null = null
const listeners = new Set<() => void>()
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault()
  deferred = e as BeforeInstallPromptEvent
  listeners.forEach((l) => l())
})
window.addEventListener('appinstalled', () => {
  deferred = null
  listeners.forEach((l) => l())
})

function useInstallPrompt(): { canInstall: boolean; install(): Promise<boolean> } {
  const [, force] = useState(0)
  useEffect(() => {
    const l = (): void => force((n) => n + 1)
    listeners.add(l)
    return () => void listeners.delete(l)
  }, [])
  return {
    canInstall: !!deferred,
    async install() {
      if (!deferred) return false
      await deferred.prompt()
      const { outcome } = await deferred.userChoice
      deferred = null
      listeners.forEach((l) => l())
      return outcome === 'accepted'
    }
  }
}

/** 카카오톡 안에서 열렸을 때 기본 브라우저로 다시 열기 */
export function openInBrowser(): void {
  location.href = 'kakaotalk://web/openExternal?url=' + encodeURIComponent(location.href)
}

/* ----- 4개 언어 문구 ----- */

const SHARE = '⬆️'
type Guide = {
  title: string
  oneTap: string
  installed: string
  why: string
  tabs: { phoneIos: string; phoneAndroid: string; computer: string }
  kakaoTitle: string
  kakaoBody: string
  kakaoBtn: string
  kakaoManual: string
  inapp: string
  iosSafari: string[]
  iosOther: string[]
  iosNote: string
  android: string[]
  samsung: string[]
  desktopChromium: string[]
  macSafari: string[]
  desktopOther: string
  openGuide: string
  banner: string
}

const G: Record<Lang, Guide> = {
  ko: {
    title: '휴대폰에 앱으로 설치하기',
    oneTap: '📲 지금 바로 설치',
    installed: '✅ 앱으로 실행 중이에요. 다음부터 홈 화면의 강철노트 아이콘으로 여세요.',
    why: '홈 화면에 추가하면 앱처럼 바로 열리고, 출석 알림도 받을 수 있어요. 앱스토어 설치는 필요 없어요.',
    tabs: { phoneIos: '아이폰', phoneAndroid: '안드로이드', computer: '컴퓨터' },
    kakaoTitle: '카카오톡 안에서 열렸어요',
    kakaoBody: '카카오톡 안에서는 홈 화면에 추가할 수 없어요. 아래 버튼으로 브라우저에서 다시 열어 주세요.',
    kakaoBtn: '🌐 브라우저에서 열기',
    kakaoManual: '버튼이 안 되면: 오른쪽 아래(또는 위) ⋯ / ⋮ 메뉴 → "다른 브라우저로 열기" (아이폰은 "Safari로 열기")',
    inapp: '지금 다른 앱 안에서 열렸어요. 메뉴(⋯ / ⋮)에서 "브라우저로 열기"를 누른 뒤 아래 순서대로 해 주세요. 아이폰은 Safari, 안드로이드는 Chrome을 권장해요.',
    iosSafari: [
      `화면 아래 가운데 공유 버튼 ${SHARE}(네모에 위 화살표)을 눌러요. (아이패드는 화면 위 오른쪽)`,
      '나온 목록을 위로 올려 "홈 화면에 추가"를 눌러요. (안 보이면 맨 아래 "작업 편집"에서 추가)',
      '오른쪽 위 "추가"를 눌러요.',
      '홈 화면에 생긴 강철노트 아이콘으로 열어요.'
    ],
    iosOther: [
      `주소창 오른쪽(또는 아래)의 공유 버튼 ${SHARE}을 눌러요.`,
      '"홈 화면에 추가"를 눌러요. 목록에 없으면 이 주소를 Safari로 열어서 다시 해 주세요.',
      '"추가"를 누르고 홈 화면 아이콘으로 열어요.'
    ],
    iosNote: '알림을 받으려면 iOS 16.4 이상이어야 하고, 꼭 홈 화면 아이콘으로 열어야 해요.',
    android: [
      'Chrome 오른쪽 위 ⋮ (점 세 개)를 눌러요.',
      '"홈 화면에 추가" 또는 "앱 설치"를 눌러요.',
      '"설치"(또는 "추가")를 누르면 홈 화면에 아이콘이 생겨요.'
    ],
    samsung: [
      '화면 아래 ≡ (줄 세 개) 메뉴를 눌러요.',
      '"현재 페이지 추가" → "홈 화면"을 눌러요.',
      '"추가"를 누르면 홈 화면에 아이콘이 생겨요.'
    ],
    desktopChromium: [
      '주소창 오른쪽 끝의 설치 아이콘(모니터에 ↓ 모양)을 눌러요.',
      '안 보이면 Chrome: ⋮ → "전송, 저장 및 공유" → "페이지를 앱으로 설치" / Edge: ⋯ → "앱" → "이 사이트를 앱으로 설치"',
      '"설치"를 누르면 바탕화면·시작 메뉴에 강철노트가 생겨요.'
    ],
    macSafari: ['위쪽 메뉴 막대에서 "파일" → "Dock에 추가"를 눌러요. (macOS Sonoma 이상)', '"추가"를 누르면 Dock에 강철노트가 생겨요.'],
    desktopOther: 'Chrome 또는 Edge 브라우저로 열면 앱처럼 설치할 수 있어요.',
    openGuide: '📲 휴대폰에 앱으로 설치하는 법',
    banner: '홈 화면에 추가하면 앱처럼 쓸 수 있어요'
  },
  zh: {
    title: '安装到手机',
    oneTap: '📲 立即安装',
    installed: '✅ 已作为应用运行。以后请从主屏幕的图标打开。',
    why: '添加到主屏幕后可以像应用一样直接打开，还能收到出勤通知。无需从应用商店下载。',
    tabs: { phoneIos: 'iPhone', phoneAndroid: '安卓', computer: '电脑' },
    kakaoTitle: '当前在 KakaoTalk 内打开',
    kakaoBody: '在 KakaoTalk 内无法添加到主屏幕。请点击下方按钮，在浏览器中重新打开。',
    kakaoBtn: '🌐 在浏览器中打开',
    kakaoManual: '如果按钮无效：点击右下角（或右上角）⋯ / ⋮ 菜单 →“用其他浏览器打开”（iPhone 为“在 Safari 中打开”）',
    inapp: '当前在其他应用内打开。请在菜单（⋯ / ⋮）中选择“在浏览器中打开”，然后按以下步骤操作。iPhone 建议使用 Safari，安卓建议使用 Chrome。',
    iosSafari: [
      `点击屏幕下方中间的分享按钮 ${SHARE}（方框加向上箭头）。（iPad 在屏幕右上方）`,
      '向上滑动列表，点击“添加到主屏幕”。（如果没有，请在最下方“编辑操作”中添加）',
      '点击右上角“添加”。',
      '从主屏幕上的图标打开。'
    ],
    iosOther: [`点击地址栏右侧（或下方）的分享按钮 ${SHARE}。`, '点击“添加到主屏幕”。如果没有，请用 Safari 打开此网址后再试。', '点击“添加”，然后从主屏幕图标打开。'],
    iosNote: '要接收通知，需要 iOS 16.4 或以上版本，并且必须从主屏幕图标打开。',
    android: ['点击 Chrome 右上角 ⋮（三个点）。', '点击“添加到主屏幕”或“安装应用”。', '点击“安装”（或“添加”），主屏幕上就会出现图标。'],
    samsung: ['点击屏幕下方 ≡（三条线）菜单。', '点击“添加页面至” →“主屏幕”。', '点击“添加”，主屏幕上就会出现图标。'],
    desktopChromium: [
      '点击地址栏最右侧的安装图标（显示器加 ↓）。',
      '如果没有：Chrome ⋮ →“投放、保存和分享”→“将页面作为应用安装” / Edge ⋯ →“应用”→“将此站点作为应用安装”',
      '点击“安装”，桌面和开始菜单就会出现该应用。'
    ],
    macSafari: ['在顶部菜单栏点击“文件”→“添加到程序坞”。（macOS Sonoma 及以上）', '点击“添加”，程序坞中就会出现该应用。'],
    desktopOther: '使用 Chrome 或 Edge 浏览器打开即可安装为应用。',
    openGuide: '📲 如何安装到手机',
    banner: '添加到主屏幕后可以像应用一样使用'
  },
  ru: {
    title: 'Установка на телефон',
    oneTap: '📲 Установить сейчас',
    installed: '✅ Открыто как приложение. В следующий раз открывайте с иконки на главном экране.',
    why: 'После добавления на главный экран приложение открывается сразу, и вы сможете получать уведомления о посещении. Скачивать из магазина приложений не нужно.',
    tabs: { phoneIos: 'iPhone', phoneAndroid: 'Android', computer: 'Компьютер' },
    kakaoTitle: 'Открыто внутри KakaoTalk',
    kakaoBody: 'Внутри KakaoTalk нельзя добавить на главный экран. Нажмите кнопку ниже, чтобы открыть в браузере.',
    kakaoBtn: '🌐 Открыть в браузере',
    kakaoManual: 'Если кнопка не работает: меню ⋯ / ⋮ справа внизу (или вверху) → «Открыть в другом браузере» (на iPhone — «Открыть в Safari»)',
    inapp: 'Страница открыта внутри другого приложения. В меню (⋯ / ⋮) выберите «Открыть в браузере» и выполните шаги ниже. На iPhone лучше Safari, на Android — Chrome.',
    iosSafari: [
      `Нажмите кнопку «Поделиться» ${SHARE} (квадрат со стрелкой вверх) внизу экрана. (На iPad — вверху справа)`,
      'Пролистайте вверх и нажмите «На экран „Домой“». (Если нет — добавьте через «Изменить действия» внизу)',
      'Нажмите «Добавить» справа вверху.',
      'Открывайте с новой иконки на главном экране.'
    ],
    iosOther: [`Нажмите кнопку «Поделиться» ${SHARE} справа от адресной строки (или внизу).`, 'Нажмите «На экран „Домой“». Если такого пункта нет, откройте этот адрес в Safari и повторите.', 'Нажмите «Добавить» и открывайте с иконки.'],
    iosNote: 'Для уведомлений нужна iOS 16.4 или новее, и открывать нужно именно с иконки на главном экране.',
    android: ['Нажмите ⋮ (три точки) справа вверху в Chrome.', 'Выберите «Добавить на главный экран» или «Установить приложение».', 'Нажмите «Установить» (или «Добавить») — иконка появится на главном экране.'],
    samsung: ['Нажмите меню ≡ (три линии) внизу экрана.', 'Выберите «Добавить страницу» → «Главный экран».', 'Нажмите «Добавить» — иконка появится на главном экране.'],
    desktopChromium: [
      'Нажмите значок установки (монитор со стрелкой ↓) справа в адресной строке.',
      'Если его нет: Chrome ⋮ → «Трансляция, сохранение и отправка» → «Установить страницу как приложение» / Edge ⋯ → «Приложения» → «Установить этот сайт как приложение»',
      'Нажмите «Установить» — приложение появится на рабочем столе и в меню «Пуск».'
    ],
    macSafari: ['В строке меню выберите «Файл» → «Добавить в Dock». (macOS Sonoma и новее)', 'Нажмите «Добавить» — приложение появится в Dock.'],
    desktopOther: 'Откройте в Chrome или Edge, чтобы установить как приложение.',
    openGuide: '📲 Как установить на телефон',
    banner: 'Добавьте на главный экран и пользуйтесь как приложением'
  },
  en: {
    title: 'Install on your phone',
    oneTap: '📲 Install now',
    installed: '✅ Running as an app. Next time, open it from the icon on your home screen.',
    why: "Add it to your home screen to open it like an app and receive attendance notifications. No app store download needed.",
    tabs: { phoneIos: 'iPhone', phoneAndroid: 'Android', computer: 'Computer' },
    kakaoTitle: 'Opened inside KakaoTalk',
    kakaoBody: "You can't add to the home screen inside KakaoTalk. Tap the button below to reopen in your browser.",
    kakaoBtn: '🌐 Open in browser',
    kakaoManual: 'If the button does not work: tap the ⋯ / ⋮ menu at the bottom (or top) right → "Open in other browser" ("Open in Safari" on iPhone)',
    inapp: 'This page is open inside another app. Choose "Open in browser" from its menu (⋯ / ⋮), then follow the steps below. Use Safari on iPhone and Chrome on Android.',
    iosSafari: [
      `Tap the Share button ${SHARE} (square with an up arrow) at the bottom of the screen. (Top right on iPad)`,
      'Scroll up and tap "Add to Home Screen". (If missing, add it via "Edit Actions" at the bottom)',
      'Tap "Add" at the top right.',
      'Open it from the new icon on your home screen.'
    ],
    iosOther: [`Tap the Share button ${SHARE} next to (or below) the address bar.`, 'Tap "Add to Home Screen". If it is not there, open this address in Safari and try again.', 'Tap "Add" and open it from the home screen icon.'],
    iosNote: 'To receive notifications you need iOS 16.4 or later, and you must open the app from the home screen icon.',
    android: ['Tap ⋮ (three dots) at the top right of Chrome.', 'Tap "Add to Home screen" or "Install app".', 'Tap "Install" (or "Add") and the icon appears on your home screen.'],
    samsung: ['Tap the ≡ (three lines) menu at the bottom.', 'Tap "Add page to" → "Home screen".', 'Tap "Add" and the icon appears on your home screen.'],
    desktopChromium: [
      'Click the install icon (monitor with ↓) at the right end of the address bar.',
      'If you do not see it: Chrome ⋮ → "Cast, save, and share" → "Install page as app" / Edge ⋯ → "Apps" → "Install this site as an app"',
      'Click "Install" and the app appears on your desktop and Start menu.'
    ],
    macSafari: ['In the menu bar, choose "File" → "Add to Dock". (macOS Sonoma or later)', 'Click "Add" and the app appears in your Dock.'],
    desktopOther: 'Open this page in Chrome or Edge to install it as an app.',
    openGuide: '📲 How to install on your phone',
    banner: 'Add to your home screen to use it like an app'
  }
}

export const useGuide = (): Guide => G[useI18n().lang]

type Tab = 'ios' | 'android' | 'computer'
const tabOf = (p: Platform): Tab =>
  p === 'ios-safari' || p === 'ios-other' ? 'ios' : p === 'android' || p === 'samsung' ? 'android' : p.startsWith('desktop') || p === 'mac-safari' ? 'computer' : /iPhone|iPad/.test(navigator.userAgent) ? 'ios' : 'android'

/** 전체 안내 (기기 자동 선택 + 다른 기기 안내도 볼 수 있는 탭) */
export function InstallGuide({ compact }: { compact?: boolean }): JSX.Element {
  const g = useGuide()
  const platform = detectPlatform()
  const { canInstall, install } = useInstallPrompt()
  const [tab, setTab] = useState<Tab>(tabOf(platform))

  return (
    <div className="guide">
      {!compact && <p className="muted small">{g.why}</p>}

      {platform === 'installed' && <div className="guide-ok">{g.installed}</div>}

      {platform === 'kakao' && (
        <div className="guide-warn">
          <b>{g.kakaoTitle}</b>
          <p>{g.kakaoBody}</p>
          <button className="primary big wide" onClick={openInBrowser}>{g.kakaoBtn}</button>
          <p className="small muted">{g.kakaoManual}</p>
        </div>
      )}
      {platform === 'inapp' && <div className="guide-warn"><p>{g.inapp}</p></div>}

      {canInstall && <button className="primary big wide" onClick={() => install()}>{g.oneTap}</button>}

      <div className="seg small-seg">
        {(['ios', 'android', 'computer'] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t === 'ios' ? '📱 ' + g.tabs.phoneIos : t === 'android' ? '🤖 ' + g.tabs.phoneAndroid : '💻 ' + g.tabs.computer}
          </button>
        ))}
      </div>

      {tab === 'ios' && (
        <>
          <Steps title="Safari" steps={g.iosSafari} />
          <Steps title="Chrome · Whale · Edge" steps={g.iosOther} />
          <p className="guide-note">🔔 {g.iosNote}</p>
        </>
      )}
      {tab === 'android' && (
        <>
          <Steps title="Chrome" steps={g.android} />
          <Steps title="Samsung Internet" steps={g.samsung} />
        </>
      )}
      {tab === 'computer' && (
        <>
          <Steps title="Chrome · Edge (Windows / Mac)" steps={g.desktopChromium} />
          <Steps title="Safari (Mac)" steps={g.macSafari} />
          <p className="muted small">{g.desktopOther}</p>
        </>
      )}
    </div>
  )
}

/** 아이폰 공유 버튼과 같은 모양 (네모 + 위 화살표) */
function ShareIcon(): JSX.Element {
  return (
    <svg className="share-icon" viewBox="0 0 24 24" width="20" height="20" aria-label="share" fill="none" stroke="#2f7bf6" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 9H6.5A1.5 1.5 0 0 0 5 10.5v9A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 17.5 9H16" />
      <path d="M12 3v12M8.5 6.5 12 3l3.5 3.5" />
    </svg>
  )
}

function Steps({ title, steps }: { title: string; steps: string[] }): JSX.Element {
  return (
    <div className="steps">
      <div className="steps-title">{title}</div>
      <ol>
        {steps.map((s, i) => (
          <li key={i}>
            {s.split(SHARE).map((part, j) => (
              <span key={j}>
                {j > 0 && <ShareIcon />}
                {part}
              </span>
            ))}
          </li>
        ))}
      </ol>
    </div>
  )
}

/** 화면 위에 띄우는 작은 안내 띠 (설치된 경우·닫은 경우 안 보임) → 누르면 전체 안내 */
export function InstallBanner(): JSX.Element | null {
  const g = useGuide()
  const platform = detectPlatform()
  const [open, setOpen] = useState(false)
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem('installHintHidden') === '1'
    } catch {
      return false
    }
  })
  if (platform === 'installed' || (hidden && platform !== 'kakao')) return null
  return (
    <>
      <div className={platform === 'kakao' ? 'install warn' : 'install'}>
        <span className="grow">📲 {platform === 'kakao' ? g.kakaoTitle : g.banner}</span>
        {platform === 'kakao' ? (
          <button className="primary small-btn" onClick={openInBrowser}>{g.kakaoBtn}</button>
        ) : (
          <button className="primary small-btn" onClick={() => setOpen(true)}>{g.oneTap.replace('📲 ', '')}</button>
        )}
        {platform !== 'kakao' && (
          <button
            className="ghost small-btn"
            aria-label="close"
            onClick={() => {
              setHidden(true)
              try {
                localStorage.setItem('installHintHidden', '1')
              } catch {
                // 무시
              }
            }}
          >
            ✕
          </button>
        )}
      </div>
      {open && (
        <div className="sheet-bg" onClick={() => setOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head">
              <h2>{g.title}</h2>
              <button className="ghost" onClick={() => setOpen(false)}>✕</button>
            </div>
            <InstallGuide />
          </div>
        </div>
      )}
    </>
  )
}

/** 로그인 화면 아래 "설치하는 법" 링크 */
export function InstallLink(): JSX.Element {
  const g = useGuide()
  const [open, setOpen] = useState(false)
  return (
    <>
      <button className="link-btn" onClick={() => setOpen(true)}>{g.openGuide}</button>
      {open && (
        <div className="sheet-bg" onClick={() => setOpen(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head">
              <h2>{g.title}</h2>
              <button className="ghost" onClick={() => setOpen(false)}>✕</button>
            </div>
            <InstallGuide />
          </div>
        </div>
      )}
    </>
  )
}
