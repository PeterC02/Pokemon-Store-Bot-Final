/**
 * Breacher — Imperva bypass logic for each browser panel.
 *
 * When a queue signal fires:
 * 1. Navigate all panels to PKC homepage
 * 2. Read page HTML to classify state
 * 3. If challenge (edet=12) → auto-solve reese84 via CapSolver + executeJavaScript
 * 4. If hCaptcha → bring panel to front, alarm for user to solve
 * 5. If queue → user is in queue, wait
 * 6. After queue passes → auto-navigate to target product URL
 */

import { Notification, shell } from 'electron'
import type { BrowserManager } from './browser-manager'
import type { ProfileStore } from './profiles'

const PKC_HOMEPAGE = 'https://www.pokemoncenter.com/en-gb'

interface BreachState {
  profileId: string
  state: 'idle' | 'navigating' | 'solving_reese' | 'waiting_captcha' | 'in_queue' | 'passed' | 'error'
  targetProductUrl: string | null
}

export class Breacher {
  private browserManager: BrowserManager
  private profileStore: ProfileStore
  private states: Map<string, BreachState> = new Map()
  private targetProductUrl: string | null = null

  constructor(browserManager: BrowserManager, profileStore: ProfileStore) {
    this.browserManager = browserManager
    this.profileStore = profileStore
  }

  /**
   * Called when detection server sends a CRITICAL signal (queue is live).
   */
  async onQueueDetected(signal: any): Promise<void> {
    console.log('[Breacher] Queue detected! Launching all profiles...')

    // Extract target product URL from signal if available
    if (signal.detected_urls?.length > 0) {
      this.targetProductUrl = signal.detected_urls[0]
    }

    // Show notification
    new Notification({
      title: '🔴 PKC Queue is LIVE!',
      body: 'Auto-launching all profiles...',
      urgency: 'critical',
    }).show()

    // Launch all enabled profiles
    const profiles = this.profileStore.getAll().filter(p => p.enabled)
    if (profiles.length === 0) {
      console.log('[Breacher] No enabled profiles — nothing to launch')
      return
    }

    for (const profile of profiles) {
      // Create panel if not already open
      if (!this.browserManager.getPanel(profile.id)) {
        await this.browserManager.createPanel(profile)
      }

      this.states.set(profile.id, {
        profileId: profile.id,
        state: 'navigating',
        targetProductUrl: this.targetProductUrl,
      })
    }

    // Update layout
    // (Layout update will be triggered by the main process)

    // Navigate all panels to PKC
    await this.browserManager.navigateAll(PKC_HOMEPAGE)

    // After navigation, classify each panel's state
    // Wait a moment for pages to load
    setTimeout(() => this.classifyAllPanels(), 3000)
  }

  /**
   * Classify the state of all active browser panels.
   */
  private async classifyAllPanels(): Promise<void> {
    const ids = this.browserManager.getActivePanelIds()

    for (const id of ids) {
      await this.classifyPanel(id)
    }
  }

  /**
   * Classify a single panel's page state and take action.
   */
  private async classifyPanel(profileId: string): Promise<void> {
    const html = await this.browserManager.getPanelHtml(profileId)
    if (!html) return

    const state = this.classifyHtml(html)
    console.log(`[Breacher] Profile ${profileId}: ${state}`)

    const breachState = this.states.get(profileId)
    if (!breachState) return

    switch (state) {
      case 'queue':
        breachState.state = 'in_queue'
        new Notification({
          title: `✅ Profile in Queue`,
          body: `Profile is waiting in the queue`,
        }).show()
        // Monitor for queue pass
        this.monitorQueuePass(profileId)
        break

      case 'challenge':
        breachState.state = 'solving_reese'
        await this.solveReese84(profileId)
        break

      case 'hcaptcha':
        breachState.state = 'waiting_captcha'
        new Notification({
          title: '⚠️ Solve CAPTCHA NOW',
          body: `hCaptcha detected — solve it in the app`,
          urgency: 'critical',
        }).show()
        this.playAlarm(profileId)
        break

      case 'normal':
        breachState.state = 'passed'
        // Site is open — navigate to product
        if (breachState.targetProductUrl) {
          await this.browserManager.navigatePanel(profileId, breachState.targetProductUrl)
        }
        break

      default:
        breachState.state = 'error'
        console.log(`[Breacher] Profile ${profileId}: unknown state`)
    }
  }

  /**
   * Classify HTML into a page state.
   */
  private classifyHtml(html: string): string {
    if (html.includes('edet=47') || html.includes('WaitingRoom') || html.includes('wrid=')) {
      return 'queue'
    }
    if (html.includes('h-captcha') || html.includes('hcaptcha')) {
      return 'hcaptcha'
    }
    if (html.includes('_Incapsula_Resource') || html.includes('edet=12')) {
      return 'challenge'
    }
    if (html.includes('__NEXT_DATA__')) {
      return 'normal'
    }
    return 'unknown'
  }

  /**
   * Solve the Imperva reese84 challenge via CapSolver.
   */
  private async solveReese84(profileId: string): Promise<void> {
    const settings = this.profileStore.getSettings()
    const profile = this.profileStore.get(profileId)
    // Per-profile key takes priority, fall back to global
    const capsolverKey = profile?.capsolverKey || settings.capsolverKey
    if (!capsolverKey) {
      console.log('[Breacher] No CapSolver key — cannot auto-solve reese84')
      return
    }

    console.log(`[Breacher] Solving reese84 for profile ${profileId}...`)

    try {
      // Step 1: Extract the reese84 script URL from the page
      const reese84Url = await this.browserManager.executeInPanel(profileId, `
        (() => {
          const scripts = document.querySelectorAll('script[src]');
          for (const s of scripts) {
            if (s.src && s.src.includes('reese84')) return s.src;
          }
          // Also check for inline reese reference
          const html = document.documentElement.outerHTML;
          const match = html.match(/src="([^"]*reese84[^"]*)"/);
          return match ? match[1] : null;
        })()
      `)

      if (!reese84Url) {
        console.log('[Breacher] Could not find reese84 script URL')
        // Fall through — might be a different challenge type
        return
      }

      // Step 2: Fetch the reese84 script source
      const scriptResp = await fetch(reese84Url)
      const scriptSource = await scriptResp.text()

      // Step 3: Send to CapSolver
      const taskResp = await fetch('https://api.capsolver.com/createTask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientKey: capsolverKey,
          task: {
            type: 'AntiImpervaTaskProxyLess',
            websiteUrl: PKC_HOMEPAGE,
            reese84Url: reese84Url,
            reese84Script: scriptSource,
          },
        }),
      })
      const taskData = await taskResp.json() as any

      if (taskData.errorId) {
        console.error('[Breacher] CapSolver createTask error:', taskData.errorDescription)
        return
      }

      const taskId = taskData.taskId
      console.log(`[Breacher] CapSolver task ${taskId} created, polling...`)

      // Step 4: Poll for result
      let payload: string | null = null
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 2000))
        const resultResp = await fetch('https://api.capsolver.com/getTaskResult', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientKey: capsolverKey, taskId }),
        })
        const result = await resultResp.json() as any

        if (result.status === 'ready') {
          payload = result.solution?.reese84Payload
          break
        } else if (result.errorId) {
          console.error('[Breacher] CapSolver error:', result.errorDescription)
          return
        }
      }

      if (!payload) {
        console.error('[Breacher] CapSolver timeout — no payload received')
        return
      }

      // Step 5: POST the payload via browser fetch() (same IP/TLS = valid cookie)
      console.log(`[Breacher] Posting reese84 payload via browser fetch...`)
      const postUrl = reese84Url.replace(/\?.*/, '') // Strip query params for POST
      await this.browserManager.executeInPanel(profileId, `
        fetch("${postUrl}", {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: ${JSON.stringify(payload)},
          credentials: "include"
        }).then(r => r.text())
      `)

      // Step 6: Reload and re-classify
      console.log(`[Breacher] Reloading page after reese84 solve...`)
      await this.browserManager.navigatePanel(profileId, PKC_HOMEPAGE)

      // Re-classify after a short delay
      setTimeout(() => this.classifyPanel(profileId), 2000)

    } catch (e: any) {
      console.error(`[Breacher] reese84 solve error: ${e.message}`)
    }
  }

  /**
   * Monitor a panel that's in queue, detect when it passes through.
   */
  private monitorQueuePass(profileId: string): void {
    const interval = setInterval(async () => {
      const state = this.states.get(profileId)
      if (!state || state.state !== 'in_queue') {
        clearInterval(interval)
        return
      }

      const url = this.browserManager.getPanelUrl(profileId)
      // When queue passes, Imperva redirects to the real site (URL changes from _Incapsula_Resource)
      if (url && !url.includes('_Incapsula_Resource') && !url.includes('about:blank')) {
        console.log(`[Breacher] Profile ${profileId}: Queue passed! URL: ${url}`)
        state.state = 'passed'
        clearInterval(interval)

        new Notification({
          title: '🎉 Queue Passed!',
          body: 'Navigating to product page...',
          urgency: 'critical',
        }).show()

        // Auto-navigate to product
        if (state.targetProductUrl) {
          await this.browserManager.navigatePanel(profileId, state.targetProductUrl)
        }
      }
    }, 3000) // Check every 3 seconds
  }

  /**
   * Play an alarm sound to alert the user about hCaptcha.
   * Beeps repeatedly until the captcha state changes.
   */
  private playAlarm(profileId: string): void {
    const settings = this.profileStore.getSettings()
    if (!settings.soundEnabled) return

    let count = 0
    const maxBeeps = 20  // ~20 seconds of beeping
    const interval = setInterval(() => {
      const state = this.states.get(profileId)
      if (!state || state.state !== 'waiting_captcha' || count >= maxBeeps) {
        clearInterval(interval)
        return
      }
      shell.beep()
      count++
    }, 1000)
  }

  /**
   * Set the target product URL (from detection signals).
   */
  setTargetProduct(url: string): void {
    this.targetProductUrl = url
    // Update all active states
    for (const state of this.states.values()) {
      state.targetProductUrl = url
    }
  }
}
