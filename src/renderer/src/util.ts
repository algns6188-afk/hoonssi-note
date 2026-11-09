import type { Note, NoteType } from '@shared/types'

export const uid = (): string => crypto.randomUUID()
export const now = (): string => new Date().toISOString()

export function newNote(type: NoteType, author: string): Note {
  const t = now()
  return {
    id: uid(),
    type,
    title: '',
    content: '',
    tags: [],
    author,
    createdAt: t,
    updatedAt: t,
    meeting:
      type === 'meeting'
        ? { participants: [], audioFiles: [], transcript: '', analysis: null, sentLog: [] }
        : undefined
  }
}

export const fmtDate = (iso: string): string => {
  const d = new Date(iso)
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`
}

export const errMsg = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e)
  return m.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

export const splitList = (s: string): string[] =>
  s.split(',').map((x) => x.trim()).filter(Boolean)
