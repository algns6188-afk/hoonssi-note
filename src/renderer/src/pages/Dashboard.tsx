import type { Note, Task } from '@shared/types'
import { NOTE_TYPE_LABEL } from '@shared/types'
import type { Page } from '../App'
import { fmtDate } from '../util'

interface Props {
  notes: Note[]
  tasks: Task[]
  onOpen(n: Note): void
  onGo(p: Page): void
}

export default function Dashboard({ notes, tasks, onOpen, onGo }: Props): JSX.Element {
  const today = new Date().toISOString().slice(0, 10)
  const open = tasks.filter((t) => !t.done)
  const overdue = open.filter((t) => t.due && /^\d{4}-\d{2}-\d{2}$/.test(t.due) && t.due < today)
  const meetings = notes.filter((n) => n.type === 'meeting')
  const thisMonth = meetings.filter((n) => n.createdAt.slice(0, 7) === today.slice(0, 7))

  return (
    <div className="page">
      <h1>안녕하세요 👋</h1>
      <p className="muted">오늘 업무를 한눈에 확인하세요.</p>

      <div className="stats">
        <div className="stat"><b>{open.length}</b><span>진행 중인 할 일</span></div>
        <div className={overdue.length ? 'stat warn' : 'stat'}><b>{overdue.length}</b><span>기한 지난 할 일</span></div>
        <div className="stat"><b>{thisMonth.length}</b><span>이번 달 회의</span></div>
        <div className="stat"><b>{notes.length}</b><span>전체 노트</span></div>
      </div>

      <div className="grid2">
        <section className="card">
          <div className="card-head">
            <h2>최근 회의록</h2>
            <button className="link" onClick={() => onGo('meetings')}>전체 보기</button>
          </div>
          {meetings.length === 0 && <p className="muted">아직 회의록이 없습니다. 회의록 메뉴에서 녹음을 시작해 보세요.</p>}
          {meetings.slice(0, 6).map((n) => (
            <button key={n.id} className="row" onClick={() => onOpen(n)}>
              <span>{n.title || '(제목 없음)'}</span>
              <span className="muted">{fmtDate(n.createdAt)}</span>
            </button>
          ))}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>해야 할 일</h2>
            <button className="link" onClick={() => onGo('tasks')}>전체 보기</button>
          </div>
          {open.length === 0 && <p className="muted">진행 중인 할 일이 없습니다.</p>}
          {open.slice(0, 8).map((t) => (
            <div key={t.id} className="row static">
              <span>{t.title}</span>
              <span className={overdue.includes(t) ? 'danger' : 'muted'}>
                {[t.owner, t.due].filter(Boolean).join(' · ')}
              </span>
            </div>
          ))}
        </section>
      </div>

      <section className="card">
        <div className="card-head"><h2>최근 업무 노트</h2></div>
        {notes.filter((n) => n.type !== 'meeting').slice(0, 6).map((n) => (
          <button key={n.id} className="row" onClick={() => onOpen(n)}>
            <span><span className="chip">{NOTE_TYPE_LABEL[n.type]}</span> {n.title || '(제목 없음)'}</span>
            <span className="muted">{fmtDate(n.updatedAt)}</span>
          </button>
        ))}
      </section>
    </div>
  )
}
