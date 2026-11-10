import { useEffect, useState } from 'react'
import type { Channel, Settings, SyncStatus, UpdateStatus } from '@shared/types'
import { CLAUDE_MODELS, TRANSCRIBE_MODELS } from '@shared/types'
import { errMsg } from '../util'

export default function SettingsPage({ settings, reload, sync }: { settings: Settings; reload(): Promise<void>; sync: SyncStatus | null }): JSX.Element {
  const [s, setS] = useState(settings)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => setS(settings), [settings])

  const set = <K extends keyof Settings>(k: K, v: Settings[K]): void => setS({ ...s, [k]: v })

  const save = async (): Promise<void> => {
    await window.api.saveSettings(s)
    await reload()
    setMsg({ ok: true, text: '저장했습니다.' })
  }

  const test = async (c: Channel): Promise<void> => {
    setMsg(null)
    try {
      await window.api.saveSettings(s)
      setMsg({ ok: true, text: await window.api.testChannel(c) })
    } catch (e) {
      setMsg({ ok: false, text: errMsg(e) })
    }
  }

  const autoSend = (c: Channel, v: boolean): void => setS({ ...s, autoSend: { ...s.autoSend, [c]: v } })

  return (
    <div className="page narrow">
      <h1>설정·연동</h1>

      <VersionSection />

      <section className="card form">
        <h2>내 정보</h2>
        <label>이름<input value={s.userName} onChange={(e) => set('userName', e.target.value)} placeholder="예: 김훈" /></label>
      </section>

      <ServerSection s={s} set={set} sync={sync} onSave={save} />

      <section className="card form">
        <h2>AI 연결</h2>
        <label>
          Claude API 키 <span className="muted small">(회의 요약·분석)</span>
          <input type="password" value={s.anthropicKey} onChange={(e) => set('anthropicKey', e.target.value)} placeholder="sk-ant-..." />
        </label>
        <label>
          OpenAI API 키 <span className="muted small">(녹음 → 텍스트 변환)</span>
          <input type="password" value={s.openaiKey} onChange={(e) => set('openaiKey', e.target.value)} placeholder="sk-..." />
        </label>
        <label>
          회의 정리 AI 모델
          <select value={s.claudeModel} onChange={(e) => set('claudeModel', e.target.value)}>
            {CLAUDE_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <span className="muted small">{CLAUDE_MODELS.find((m) => m.id === s.claudeModel)?.cost}</span>
        </label>
        <label>
          음성 인식 모델
          <select value={s.transcribeModel} onChange={(e) => set('transcribeModel', e.target.value)}>
            {TRANSCRIBE_MODELS.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
          <span className="muted small">{TRANSCRIBE_MODELS.find((m) => m.id === s.transcribeModel)?.cost}</span>
        </label>
        <p className="muted small">키는 이 PC의 보안 저장소로 암호화해 보관합니다.</p>
      </section>

      <section className="card form">
        <h2>결과 보내기 연동</h2>

        <h3>Slack</h3>
        <label>
          수신 웹훅(Incoming Webhook) 주소
          <input type="password" value={s.slackWebhook} onChange={(e) => set('slackWebhook', e.target.value)} placeholder="https://hooks.slack.com/services/..." />
        </label>
        <div className="row-actions">
          <label className="check"><input type="checkbox" checked={s.autoSend.slack} onChange={(e) => autoSend('slack', e.target.checked)} /> AI 정리가 끝나면 자동 전송</label>
          <button onClick={() => test('slack')}>테스트 전송</button>
        </div>

        <h3>MS Teams</h3>
        <label>
          워크플로 웹훅 주소 <span className="muted small">(Teams 채널 → 워크플로 → "웹후크 요청이 수신되면 채널에 게시")</span>
          <input type="password" value={s.teamsWebhook} onChange={(e) => set('teamsWebhook', e.target.value)} placeholder="https://...logic.azure.com/..." />
        </label>
        <div className="row-actions">
          <label className="check"><input type="checkbox" checked={s.autoSend.teams} onChange={(e) => autoSend('teams', e.target.checked)} /> AI 정리가 끝나면 자동 전송</label>
          <button onClick={() => test('teams')}>테스트 전송</button>
        </div>

        <h3>카카오톡</h3>
        <label>
          카카오 액세스 토큰 <span className="muted small">(카카오 디벨로퍼스 앱 · "카카오톡 메시지 전송" 동의 필요)</span>
          <input type="password" value={s.kakaoAccessToken} onChange={(e) => set('kakaoAccessToken', e.target.value)} />
        </label>
        <p className="muted small">현재는 "나에게 보내기"로 요약(200자)을 받습니다. 팀원에게 보내는 알림톡은 다음 단계에서 연결합니다.</p>
        <div className="row-actions">
          <label className="check"><input type="checkbox" checked={s.autoSend.kakao} onChange={(e) => autoSend('kakao', e.target.checked)} /> AI 정리가 끝나면 자동 전송</label>
          <button onClick={() => test('kakao')}>테스트 전송</button>
        </div>
      </section>

      <div className="save-bar">
        {msg && <span className={msg.ok ? 'ok' : 'danger'}>{msg.text}</span>}
        <button className="primary" onClick={save}>저장</button>
      </div>
    </div>
  )
}

function ServerSection({ s, set, sync, onSave }: {
  s: Settings
  set<K extends keyof Settings>(k: K, v: Settings[K]): void
  sync: SyncStatus | null
  onSave(): Promise<void>
}): JSX.Element {
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    setErr(null)
    try {
      await fn()
    } catch (e) {
      setErr(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const state = sync?.state ?? 'off'
  const label: Record<string, string> = {
    off: '연결 안 함 (이 PC에만 저장)',
    login: '로그인이 필요합니다',
    connecting: '연결 중…',
    online: '실시간 연결됨',
    offline: '오프라인 (이 PC에 저장 중, 연결되면 자동 업로드)',
    error: '서버 설정을 확인해 주세요'
  }

  return (
    <section className="card form">
      <h2>팀 공유 서버</h2>
      <p className="muted small">연결하면 여러 PC에서 같은 노트·할 일·선수 기록을 실시간으로 함께 씁니다. API 키 같은 설정은 PC마다 따로 입력합니다.</p>
      <label>
        서버 주소 <span className="muted small">(Supabase → Project Settings → API → Project URL)</span>
        <input value={s.serverUrl} onChange={(e) => set('serverUrl', e.target.value)} placeholder="https://xxxx.supabase.co" />
      </label>
      <label>
        공개 키 <span className="muted small">(같은 화면의 anon / publishable key)</span>
        <input type="password" value={s.serverKey} onChange={(e) => set('serverKey', e.target.value)} placeholder="eyJ... 또는 sb_publishable_..." />
      </label>
      <div className="row-actions">
        <span className={state === 'online' ? 'ok' : state === 'off' ? 'muted' : 'danger'}>
          ● {label[state]}
          {sync?.email && ` · ${sync.email}`}
          {sync && sync.pending > 0 && ` · 올릴 변경 ${sync.pending}건`}
        </span>
        <button onClick={() => run(onSave)} disabled={busy}>서버 정보 저장·연결</button>
      </div>
      {sync?.message && <p className="muted small">{sync.message}</p>}

      {state === 'login' && (
        <div className="login-box">
          <h3>팀 계정으로 로그인</h3>
          <input placeholder="이메일" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input type="password" placeholder="비밀번호" value={pw} onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && run(() => window.api.syncSignIn(email, pw))} />
          <button className="primary" disabled={busy || !email || !pw} onClick={() => run(() => window.api.syncSignIn(email, pw))}>
            {busy ? '로그인 중…' : '로그인'}
          </button>
          <p className="muted small">계정은 관리자가 Supabase → Authentication → Users 에서 만들어 줍니다.</p>
        </div>
      )}
      {(state === 'online' || state === 'offline' || state === 'error') && (
        <div className="row-actions">
          <button onClick={() => run(() => window.api.syncNow())} disabled={busy}>지금 동기화</button>
          <button className="ghost" onClick={() => run(() => window.api.syncSignOut())} disabled={busy}>로그아웃</button>
        </div>
      )}
      {sync?.lastSyncAt && <p className="muted small">마지막 동기화: {new Date(sync.lastSyncAt).toLocaleString('ko-KR')}</p>}
      {err && <div className="error">{err}</div>}
    </section>
  )
}

function VersionSection(): JSX.Element {
  const [version, setVersion] = useState('')
  const [u, setU] = useState<UpdateStatus | null>(null)
  useEffect(() => {
    window.api.appVersion().then(setVersion)
    window.api.updateStatus().then(setU)
    return window.api.onUpdateStatus(setU)
  }, [])
  const text: Record<UpdateStatus['state'], string> = {
    idle: '',
    checking: '확인 중…',
    none: '최신 버전입니다.',
    downloading: `새 버전 v${u?.version ?? ''} 받는 중… ${u?.percent ?? 0}%`,
    ready: `새 버전 v${u?.version ?? ''} 준비 완료`,
    error: '업데이트 확인 실패'
  }
  return (
    <section className="card form">
      <div className="row-actions">
        <h2 style={{ margin: 0 }}>훈씨노트 v{version}</h2>
        <span className={u?.state === 'error' ? 'danger small' : 'muted small'}>{u ? text[u.state] : ''}</span>
        {u?.state === 'ready' ? (
          <button className="primary" onClick={() => window.api.installUpdate()}>업데이트 설치</button>
        ) : (
          <button onClick={() => window.api.checkForUpdates().then(setU)} disabled={u?.state === 'checking' || u?.state === 'downloading'}>업데이트 확인</button>
        )}
      </div>
      {u?.state === 'error' && u.message && <p className="muted small">{u.message.slice(0, 200)}</p>}
    </section>
  )
}
