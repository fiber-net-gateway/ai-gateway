import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/manrope/latin-400.css'
import '@fontsource/manrope/latin-500.css'
import '@fontsource/manrope/latin-600.css'
import '@fontsource/manrope/latin-700.css'
import '@fontsource/manrope/latin-800.css'
import '@fontsource/dm-mono/latin-400.css'
import '@fontsource/dm-mono/latin-500.css'
import { AlertCircle, X } from 'lucide-react'

import { api, ApiError, type EnvironmentAccess, type IssuedToken, type User } from './api/client'
import { ConsoleLayout, type Section } from './components/ConsoleLayout'
import { AuditPage } from './pages/AuditPage'
import { LoginPage } from './pages/LoginPage'
import { IssuedTokenModal, TokensPage } from './pages/TokensPage'
import { UsersPage } from './pages/UsersPage'
import './styles.css'

function initialSection(): Section {
  const value = window.location.hash.replace('#/', '')
  return value === 'users' || value === 'audit' ? value : 'tokens'
}

function App() {
  const [authMode, setAuthMode] = useState<'development' | 'oidc'>('development')
  const [user, setUser] = useState<User | null>(null)
  const [environments, setEnvironments] = useState<EnvironmentAccess[]>([])
  const [section, setSection] = useState<Section>(initialSection)
  const [booting, setBooting] = useState(true)
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [issued, setIssued] = useState<IssuedToken | null>(null)

  const loadSession = async () => {
    try {
      const [status, me] = await Promise.all([api.authStatus(), api.me()])
      setAuthMode(status.mode)
      setUser(me.user)
      const access = await api.environments()
      setEnvironments(access.items)
    } catch (error) {
      const status = await api.authStatus().catch(() => ({ mode: 'development' as const }))
      setAuthMode(status.mode)
      if (!(error instanceof ApiError && error.status === 401)) {
        setLoginError(error instanceof Error ? error.message : '控制台服务暂时不可用')
      }
      setUser(null)
    } finally {
      setBooting(false)
    }
  }

  useEffect(() => {
    void loadSession()
  }, [])

  useEffect(() => {
    const update = () => setSection(initialSection())
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])

  const navigate = (next: Section) => {
    window.location.hash = `/${next}`
    setSection(next)
  }

  const login = async (username: string) => {
    setLoginBusy(true)
    setLoginError(null)
    try {
      const result = await api.developmentLogin(username)
      setUser(result.user)
      setEnvironments((await api.environments()).items)
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : '登录失败')
    } finally {
      setLoginBusy(false)
    }
  }

  const logout = async () => {
    await api.logout().catch(() => undefined)
    setUser(null)
    setEnvironments([])
  }

  const closeIssued = async () => {
    const current = issued
    setIssued(null)
    if (current) await api.purgeDelivery(current.id).catch(() => undefined)
  }

  if (booting) {
    return (
      <div className="boot-screen">
        <span className="console-mark light">
          <i />
          <i />
          <i />
        </span>
        <p>正在建立安全会话…</p>
      </div>
    )
  }

  if (!user) {
    return (
      <LoginPage mode={authMode} busy={loginBusy} error={loginError} onDevelopmentLogin={login} />
    )
  }

  const visibleSection = user.systemRole === 'ADMIN' ? section : 'tokens'
  return (
    <ConsoleLayout
      user={user}
      environment={environments[0] ?? null}
      section={visibleSection}
      onNavigate={navigate}
      onLogout={() => void logout()}
    >
      {visibleSection === 'tokens' && (
        <TokensPage
          environments={environments}
          onEnvironmentsChange={setEnvironments}
          onError={setNotice}
        />
      )}
      {visibleSection === 'users' && (
        <UsersPage
          environments={environments}
          currentUser={user}
          onError={setNotice}
          onIssued={setIssued}
        />
      )}
      {visibleSection === 'audit' && <AuditPage onError={setNotice} />}
      {notice && (
        <div className="toast" role="alert">
          <AlertCircle size={18} />
          <span>{notice}</span>
          <button type="button" aria-label="关闭消息" onClick={() => setNotice(null)}>
            <X size={16} />
          </button>
        </div>
      )}
      <IssuedTokenModal token={issued} onClose={() => void closeIssued()} />
    </ConsoleLayout>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
