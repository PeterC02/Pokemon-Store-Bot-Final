/**
 * Canary — Electron Main Process
 *
 * Creates a BaseWindow with:
 * - Dashboard panel (React WebContentsView) on the left
 * - Browser panels (WebContentsView per profile) on the right
 *
 * Manages WebSocket connection to detection server,
 * profile sessions, breacher logic, and notifications.
 */

import { app, BaseWindow, WebContentsView, session, ipcMain, Notification } from 'electron'
import { join } from 'path'
import { BrowserManager } from './browser-manager'
import { WSClient } from './ws-client'
import { ProfileStore } from './profiles'
import { Breacher } from './breacher'

let mainWindow: BaseWindow | null = null
let dashboardView: WebContentsView | null = null
let browserManager: BrowserManager | null = null
let wsClient: WSClient | null = null
let profileStore: ProfileStore | null = null
let breacher: Breacher | null = null

// Layout constants
const SIDEBAR_WIDTH = 400
const MIN_WINDOW_WIDTH = 1200
const MIN_WINDOW_HEIGHT = 800

function createWindow(): void {
  mainWindow = new BaseWindow({
    width: MIN_WINDOW_WIDTH,
    height: MIN_WINDOW_HEIGHT,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    title: 'Canary',
    show: false,
  })

  // Dashboard panel — React app
  dashboardView = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  mainWindow.contentView.addChildView(dashboardView)

  // Load the React renderer
  if (process.env.ELECTRON_RENDERER_URL) {
    dashboardView.webContents.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    dashboardView.webContents.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Layout on resize
  const updateLayout = () => {
    if (!mainWindow || !dashboardView) return
    const { width, height } = mainWindow.getBounds()

    // Dashboard takes left SIDEBAR_WIDTH
    dashboardView.setBounds({
      x: 0,
      y: 0,
      width: SIDEBAR_WIDTH,
      height,
    })

    // Browser manager handles right-side layout
    if (browserManager) {
      browserManager.updateLayout(SIDEBAR_WIDTH, 0, width - SIDEBAR_WIDTH, height)
    }
  }

  mainWindow.on('resize', updateLayout)

  // BaseWindow has no 'ready-to-show' — use webContents did-finish-load instead
  dashboardView.webContents.once('did-finish-load', () => {
    updateLayout()
    mainWindow!.show()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    dashboardView = null
  })

  // Initialise subsystems
  profileStore = new ProfileStore()
  browserManager = new BrowserManager(mainWindow)
  breacher = new Breacher(browserManager, profileStore)
  wsClient = new WSClient(profileStore)

  // Wire up WS signals to breacher + dashboard
  wsClient.on('signal', (signal) => {
    // Forward to dashboard renderer
    dashboardView?.webContents.send('signal', signal)

    // If critical (queue live) → trigger breacher on all profiles
    if (signal.alert_level === 'critical') {
      breacher?.onQueueDetected(signal)
    }
  })

  wsClient.on('status', (status) => {
    dashboardView?.webContents.send('status', status)
  })

  wsClient.on('connected', () => {
    dashboardView?.webContents.send('ws-state', 'connected')
  })

  wsClient.on('disconnected', () => {
    dashboardView?.webContents.send('ws-state', 'disconnected')
  })
}


// ---------------------------------------------------------------------------
// IPC handlers — renderer ↔ main process
// ---------------------------------------------------------------------------

function registerIPC(): void {
  // --- Profiles ---
  ipcMain.handle('profiles:list', () => profileStore!.getAll())
  ipcMain.handle('profiles:get', (_e, id: string) => profileStore!.get(id))
  ipcMain.handle('profiles:save', (_e, profile) => {
    profileStore!.save(profile)
    return profileStore!.getAll()
  })
  ipcMain.handle('profiles:delete', (_e, id: string) => {
    profileStore!.delete(id)
    browserManager?.destroyPanel(id)
    return profileStore!.getAll()
  })

  // --- Browser panels ---
  ipcMain.handle('browser:launch', async (_e, profileId: string) => {
    if (!mainWindow || !browserManager) return { ok: false }
    const profile = profileStore!.get(profileId)
    if (!profile) return { ok: false, error: 'Profile not found' }
    await browserManager.createPanel(profile)
    // Trigger layout update
    const { width, height } = mainWindow.getBounds()
    browserManager.updateLayout(SIDEBAR_WIDTH, 0, width - SIDEBAR_WIDTH, height)
    return { ok: true }
  })

  ipcMain.handle('browser:close', (_e, profileId: string) => {
    browserManager?.destroyPanel(profileId)
    if (mainWindow) {
      const { width, height } = mainWindow.getBounds()
      browserManager?.updateLayout(SIDEBAR_WIDTH, 0, width - SIDEBAR_WIDTH, height)
    }
    return { ok: true }
  })

  ipcMain.handle('browser:navigate', async (_e, profileId: string, url: string) => {
    return browserManager?.navigatePanel(profileId, url) ?? false
  })

  // --- Settings ---
  ipcMain.handle('settings:get', () => profileStore!.getSettings())
  ipcMain.handle('settings:save', (_e, partial: Record<string, unknown>) => {
    // Merge — never allow renderer to wipe auth fields accidentally
    const current = profileStore!.getSettings()
    const merged = { ...current, ...partial }
    // Protect auth fields from being set to empty by the settings page
    if (!partial.serverUrl) merged.serverUrl = current.serverUrl
    if (!partial.authToken) merged.authToken = current.authToken
    if (!partial.username) merged.username = current.username
    if (partial.userId === undefined) merged.userId = current.userId
    profileStore!.saveSettings(merged)
    // Reconnect WS if server URL changed
    if (partial.serverUrl && partial.serverUrl !== current.serverUrl) {
      wsClient?.reconnect()
    }
    return profileStore!.getSettings()
  })

  // --- Auth ---
  ipcMain.handle('auth:login', async (_e, serverUrl: string, username: string, password: string) => {
    try {
      const resp = await fetch(`${serverUrl}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (!resp.ok) {
        const err = await resp.json()
        return { ok: false, error: err.detail || 'Login failed' }
      }
      const data = await resp.json()
      // Save token + server URL
      profileStore!.saveSettings({
        ...profileStore!.getSettings(),
        serverUrl,
        authToken: data.access_token,
        username: data.user.username,
        userId: data.user.id,
      })
      // Connect WS
      wsClient?.connect()
      return { ok: true, user: data.user }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  ipcMain.handle('auth:register', async (_e, serverUrl: string, username: string, password: string, inviteCode: string) => {
    try {
      const resp = await fetch(`${serverUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, invite_code: inviteCode }),
      })
      if (!resp.ok) {
        const err = await resp.json()
        return { ok: false, error: err.detail || 'Registration failed' }
      }
      const data = await resp.json()
      profileStore!.saveSettings({
        ...profileStore!.getSettings(),
        serverUrl,
        authToken: data.access_token,
        username: data.user.username,
        userId: data.user.id,
      })
      wsClient?.connect()
      return { ok: true, user: data.user }
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  // --- Discord OAuth ---
  ipcMain.handle('auth:discord', async () => {
    try {
      const settings = profileStore!.getSettings()
      const serverUrl = (settings.serverUrl || 'https://api.canary.heuricity.com').replace(/\/$/, '')

      // Open Discord OAuth in the user's default browser via the server's redirect endpoint
      // The server handles: Discord OAuth → get user ID → create/find user → return token
      // We use a local callback approach: the server redirects to a localhost URL with the token
      const { BrowserWindow } = await import('electron')
      const authWin = new BrowserWindow({
        width: 500,
        height: 700,
        title: 'Sign in with Discord',
        webPreferences: { nodeIntegration: false, contextIsolation: true },
      })

      const authUrl = `${serverUrl}/api/auth/discord/desktop`

      return new Promise((resolve) => {
        authWin.loadURL(authUrl)

        // Listen for the redirect back with token
        authWin.webContents.on('will-redirect', (_event, url) => {
          try {
            const parsed = new URL(url)
            const token = parsed.searchParams.get('token')
            const username = parsed.searchParams.get('username')
            const userId = parsed.searchParams.get('user_id')
            const discordId = parsed.searchParams.get('discord_id')

            if (token) {
              profileStore!.saveSettings({
                ...profileStore!.getSettings(),
                serverUrl,
                authToken: token,
                username: username || 'Discord User',
                userId: parseInt(userId || '0', 10),
                discordId: discordId || '',
              })
              wsClient?.connect()
              authWin.close()
              resolve({ ok: true, user: { username, id: userId } })
            }
          } catch { /* not our redirect yet */ }
        })

        // Also check URL changes (some OAuth flows use navigation, not redirect)
        authWin.webContents.on('did-navigate', (_event, url) => {
          try {
            const parsed = new URL(url)
            const token = parsed.searchParams.get('token')
            const username = parsed.searchParams.get('username')
            const userId = parsed.searchParams.get('user_id')
            const discordId = parsed.searchParams.get('discord_id')

            if (token) {
              profileStore!.saveSettings({
                ...profileStore!.getSettings(),
                serverUrl,
                authToken: token,
                username: username || 'Discord User',
                userId: parseInt(userId || '0', 10),
                discordId: discordId || '',
              })
              wsClient?.connect()
              authWin.close()
              resolve({ ok: true, user: { username, id: userId } })
            }
          } catch { /* not our redirect yet */ }
        })

        authWin.on('closed', () => {
          resolve({ ok: false, error: 'Login window closed' })
        })
      })
    } catch (e: any) {
      return { ok: false, error: e.message }
    }
  })

  // --- Subscription Check ---
  ipcMain.handle('auth:check-subscription', async () => {
    const settings = profileStore!.getSettings()
    if (!settings.serverUrl || !settings.authToken) return { active: false }
    try {
      const discordId = settings.discordId || ''
      if (!discordId) return { active: false }
      const resp = await fetch(
        `${settings.serverUrl}/api/subscriptions/check?user_discord_id=${discordId}&guild_id=`,
        { headers: { Authorization: `Bearer ${settings.authToken}` } },
      )
      if (!resp.ok) return { active: false }
      return await resp.json()
    } catch {
      return { active: false }
    }
  })

  // --- WS ---
  ipcMain.handle('ws:status', () => wsClient?.getState() ?? 'disconnected')
  ipcMain.handle('ws:connect', () => { wsClient?.connect(); return true })

  // --- Signals ---
  ipcMain.handle('signals:history', async () => {
    const settings = profileStore!.getSettings()
    if (!settings.serverUrl || !settings.authToken) return []
    try {
      const resp = await fetch(`${settings.serverUrl}/api/signals?limit=50`, {
        headers: { Authorization: `Bearer ${settings.authToken}` },
      })
      if (!resp.ok) return []
      return await resp.json()
    } catch {
      return []
    }
  })
}


// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(() => {
  registerIPC()
  createWindow()

  // Auto-connect WS if we have saved credentials
  const settings = profileStore?.getSettings()
  if (settings?.serverUrl && settings?.authToken) {
    wsClient?.connect()
  }
})

app.on('window-all-closed', () => {
  wsClient?.disconnect()
  app.quit()
})
