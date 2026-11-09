import { app, safeStorage } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { DEFAULT_SETTINGS, type Note, type Settings, type Task } from '../shared/types'

/**
 * 데이터 저장소.
 * 지금은 PC 안의 JSON 파일에 저장합니다. 팀 공유 단계에서 같은 인터페이스로
 * 공유 서버(Supabase) 구현을 추가해 바꿔 끼울 수 있게 분리해 두었습니다.
 */
export interface Repository {
  listNotes(): Promise<Note[]>
  getNote(id: string): Promise<Note | undefined>
  saveNote(note: Note): Promise<Note>
  deleteNote(id: string): Promise<void>
  listTasks(): Promise<Task[]>
  saveTask(task: Task): Promise<Task>
  deleteTask(id: string): Promise<void>
}

interface DbShape { notes: Note[]; tasks: Task[] }

export const dataDir = (): string => join(app.getPath('userData'), 'data')
export const audioDir = (noteId: string): string => join(dataDir(), 'audio', noteId)

class LocalJsonRepository implements Repository {
  private cache: DbShape | null = null
  private file = (): string => join(dataDir(), 'db.json')

  private async load(): Promise<DbShape> {
    if (this.cache) return this.cache
    try {
      this.cache = JSON.parse(await fs.readFile(this.file(), 'utf8')) as DbShape
    } catch {
      this.cache = { notes: [], tasks: [] }
    }
    return this.cache
  }

  private async flush(): Promise<void> {
    await fs.mkdir(dataDir(), { recursive: true })
    const tmp = this.file() + '.tmp'
    await fs.writeFile(tmp, JSON.stringify(this.cache, null, 2), 'utf8')
    await fs.rename(tmp, this.file())
  }

  async listNotes(): Promise<Note[]> {
    const db = await this.load()
    return [...db.notes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
  async getNote(id: string): Promise<Note | undefined> {
    return (await this.load()).notes.find((n) => n.id === id)
  }
  async saveNote(note: Note): Promise<Note> {
    const db = await this.load()
    const saved = { ...note, updatedAt: new Date().toISOString() }
    const i = db.notes.findIndex((n) => n.id === note.id)
    if (i >= 0) db.notes[i] = saved
    else db.notes.push(saved)
    await this.flush()
    return saved
  }
  async deleteNote(id: string): Promise<void> {
    const db = await this.load()
    db.notes = db.notes.filter((n) => n.id !== id)
    await this.flush()
    await fs.rm(audioDir(id), { recursive: true, force: true })
  }
  async listTasks(): Promise<Task[]> {
    return [...(await this.load()).tasks]
  }
  async saveTask(task: Task): Promise<Task> {
    const db = await this.load()
    const i = db.tasks.findIndex((t) => t.id === task.id)
    if (i >= 0) db.tasks[i] = task
    else db.tasks.push(task)
    await this.flush()
    return task
  }
  async deleteTask(id: string): Promise<void> {
    const db = await this.load()
    db.tasks = db.tasks.filter((t) => t.id !== id)
    await this.flush()
  }
}

export const repo: Repository = new LocalJsonRepository()

/* ---------- 설정 (API 키 등은 OS 보안 저장소로 암호화) ---------- */

const SECRET_KEYS = ['anthropicKey', 'openaiKey', 'kakaoAccessToken', 'slackWebhook', 'teamsWebhook'] as const
const settingsFile = (): string => join(dataDir(), 'settings.json')

export async function getSettings(): Promise<Settings> {
  try {
    const raw = JSON.parse(await fs.readFile(settingsFile(), 'utf8'))
    const s = { ...DEFAULT_SETTINGS, ...raw, autoSend: { ...DEFAULT_SETTINGS.autoSend, ...raw.autoSend } }
    for (const k of SECRET_KEYS) {
      const v = raw[k]
      if (typeof v === 'string' && v.startsWith('enc:')) {
        try {
          s[k] = safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'))
        } catch {
          s[k] = ''
        }
      }
    }
    return s
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export async function saveSettings(s: Settings): Promise<void> {
  const out: Record<string, unknown> = { ...s }
  if (safeStorage.isEncryptionAvailable()) {
    for (const k of SECRET_KEYS) {
      if (s[k]) out[k] = 'enc:' + safeStorage.encryptString(s[k]).toString('base64')
    }
  }
  await fs.mkdir(dataDir(), { recursive: true })
  await fs.writeFile(settingsFile(), JSON.stringify(out, null, 2), 'utf8')
}
