import { useEffect, useMemo, useRef, useState } from 'react'
import type { Note, NoteType, Settings } from '@shared/types'
import { NOTE_TYPE_LABEL } from '@shared/types'
import { errMsg, fmtDate, newNote, splitList } from '../util'
import MeetingPanel from './MeetingPanel'

interface Props {
  mode: 'meetings' | 'notes'
  notes: Note[]
  settings: Settings
  selectedId: string | null
  onSelect(id: string | null): void
  reload(): Promise<void>
}

const WORK_TYPES: NoteType[] = ['memo', 'client', 'project']

export default function NotesPage({ mode, notes, settings, selectedId, onSelect, reload }: Props): JSX.Element {
  const [query, setQuery] = useState('')
  const [typeFilter, setTypeFilter] = useState<NoteType | 'all'>('all')
  const [draft, setDraft] = useState<Note | null>(null)
  const [saveState, setSaveState] = useState<'saved' | 'dirty' | 'saving'>('saved')
  const timer = useRef<number | null>(null)

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    return notes
      .filter((n) => (mode === 'meetings' ? n.type === 'meeting' : n.type !== 'meeting'))
      .filter((n) => typeFilter === 'all' || n.type === typeFilter)
      .filter((n) => {
        if (!q) return true
        const hay = [n.title, n.content, n.tags.join(' '), n.meeting?.transcript ?? '', n.meeting?.analysis?.summary ?? '']
          .join(' ')
          .toLowerCase()
        return hay.includes(q)
      })
  }, [notes, mode, query, typeFilter])

  // 목록에서 선택이 바뀌면 편집 중인 내용 교체
  useEffect(() => {
    if (draft && draft.id === selectedId) return
    const n = notes.find((x) => x.id === selectedId)
    const fits = n && (mode === 'meetings' ? n.type === 'meeting' : n.type !== 'meeting')
    setDraft(fits ? structuredClone(n) : null)
    setSaveState('saved')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, notes, mode])

  const persist = async (n: Note): Promise<Note> => {
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = null
    setSaveState('saving')
    const saved = await window.api.saveNote(n)
    setSaveState('saved')
    await reload()
    return saved
  }

  const update = (patch: Partial<Note>): void => {
    if (!draft) return
    const next = { ...draft, ...patch }
    setDraft(next)
    setSaveState('dirty')
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => persist(next), 800)
  }

  const create = async (type: NoteType): Promise<void> => {
    const n = newNote(type, settings.userName)
    await window.api.saveNote(n)
    await reload()
    setDraft(n)
    onSelect(n.id)
  }

  const remove = async (): Promise<void> => {
    if (!draft || !confirm(`'${draft.title || '제목 없음'}' 노트를 삭제할까요?\n녹음 파일도 함께 삭제됩니다.`)) return
    if (timer.current) window.clearTimeout(timer.current)
    await window.api.deleteNote(draft.id)
    setDraft(null)
    onSelect(null)
    await reload()
  }

  return (
    <div className="split">
      <section className="list-pane">
        <div className="list-head">
          <h1>{mode === 'meetings' ? '회의록' : '업무 노트'}</h1>
          {mode === 'meetings' ? (
            <button className="primary" onClick={() => create('meeting')}>+ 새 회의</button>
          ) : (
            <select className="primary-select" value="" onChange={(e) => e.target.value && create(e.target.value as NoteType)}>
              <option value="">+ 새 노트</option>
              {WORK_TYPES.map((t) => <option key={t} value={t}>{NOTE_TYPE_LABEL[t]}</option>)}
            </select>
          )}
        </div>
        <input className="search" placeholder="제목, 내용, 태그, 녹취록 검색" value={query} onChange={(e) => setQuery(e.target.value)} />
        {mode === 'notes' && (
          <div className="filters">
            {(['all', ...WORK_TYPES] as const).map((t) => (
              <button key={t} className={typeFilter === t ? 'pill on' : 'pill'} onClick={() => setTypeFilter(t)}>
                {t === 'all' ? '전체' : NOTE_TYPE_LABEL[t]}
              </button>
            ))}
          </div>
        )}
        <div className="items">
          {list.length === 0 && <p className="muted pad">노트가 없습니다.</p>}
          {list.map((n) => (
            <button key={n.id} className={n.id === selectedId ? 'item on' : 'item'} onClick={() => onSelect(n.id)}>
              <div className="item-title">{n.title || '(제목 없음)'}</div>
              <div className="item-meta">
                {mode === 'notes' && <span className="chip">{NOTE_TYPE_LABEL[n.type]}</span>}
                {n.type === 'meeting' && (n.meeting?.analysis ? <span className="chip ok">분석 완료</span> : n.meeting?.transcript ? <span className="chip">변환됨</span> : null)}
                <span>{fmtDate(n.createdAt)}</span>
                {n.tags.slice(0, 3).map((t) => <span key={t} className="tag">#{t}</span>)}
              </div>
            </button>
          ))}
        </div>
      </section>

      <section className="editor-pane">
        {!draft ? (
          <div className="empty">
            <p>{mode === 'meetings' ? '왼쪽에서 회의를 고르거나 새 회의를 시작하세요.' : '왼쪽에서 노트를 고르거나 새 노트를 만드세요.'}</p>
          </div>
        ) : (
          <div className="editor">
            <div className="editor-top">
              <input className="title-input" placeholder="제목" value={draft.title} onChange={(e) => update({ title: e.target.value })} />
              <span className="save-state">{saveState === 'saved' ? '저장됨' : saveState === 'saving' ? '저장 중…' : '수정됨'}</span>
              <button className="ghost danger" onClick={remove}>삭제</button>
            </div>
            <div className="meta-row">
              {draft.type !== 'meeting' && (
                <select value={draft.type} onChange={(e) => update({ type: e.target.value as NoteType })}>
                  {WORK_TYPES.map((t) => <option key={t} value={t}>{NOTE_TYPE_LABEL[t]}</option>)}
                </select>
              )}
              <TagInput tags={draft.tags} onChange={(tags) => update({ tags })} />
              <span className="muted">작성 {fmtDate(draft.createdAt)}{draft.author ? ` · ${draft.author}` : ''}</span>
            </div>

            {draft.type === 'meeting' && (
              <MeetingPanel
                note={draft}
                settings={settings}
                onChange={(meeting) => update({ meeting })}
                flush={() => persist(draft)}
                onUpdated={async (n) => {
                  setDraft(structuredClone(n))
                  setSaveState('saved')
                  await reload()
                }}
              />
            )}

            <label className="field-label">{draft.type === 'meeting' ? '내 메모 (AI 분석 때 함께 참고합니다)' : '내용'}</label>
            <textarea
              className="body-input"
              placeholder={PLACEHOLDER[draft.type]}
              value={draft.content}
              onChange={(e) => update({ content: e.target.value })}
            />
          </div>
        )}
      </section>
    </div>
  )
}

const PLACEHOLDER: Record<NoteType, string> = {
  meeting: '회의 중 떠오른 내용, 강조할 점 등을 적어 두세요.',
  memo: '자유롭게 기록하세요.',
  client: '담당자, 연락처, 거래 조건, 진행 상황 등을 기록하세요.',
  project: '목표, 일정, 담당, 진행 현황 등을 기록하세요.'
}

function TagInput({ tags, onChange }: { tags: string[]; onChange(t: string[]): void }): JSX.Element {
  const [text, setText] = useState(tags.join(', '))
  useEffect(() => setText(tags.join(', ')), [tags])
  return (
    <input
      className="tag-input"
      placeholder="태그 (쉼표로 구분)"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onChange(splitList(text.replace(/#/g, '')))}
    />
  )
}

export { errMsg }
