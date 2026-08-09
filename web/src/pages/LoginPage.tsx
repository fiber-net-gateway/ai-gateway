import {
  Activity,
  ArrowRight,
  Braces,
  ChartNoAxesCombined,
  GitBranch,
  Radio,
  RefreshCw,
  Route,
  ShieldCheck,
  Waves,
} from 'lucide-react'
import { useState, type FormEvent } from 'react'

import { LanguageSwitcher } from '../components/LanguageSwitcher'

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
            <strong>FIBER</strong> AI SERVER
          </span>
          <span className="login-runtime-status">
            <i /> PRODUCTION LLM GATEWAY
          </span>
        </div>
        <div className="login-copy">
          <span className="eyebrow lime">C++23 · FIBER RUNTIME</span>
          <h1>
            一个入口，稳定连接
            <br />
            多种 LLM Provider。
          </h1>
          <p>
            ai-server 是面向生产的高性能 LLM 代理。原生承接 OpenAI 与 Anthropic 请求，在同协议
            Provider 之间完成鉴权、限流、确定性路由、故障重试与流式透传。
          </p>
          <div className="login-protocols" aria-label="支持的原生协议与响应模式">
            <span>
              <Braces size={14} /> OPENAI CHAT COMPLETIONS
            </span>
            <span>
              <Radio size={14} /> ANTHROPIC MESSAGES
            </span>
            <span>
              <Waves size={14} /> SYNC + SSE STREAMING
            </span>
          </div>
        </div>

        <section className="login-request-path" aria-label="ai-server 请求执行链路">
          <header>
            <span>REQUEST EXECUTION PATH</span>
            <b>
              <i /> PINNED IMMUTABLE SNAPSHOT
            </b>
          </header>
          <div className="login-flow">
            <article>
              <Braces size={17} />
              <span>
                <small>01 · NATIVE INGRESS</small>
                <b>双协议入口</b>
                <em>OpenAI / Anthropic</em>
              </span>
            </article>
            <ArrowRight className="login-flow-arrow" size={15} />
            <article>
              <ShieldCheck size={17} />
              <span>
                <small>02 · POLICY</small>
                <b>安全决策</b>
                <em>BT1 · 授权 · 限流</em>
              </span>
            </article>
            <ArrowRight className="login-flow-arrow" size={15} />
            <article>
              <Route size={17} />
              <span>
                <small>03 · EXECUTION PLAN</small>
                <b>确定性路由</b>
                <em>Provider · Token</em>
              </span>
            </article>
            <ArrowRight className="login-flow-arrow" size={15} />
            <article>
              <GitBranch size={17} />
              <span>
                <small>04 · DELIVERY</small>
                <b>弹性转发</b>
                <em>Retry · Fallback · SSE</em>
              </span>
            </article>
          </div>
        </section>

        <div className="login-capabilities">
          <article>
            <Activity size={18} />
            <span>
              <b>生产级韧性</b>Token 暂停、Provider 熔断与请求排空
            </span>
          </article>
          <article>
            <RefreshCw size={18} />
            <span>
              <b>动态配置</b>Nacos 热更新与请求级不可变快照
            </span>
          </article>
          <article>
            <ChartNoAxesCombined size={18} />
            <span>
              <b>全链路观测</b>Prometheus、CAT 与专用对话审计
            </span>
          </article>
        </div>
        <span className="login-build">
          C++23 FIBER RUNTIME · NACOS CONFIG + DISCOVERY · HTTP/HTTPS PROVIDERS
        </span>
      </section>
      <section className="login-action">
        <LanguageSwitcher />
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
