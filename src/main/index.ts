import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, session, shell } from 'electron'
import { cpSync, existsSync, promises as fs } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { Athlete, Channel, GrowthRecord, Note, Settings, Task } from '../shared/types'
import { audioDir, getSettings, repo, saveSettings } from './store'
import { sync } from './sync'
import { checkForUpdates, getUpdateStatus, initUpdater, installUpdate } from './updater'
import { transcribeNoteAudio } from './services/transcribe'
import { analyzeMeeting } from './services/analyze'
import { CHANNEL_LABEL, sendTest, sendToChannel } from './services/send'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    title: '강철노트',
    backgroundColor: '#f6f7f9',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  // 외부 링크는 기본 브라우저로
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

/** 온라인 회의 소리(시스템 소리)를 함께 녹음할 수 있게 화면 공유 요청에 루프백 오디오를 연결 */
function setupSystemAudioCapture(): void {
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
    const sources = await desktopCapturer.getSources({ types: ['screen'] })
    callback({ video: sources[0], audio: 'loopback' })
  })
}

async function requireNote(id: string): Promise<Note> {
  const note = await repo.getNote(id)
  if (!note) throw new Error('노트를 찾을 수 없습니다.')
  if (!note.meeting) throw new Error('회의록 노트가 아닙니다.')
  return note
}

function registerIpc(): void {
  ipcMain.handle('notes:list', () => repo.listNotes())
  ipcMain.handle('notes:save', (_e, n: Note) => repo.saveNote(n))
  ipcMain.handle('notes:delete', (_e, id: string) => repo.deleteNote(id))
  ipcMain.handle('tasks:list', () => repo.listTasks())
  ipcMain.handle('tasks:save', (_e, t: Task) => repo.saveTask(t))
  ipcMain.handle('tasks:delete', (_e, id: string) => repo.deleteTask(id))
  ipcMain.handle('settings:get', () => getSettings())
  ipcMain.handle('settings:save', async (_e, s: Settings) => {
    await saveSettings(s)
    await sync.configure(s)
  })
  ipcMain.handle('app:version', () => app.getVersion())
  ipcMain.handle('update:status', () => getUpdateStatus())
  ipcMain.handle('update:check', () => checkForUpdates())
  ipcMain.handle('update:install', () => installUpdate())
  ipcMain.handle('sync:status', () => sync.getStatus())
  ipcMain.handle('sync:signIn', (_e, email: string, pw: string) => sync.signIn(email, pw))
  ipcMain.handle('sync:signOut', () => sync.signOut())
  ipcMain.handle('sync:now', () => sync.syncNow())

  ipcMain.handle('audio:save', async (_e, noteId: string, index: number, data: ArrayBuffer) => {
    if (!/^[\w-]+$/.test(noteId)) throw new Error('잘못된 노트 ID')
    const dir = audioDir(noteId)
    await fs.mkdir(dir, { recursive: true })
    // 시각을 앞에 붙여 이전 녹음을 덮어쓰지 않고, 이름순 = 녹음순이 되게 함
    const file = join(dir, `${Date.now()}-${String(index).padStart(3, '0')}.webm`)
    await fs.writeFile(file, Buffer.from(data))
    return file
  })

  ipcMain.handle('meeting:transcribe', async (_e, noteId: string) => {
    const note = await requireNote(noteId)
    const s = await getSettings()
    note.meeting!.transcript = await transcribeNoteAudio(noteId, s.openaiKey, s.transcribeModel)
    return repo.saveNote(note)
  })

  ipcMain.handle('meeting:analyze', async (_e, noteId: string) => {
    const note = await requireNote(noteId)
    const s = await getSettings()
    const analysis = await analyzeMeeting({
      apiKey: s.anthropicKey,
      model: s.claudeModel,
      transcript: note.meeting!.transcript,
      participants: note.meeting!.participants,
      meetingDate: note.createdAt.slice(0, 10),
      memo: note.content
    })
    note.meeting!.analysis = analysis
    if (!note.title.trim()) note.title = analysis.title

    // 할 일 목록에 자동 등록 (이미 같은 회의에서 만든 항목은 교체)
    for (const t of (await repo.listTasks()).filter((t) => t.sourceNoteId === noteId && !t.done)) {
      await repo.deleteTask(t.id)
    }
    for (const a of analysis.actionItems) {
      await repo.saveTask({
        id: randomUUID(),
        title: a.task,
        owner: a.owner,
        due: a.due,
        done: false,
        sourceNoteId: noteId,
        createdAt: new Date().toISOString()
      })
    }
    const saved = await repo.saveNote(note)

    // 자동 전송 설정이 켜진 채널로 바로 보냄
    const auto = (Object.keys(s.autoSend) as Channel[]).filter((c) => s.autoSend[c])
    return auto.length ? sendAll(saved, auto, s) : saved
  })

  ipcMain.handle('meeting:send', async (_e, noteId: string, channels: Channel[]) => {
    return sendAll(await requireNote(noteId), channels, await getSettings())
  })

  ipcMain.handle('athletes:list', () => repo.listAthletes())
  ipcMain.handle('athletes:save', (_e, a: Athlete) => repo.saveAthlete(a))
  ipcMain.handle('athletes:delete', (_e, id: string) => repo.deleteAthlete(id))
  ipcMain.handle('growth:list', (_e, athleteId: string) => repo.listGrowthRecords(athleteId))
  ipcMain.handle('growth:save', (_e, r: GrowthRecord) => repo.saveGrowthRecord(r))

  // 화면에서 만든 기록부 HTML 을 A4 PDF 로 저장
  ipcMain.handle('pdf:save', async (e, html: string, defaultName: string) => {
    const parent = BrowserWindow.fromWebContents(e.sender) ?? undefined
    const { canceled, filePath } = await dialog.showSaveDialog(parent!, {
      title: 'PDF로 저장',
      defaultPath: join(app.getPath('documents'), defaultName.replace(/[\\/:*?"<>|]/g, '_')),
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    })
    if (canceled || !filePath) return null
    const win = new BrowserWindow({ show: false, webPreferences: { javascript: false } })
    try {
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
      const pdf = await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { marginType: 'default' } })
      await fs.writeFile(filePath, pdf)
    } finally {
      win.destroy()
    }
    shell.openPath(filePath)
    return filePath
  })

  ipcMain.handle('channel:test', async (_e, c: Channel) => {
    await sendTest(c, await getSettings())
    return `${CHANNEL_LABEL[c]}로 테스트 메시지를 보냈습니다.`
  })
}

async function sendAll(note: Note, channels: Channel[], s: Settings): Promise<Note> {
  for (const c of channels) {
    try {
      await sendToChannel(c, s, note)
      note.meeting!.sentLog.push({ channel: c, at: new Date().toISOString(), ok: true, message: '전송 완료' })
    } catch (err) {
      note.meeting!.sentLog.push({
        channel: c,
        at: new Date().toISOString(),
        ok: false,
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }
  return repo.saveNote(note)
}

/**
 * 프로그램 이름이 '훈씨노트' → '강철노트'로 바뀌면서 데이터 폴더 이름도 바뀜.
 * 새 폴더에 데이터가 없고 옛 폴더에 있으면 한 번 복사해 옴 (옛 폴더는 그대로 둠).
 */
function migrateFromOldName(): void {
  try {
    const newData = join(app.getPath('userData'), 'data')
    if (existsSync(newData)) return
    for (const oldName of ['훈씨노트', 'hoonssi-note']) {
      const oldData = join(app.getPath('appData'), oldName, 'data')
      if (oldData !== newData && existsSync(oldData)) {
        cpSync(oldData, newData, { recursive: true })
        return
      }
    }
  } catch (e) {
    console.error('이전 데이터 옮기기 실패', e)
  }
}
migrateFromOldName()

app.whenReady().then(async () => {
  registerIpc()
  setupSystemAudioCapture()
  createWindow()
  initUpdater()
  sync.init(await getSettings()).catch((e) => console.error('sync init', e))
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
