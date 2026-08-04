import {
  BookOpen,
  Boxes,
  ClipboardCheck,
  ClipboardList,
  ChevronDown,
  CloudUpload,
  FileClock,
  KeyRound,
  LogOut,
  Menu,
  ShieldCheck,
  Server,
  Users,
  X,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'

import type { EnvironmentAccess, User } from '../api/client'

export type Section =
  | 'models'
  | 'providers'
  | 'releases'
  | 'tokens'
  | 'my-access'
  | 'access-requests'
  | 'users'
  | 'audit'

interface LayoutProps {
  user: User
  environment: EnvironmentAccess | null
  section: Section
  children: ReactNode
  onNavigate: (section: Section) => void
  onLogout: () => void
}

export function ConsoleLayout({
  user,
  environment,
  section,
  children,
  onNavigate,
  onLogout,
}: LayoutProps) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const navigate = (next: Section) => {
    setMobileOpen(false)
    onNavigate(next)
  }
  return (
    <div className="console-shell">
      <aside className={`sidebar${mobileOpen ? ' sidebar-open' : ''}`}>
        <div className="console-brand">
          <span className="console-mark">
            <i />
            <i />
            <i />
          </span>
          <span>
            <strong>FIBER</strong> CONTROL
          </span>
          <button
            className="sidebar-close"
            type="button"
            aria-label="关闭导航"
            onClick={() => setMobileOpen(false)}
          >
            <X size={19} />
          </button>
        </div>
        <div className="environment-switcher">
          <span>当前环境</span>
          <button type="button">
            <span className={`environment-dot stage-${environment?.environment.stage ?? 'none'}`} />
            <b>{environment?.environment.name ?? '未授权环境'}</b>
            <ChevronDown size={15} />
          </button>
          {environment && (
            <small>{environment.environment.stage.toUpperCase()} · MYSQL DRAFT</small>
          )}
        </div>
        <nav className="console-nav" aria-label="控制台导航">
          <span className="nav-heading">模型配置</span>
          <button
            className={section === 'models' ? 'active' : ''}
            type="button"
            onClick={() => navigate('models')}
          >
            <Boxes size={18} /> 模型广场
          </button>
          {user.systemRole === 'ADMIN' && (
            <button
              className={section === 'providers' ? 'active' : ''}
              type="button"
              onClick={() => navigate('providers')}
            >
              <Server size={18} /> Provider 管理
            </button>
          )}
          {user.systemRole === 'ADMIN' && (
            <button
              className={section === 'releases' ? 'active' : ''}
              type="button"
              onClick={() => navigate('releases')}
            >
              <CloudUpload size={18} /> 发布中心
            </button>
          )}
          <span className="nav-heading">个人工作台</span>
          <button
            className={section === 'tokens' ? 'active' : ''}
            type="button"
            onClick={() => navigate('tokens')}
          >
            <KeyRound size={18} /> Token 管理
          </button>
          <button
            className={section === 'my-access' ? 'active' : ''}
            type="button"
            onClick={() => navigate('my-access')}
          >
            <ClipboardList size={18} /> 我的权限申请
          </button>
          {user.systemRole === 'ADMIN' && (
            <>
              <span className="nav-heading">平台管理</span>
              <button
                className={section === 'access-requests' ? 'active' : ''}
                type="button"
                onClick={() => navigate('access-requests')}
              >
                <ClipboardCheck size={18} /> 权限审批
              </button>
              <button
                className={section === 'users' ? 'active' : ''}
                type="button"
                onClick={() => navigate('users')}
              >
                <Users size={18} /> 用户与角色
              </button>
              <button
                className={section === 'audit' ? 'active' : ''}
                type="button"
                onClick={() => navigate('audit')}
              >
                <FileClock size={18} /> 审计事件
              </button>
            </>
          )}
          <span className="nav-heading">帮助</span>
          <a
            href="https://github.com/fiber-net-gateway/introduction/blob/master/docs/user-module-design.md"
            target="_blank"
            rel="noreferrer"
          >
            <BookOpen size={18} /> 用户模块设计
          </a>
        </nav>
        <div className="sidebar-principle">
          <ShieldCheck size={18} />
          <p>
            <b>状态边界</b>
            <span>数据库记录不等于 rnacos 发布，也不代表实例已生效。</span>
          </p>
        </div>
        <div className="account-card">
          <span className="avatar">{user.displayName.slice(0, 1).toUpperCase()}</span>
          <p>
            <b>{user.displayName}</b>
            <span>{user.systemRole === 'ADMIN' ? '管理员' : '普通用户'}</span>
          </p>
          <button type="button" aria-label="退出登录" onClick={onLogout}>
            <LogOut size={17} />
          </button>
        </div>
      </aside>
      {mobileOpen && (
        <button
          className="sidebar-scrim"
          aria-label="关闭导航"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <main className="console-main">
        <header className="mobile-header">
          <button type="button" aria-label="打开导航" onClick={() => setMobileOpen(true)}>
            <Menu size={20} />
          </button>
          <span>
            <strong>FIBER</strong> CONTROL
          </span>
          <span className="avatar small">{user.displayName.slice(0, 1)}</span>
        </header>
        {children}
      </main>
    </div>
  )
}
