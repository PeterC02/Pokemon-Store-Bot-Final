/**
 * Profile CRUD + Settings — persisted via JSON file in app data dir.
 */

import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'

export interface Profile {
  id: string
  name: string
  proxy: string | null  // "ip:port:user:pass" or null for direct
  capsolverKey: string
  enabled: boolean
}

export interface Settings {
  serverUrl: string
  authToken: string
  username: string
  userId: number | null
  discordId: string
  capsolverKey: string
  discordWebhook: string
  soundEnabled: boolean
  autoLaunchOnQueue: boolean
}

const DEFAULT_SETTINGS: Settings = {
  serverUrl: '',
  authToken: '',
  username: '',
  userId: null,
  discordId: '',
  capsolverKey: '',
  discordWebhook: '',
  soundEnabled: true,
  autoLaunchOnQueue: true,
}

interface StoreData {
  profiles: Record<string, Profile>
  settings: Settings
}

export class ProfileStore {
  private filePath: string
  private data: StoreData

  constructor() {
    const dir = join(app.getPath('userData'), 'canary')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.filePath = join(dir, 'store.json')
    this.data = this.load()
  }

  private load(): StoreData {
    try {
      if (existsSync(this.filePath)) {
        const raw = readFileSync(this.filePath, 'utf-8')
        return JSON.parse(raw)
      }
    } catch {
      // Corrupted file — reset
    }
    return { profiles: {}, settings: { ...DEFAULT_SETTINGS } }
  }

  private persist(): void {
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8')
  }

  // --- Profiles ---

  getAll(): Profile[] {
    return Object.values(this.data.profiles)
  }

  get(id: string): Profile | undefined {
    return this.data.profiles[id]
  }

  save(profile: Profile): void {
    this.data.profiles[profile.id] = profile
    this.persist()
  }

  delete(id: string): void {
    delete this.data.profiles[id]
    this.persist()
  }

  // --- Settings ---

  getSettings(): Settings {
    return { ...DEFAULT_SETTINGS, ...this.data.settings }
  }

  saveSettings(settings: Partial<Settings>): void {
    this.data.settings = { ...this.data.settings, ...settings }
    this.persist()
  }

  isAuthenticated(): boolean {
    const s = this.getSettings()
    return !!(s.serverUrl && s.authToken)
  }
}
