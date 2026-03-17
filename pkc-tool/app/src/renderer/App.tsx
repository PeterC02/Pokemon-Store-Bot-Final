import React, { useState, useEffect, useCallback } from 'react'

declare global {
  interface Window {
    api: {
      listProfiles: () => Promise<any[]>
      getProfile: (id: string) => Promise<any>
      saveProfile: (profile: any) => Promise<any[]>
      deleteProfile: (id: string) => Promise<any[]>
      launchBrowser: (profileId: string) => Promise<{ ok: boolean; error?: string }>
      closeBrowser: (profileId: string) => Promise<{ ok: boolean }>
      navigateBrowser: (profileId: string, url: string) => Promise<boolean>
      getSettings: () => Promise<any>
      saveSettings: (settings: any) => Promise<any>
      login: (serverUrl: string, username: string, password: string) => Promise<{ ok: boolean; error?: string; user?: any }>
      register: (serverUrl: string, username: string, password: string, inviteCode: string) => Promise<{ ok: boolean; error?: string; user?: any }>
      loginWithDiscord: () => Promise<{ ok: boolean; error?: string; user?: any }>
      checkSubscription: () => Promise<{ active: boolean; tier?: string; expires_at?: string }>
      wsStatus: () => Promise<string>
      wsConnect: () => Promise<boolean>
      getSignalHistory: () => Promise<any[]>
      onSignal: (callback: (signal: any) => void) => void
      onStatus: (callback: (status: any) => void) => void
      onWsState: (callback: (state: string) => void) => void
    }
  }
}

type Page = 'feed' | 'profiles' | 'settings' | 'login'

export default function App() {
  const [page, setPage] = useState<Page>('feed')
  const [signals, setSignals] = useState<any[]>([])
  const [siteStatus, setSiteStatus] = useState<any>({})
  const [wsState, setWsState] = useState('disconnected')
  const [profiles, setProfiles] = useState<any[]>([])
  const [settings, setSettings] = useState<any>({})
  const [isAuthenticated, setIsAuthenticated] = useState(false)
  const [subscription, setSubscription] = useState<{ active: boolean; tier?: string } | null>(null)

  // Load initial data
  useEffect(() => {
    const init = async () => {
      const s = await window.api.getSettings()
      setSettings(s)
      setIsAuthenticated(!!(s.serverUrl && s.authToken))
      if (s.serverUrl && s.authToken) {
        setPage('feed')
        const history = await window.api.getSignalHistory()
        setSignals(history)
        const profs = await window.api.listProfiles()
        setProfiles(profs)
        const ws = await window.api.wsStatus()
        setWsState(ws)
        // Check subscription status
        try {
          const sub = await window.api.checkSubscription()
          setSubscription(sub)
        } catch { setSubscription({ active: false }) }
      } else {
        setPage('login')
      }
    }
    init()
  }, [])

  // Listen for real-time events from main process
  useEffect(() => {
    window.api.onSignal((signal: any) => {
      setSignals(prev => [signal, ...prev].slice(0, 200))
    })
    window.api.onStatus((status: any) => {
      setSiteStatus(status)
    })
    window.api.onWsState((state: string) => {
      setWsState(state)
    })
  }, [])

  if (!isAuthenticated && page !== 'login') {
    setPage('login')
  }

  return (
    <div className="h-screen flex flex-col bg-gray-950 text-gray-100 overflow-hidden select-none">
      {/* Header — Canary branding */}
      <header className="flex items-center justify-between px-4 py-2 bg-gray-900/80 border-b border-gray-800 shrink-0 backdrop-blur-sm app-drag">
        <div className="flex items-center gap-2 app-no-drag">
          <CanaryLogo />
          <span className="text-lg font-bold text-yellow-400 tracking-tight">Canary</span>
          <span className="text-[10px] text-gray-500 font-medium mt-0.5">by Heuricity</span>
        </div>
        <div className="flex items-center gap-3 app-no-drag">
          {subscription?.active && (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-yellow-400/10 text-yellow-400 border border-yellow-400/20">
              {subscription.tier === 'desktop' ? 'Desktop + Bot' : 'Bot'}
            </span>
          )}
          <StatusDot state={siteStatus.state || 'unknown'} />
          <WsDot state={wsState} />
        </div>
      </header>

      {page === 'login' ? (
        <LoginPage
          onLogin={(s: any) => {
            setSettings(s)
            setIsAuthenticated(true)
            setPage('feed')
            window.api.getSignalHistory().then(setSignals)
            window.api.listProfiles().then(setProfiles)
            window.api.checkSubscription?.().then(setSubscription).catch(() => {})
          }}
        />
      ) : (
        <div className="flex flex-1 overflow-hidden">
          {/* Sidebar nav */}
          <nav className="w-12 bg-gray-900 border-r border-gray-800 flex flex-col items-center py-3 gap-3 shrink-0">
            <NavBtn active={page === 'feed'} onClick={() => setPage('feed')} icon="feed" title="Live Feed" />
            <NavBtn active={page === 'profiles'} onClick={() => setPage('profiles')} icon="profiles" title="Profiles" />
            <NavBtn active={page === 'settings'} onClick={() => setPage('settings')} icon="settings" title="Settings" />
          </nav>

          {/* Content */}
          <main className="flex-1 overflow-y-auto p-4">
            {page === 'feed' && <FeedPage signals={signals} status={siteStatus} />}
            {page === 'profiles' && (
              <ProfilesPage
                profiles={profiles}
                onUpdate={async () => {
                  const p = await window.api.listProfiles()
                  setProfiles(p)
                }}
              />
            )}
            {page === 'settings' && (
              <SettingsPage
                settings={settings}
                subscription={subscription}
                onSave={async (s: any) => {
                  const updated = await window.api.saveSettings(s)
                  setSettings(updated)
                }}
                onLogout={() => {
                  setIsAuthenticated(false)
                  setSettings({})
                  setSubscription(null)
                  setPage('login')
                }}
              />
            )}
          </main>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function CanaryLogo() {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2C9.5 2 7.5 3.5 7 6C5 6 3 8 3 10.5C3 13 5 15 7 15.5V18C7 20 9 22 12 22C15 22 17 20 17 18V15.5C19 15 21 13 21 10.5C21 8 19 6 17 6C16.5 3.5 14.5 2 12 2Z" fill="#FACC15"/>
      <circle cx="10" cy="10" r="1.5" fill="#1C1917"/>
      <circle cx="14" cy="10" r="1.5" fill="#1C1917"/>
      <path d="M10 13.5C10 13.5 11 14.5 12 14.5C13 14.5 14 13.5 14 13.5" stroke="#1C1917" strokeWidth="1" strokeLinecap="round"/>
    </svg>
  )
}

function StatusDot({ state }: { state: string }) {
  const colors: Record<string, string> = {
    normal: 'bg-green-500',
    challenge: 'bg-yellow-500',
    queue: 'bg-red-500',
    maintenance: 'bg-orange-500',
    unknown: 'bg-gray-500',
  }
  return (
    <div className="flex items-center gap-1.5" title={`Site: ${state}`}>
      <div className={`w-2 h-2 rounded-full ${colors[state] || colors.unknown} animate-pulse`} />
      <span className="text-xs text-gray-400 uppercase">{state}</span>
    </div>
  )
}

function WsDot({ state }: { state: string }) {
  const connected = state === 'connected'
  return (
    <div className="flex items-center gap-1.5" title={`Server: ${state}`}>
      <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-400' : 'bg-red-400'}`} />
      <span className="text-xs text-gray-500">{connected ? 'Live' : 'Offline'}</span>
    </div>
  )
}

const NAV_ICONS: Record<string, string> = {
  feed: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-4 0h4',
  profiles: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z',
  settings: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
}

function NavBtn({ active, onClick, icon, title }: { active: boolean; onClick: () => void; icon: string; title: string }) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={`w-8 h-8 rounded-lg flex items-center justify-center transition-colors
        ${active ? 'bg-yellow-400 text-gray-950' : 'bg-gray-800 text-gray-400 hover:bg-gray-700'}`}
    >
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <path d={NAV_ICONS[icon] || NAV_ICONS.feed} />
      </svg>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

function LoginPage({ onLogin }: { onLogin: (settings: any) => void }) {
  const [mode, setMode] = useState<'discord' | 'manual'>('discord')
  const [serverUrl, setServerUrl] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [inviteCode, setInviteCode] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleDiscordLogin = async () => {
    setError('')
    setLoading(true)
    try {
      const result = await window.api.loginWithDiscord()
      if (result.ok) {
        const s = await window.api.getSettings()
        onLogin(s)
      } else {
        setError(result.error || 'Discord login failed')
      }
    } catch (e: any) {
      setError(e.message || 'Discord login failed')
    }
    setLoading(false)
  }

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    const url = serverUrl.replace(/\/$/, '')
    const result = await window.api.login(url, username, password)
    setLoading(false)

    if (result.ok) {
      const s = await window.api.getSettings()
      onLogin(s)
    } else {
      setError(result.error || 'Login failed')
    }
  }

  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="w-full max-w-sm">
        {/* Canary branding */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-yellow-400/10 border border-yellow-400/20 mb-4">
            <CanaryLogo />
          </div>
          <h1 className="text-2xl font-bold text-yellow-400 tracking-tight">Canary</h1>
          <p className="text-xs text-gray-500 mt-1">by Heuricity — early warning for Pokemon Center drops</p>
        </div>

        {mode === 'discord' ? (
          <>
            <button
              onClick={handleDiscordLogin}
              disabled={loading}
              className="w-full py-2.5 bg-[#5865F2] text-white font-semibold rounded-lg hover:bg-[#4752C4] disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
            >
              {loading ? (
                <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : (
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
                </svg>
              )}
              {loading ? 'Connecting...' : 'Sign in with Discord'}
            </button>

            <div className="relative my-6">
              <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-gray-800" /></div>
              <div className="relative flex justify-center text-xs"><span className="bg-gray-950 px-2 text-gray-600">or</span></div>
            </div>

            <button
              onClick={() => setMode('manual')}
              className="w-full py-2 bg-gray-800 text-gray-300 text-sm rounded-lg hover:bg-gray-700 transition-colors"
            >
              Manual server login
            </button>
          </>
        ) : (
          <>
            <form onSubmit={handleManualSubmit} className="space-y-3">
              <Input label="Server URL" value={serverUrl} onChange={setServerUrl} placeholder="https://api.canary.heuricity.com" />
              <Input label="Username" value={username} onChange={setUsername} />
              <Input label="Password" value={password} onChange={setPassword} type="password" />

              {error && <p className="text-red-400 text-sm">{error}</p>}

              <button
                type="submit"
                disabled={loading}
                className="w-full py-2 bg-yellow-400 text-gray-950 font-bold rounded-lg hover:bg-yellow-300 disabled:opacity-50 transition-colors"
              >
                {loading ? 'Connecting...' : 'Login'}
              </button>
            </form>

            <button
              onClick={() => setMode('discord')}
              className="mt-3 text-xs text-gray-500 hover:text-gray-300 transition-colors"
            >
              ← Back to Discord login
            </button>
          </>
        )}

        {error && mode === 'discord' && <p className="text-red-400 text-sm mt-3 text-center">{error}</p>}

        <p className="text-center text-[10px] text-gray-600 mt-6">
          Canary v1.0 — requires an active subscription
        </p>
      </div>
    </div>
  )
}

function FeedPage({ signals, status }: { signals: any[]; status: any }) {
  const levelColors: Record<string, string> = {
    info: 'border-green-900/50 bg-green-950/20',
    warning: 'border-yellow-900/50 bg-yellow-950/20',
    critical: 'border-red-900/50 bg-red-950/20',
  }

  const levelDots: Record<string, string> = {
    info: 'bg-green-400',
    warning: 'bg-yellow-400',
    critical: 'bg-red-400',
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold">Live Signal Feed</h2>
        <span className="text-xs text-gray-500">{signals.length} signals</span>
      </div>

      {signals.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-gray-600">
          <CanaryLogo />
          <p className="text-sm mt-4">Waiting for signals...</p>
          <p className="text-xs mt-1">Monitoring pokemoncenter.com in real-time</p>
        </div>
      ) : (
        <div className="space-y-2">
          {signals.map((s: any, i: number) => (
            <div
              key={s.id || i}
              className={`border rounded-lg p-3 ${levelColors[s.alert_level] || 'border-gray-800 bg-gray-900/50'}`}
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <div className={`w-1.5 h-1.5 rounded-full ${levelDots[s.alert_level] || 'bg-gray-500'}`} />
                  <span className="font-semibold text-sm">{s.title}</span>
                </div>
                <span className="text-[10px] text-gray-500 tabular-nums">
                  {s.timestamp ? new Date(s.timestamp).toLocaleTimeString() : ''}
                </span>
              </div>
              {s.detail && <p className="text-xs text-gray-400 ml-3.5">{s.detail}</p>}
              {s.detected_urls?.length > 0 && (
                <div className="mt-1 ml-3.5">
                  {(typeof s.detected_urls === 'string' ? JSON.parse(s.detected_urls) : s.detected_urls).map((url: string, j: number) => (
                    <p key={j} className="text-[11px] text-blue-400 truncate">{url}</p>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function ProfilesPage({ profiles, onUpdate }: { profiles: any[]; onUpdate: () => void }) {
  const [editId, setEditId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [proxy, setProxy] = useState('')
  const [capKey, setCapKey] = useState('')

  const startNew = () => {
    setEditId('new')
    setName('')
    setProxy('')
    setCapKey('')
  }

  const save = async () => {
    const id = editId === 'new' ? `p-${Date.now()}` : editId!
    await window.api.saveProfile({
      id,
      name: name || `Profile ${profiles.length + 1}`,
      proxy: proxy || null,
      capsolverKey: capKey,
      enabled: true,
    })
    setEditId(null)
    onUpdate()
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-bold">Browser Profiles</h2>
        <button
          onClick={startNew}
          className="px-3 py-1 bg-yellow-400 text-gray-950 text-sm font-bold rounded-lg hover:bg-yellow-300 transition-colors"
        >
          + New
        </button>
      </div>

      {editId && (
        <div className="border border-yellow-400/20 rounded-lg p-3 mb-3 bg-gray-900">
          <Input label="Name" value={name} onChange={setName} placeholder="Main" />
          <Input label="Proxy" value={proxy} onChange={setProxy} placeholder="ip:port:user:pass (optional)" />
          <Input label="CapSolver Key" value={capKey} onChange={setCapKey} placeholder="CAP-xxx" />
          <div className="flex gap-2 mt-2">
            <button onClick={save} className="px-3 py-1 bg-yellow-400 text-gray-950 text-sm font-semibold rounded-lg hover:bg-yellow-300">Save</button>
            <button onClick={() => setEditId(null)} className="px-3 py-1 bg-gray-800 text-gray-300 text-sm rounded-lg hover:bg-gray-700">Cancel</button>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {profiles.map((p: any) => (
          <div key={p.id} className="border border-gray-800 rounded-lg p-3 flex items-center justify-between bg-gray-900/50 hover:border-gray-700 transition-colors">
            <div>
              <span className="font-medium text-sm">{p.name}</span>
              <span className="text-xs text-gray-500 ml-2">{p.proxy || 'Direct'}</span>
            </div>
            <div className="flex gap-1.5">
              <button
                onClick={async () => { await window.api.launchBrowser(p.id) }}
                className="px-2.5 py-1 bg-yellow-400/10 text-yellow-400 text-xs font-medium rounded border border-yellow-400/20 hover:bg-yellow-400/20"
              >
                Launch
              </button>
              <button
                onClick={async () => { await window.api.closeBrowser(p.id) }}
                className="px-2.5 py-1 bg-gray-800 text-gray-400 text-xs rounded hover:bg-gray-700"
              >
                Close
              </button>
              <button
                onClick={async () => { await window.api.deleteProfile(p.id); onUpdate() }}
                className="px-2.5 py-1 bg-red-950/50 text-red-400 text-xs rounded border border-red-900/30 hover:bg-red-950"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
        {profiles.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 text-gray-600">
            <p className="text-sm">No profiles yet</p>
            <p className="text-xs mt-1">Create a browser profile to use auto-queue</p>
          </div>
        )}
      </div>
    </div>
  )
}

function SettingsPage({ settings, subscription, onSave, onLogout }: {
  settings: any
  subscription: { active: boolean; tier?: string } | null
  onSave: (s: any) => void
  onLogout: () => void
}) {
  const [capKey, setCapKey] = useState(settings.capsolverKey || '')
  const [discord, setDiscord] = useState(settings.discordWebhook || '')
  const [sound, setSound] = useState(settings.soundEnabled ?? true)
  const [autoLaunch, setAutoLaunch] = useState(settings.autoLaunchOnQueue ?? true)

  return (
    <div>
      <h2 className="text-lg font-bold mb-4">Settings</h2>
      <div className="space-y-4 max-w-md">
        {/* Account info */}
        <div className="rounded-lg border border-gray-800 bg-gray-900/50 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500">Account</span>
            {subscription?.active ? (
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-yellow-400/10 text-yellow-400 border border-yellow-400/20">
                {subscription.tier === 'desktop' ? 'Desktop + Bot' : 'Bot'} — Active
              </span>
            ) : (
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-red-400/10 text-red-400 border border-red-400/20">
                No subscription
              </span>
            )}
          </div>
          <div className="text-sm">
            <span className="text-gray-400">Server: </span>
            <span className="text-gray-200 font-mono text-xs">{settings.serverUrl || 'Not connected'}</span>
          </div>
          <div className="text-sm">
            <span className="text-gray-400">User: </span>
            <span className="text-gray-200">{settings.username || '—'}</span>
          </div>
        </div>

        {/* App settings */}
        <Input label="CapSolver API Key" value={capKey} onChange={setCapKey} placeholder="CAP-xxx" />
        <Input label="Discord Webhook (personal)" value={discord} onChange={setDiscord} placeholder="https://discord.com/api/webhooks/..." />

        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={sound} onChange={e => setSound(e.target.checked)} className="accent-yellow-400 rounded" />
          Sound notifications
        </label>

        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={autoLaunch} onChange={e => setAutoLaunch(e.target.checked)} className="accent-yellow-400 rounded" />
          Auto-launch browsers on queue detection
        </label>

        <div className="flex gap-2 pt-2">
          <button
            onClick={() => onSave({ capsolverKey: capKey, discordWebhook: discord, soundEnabled: sound, autoLaunchOnQueue: autoLaunch })}
            className="px-4 py-2 bg-yellow-400 text-gray-950 font-bold rounded-lg hover:bg-yellow-300 transition-colors"
          >
            Save Settings
          </button>
          <button
            onClick={async () => {
              await window.api.saveSettings({ serverUrl: '', authToken: '', username: '', userId: 0 })
              onLogout()
            }}
            className="px-4 py-2 bg-gray-800 text-gray-400 rounded-lg hover:bg-gray-700 transition-colors text-sm"
          >
            Sign Out
          </button>
        </div>

        <p className="text-[10px] text-gray-600 pt-2">Canary v1.0.0 by Heuricity</p>
      </div>
    </div>
  )
}

function Input({ label, value, onChange, placeholder, type }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string
}) {
  return (
    <div className="mb-2">
      <label className="block text-xs text-gray-400 mb-1">{label}</label>
      <input
        type={type || 'text'}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm focus:outline-none focus:border-yellow-400 transition-colors"
      />
    </div>
  )
}
