import { useEffect, useRef, useState } from 'react'
import type { Channel, MeetingInfo, Note, Settings } from '@shared/types'
import { MeetingRecorder } from '../recorder'
import { errMsg, splitList } from '../util'

interface Props {
  note: Note
  settings: Settings
  onChange(m: MeetingInfo): void
  flush(): Promise<Note>
  onUpdated(n: Note): Promise<void>
}

const CHANNELS: { id: Channel; label: string; configured: (s: Settings) => boolean }[] = [
  { id: 'slack', label: 'Slack', configured: (s) => !!s.slackWebhook },
  { id: 'teams', label: 'MS Teams', configured: (s) => !!s.teamsWebhook },
  { id: 'kakao', label: '카카오톡', configured: (s) => !!s.kakaoAccessToken }
]

const fmtTime = (sec: number): string =>
  `${String(Math.floor(sec / 3600)).padStart(2, '0')}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`

export default function MeetingPanel({ note, settings, onChange, flush, onUpdated }: Props): JSX.Element {
  const m = note.meeting!
  const recRef = useRef<MeetingRecorder | null>(null)
  const savedFiles = useRef<string[]>([])
  const [recState, setRecState] = useState<'idle' | 'recording' | 'paused' | 'saving'>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [withSystem, setWithSystem] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [participants, setParticipants] = useState(m.participants.join(', '))
  const [channels, setChannels] = useState<Channel[]>(CHANNELS.filter((c) => c.configured(settings)).map((c) => c.id))

  useEffect(() => setParticipants(m.participants.join(', ')), [note.id]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (recState !== 'recording') return
    const t = window.setInterval(() => setElapsed((e) => e + 1), 1000)
    return () => window.clearInterval(t)
  }, [recState])

  // 화면을 떠나면 녹음을 안전하게 종료
  useEffect(() => () => void recRef.current?.stop(), [note.id])

  const run = async (label: string, fn: () => Promise<Note>): Promise<void> => {
    setBusy(label)
    setError(null)
    setNotice(null)
    try {
      await flush()
      const n = await fn()
      await onUpdated(n)
      const failed = n.meeting!.sentLog.slice(-channels.length).filter((l) => !l.ok)
      if (label === '전송' && failed.length) setError(failed.map((f) => f.message).join('\n'))
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(null)
    }
  }

  const startRec = async (): Promise<void> => {
    setError(null)
    savedFiles.current = [...m.audioFiles]
    const rec = new MeetingRecorder(m.audioFiles.length, async (index, data) => {
      savedFiles.current.push(await window.api.saveAudio(note.id, index, data))
    })
    try {
      const { systemAudio } = await rec.start(withSystem)
      recRef.current = rec
      setElapsed(0)
      setRecState('recording')
      if (withSystem && !systemAudio) setNotice('시스템 소리를 가져오지 못해 마이크 소리만 녹음합니다.')
    } catch (e) {
      setError('마이크를 사용할 수 없습니다. 마이크 연결과 권한을 확인해 주세요. (' + errMsg(e) + ')')
    }
  }

  const stopRec = async (): Promise<void> => {
    const rec = recRef.current
    if (!rec) return
    setRecState('saving')
    await rec.stop()
    recRef.current = null
    onChange({ ...m, audioFiles: [...savedFiles.current] })
    setRecState('idle')
    setNotice(`녹음을 저장했습니다 (${fmtTime(elapsed)}). 이제 텍스트로 변환하세요.`)
  }

  const togglePause = (): void => {
    const rec = recRef.current
    if (!rec) return
    if (rec.paused) {
      rec.resume()
      setRecState('recording')
    } else {
      rec.pause()
      setRecState('paused')
    }
  }

  const a = m.analysis

  return (
    <div className="meeting">
      <div className="meta-row">
        <input
          className="grow"
          placeholder="참석자 (쉼표로 구분, 예: 김훈, 이영희, 박민수)"
          value={participants}
          onChange={(e) => setParticipants(e.target.value)}
          onBlur={() => onChange({ ...m, participants: splitList(participants) })}
        />
      </div>

      {/* 1. 녹음 */}
      <div className="step">
        <div className="step-head"><span className="num">1</span> 녹음</div>
        <div className="rec-bar">
          {recState === 'idle' ? (
            <>
              <button className="rec-btn" onClick={startRec}>● 녹음 시작</button>
              <label className="check">
                <input type="checkbox" checked={withSystem} onChange={(e) => setWithSystem(e.target.checked)} />
                온라인 회의 소리도 함께 녹음 (Zoom, Teams 등)
              </label>
            </>
          ) : (
            <>
              <span className={recState === 'recording' ? 'rec-dot live' : 'rec-dot'} />
              <span className="timer">{fmtTime(elapsed)}</span>
              <button onClick={togglePause} disabled={recState === 'saving'}>{recState === 'paused' ? '▶ 계속' : '❚❚ 일시정지'}</button>
              <button className="primary" onClick={stopRec} disabled={recState === 'saving'}>
                {recState === 'saving' ? '저장 중…' : '■ 녹음 끝내기'}
              </button>
            </>
          )}
          <span className="muted right">녹음 파일 {m.audioFiles.length}개</span>
        </div>
      </div>

      {/* 2. 텍스트 변환 */}
      <div className="step">
        <div className="step-head">
          <span className="num">2</span> 텍스트 변환
          <button
            className="right"
            disabled={!!busy || recState !== 'idle' || m.audioFiles.length === 0}
            onClick={() => run('변환', () => window.api.transcribe(note.id))}
          >
            {busy === '변환' ? '변환 중… (회의 길이에 따라 몇 분 걸려요)' : m.transcript ? '다시 변환' : '텍스트로 변환'}
          </button>
        </div>
        <textarea
          className="transcript"
          placeholder="녹음을 변환하면 회의 내용이 여기에 나옵니다. 직접 붙여넣거나 고칠 수도 있습니다."
          value={m.transcript}
          onChange={(e) => onChange({ ...m, transcript: e.target.value })}
        />
      </div>

      {/* 3. AI 요약·분석 */}
      <div className="step">
        <div className="step-head">
          <span className="num">3</span> AI 요약·분석
          <button
            className="right primary"
            disabled={!!busy || !m.transcript.trim()}
            onClick={() => run('분석', () => window.api.analyze(note.id))}
          >
            {busy === '분석' ? '분석 중…' : a ? '다시 분석' : 'AI로 정리하기'}
          </button>
        </div>
        {a ? (
          <div className="analysis">
            <h3>요약</h3>
            <p>{a.summary}</p>
            <Section title="주요 논의" items={a.keyPoints} />
            <Section title="결정 사항" items={a.decisions} />
            <h3>할 일 <span className="muted small">(할 일 메뉴에 자동 등록됨)</span></h3>
            {a.actionItems.length === 0 ? <p className="muted">없음</p> : (
              <table className="actions">
                <thead><tr><th>할 일</th><th>담당</th><th>기한</th></tr></thead>
                <tbody>
                  {a.actionItems.map((x, i) => (
                    <tr key={i}><td>{x.task}</td><td>{x.owner ?? '-'}</td><td>{x.due ?? '-'}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
            <Section title="미결 사항" items={a.openIssues} />
            <Section title="우려·리스크" items={a.risks} />
            <Section title="다음 회의 안건" items={a.nextAgenda} />
          </div>
        ) : (
          <p className="muted">텍스트 변환 후 버튼을 누르면 요약, 결정 사항, 할 일(담당·기한), 리스크를 정리합니다.</p>
        )}
      </div>

      {/* 4. 공유 */}
      <div className="step">
        <div className="step-head">
          <span className="num">4</span> 결과 보내기
          <button
            className="right"
            disabled={!!busy || !a || channels.length === 0}
            onClick={() => run('전송', () => window.api.send(note.id, channels))}
          >
            {busy === '전송' ? '보내는 중…' : '보내기'}
          </button>
        </div>
        <div className="channels">
          {CHANNELS.map((c) => (
            <label key={c.id} className={c.configured(settings) ? 'check' : 'check disabled'} title={c.configured(settings) ? '' : '설정·연동 메뉴에서 먼저 연결하세요'}>
              <input
                type="checkbox"
                disabled={!c.configured(settings)}
                checked={channels.includes(c.id)}
                onChange={(e) => setChannels(e.target.checked ? [...channels, c.id] : channels.filter((x) => x !== c.id))}
              />
              {c.label}{!c.configured(settings) && ' (미연결)'}
            </label>
          ))}
        </div>
        {m.sentLog.length > 0 && (
          <ul className="sent-log">
            {m.sentLog.slice(-6).reverse().map((l, i) => (
              <li key={i} className={l.ok ? 'ok' : 'danger'}>
                {new Date(l.at).toLocaleString('ko-KR')} · {CHANNELS.find((c) => c.id === l.channel)?.label} · {l.ok ? '전송 완료' : l.message}
              </li>
            ))}
          </ul>
        )}
      </div>

      {notice && <div className="notice">{notice}</div>}
      {error && <div className="error">{error}</div>}
    </div>
  )
}

function Section({ title, items }: { title: string; items: string[] }): JSX.Element | null {
  if (!items.length) return null
  return (
    <>
      <h3>{title}</h3>
      <ul>{items.map((x, i) => <li key={i}>{x}</li>)}</ul>
    </>
  )
}
