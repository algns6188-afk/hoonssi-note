import { useEffect, useState } from 'react'
import type { Channel, Settings } from '@shared/types'
import { CLAUDE_MODELS, TRANSCRIBE_MODELS } from '@shared/types'
import { errMsg } from '../util'

export default function SettingsPage({ settings, reload }: { settings: Settings; reload(): Promise<void> }): JSX.Element {
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

      <section className="card form">
        <h2>내 정보</h2>
        <label>이름<input value={s.userName} onChange={(e) => set('userName', e.target.value)} placeholder="예: 김훈" /></label>
      </section>

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
