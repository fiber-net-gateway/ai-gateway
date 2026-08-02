import { ArrowRight, KeyRound, Layers3, ShieldCheck } from 'lucide-react'
import { useState, type FormEvent } from 'react'

interface LoginPageProps {
  mode: 'development' | 'oidc'
  busy: boolean
  error: string | null
  onDevelopmentLogin: (username: string) => Promise<void>
}

export function LoginPage({ mode, busy, error, onDevelopmentLogin }: LoginPageProps) {
  const [username, setUsername] = useState('admin')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    void onDevelopmentLogin(username)
  }
  return (
    <main className="login-shell">
      <section className="login-story">
        <div className="login-brand">
          <span className="console-mark light">
            <i />
            <i />
            <i />
          </span>
          <span>
            <strong>FIBER</strong> CONTROL
          </span>
        </div>
        <div className="login-copy">
          <span className="eyebrow lime">AI-SERVER MANAGEMENT CONSOLE</span>
          <h1>
            让每一次配置变更
            <br />
            都可见、可控、可追溯。
          </h1>
          <p>管理 ai-server 的用户、BT1 访问凭据与发布状态，同时保留清晰的运行时证据边界。</p>
        </div>
        <div className="login-pillars">
          <article>
            <Layers3 size={19} />
            <span>
              <b>三态分离</b>草稿、发布、实例生效
            </span>
          </article>
          <article>
            <KeyRound size={19} />
            <span>
              <b>安全交付</b>BT1 Token 仅短暂展示
            </span>
          </article>
          <article>
            <ShieldCheck size={19} />
            <span>
              <b>完整审计</b>高风险操作留痕
            </span>
          </article>
        </div>
        <span className="login-build">CONSOLE PREVIEW · USER MODULE</span>
      </section>
      <section className="login-action">
        <div className="login-card">
          <span className="eyebrow">SECURE ACCESS</span>
          <h2>登录管理控制台</h2>
          <p className="subtle">
            {mode === 'development'
              ? '当前为本地开发认证。输入已开通的 username 进入。'
              : '通过组织身份提供方验证身份后进入控制台。'}
          </p>
          {error && (
            <div className="form-error" role="alert">
              {error}
            </div>
          )}
          {mode === 'development' ? (
            <form onSubmit={submit}>
              <label>
                <span>用户名</span>
                <input
                  autoFocus
                  autoComplete="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  placeholder="admin"
                  required
                />
              </label>
              <button className="primary-button full" type="submit" disabled={busy}>
                {busy ? '正在验证…' : '进入控制台'} <ArrowRight size={17} />
              </button>
            </form>
          ) : (
            <a className="primary-button full" href="/api/auth/login">
              使用企业 SSO 登录 <ArrowRight size={17} />
            </a>
          )}
          <div className="login-security">
            <ShieldCheck size={16} />
            Session 使用 HttpOnly Cookie，写操作启用 CSRF 校验
          </div>
        </div>
        <p className="login-footnote">仅供授权人员使用 · 所有管理操作均会记录审计事件</p>
      </section>
    </main>
  )
}
