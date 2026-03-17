/**
 * Preload script — secure IPC bridge between renderer and main process.
 */

import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  // Profiles
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  getProfile: (id: string) => ipcRenderer.invoke('profiles:get', id),
  saveProfile: (profile: any) => ipcRenderer.invoke('profiles:save', profile),
  deleteProfile: (id: string) => ipcRenderer.invoke('profiles:delete', id),

  // Browser panels
  launchBrowser: (profileId: string) => ipcRenderer.invoke('browser:launch', profileId),
  closeBrowser: (profileId: string) => ipcRenderer.invoke('browser:close', profileId),
  navigateBrowser: (profileId: string, url: string) => ipcRenderer.invoke('browser:navigate', profileId, url),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (settings: any) => ipcRenderer.invoke('settings:save', settings),

  // Auth
  login: (serverUrl: string, username: string, password: string) =>
    ipcRenderer.invoke('auth:login', serverUrl, username, password),
  register: (serverUrl: string, username: string, password: string, inviteCode: string) =>
    ipcRenderer.invoke('auth:register', serverUrl, username, password, inviteCode),
  loginWithDiscord: () => ipcRenderer.invoke('auth:discord'),
  checkSubscription: () => ipcRenderer.invoke('auth:check-subscription'),

  // WebSocket
  wsStatus: () => ipcRenderer.invoke('ws:status'),
  wsConnect: () => ipcRenderer.invoke('ws:connect'),

  // Signals
  getSignalHistory: () => ipcRenderer.invoke('signals:history'),

  // Event listeners (main → renderer)
  onSignal: (callback: (signal: any) => void) => {
    ipcRenderer.on('signal', (_e, signal) => callback(signal))
  },
  onStatus: (callback: (status: any) => void) => {
    ipcRenderer.on('status', (_e, status) => callback(status))
  },
  onWsState: (callback: (state: string) => void) => {
    ipcRenderer.on('ws-state', (_e, state) => callback(state))
  },
})
