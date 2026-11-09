export type NoteType = 'memo' | 'meeting' | 'client' | 'project'

export const NOTE_TYPE_LABEL: Record<NoteType, string> = {
  memo: '메모',
  meeting: '회의록',
  client: '거래처',
  project: '프로젝트'
}

export interface ActionItem {
  task: string
  owner: string | null
  due: string | null
}

export interface MeetingAnalysis {
  title: string
  summary: string
  keyPoints: string[]
  decisions: string[]
  actionItems: ActionItem[]
  openIssues: string[]
  risks: string[]
  nextAgenda: string[]
}

export interface MeetingInfo {
  participants: string[]
  audioFiles: string[]
  transcript: string
  analysis: MeetingAnalysis | null
  sentLog: { channel: Channel; at: string; ok: boolean; message: string }[]
}

export interface Note {
  id: string
  type: NoteType
  title: string
  content: string
  tags: string[]
  author: string
  createdAt: string
  updatedAt: string
  meeting?: MeetingInfo
}

export interface Task {
  id: string
  title: string
  owner: string | null
  due: string | null
  done: boolean
  sourceNoteId: string | null
  createdAt: string
}

export type Channel = 'slack' | 'teams' | 'kakao'

export interface Settings {
  userName: string
  anthropicKey: string
  openaiKey: string
  transcribeModel: string
  slackWebhook: string
  teamsWebhook: string
  kakaoAccessToken: string
  autoSend: Record<Channel, boolean>
}

export const DEFAULT_SETTINGS: Settings = {
  userName: '',
  anthropicKey: '',
  openaiKey: '',
  transcribeModel: 'whisper-1',
  slackWebhook: '',
  teamsWebhook: '',
  kakaoAccessToken: '',
  autoSend: { slack: false, teams: false, kakao: false }
}

/** preload 가 window.api 로 노출하는 기능 목록 */
export interface HoonssiApi {
  listNotes(): Promise<Note[]>
  saveNote(note: Note): Promise<Note>
  deleteNote(id: string): Promise<void>
  listTasks(): Promise<Task[]>
  saveTask(task: Task): Promise<Task>
  deleteTask(id: string): Promise<void>
  getSettings(): Promise<Settings>
  saveSettings(s: Settings): Promise<void>
  saveAudio(noteId: string, index: number, data: ArrayBuffer): Promise<string>
  transcribe(noteId: string): Promise<Note>
  analyze(noteId: string): Promise<Note>
  send(noteId: string, channels: Channel[]): Promise<Note>
  testChannel(channel: Channel): Promise<string>
}
