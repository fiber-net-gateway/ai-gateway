import React, { useCallback, useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/manrope/latin-400.css'
import '@fontsource/manrope/latin-500.css'
import '@fontsource/manrope/latin-600.css'
import '@fontsource/manrope/latin-700.css'
import '@fontsource/manrope/latin-800.css'
import '@fontsource/dm-mono/latin-400.css'
import '@fontsource/dm-mono/latin-500.css'
import { AlertCircle, AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'

import { api, ApiError, type EnvironmentAccess, type IssuedToken, type User } from './api/client'
import { ConsoleLayout, type Section } from './components/ConsoleLayout'
import { AuditPage } from './pages/AuditPage'
import { AccessRequestsPage } from './pages/AccessRequestsPage'
import { LoginPage } from './pages/LoginPage'
import { ModelDetailPage } from './pages/ModelDetailPage'
import { ModelEditorPage } from './pages/ModelEditorPage'
import { ModelMarketplacePage } from './pages/ModelMarketplacePage'
import { MyAccessRequestsPage } from './pages/MyAccessRequestsPage'
import { MyLlmCallsPage } from './pages/MyLlmCallsPage'
import { ProvidersPage } from './pages/ProvidersPage'
import { ReleaseCenterPage } from './pages/ReleaseCenterPage'
import { IssuedTokenModal, TokensPage } from './pages/TokensPage'
import { UsersPage } from './pages/UsersPage'
import './styles.css'

function initialSection(): Section {
  const value = window.location.hash.replace('#/', '')
  if (value === 'releases' || value.startsWith('releases/')) return 'releases'
  if (value === 'providers') return 'providers'
  if (
    value === 'users' ||
    value === 'audit' ||
    value === 'tokens' ||
    value === 'calls' ||
    value === 'my-access' ||
    value === 'access-requests'
  )
    return value
  return 'models'
}

function releaseRoute(): string | null {
  const parts = window.location.hash.replace(/^#\/?/u, '').split('/').filter(Boolean)
  return parts[0] === 'releases' ? (parts[1] ?? null) : null
}

function marketplaceRoute():
  | { kind: 'list' }
  | { kind: 'new' }
  | { kind: 'detail'; modelId: string }
  | { kind: 'edit'; modelId: string } {
  const parts = window.location.hash.replace(/^#\/?/u, '').split('/').filter(Boolean)
  if (parts[0] !== 'models') return { kind: 'list' }
  if (parts[1] === 'new') return { kind: 'new' }
  if (parts[1] && parts[2] === 'edit') return { kind: 'edit', modelId: parts[1] }
  if (parts[1]) return { kind: 'detail', modelId: parts[1] }
  return { kind: 'list' }
}

function App() {
  const [authMode, setAuthMode] = useState<'development' | 'oidc'>('development')
  const [user, setUser] = useState<User | null>(null)
  const [environments, setEnvironments] = useState<EnvironmentAccess[]>([])
  const [section, setSection] = useState<Section>(initialSection)
  const [modelRoute, setModelRoute] = useState(marketplaceRoute)
  const [releaseId, setReleaseId] = useState<string | null>(releaseRoute)
  const [booting, setBooting] = useState(true)
  const [loginBusy, setLoginBusy] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{
    message: string
    kind: 'success' | 'error' | 'info' | 'warning'
  } | null>(null)
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
    const update = () => {
      setSection(initialSection())
      setModelRoute(marketplaceRoute())
      setReleaseId(releaseRoute())
    }
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])

  const navigate = (next: Section) => {
    window.location.hash = `/${next}`
    setSection(next)
  }

  const navigateModel = (path = '') => {
    window.location.hash = `/models${path ? `/${path}` : ''}`
  }

  const showError = useCallback((message: string) => setNotice({ message, kind: 'error' }), [])
  const showSuccess = useCallback((message: string) => setNotice({ message, kind: 'success' }), [])
  const showInfo = useCallback((message: string) => setNotice({ message, kind: 'info' }), [])

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

  const visibleSection =
    user.systemRole === 'ADMIN'
      ? section
      : section === 'models' ||
          section === 'tokens' ||
          section === 'calls' ||
          section === 'my-access'
        ? section
        : 'models'
  const environmentId = environments[0]?.environment.id
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
          onError={showError}
        />
      )}
      {visibleSection === 'calls' && environmentId && (
        <MyLlmCallsPage environmentId={environmentId} onError={showError} />
      )}
      {visibleSection === 'my-access' && environmentId && (
        <MyAccessRequestsPage
          environmentId={environmentId}
          onOpenModel={(modelId) => navigateModel(modelId)}
          onError={showError}
          onNotice={showSuccess}
        />
      )}
      {visibleSection === 'models' &&
        environmentId &&
        (modelRoute.kind === 'list' ||
          (user.systemRole !== 'ADMIN' &&
            (modelRoute.kind === 'new' || modelRoute.kind === 'edit'))) && (
          <ModelMarketplacePage
            environmentId={environmentId}
            admin={user.systemRole === 'ADMIN'}
            onOpen={(modelId) => navigateModel(modelId)}
            onCreate={() => navigateModel('new')}
            onOpenReleases={() => navigate('releases')}
            onError={showError}
          />
        )}
      {visibleSection === 'models' && environmentId && modelRoute.kind === 'detail' && (
        <ModelDetailPage
          environmentId={environmentId}
          modelId={modelRoute.modelId}
          admin={user.systemRole === 'ADMIN'}
          onBack={() => navigateModel()}
          onEdit={() => navigateModel(`${modelRoute.modelId}/edit`)}
          onOpenReleases={() => navigate('releases')}
          onArchived={() => navigateModel()}
          onError={showError}
          onNotice={showSuccess}
        />
      )}
      {visibleSection === 'models' &&
        environmentId &&
        user.systemRole === 'ADMIN' &&
        (modelRoute.kind === 'new' || modelRoute.kind === 'edit') && (
          <ModelEditorPage
            environmentId={environmentId}
            modelId={modelRoute.kind === 'edit' ? modelRoute.modelId : undefined}
            onBack={() =>
              modelRoute.kind === 'edit' ? navigateModel(modelRoute.modelId) : navigateModel()
            }
            onSaved={(modelId) => navigateModel(modelId)}
            onOpenProviders={() => navigate('providers')}
            onError={showError}
            onNotice={showSuccess}
          />
        )}
      {visibleSection === 'providers' && environmentId && user.systemRole === 'ADMIN' && (
        <ProvidersPage environmentId={environmentId} onError={showError} onNotice={showSuccess} />
      )}
      {visibleSection === 'users' && (
        <UsersPage
          environments={environments}
          currentUser={user}
          onError={showError}
          onIssued={setIssued}
        />
      )}
      {visibleSection === 'access-requests' && environmentId && (
        <AccessRequestsPage
          environmentId={environmentId}
          onError={showError}
          onNotice={showSuccess}
        />
      )}
      {visibleSection === 'releases' && environmentId && user.systemRole === 'ADMIN' && (
        <ReleaseCenterPage
          environmentId={environmentId}
          releaseId={releaseId}
          onOpenRelease={(id) => {
            window.location.hash = `/releases/${id}`
          }}
          onError={showError}
          onNotice={showSuccess}
          onInfo={showInfo}
        />
      )}
      {visibleSection === 'audit' && <AuditPage onError={showError} />}
      {notice && (
        <div
          className={`toast toast-${notice.kind}`}
          role={notice.kind === 'error' ? 'alert' : 'status'}
        >
          {notice.kind === 'error' ? (
            <AlertCircle size={18} />
          ) : notice.kind === 'warning' ? (
            <AlertTriangle size={18} />
          ) : notice.kind === 'success' ? (
            <CheckCircle2 size={18} />
          ) : (
            <Info size={18} />
          )}
          <span>{notice.message}</span>
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
