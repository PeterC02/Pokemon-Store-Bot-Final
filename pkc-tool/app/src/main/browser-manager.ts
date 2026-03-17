/**
 * Browser Manager — creates/destroys WebContentsView panels for profiles.
 *
 * Each profile gets its own:
 * - WebContentsView (embedded browser panel)
 * - session.fromPartition() (isolated cookies, storage)
 * - Proxy configuration via ses.setProxy()
 */

import { BaseWindow, WebContentsView, session } from 'electron'
import type { Profile } from './profiles'

interface PanelInfo {
  view: WebContentsView
  profileId: string
  partitionName: string
}

export class BrowserManager {
  private window: BaseWindow
  private panels: Map<string, PanelInfo> = new Map()

  constructor(window: BaseWindow) {
    this.window = window
  }

  /**
   * Create an embedded browser panel for a profile.
   */
  async createPanel(profile: Profile): Promise<WebContentsView> {
    // Destroy existing if any
    if (this.panels.has(profile.id)) {
      this.destroyPanel(profile.id)
    }

    const partitionName = `persist:profile-${profile.id}`
    const ses = session.fromPartition(partitionName)

    // Set proxy if configured
    if (profile.proxy) {
      const parts = profile.proxy.split(':')
      if (parts.length >= 2) {
        const [host, port, user, pass] = parts
        const proxyUrl = user && pass
          ? `http://${user}:${pass}@${host}:${port}`
          : `http://${host}:${port}`
        await ses.setProxy({ proxyRules: proxyUrl })
      }
    }

    const view = new WebContentsView({
      webPreferences: {
        session: ses,
        contextIsolation: true,
        nodeIntegration: false,
        // Allow the real PKC site to run its JS (DataDome tags.js, etc.)
        webSecurity: true,
      },
    })

    this.window.contentView.addChildView(view)
    this.panels.set(profile.id, { view, profileId: profile.id, partitionName })

    // Load a blank page initially
    view.webContents.loadURL('about:blank')

    return view
  }

  /**
   * Destroy a browser panel and clean up.
   */
  destroyPanel(profileId: string): void {
    const panel = this.panels.get(profileId)
    if (!panel) return

    try {
      this.window.contentView.removeChildView(panel.view)
      // WebContentsView doesn't have a destroy method, but removing it is sufficient
      ;(panel.view.webContents as any).close?.()
    } catch {
      // View may already be destroyed
    }
    this.panels.delete(profileId)
  }

  /**
   * Navigate a specific panel to a URL.
   */
  async navigatePanel(profileId: string, url: string): Promise<boolean> {
    const panel = this.panels.get(profileId)
    if (!panel) return false
    try {
      await panel.view.webContents.loadURL(url)
      return true
    } catch {
      return false
    }
  }

  /**
   * Execute JavaScript in a panel's webContents.
   */
  async executeInPanel(profileId: string, code: string): Promise<any> {
    const panel = this.panels.get(profileId)
    if (!panel) return null
    return panel.view.webContents.executeJavaScript(code)
  }

  /**
   * Get the current URL of a panel.
   */
  getPanelUrl(profileId: string): string | null {
    const panel = this.panels.get(profileId)
    if (!panel) return null
    return panel.view.webContents.getURL()
  }

  /**
   * Get page HTML content from a panel.
   */
  async getPanelHtml(profileId: string): Promise<string | null> {
    const panel = this.panels.get(profileId)
    if (!panel) return null
    return panel.view.webContents.executeJavaScript('document.documentElement.outerHTML')
  }

  /**
   * Get the WebContentsView for a profile.
   */
  getPanel(profileId: string): WebContentsView | null {
    return this.panels.get(profileId)?.view ?? null
  }

  /**
   * Get all active panel profile IDs.
   */
  getActivePanelIds(): string[] {
    return Array.from(this.panels.keys())
  }

  /**
   * Update layout of all browser panels.
   * Tiles them evenly in the available space.
   */
  updateLayout(x: number, y: number, width: number, height: number): void {
    const ids = this.getActivePanelIds()
    if (ids.length === 0) return

    // Grid layout: stack vertically if 1-2 panels, 2-column grid if 3+
    const cols = ids.length <= 2 ? 1 : 2
    const rows = Math.ceil(ids.length / cols)
    const panelWidth = Math.floor(width / cols)
    const panelHeight = Math.floor(height / rows)

    ids.forEach((id, i) => {
      const panel = this.panels.get(id)
      if (!panel) return

      const col = i % cols
      const row = Math.floor(i / cols)

      panel.view.setBounds({
        x: x + col * panelWidth,
        y: y + row * panelHeight,
        width: panelWidth,
        height: panelHeight,
      })
    })
  }

  /**
   * Navigate all panels to a URL (used when queue is detected).
   */
  async navigateAll(url: string): Promise<void> {
    const promises = Array.from(this.panels.keys()).map(id =>
      this.navigatePanel(id, url)
    )
    await Promise.allSettled(promises)
  }

  /**
   * Destroy all panels.
   */
  destroyAll(): void {
    for (const id of Array.from(this.panels.keys())) {
      this.destroyPanel(id)
    }
  }
}
