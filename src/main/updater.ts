import { app, BrowserWindow, shell } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateStatus } from '../shared/types'

/**
 * 자동 업데이트.
 * - Windows: 새 버전을 뒤에서 받아 두고, "지금 재시작"을 누르거나 프로그램을 끌 때 설치.
 * - Mac: 코드 서명이 없으면 자동 설치가 안 되므로 새 버전 알림 + 다운로드 페이지 열기.
 */
const RELEASES = 'https://github.com/algns6188-afk/hoonssi-note/releases/latest'
let status: UpdateStatus = { state: 'idle', version: null, percent: 0, message: null }

function set(patch: Partial<UpdateStatus>): void {
  status = { ...status, ...patch }
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('update:status', status)
}

export function getUpdateStatus(): UpdateStatus {
  return status
}

export async function checkForUpdates(): Promise<UpdateStatus> {
  if (!app.isPackaged) {
    set({ state: 'none', message: '개발 모드에서는 업데이트를 확인하지 않습니다.' })
    return status
  }
  try {
    set({ state: 'checking', message: null })
    await autoUpdater.checkForUpdates()
  } catch (e) {
    set({ state: 'error', message: e instanceof Error ? e.message : String(e) })
  }
  return status
}

export function installUpdate(): void {
  if (process.platform === 'darwin') shell.openExternal(RELEASES)
  else autoUpdater.quitAndInstall(false, true)
}

export function initUpdater(): void {
  if (!app.isPackaged) return
  const mac = process.platform === 'darwin'
  autoUpdater.autoDownload = !mac
  autoUpdater.autoInstallOnAppQuit = !mac

  autoUpdater.on('update-available', (info) =>
    set({ state: mac ? 'ready' : 'downloading', version: info.version, percent: 0 })
  )
  autoUpdater.on('update-not-available', () => set({ state: 'none' }))
  autoUpdater.on('download-progress', (p) => set({ state: 'downloading', percent: Math.round(p.percent) }))
  autoUpdater.on('update-downloaded', (info) => set({ state: 'ready', version: info.version, percent: 100 }))
  autoUpdater.on('error', (e) => set({ state: 'error', message: e?.message ?? String(e) }))

  // 켤 때 한 번, 그 뒤로 1시간마다 확인
  setTimeout(() => checkForUpdates(), 10_000)
  setInterval(() => checkForUpdates(), 60 * 60 * 1000)
}
