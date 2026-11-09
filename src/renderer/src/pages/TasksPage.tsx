import { useMemo, useState } from 'react'
import type { Note, Task } from '@shared/types'
import { now, uid } from '../util'

interface Props {
  tasks: Task[]
  notes: Note[]
  reload(): Promise<void>
  onOpen(n: Note): void
}

export default function TasksPage({ tasks, notes, reload, onOpen }: Props): JSX.Element {
  const [title, setTitle] = useState('')
  const [owner, setOwner] = useState('')
  const [due, setDue] = useState('')
  const [ownerFilter, setOwnerFilter] = useState('')
  const [showDone, setShowDone] = useState(false)
  const today = new Date().toISOString().slice(0, 10)

  const owners = useMemo(() => [...new Set(tasks.map((t) => t.owner).filter(Boolean) as string[])].sort(), [tasks])
  const visible = tasks
    .filter((t) => showDone || !t.done)
    .filter((t) => !ownerFilter || t.owner === ownerFilter)
    .sort((a, b) => Number(a.done) - Number(b.done) || (a.due ?? '9999').localeCompare(b.due ?? '9999'))

  const add = async (): Promise<void> => {
    if (!title.trim()) return
    await window.api.saveTask({
      id: uid(), title: title.trim(), owner: owner.trim() || null, due: due || null,
      done: false, sourceNoteId: null, createdAt: now()
    })
    setTitle('')
    setDue('')
    await reload()
  }

  const toggle = async (t: Task): Promise<void> => {
    await window.api.saveTask({ ...t, done: !t.done })
    await reload()
  }

  const remove = async (t: Task): Promise<void> => {
    await window.api.deleteTask(t.id)
    await reload()
  }

  return (
    <div className="page">
      <h1>할 일</h1>
      <p className="muted">회의를 AI로 정리하면 할 일이 여기에 자동으로 등록됩니다.</p>

      <div className="card add-task">
        <input className="grow" placeholder="할 일 추가" value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
        <input placeholder="담당자" value={owner} onChange={(e) => setOwner(e.target.value)} list="owners" />
        <input type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        <button className="primary" onClick={add}>추가</button>
        <datalist id="owners">{owners.map((o) => <option key={o} value={o} />)}</datalist>
      </div>

      <div className="filters">
        <button className={!ownerFilter ? 'pill on' : 'pill'} onClick={() => setOwnerFilter('')}>전체</button>
        {owners.map((o) => (
          <button key={o} className={ownerFilter === o ? 'pill on' : 'pill'} onClick={() => setOwnerFilter(o)}>{o}</button>
        ))}
        <label className="check right"><input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> 완료한 일 보기</label>
      </div>

      <div className="card">
        {visible.length === 0 && <p className="muted">할 일이 없습니다.</p>}
        {visible.map((t) => {
          const src = notes.find((n) => n.id === t.sourceNoteId)
          const late = !t.done && t.due && /^\d{4}-\d{2}-\d{2}$/.test(t.due) && t.due < today
          return (
            <div key={t.id} className={t.done ? 'task done' : 'task'}>
              <input type="checkbox" checked={t.done} onChange={() => toggle(t)} />
              <span className="grow">{t.title}</span>
              {src && <button className="link small" onClick={() => onOpen(src)}>📎 {src.title || '회의'}</button>}
              <span className="muted">{t.owner ?? '담당 미정'}</span>
              <span className={late ? 'danger' : 'muted'}>{t.due ?? '기한 없음'}</span>
              <button className="ghost small" onClick={() => remove(t)}>삭제</button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
