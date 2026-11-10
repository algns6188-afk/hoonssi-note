import { BrowserWindow, net, safeStorage } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js'
import WebSocket from 'ws'
import type { Settings, SyncStatus } from '../shared/types'
import { COLLECTIONS, type Collection, dataDir, repo } from './store'

/**
 * 팀 공유 서버(Supabase) 동기화.
 *
 * - 이 PC의 저장소가 기준이고, 바뀐 내용은 대기열(queue)에 쌓였다가 서버로 올라갑니다.
 *   인터넷이 끊겨도 대기열은 파일로 보관되어, 다시 연결되면 이어서 올립니다.
 * - 다른 PC의 변경은 실시간(Realtime)으로 받고, 놓친 것은 주기적으로 다시 받아옵니다.
 * - 같은 항목을 두 곳에서 고치면 나중에 고친 쪽이 남습니다(서버에서도 같은 규칙 적용).
 */

const TABLE: Record<Collection, string> = {
  notes: 'notes',
  tasks: 'tasks',
  athletes: 'athletes',
  growthRecords: 'growth_records'
}
const COL_OF_TABLE = Object.fromEntries(Object.entries(TABLE).map(([c, t]) => [t, c as Collection]))

type Doc = { id: string; updatedAt?: string }
interface Row {
  id: string
  data: Doc | null
  changed_at: string
  deleted: boolean
  updated_at: string
}
interface QueueItem {
  col: Collection
  id: string
  doc: Doc | null
  at: string
}
interface SyncState {
  server: string
  cursors: Partial<Record<Collection, string>>
  reconciled: boolean
}

const file = (name: string): string => join(dataDir(), name)

async function readJson<T>(name: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file(name), 'utf8')) as T
  } catch {
    return fallback
  }
}
async function writeJson(name: string, v: unknown): Promise<void> {
  await fs.mkdir(dataDir(), { recursive: true })
  await fs.writeFile(file(name), JSON.stringify(v), 'utf8')
}

/** 로그인 정보(토큰)를 PC 보안 저장소로 암호화해 파일에 보관 */
const authStorage = {
  async getItem(key: string): Promise<string | null> {
    const all = await readJson<Record<string, string>>('server-auth.json', {})
    const v = all[key]
    if (!v) return null
    try {
      return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(Buffer.from(v, 'base64')) : v
    } catch {
      return null
    }
  },
  async setItem(key: string, value: string): Promise<void> {
    const all = await readJson<Record<string, string>>('server-auth.json', {})
    all[key] = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(value).toString('base64') : value
    await writeJson('server-auth.json', all)
  },
  async removeItem(key: string): Promise<void> {
    const all = await readJson<Record<string, string>>('server-auth.json', {})
    delete all[key]
    await writeJson('server-auth.json', all)
  }
}

/** 'https://xxx.supabase.co/rest/v1/' 처럼 붙여넣어도 기본 주소만 남김 */
export function normalizeUrl(raw: string): string {
  let u = raw.trim()
  if (!u) return ''
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u
  try {
    const url = new URL(u)
    return `${url.protocol}//${url.host}`
  } catch {
    return u.replace(/\/+$/, '')
  }
}

const isNetworkError = (m: string): boolean =>
  /fetch failed|failed to fetch|network|net::ERR_|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN|certificate|CERT_/i.test(m)

/** 오류의 실제 원인(예: 인증서 문제, 주소 못 찾음)까지 꺼내서 보여줌 */
function errorText(e: unknown): string {
  if (!(e instanceof Error)) return String(e)
  const cause = (e as Error & { cause?: { code?: string; message?: string } }).cause
  const extra = cause?.code ?? cause?.message
  return extra && !e.message.includes(extra) ? `${e.message} (${extra})` : e.message
}

class SyncService {
  private client: SupabaseClient | null = null
  private channel: RealtimeChannel | null = null
  private server = ''
  private queue = new Map<string, QueueItem>()
  private state: SyncState = { server: '', cursors: {}, reconciled: false }
  private status: SyncStatus = { state: 'off', email: null, pending: 0, lastSyncAt: null, message: null }
  private retryTimer: NodeJS.Timeout | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private changedTimer: NodeJS.Timeout | null = null
  private pushing = false
  private fastPoll: NodeJS.Timeout | null = null

  async init(settings: Settings): Promise<void> {
    const items = await readJson<QueueItem[]>('sync-queue.json', [])
    this.queue = new Map(items.map((q) => [`${q.col}:${q.id}`, q]))
    repo.onLocalChange = (col, id, doc, at) => {
      if (!this.server) return
      this.queue.set(`${col}:${id}`, { col, id, doc, at })
      this.saveQueue()
      this.setStatus({ pending: this.queue.size })
      this.schedulePush()
    }
    await this.configure(settings)
  }

  /** 설정의 서버 주소/키가 바뀌면 다시 연결 */
  async configure(s: Settings): Promise<void> {
    const url = normalizeUrl(s.serverUrl)
    const key = s.serverKey.trim()
    const server = url && key ? url : ''
    if (server === this.server && this.client) return
    await this.stop()
    this.server = server
    if (!server) {
      this.setStatus({ state: 'off', email: null, message: null })
      return
    }
    this.state = await readJson<SyncState>('sync-state.json', { server, cursors: {}, reconciled: false })
    if (this.state.server !== server) this.state = { server, cursors: {}, reconciled: false }

    this.client = createClient(url, key, {
      auth: { storage: authStorage, persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
      // 크롬과 같은 통신 방식: 회사망 프록시·백신 인증서 등 PC의 인터넷 설정을 그대로 사용
      global: { fetch: ((input: RequestInfo | URL, init?: RequestInit) => net.fetch(input as string, init)) as typeof fetch },
      realtime: { transport: WebSocket as unknown as typeof globalThis.WebSocket }
    })
    this.client.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_OUT') this.setStatus({ state: 'login', email: null })
      else if (session) this.setStatus({ email: session.user.email ?? null })
    })
    const { data } = await this.client.auth.getSession()
    if (!data.session) {
      this.setStatus({ state: 'login', email: null, message: null })
      return
    }
    this.setStatus({ email: data.session.user.email ?? null })
    await this.start()
  }

  async signIn(email: string, password: string): Promise<SyncStatus> {
    if (!this.client) throw new Error('설정에서 공유 서버 주소와 키를 먼저 저장해 주세요.')
    let error: { message: string } | null = null
    try {
      ;({ error } = await this.client.auth.signInWithPassword({ email: email.trim(), password }))
    } catch (e) {
      error = { message: errorText(e) }
    }
    if (error) {
      const m = error.message
      throw new Error(
        /invalid login/i.test(m)
          ? '이메일 또는 비밀번호가 맞지 않습니다.'
          : /email not confirmed/i.test(m)
            ? '이메일 인증이 안 된 계정입니다. 관리자가 계정을 만들 때 "Auto Confirm User"를 체크해야 합니다.'
            : isNetworkError(m)
              ? `서버에 연결할 수 없습니다. 인터넷 연결과 서버 주소를 확인해 주세요.\n(주소: ${this.server} · 원인: ${m})`
              : m
      )
    }
    await this.start()
    return this.status
  }

  async signOut(): Promise<SyncStatus> {
    await this.stopRealtime()
    await this.client?.auth.signOut()
    this.setStatus({ state: 'login', email: null, message: null })
    return this.status
  }

  getStatus(): SyncStatus {
    return this.status
  }

  async syncNow(): Promise<SyncStatus> {
    await this.start()
    return this.status
  }

  /* ---------------- 내부 ---------------- */

  private async start(): Promise<void> {
    if (!this.client) return
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.setStatus({ state: 'connecting', message: null })
    try {
      await this.pull()
      if (!this.state.reconciled) await this.reconcile()
      await this.push()
      this.subscribe()
      this.setStatus({ state: 'online', lastSyncAt: new Date().toISOString(), message: null })
      if (!this.pollTimer) this.pollTimer = setInterval(() => this.quietSync(), 5 * 60 * 1000)
    } catch (e) {
      this.fail(e)
    }
  }

  private async quietSync(): Promise<void> {
    if (this.status.state !== 'online') return
    try {
      await this.pull()
      await this.push()
      this.setStatus({ lastSyncAt: new Date().toISOString() })
    } catch (e) {
      this.fail(e)
    }
  }

  private fail(e: unknown): void {
    const msg = errorText(e)
    const auth = /jwt|token|auth|401|403/i.test(msg)
    const missingTable = /relation .* does not exist|could not find the table/i.test(msg)
    this.setStatus({
      state: auth ? 'login' : missingTable ? 'error' : 'offline',
      message: missingTable
        ? '서버에 표가 아직 없습니다. 안내받은 SQL을 Supabase에서 실행해 주세요.'
        : auth
          ? '다시 로그인해 주세요.'
          : '서버에 연결할 수 없어 이 PC에 저장 중입니다. 연결되면 자동으로 올립니다.'
    })
    if (!auth && !missingTable) {
      if (this.retryTimer) clearTimeout(this.retryTimer)
      this.retryTimer = setTimeout(() => this.start(), 30_000)
    }
  }

  /** 서버에서 마지막으로 받은 이후 바뀐 것만 받아오기 */
  private async pull(): Promise<void> {
    const c = this.client!
    for (const col of COLLECTIONS) {
      for (;;) {
        let q = c.from(TABLE[col]).select('id,data,changed_at,deleted,updated_at').order('updated_at').limit(1000)
        const cursor = this.state.cursors[col]
        if (cursor) q = q.gt('updated_at', cursor)
        const { data, error } = await q
        if (error) throw new Error(error.message)
        const rows = (data ?? []) as Row[]
        let changed = false
        for (const r of rows) changed = (await this.applyRow(col, r)) || changed
        if (rows.length) {
          this.state.cursors[col] = rows[rows.length - 1].updated_at
          await writeJson('sync-state.json', this.state)
        }
        if (changed) this.notifyChanged()
        if (rows.length < 1000) break
      }
    }
  }

  private async applyRow(col: Collection, r: Row): Promise<boolean> {
    // 아직 올리지 못한 이 PC의 변경이 더 최신이면 서버 것을 무시
    const pending = this.queue.get(`${col}:${r.id}`)
    if (pending && pending.at >= r.changed_at) return false
    return repo.applyRemote(col, r.id, r.deleted ? null : r.data, r.changed_at)
  }

  /** 처음 연결할 때: 이 PC에만 있거나 더 최신인 데이터를 서버로 올리기 */
  private async reconcile(): Promise<void> {
    const c = this.client!
    for (const col of COLLECTIONS) {
      const server = new Map<string, string>()
      for (let from = 0; ; from += 1000) {
        const { data, error } = await c.from(TABLE[col]).select('id,changed_at').range(from, from + 999)
        if (error) throw new Error(error.message)
        for (const r of data ?? []) server.set(r.id as string, r.changed_at as string)
        if (!data || data.length < 1000) break
      }
      for (const d of await repo.all(col)) {
        const at = d.updatedAt ?? new Date().toISOString()
        const s = server.get(d.id)
        if (!s || at > s) this.queue.set(`${col}:${d.id}`, { col, id: d.id, doc: d, at })
      }
    }
    await this.saveQueue()
    this.state.reconciled = true
    await writeJson('sync-state.json', this.state)
  }

  private schedulePush(): void {
    if (this.status.state !== 'online') return
    setTimeout(() => this.push().catch((e) => this.fail(e)), 300)
  }

  private async push(): Promise<void> {
    if (!this.client || this.pushing || this.queue.size === 0) return
    this.pushing = true
    try {
      const items = [...this.queue.values()]
      for (const col of COLLECTIONS) {
        const mine = items.filter((q) => q.col === col)
        for (let i = 0; i < mine.length; i += 200) {
          const batch = mine.slice(i, i + 200)
          const { error } = await this.client.from(TABLE[col]).upsert(
            batch.map((q) => ({ id: q.id, data: q.doc, changed_at: q.at, deleted: q.doc === null })),
            { onConflict: 'id' }
          )
          if (error) throw new Error(error.message)
          // 올리는 사이에 또 바뀐 항목은 대기열에 남겨 둠
          for (const q of batch) {
            const key = `${q.col}:${q.id}`
            if (this.queue.get(key)?.at === q.at) this.queue.delete(key)
          }
          await this.saveQueue()
          this.setStatus({ pending: this.queue.size })
        }
      }
      this.setStatus({ lastSyncAt: new Date().toISOString() })
    } finally {
      this.pushing = false
    }
    if (this.queue.size) this.schedulePush()
  }

  private subscribe(): void {
    if (!this.client || this.channel) return
    let ch = this.client.channel('hoonssi-sync')
    for (const table of Object.values(TABLE)) {
      ch = ch.on('postgres_changes', { event: '*', schema: 'public', table }, async (payload) => {
        const row = payload.new as Row | undefined
        if (!row?.id) return
        const col = COL_OF_TABLE[payload.table]
        if (await this.applyRow(col, row)) this.notifyChanged()
      })
    }
    ch.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        if (this.status.state !== 'online') this.setStatus({ state: 'online', message: null })
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        this.stopRealtime().then(() => this.fallbackToPolling())
      }
    })
    this.channel = ch
  }

  /** 실시간 연결(웹소켓)이 막힌 경우: 15초마다 서버를 확인하고, 2분마다 실시간 재연결 시도 */
  private fallbackToPolling(): void {
    if (this.fastPoll) return
    this.setStatus({ message: '실시간 연결이 막혀 있어 15초마다 서버를 확인합니다.' })
    this.fastPoll = setInterval(() => this.quietSync(), 15_000)
    setTimeout(() => {
      if (this.fastPoll) clearInterval(this.fastPoll)
      this.fastPoll = null
      if (this.client && this.status.state === 'online') this.subscribe()
    }, 120_000)
  }

  private async stopRealtime(): Promise<void> {
    if (this.channel && this.client) await this.client.removeChannel(this.channel)
    this.channel = null
  }

  private async stop(): Promise<void> {
    await this.stopRealtime()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.fastPoll) clearInterval(this.fastPoll)
    this.retryTimer = null
    this.pollTimer = null
    this.fastPoll = null
    this.client = null
  }

  private saveQueue(): Promise<void> {
    return writeJson('sync-queue.json', [...this.queue.values()])
  }

  private notifyChanged(): void {
    if (this.changedTimer) clearTimeout(this.changedTimer)
    this.changedTimer = setTimeout(() => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send('data:changed')
    }, 300)
  }

  private setStatus(patch: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...patch, pending: patch.pending ?? this.queue.size }
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send('sync:status', this.status)
  }
}

export const sync = new SyncService()
