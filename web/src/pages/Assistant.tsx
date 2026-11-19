import { useState } from 'react'
import { supabase, errText } from '../supabase'

interface Action {
  type: 'record_payment' | 'create_invoice' | 'attendance' | 'absence' | 'add_payer' | 'note'
  student_ids: string[]
  summary: string
  [k: string]: unknown
}
interface Plan {
  reply: string
  question: string | null
  actions: Action[]
  students: Record<string, string>
  error?: string
}

const ICON: Record<Action['type'], string> = {
  record_payment: '💳', create_invoice: '🧾', attendance: '✅', absence: '🚫', add_payer: '👤', note: '📝'
}
const EXAMPLES = ['김민준 11월 수련비 입금완료', '서연이 내일 결석 (감기)', '민준이 어제 4시에 왔는데 체크 못함', '지훈이 도복비 3만원 청구', '민준이 아빠 김철수 이름으로 입금함']

/** 관리자 화면 맨 위: 한 줄 쓰면 AI가 알아서 정리 → [반영] */
export default function AssistantBox(): JSX.Element {
  const [text, setText] = useState('')
  const [asked, setAsked] = useState('') // 되물음에 답할 때 원래 메모
  const [plan, setPlan] = useState<Plan | null>(null)
  const [checked, setChecked] = useState<boolean[]>([])
  const [busy, setBusy] = useState<'plan' | 'run' | null>(null)
  const [result, setResult] = useState<{ ok: boolean; summary: string; detail?: string }[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [focus, setFocus] = useState(false)

  const call = async (body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const { data, error } = await supabase.functions.invoke('assistant', { body })
    if (error) {
      // 서버가 보낸 오류 내용 꺼내기
      const ctx = (error as { context?: Response }).context
      const j = ctx ? await ctx.json().catch(() => null) : null
      throw new Error(j?.error ?? errText(error))
    }
    return data as Record<string, unknown>
  }

  const ask = async (): Promise<void> => {
    const memo = asked ? `${asked}\n(추가 설명: ${text})` : text
    if (!memo.trim()) return
    setBusy('plan')
    setErr(null)
    setResult(null)
    try {
      const p = (await call({ text: memo })) as unknown as Plan
      if (p.error) throw new Error(p.error)
      setPlan(p)
      setChecked(p.actions.map(() => true))
      if (p.question) {
        setAsked(memo)
        setText('')
      } else setAsked('')
    } catch (e) {
      const m = errText(e)
      setErr(
        m === 'no_api_key'
          ? 'AI 키가 아직 서버에 없어요. Supabase → Edge Functions → Secrets 에 ANTHROPIC_API_KEY 를 넣어 주세요.'
          : /invalid x-api-key|invalid_api_key|authentication_error|Incorrect API key|401/.test(m)
            ? 'AI 키가 맞지 않아요. Supabase 비밀값(ANTHROPIC_API_KEY 또는 OPENAI_API_KEY)에 Claude 키(sk-ant-…) 또는 GPT 키(sk-…)를 앞뒤 공백 없이 정확히 넣었는지 확인해 주세요.'
            : /credit balance|insufficient_quota|billing|402/i.test(m)
              ? 'AI 사용 요금(크레딧)이 부족해요. GPT 키면 platform.openai.com → Billing, Claude 키면 console.anthropic.com → Billing 에서 충전해 주세요.'
              : /rate_limit|429|overloaded|529/i.test(m)
                ? 'AI가 잠시 바빠요. 몇 초 뒤 다시 [정리]를 눌러 주세요.'
                : m === 'refusal'
            ? 'AI가 이 내용을 처리하지 못했어요. 다르게 써 볼까요?'
            : '해석 실패: ' + m
      )
    } finally {
      setBusy(null)
    }
  }

  const apply = async (): Promise<void> => {
    if (!plan) return
    const actions = plan.actions.filter((_, i) => checked[i])
    if (!actions.length) return
    setBusy('run')
    setErr(null)
    try {
      const r = (await call({ text: asked || text || plan.reply, execute: actions })) as { results: { ok: boolean; summary: string; detail?: string }[] }
      setResult(r.results)
      setPlan(null)
      setText('')
      setAsked('')
    } catch (e) {
      setErr('반영 실패: ' + errText(e))
    } finally {
      setBusy(null)
    }
  }

  const reset = (): void => {
    setPlan(null)
    setAsked('')
    setResult(null)
    setErr(null)
  }

  return (
    <section className="card assistant">
      <div className="as-input">
        <span className="as-icon">🤖</span>
        <textarea
          rows={1}
          value={text}
          placeholder={asked ? '위 질문에 답해 주세요' : '예: 김민준 11월 수련비 입금완료'}
          onChange={(e) => setText(e.target.value)}
          onFocus={() => setFocus(true)}
          onBlur={() => window.setTimeout(() => setFocus(false), 200)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              ask()
            }
          }}
        />
        <button className="primary" disabled={!!busy || !text.trim()} onClick={ask}>{busy === 'plan' ? '…' : '정리'}</button>
      </div>
      {focus && !text && !plan && !result && !err && (
        <div className="as-examples">
          {EXAMPLES.map((x) => <button key={x} className="pill" onClick={() => setText(x)}>{x}</button>)}
        </div>
      )}

      {busy === 'plan' && <p className="muted small">AI가 정리하고 있어요…</p>}

      {plan && (
        <div className="as-plan">
          <p className="as-reply">{plan.reply}</p>
          {plan.question && <div className="as-question">❓ {plan.question}</div>}
          {plan.actions.length > 0 && (
            <>
              <ul className="plain">
                {plan.actions.map((a, i) => (
                  <li key={i}>
                    <label className="check">
                      <input type="checkbox" checked={checked[i]} onChange={(e) => setChecked(checked.map((c, j) => (j === i ? e.target.checked : c)))} />
                      <span>{ICON[a.type]} {a.summary}</span>
                    </label>
                  </li>
                ))}
              </ul>
              <div className="row">
                <button className="primary grow" disabled={!!busy || !checked.some(Boolean)} onClick={apply}>
                  {busy === 'run' ? '반영 중…' : `✓ ${checked.filter(Boolean).length}건 반영`}
                </button>
                <button className="ghost" onClick={reset}>취소</button>
              </div>
            </>
          )}
          {!plan.actions.length && !plan.question && <button className="ghost" onClick={reset}>닫기</button>}
        </div>
      )}

      {result && (
        <div className="as-result">
          {result.map((r, i) => (
            <div key={i} className={r.ok ? 'ok' : 'danger'}>{r.ok ? '✔' : '✘'} {r.summary}{r.detail ? ` — ${r.detail}` : ''}</div>
          ))}
          <button className="ghost small-btn" onClick={reset}>닫기</button>
        </div>
      )}
      {err && <div className="error">{err}</div>}
    </section>
  )
}
