import { useCallback, useEffect, useState } from 'react'
import type { Note, Settings, Task } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import Dashboard from './pages/Dashboard'
import NotesPage from './pages/NotesPage'
import TasksPage from './pages/TasksPage'
import SettingsPage from './pages/SettingsPage'

export type Page = 'dashboard' | 'meetings' | 'notes' | 'tasks' | 'settings'

const NAV: { id: Page; label: string; icon: string }[] = [
  { id: 'dashboard', label: '홈', icon: '🏠' },
  { id: 'meetings', label: '회의록', icon: '🎙️' },
  { id: 'notes', label: '업무 노트', icon: '📒' },
  { id: 'tasks', label: '할 일', icon: '✅' },
  { id: 'settings', label: '설정·연동', icon: '⚙️' }
]

export default function App(): JSX.Element {
  const [page, setPage] = useState<Page>('dashboard')
  const [notes, setNotes] = useState<Note[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [openNoteId, setOpenNoteId] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const [n, t, s] = await Promise.all([window.api.listNotes(), window.api.listTasks(), window.api.getSettings()])
    setNotes(n)
    setTasks(t)
    setSettings(s)
  }, [])

  useEffect(() => {
    reload()
  }, [reload])

  const openNote = (n: Note): void => {
    setOpenNoteId(n.id)
    setPage(n.type === 'meeting' ? 'meetings' : 'notes')
  }

  const pendingTasks = tasks.filter((t) => !t.done).length

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo">훈</span>
          <span>훈씨노트</span>
        </div>
        <nav>
          {NAV.map((n) => (
            <button key={n.id} className={page === n.id ? 'nav active' : 'nav'} onClick={() => setPage(n.id)}>
              <span className="nav-icon">{n.icon}</span>
              {n.label}
              {n.id === 'tasks' && pendingTasks > 0 && <span className="badge">{pendingTasks}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">{settings.userName ? `${settings.userName} 님` : '설정에서 이름을 입력하세요'}</div>
      </aside>
      <main className="content">
        {page === 'dashboard' && <Dashboard notes={notes} tasks={tasks} onOpen={openNote} onGo={setPage} />}
        {(page === 'meetings' || page === 'notes') && (
          <NotesPage
            key={page}
            mode={page}
            notes={notes}
            settings={settings}
            selectedId={openNoteId}
            onSelect={setOpenNoteId}
            reload={reload}
          />
        )}
        {page === 'tasks' && <TasksPage tasks={tasks} notes={notes} reload={reload} onOpen={openNote} />}
        {page === 'settings' && <SettingsPage settings={settings} reload={reload} />}
      </main>
    </div>
  )
}
