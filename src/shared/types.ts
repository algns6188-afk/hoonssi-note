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
  claudeModel: string
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
  claudeModel: 'claude-opus-5-5',
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

/** 설정 화면에 보여 줄 모델 선택지 (1시간 회의 기준 예상 비용, 1달러 = 1,400원 가정) */
export const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 · 가장 정확', cost: '회의 1시간당 약 300원' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5 · 균형', cost: '회의 1시간당 약 150원' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5 · 가장 저렴', cost: '회의 1시간당 약 10원 (짧은 회의에 적합)' }
] as const

export const TRANSCRIBE_MODELS = [
  { id: 'whisper-1', label: 'whisper-1 · 기본', cost: '1시간당 약 500원 (2027년 2월 종료 예정 보도)' },
  { id: 'gpt-4o-transcribe', label: 'gpt-4o-transcribe · 더 정확', cost: '1시간당 약 500원 (2027년 2월 종료 예정 보도)' },
  { id: 'gpt-4o-mini-transcribe', label: 'gpt-4o-mini-transcribe · 저렴', cost: '1시간당 약 250원' },
  { id: 'gpt-transcribe', label: 'gpt-transcribe · 신규 후속 모델', cost: '1시간당 약 380원 (요금은 OpenAI에서 확인 필요)' }
] as const
