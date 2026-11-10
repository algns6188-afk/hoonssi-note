import { useCallback, useEffect, useState } from 'react'
import type { Note, Settings, SyncStatus, Task, UpdateStatus } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import Dashboard from './pages/Dashboard'
import NotesPage from './pages/NotesPage'
import TasksPage from './pages/TasksPage'
import SettingsPage from './pages/SettingsPage'
import AthletesPage from './pages/AthletesPage'

export type Page = 'dashboard' | 'meetings' | 'notes' | 'tasks' | 'athletes' | 'settings'

const NAV: { id: Page; label: string; icon: string }[] = [
  { id: 'dashboard', label: '홈', icon: '🏠' },
  { id: 'meetings', label: '회의록', icon: '🎙️' },
  { id: 'notes', label: '업무 노트', icon: '📒' },
  { id: 'tasks', label: '할 일', icon: '✅' },
  { id: 'athletes', label: '선수 관리', icon: '🥋' },
  { id: 'settings', label: '설정·연동', icon: '⚙️' }
]

export default function App(): JSX.Element {
  const [page, setPage] = useState<Page>('dashboard')
  const [notes, setNotes] = useState<Note[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS)
  const [openNoteId, setOpenNoteId] = useState<string | null>(null)
  const [sync, setSync] = useState<SyncStatus | null>(null)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)

  const reload = useCallback(async () => {
    const [n, t, s] = await Promise.all([window.api.listNotes(), window.api.listTasks(), window.api.getSettings()])
    setNotes(n)
    setTasks(t)
    setSettings(s)
  }, [])

  useEffect(() => {
    reload()
    window.api.syncStatus().then(setSync)
    window.api.updateStatus().then(setUpdate)
    const offUpdate = window.api.onUpdateStatus(setUpdate)
    const offStatus = window.api.onSyncStatus(setSync)
    // 다른 PC에서 바뀐 내용이 들어오면 화면 새로고침
    // (설정은 PC마다 따로라서 다시 불러오지 않음 → 설정 화면에서 입력 중인 내용 유지)
    const offData = window.api.onDataChanged(async () => {
      const [n, t] = await Promise.all([window.api.listNotes(), window.api.listTasks()])
      setNotes(n)
      setTasks(t)
    })
    return () => {
      offUpdate()
      offStatus()
      offData()
    }
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
        <SyncBadge status={sync} onClick={() => setPage('settings')} />
        <div className="sidebar-foot">{settings.userName ? `${settings.userName} 님` : '설정에서 이름을 입력하세요'}</div>
      </aside>
      <main className="content">
        {update?.state === 'ready' && (
          <div className="update-bar">
            🎉 새 버전 v{update.version}이 준비됐습니다.
            <button className="primary" onClick={() => window.api.installUpdate()}>
              {navigator.platform.startsWith('Mac') ? '다운로드 페이지 열기' : '지금 재시작해서 업데이트'}
            </button>
            {!navigator.platform.startsWith('Mac') && <span className="small">(나중에 프로그램을 끌 때 자동으로 설치돼요)</span>}
          </div>
        )}
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
        {page === 'athletes' && <AthletesPage />}
        {page === 'settings' && <SettingsPage settings={settings} reload={reload} sync={sync} />}
      </main>
    </div>
  )
}

function SyncBadge({ status, onClick }: { status: SyncStatus | null; onClick(): void }): JSX.Element | null {
  if (!status || status.state === 'off') return null
  const map: Record<string, [string, string]> = {
    online: ['ok', '실시간 연결됨'],
    connecting: ['wait', '연결 중…'],
    offline: ['warn', '오프라인 · 이 PC에 저장 중'],
    login: ['warn', '로그인 필요'],
    error: ['bad', '서버 설정 확인 필요']
  }
  const [cls, label] = map[status.state] ?? ['wait', status.state]
  return (
    <button className={`sync-badge ${cls}`} onClick={onClick} title={status.message ?? ''}>
      <span className="dot" />
      {label}
      {status.pending > 0 && <span className="small"> · 대기 {status.pending}</span>}
    </button>
  )
}
