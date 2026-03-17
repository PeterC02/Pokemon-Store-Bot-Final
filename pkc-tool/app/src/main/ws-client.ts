/**
 * WebSocket Client — connects to the central detection server.
 *
 * Receives signals and status updates, emits events for the main process.
 */

import WebSocket from 'ws'
import { EventEmitter } from 'events'
import type { ProfileStore } from './profiles'

const RECONNECT_DELAY_MS = 3000
const PING_INTERVAL_MS = 30000

export class WSClient extends EventEmitter {
  private ws: WebSocket | null = null
  private profileStore: ProfileStore
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private intentionalClose = false

  constructor(profileStore: ProfileStore) {
    super()
    this.profileStore = profileStore
  }

  connect(): void {
    this.intentionalClose = false
    const settings = this.profileStore.getSettings()
    if (!settings.serverUrl || !settings.authToken) {
      console.log('[WS] No server URL or auth token — skipping connect')
      return
    }

    // Build WS URL
    const httpUrl = settings.serverUrl.replace(/\/$/, '')
    const wsUrl = httpUrl.replace(/^http/, 'ws') + `/ws?token=${settings.authToken}`

    console.log(`[WS] Connecting to ${httpUrl}...`)

    try {
      this.ws = new WebSocket(wsUrl)
    } catch (e) {
      console.error('[WS] Failed to create WebSocket:', e)
      this.scheduleReconnect()
      return
    }

    this.ws.on('open', () => {
      console.log('[WS] Connected')
      this.emit('connected')
      this.startPing()
    })

    this.ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'signal') {
          this.emit('signal', msg.data)
        } else if (msg.type === 'status') {
          this.emit('status', msg.data)
        } else if (msg.type === 'pong') {
          // heartbeat response
        }
      } catch (e) {
        console.error('[WS] Failed to parse message:', e)
      }
    })

    this.ws.on('close', (code: number, reason: Buffer) => {
      console.log(`[WS] Disconnected (code=${code})`)
      this.stopPing()
      this.emit('disconnected')
      if (!this.intentionalClose) {
        this.scheduleReconnect()
      }
    })

    this.ws.on('error', (err: Error) => {
      console.error('[WS] Error:', err.message)
    })
  }

  disconnect(): void {
    this.intentionalClose = true
    this.stopPing()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.close()
      this.ws = null
    }
    this.emit('disconnected')
  }

  reconnect(): void {
    this.disconnect()
    setTimeout(() => this.connect(), 500)
  }

  getState(): string {
    if (!this.ws) return 'disconnected'
    switch (this.ws.readyState) {
      case WebSocket.CONNECTING: return 'connecting'
      case WebSocket.OPEN: return 'connected'
      case WebSocket.CLOSING: return 'disconnecting'
      case WebSocket.CLOSED: return 'disconnected'
      default: return 'unknown'
    }
  }

  private startPing(): void {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send('ping')
      }
    }, PING_INTERVAL_MS)
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    console.log(`[WS] Reconnecting in ${RECONNECT_DELAY_MS}ms...`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, RECONNECT_DELAY_MS)
  }
}
