import { contextBridge, ipcRenderer } from 'electron'
import type { HoonssiApi, SyncStatus, UpdateStatus } from '../shared/types'

const api: HoonssiApi = {
  listNotes: () => ipcRenderer.invoke('notes:list'),
  saveNote: (n) => ipcRenderer.invoke('notes:save', n),
  deleteNote: (id) => ipcRenderer.invoke('notes:delete', id),
  listTasks: () => ipcRenderer.invoke('tasks:list'),
  saveTask: (t) => ipcRenderer.invoke('tasks:save', t),
  deleteTask: (id) => ipcRenderer.invoke('tasks:delete', id),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  saveAudio: (noteId, index, data) => ipcRenderer.invoke('audio:save', noteId, index, data),
  transcribe: (noteId) => ipcRenderer.invoke('meeting:transcribe', noteId),
  analyze: (noteId) => ipcRenderer.invoke('meeting:analyze', noteId),
  send: (noteId, channels) => ipcRenderer.invoke('meeting:send', noteId, channels),
  testChannel: (c) => ipcRenderer.invoke('channel:test', c),
  listAthletes: () => ipcRenderer.invoke('athletes:list'),
  saveAthlete: (a) => ipcRenderer.invoke('athletes:save', a),
  deleteAthlete: (id) => ipcRenderer.invoke('athletes:delete', id),
  listGrowthRecords: (athleteId) => ipcRenderer.invoke('growth:list', athleteId),
  saveGrowthRecord: (r) => ipcRenderer.invoke('growth:save', r),
  savePdf: (html, name) => ipcRenderer.invoke('pdf:save', html, name),
  syncStatus: () => ipcRenderer.invoke('sync:status'),
  syncSignIn: (email, pw) => ipcRenderer.invoke('sync:signIn', email, pw),
  syncSignOut: () => ipcRenderer.invoke('sync:signOut'),
  syncNow: () => ipcRenderer.invoke('sync:now'),
  onSyncStatus: (cb) => {
    const h = (_e: unknown, s: SyncStatus): void => cb(s)
    ipcRenderer.on('sync:status', h)
    return () => ipcRenderer.removeListener('sync:status', h)
  },
  appVersion: () => ipcRenderer.invoke('app:version'),
  updateStatus: () => ipcRenderer.invoke('update:status'),
  checkForUpdates: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateStatus: (cb) => {
    const h = (_e: unknown, s: UpdateStatus): void => cb(s)
    ipcRenderer.on('update:status', h)
    return () => ipcRenderer.removeListener('update:status', h)
  },
  onDataChanged: (cb) => {
    const h = (): void => cb()
    ipcRenderer.on('data:changed', h)
    return () => ipcRenderer.removeListener('data:changed', h)
  }
}

contextBridge.exposeInMainWorld('api', api)
