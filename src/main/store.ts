import { app, safeStorage } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { DEFAULT_SETTINGS, type Athlete, type GrowthRecord, type Note, type Settings, type Task } from '../shared/types'

/**
 * 데이터 저장소.
 * 모든 데이터는 먼저 이 PC 안의 JSON 파일에 저장됩니다 (인터넷이 없어도 동작).
 * 공유 서버가 연결되어 있으면 sync.ts 가 변경 내용을 서버와 주고받습니다.
 */
export type Collection = 'notes' | 'tasks' | 'athletes' | 'growthRecords'
export const COLLECTIONS: Collection[] = ['notes', 'tasks', 'athletes', 'growthRecords']

type Doc = { id: string; updatedAt?: string }
interface DbShape {
  notes: Note[]
  tasks: Task[]
  athletes: Athlete[]
  growthRecords: GrowthRecord[]
}

/** 로컬에서 바뀐 내용을 서버로 보내기 위한 알림 (doc 이 null 이면 삭제) */
export type LocalChangeListener = (col: Collection, id: string, doc: Doc | null, at: string) => void

export const dataDir = (): string => join(app.getPath('userData'), 'data')
export const audioDir = (noteId: string): string => join(dataDir(), 'audio', noteId)

class LocalJsonRepository {
  private cache: DbShape | null = null
  private file = (): string => join(dataDir(), 'db.json')
  private writing: Promise<void> = Promise.resolve()
  onLocalChange: LocalChangeListener | null = null

  private async load(): Promise<DbShape> {
    if (this.cache) return this.cache
    let raw: Partial<DbShape> = {}
    try {
      raw = JSON.parse(await fs.readFile(this.file(), 'utf8'))
    } catch {
      // 첫 실행
    }
    // 이전 버전 데이터에 없는 항목은 빈 목록으로 채움
    this.cache = {
      notes: raw.notes ?? [],
      tasks: (raw.tasks ?? []).map((t) => ({ ...t, updatedAt: t.updatedAt ?? t.createdAt })),
      athletes: raw.athletes ?? [],
      growthRecords: raw.growthRecords ?? []
    }
    return this.cache
  }

  /** 파일 쓰기는 한 번에 하나씩 (동시에 쓰다 깨지지 않게) */
  private flush(): Promise<void> {
    this.writing = this.writing.then(async () => {
      await fs.mkdir(dataDir(), { recursive: true })
      const tmp = this.file() + '.tmp'
      await fs.writeFile(tmp, JSON.stringify(this.cache, null, 2), 'utf8')
      await fs.rename(tmp, this.file())
    })
    return this.writing
  }

  private async upsert<T extends Doc>(col: Collection, doc: T): Promise<T> {
    const db = await this.load()
    const list = db[col] as unknown as T[]
    const saved = { ...doc, updatedAt: new Date().toISOString() }
    const i = list.findIndex((x) => x.id === doc.id)
    if (i >= 0) list[i] = saved
    else list.push(saved)
    await this.flush()
    this.onLocalChange?.(col, saved.id, saved, saved.updatedAt)
    return saved
  }

  private async remove(col: Collection, ids: string[]): Promise<void> {
    if (!ids.length) return
    const db = await this.load()
    ;(db[col] as Doc[]) = (db[col] as Doc[]).filter((x) => !ids.includes(x.id))
    await this.flush()
    const at = new Date().toISOString()
    for (const id of ids) this.onLocalChange?.(col, id, null, at)
  }

  /* ----- 화면에서 쓰는 기능 ----- */

  async listNotes(): Promise<Note[]> {
    return [...(await this.load()).notes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
  async getNote(id: string): Promise<Note | undefined> {
    return (await this.load()).notes.find((n) => n.id === id)
  }
  saveNote = (note: Note): Promise<Note> => this.upsert('notes', note)
  async deleteNote(id: string): Promise<void> {
    await this.remove('notes', [id])
    await fs.rm(audioDir(id), { recursive: true, force: true })
  }

  async listTasks(): Promise<Task[]> {
    return [...(await this.load()).tasks]
  }
  saveTask = (task: Task): Promise<Task> => this.upsert('tasks', task)
  deleteTask = (id: string): Promise<void> => this.remove('tasks', [id])

  async listAthletes(): Promise<Athlete[]> {
    return [...(await this.load()).athletes].sort((a, b) => a.name.localeCompare(b.name, 'ko'))
  }
  saveAthlete = (a: Athlete): Promise<Athlete> => this.upsert('athletes', a)
  async deleteAthlete(id: string): Promise<void> {
    const db = await this.load()
    await this.remove('growthRecords', db.growthRecords.filter((r) => r.athleteId === id).map((r) => r.id))
    await this.remove('athletes', [id])
  }

  async listGrowthRecords(athleteId: string): Promise<GrowthRecord[]> {
    return (await this.load()).growthRecords
      .filter((r) => r.athleteId === athleteId)
      .sort((a, b) => a.month.localeCompare(b.month))
  }
  async saveGrowthRecord(r: GrowthRecord): Promise<GrowthRecord> {
    // 한 선수의 한 달 기록은 하나만 유지 (같은 달 기록이 이미 있으면 그 id 로 저장)
    const db = await this.load()
    const same = db.growthRecords.find((x) => x.athleteId === r.athleteId && x.month === r.month)
    return this.upsert('growthRecords', same ? { ...r, id: same.id } : r)
  }

  /* ----- 동기화용 ----- */

  async all(col: Collection): Promise<Doc[]> {
    return [...((await this.load())[col] as Doc[])]
  }

  /**
   * 서버에서 받은 변경을 이 PC에 반영. 더 최신일 때만 덮어씁니다.
   * 반영했으면 true. (서버에서 온 변경은 다시 서버로 보내지 않음)
   */
  async applyRemote(col: Collection, id: string, doc: Doc | null, at: string): Promise<boolean> {
    const db = await this.load()
    const list = db[col] as Doc[]
    const i = list.findIndex((x) => x.id === id)
    const local = i >= 0 ? list[i] : null
    if (doc === null) {
      if (!local || (local.updatedAt ?? '') > at) return false
      list.splice(i, 1)
      if (col === 'notes') await fs.rm(audioDir(id), { recursive: true, force: true })
    } else {
      if (local && (local.updatedAt ?? '') >= (doc.updatedAt ?? at)) return false
      // 녹음 파일 경로는 PC마다 다르므로 이 PC의 값을 유지
      if (col === 'notes' && local) {
        const ln = local as Note
        const rn = doc as Note
        if (ln.meeting && rn.meeting) rn.meeting = { ...rn.meeting, audioFiles: ln.meeting.audioFiles }
      }
      if (i >= 0) list[i] = doc
      else list.push(doc)
    }
    await this.flush()
    return true
  }
}

export const repo = new LocalJsonRepository()

/* ---------- 설정 (API 키 등은 OS 보안 저장소로 암호화) ---------- */

const SECRET_KEYS = ['anthropicKey', 'openaiKey', 'kakaoAccessToken', 'slackWebhook', 'teamsWebhook', 'serverKey'] as const
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
