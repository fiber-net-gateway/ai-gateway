import React, { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/manrope/latin-400.css'
import '@fontsource/manrope/latin-500.css'
import '@fontsource/manrope/latin-600.css'
import '@fontsource/manrope/latin-700.css'
import '@fontsource/manrope/latin-800.css'
import '@fontsource/dm-mono/latin-400.css'
import '@fontsource/dm-mono/latin-500.css'
import {
  Activity,
  ArrowDown,
  ArrowRight,
  Blocks,
  Bot,
  Boxes,
  Check,
  ChevronRight,
  CircleDot,
  Clipboard,
  Code2,
  Cpu,
  ExternalLink,
  Gauge,
  Github,
  Globe2,
  Layers3,
  Menu,
  Network,
  Radio,
  Route,
  Server,
  ShieldCheck,
  Sparkles,
  Terminal,
  Waypoints,
  X,
  Zap,
} from 'lucide-react'
import './styles.css'

const REPO_URL = 'https://github.com/fiber-net-gateway/fiber-gateway-cpp'
const REPO_BRANCH = 'master'

type AccentStyle = CSSProperties & Record<'--app-accent' | '--tab-accent', string>
type Application = (typeof apps)[number]

const capabilities = [
  {
    icon: Cpu,
    index: '01',
    title: '协程运行时',
    kicker: 'C++23 COROUTINES',
    description: 'EventLoop、跨线程调度、定时器与异步同步原语共同构成非阻塞运行底座。',
    tags: ['epoll', 'Task', 'Mutex', 'Watch'],
  },
  {
    icon: Globe2,
    index: '02',
    title: '全栈 HTTP',
    kicker: 'HTTP / 1.1 · 2 · 3',
    description:
      '从 HTTP/1.1 连接池到 HPACK、QPACK、QUIC 与流式 body，一套 API 覆盖服务端和客户端。',
    tags: ['TLS', 'ALPN', 'QUIC v1', 'WebSocket'],
  },
  {
    icon: Network,
    index: '03',
    title: '网络基础设施',
    kicker: 'NETWORK PRIMITIVES',
    description: 'TCP、UDP、Unix Socket、DNS 与 TLS 抽象直接服务于真实网关热路径。',
    tags: ['TCP / UDP', 'DNS cache', 'TLS', 'UDP GSO'],
  },
  {
    icon: Code2,
    index: '04',
    title: '可编程数据面',
    kicker: 'SCRIPTABLE PIPELINE',
    description:
      '内置脚本运行时、JSON codec 与 HTTP bindings，在保持性能边界的同时提供可配置能力。',
    tags: ['Script VM', 'JSONPath', 'Templates', 'HTTP bindings'],
  },
]

const apps = [
  {
    id: 'ai-server',
    label: 'AI SERVER',
    icon: Bot,
    number: '01',
    title: '面向 LLM 流量的智能代理',
    summary:
      '把认证、模型授权、Provider 选择、集群限流与观测统一放进请求链路，同时保持 SSE 原样流式传输。',
    accent: '#b8ff64',
    status: '完整应用 / 活跃演进',
    route: 'POST /v1/chat/completions',
    sourcePath: 'apps/ai-server',
    features: [
      'OpenAI Chat Completions 与 Anthropic Messages 入口',
      'BT1 认证、模型授权与确定性 Provider / token 选择',
      'Nacos 动态配置、服务发现与不可变快照发布',
      '重试、fallback、熔断及分布式 token 限流',
      '同步与 SSE 透传，统一 usage 聚合与审计',
      'Prometheus、CAT 与专用 NDJSON 对话审计',
    ],
    flow: ['BT1 鉴权', '模型路由', 'Token 限流', 'Provider 计划', 'SSE / JSON'],
    statA: ['2', '入口协议'],
    statB: ['3', '观测通道'],
  },
  {
    id: 'lite-nginx',
    label: 'LITE NGINX',
    icon: Waypoints,
    number: '02',
    title: '小而明确的多协议反向代理',
    summary: '使用 nginx 风格的配置语法，但以 Fiber Gateway 自己的路由、协议栈与连接池实现数据面。',
    accent: '#ff815c',
    status: 'V1 功能已实现',
    route: 'listen 443 ssl http3;',
    sourcePath: 'apps/lite_nginx',
    features: [
      '下游 HTTP/1.1、HTTP/2、HTTP/3 与 TLS / ALPN',
      '上游 HTTP/1.1、HTTPS 与平滑加权轮询',
      '全局 keepalive 池和跨 EventLoop 连接借用',
      '请求与响应流式转发，可选内存缓冲',
      'HTTP Upgrade 与 Extended CONNECT WebSocket 隧道',
      '脚本处理器、访问日志模板与严格配置校验',
    ],
    flow: ['Listener', 'Server / Host', 'Location', 'Upstream', 'Stream back'],
    statA: ['3', '下游 HTTP 版本'],
    statB: ['0', '默认整包缓冲'],
  },
  {
    id: 'access-server',
    label: 'ACCESS SERVER',
    icon: Route,
    number: '03',
    title: '统一接入能力的 C++23 迁移',
    summary: '以 Java 行为兼容为边界，重建配置解码、Host / Path 路由、灰度策略和代理执行链路。',
    accent: '#74a8ff',
    status: '迁移联调中 / 尚未切流',
    route: 'host → route → proxy',
    sourcePath: 'apps/access-server',
    features: [
      'Java 兼容配置 codec 与 golden fixtures',
      'Host / Path / condition 不可变路由快照',
      'RESPONSE、PROXY 与 WebSocket 101 tunnel',
      'Nacos 配置图、NamingService 与灰度规则热更新',
      'per-worker DNS、连接池和有序关闭',
      '固定 schema 指标、CAT trace 与结构化访问日志',
    ],
    flow: ['Host 匹配', '入口策略', 'Path 路由', 'PROXY / RESPONSE', 'Telemetry'],
    statA: ['2', '执行类型'],
    statB: ['P0–P2', '兼容契约'],
  },
]

const layers = [
  {
    number: '04',
    name: '应用层',
    detail: 'AI Server · Lite Nginx · Access Server',
    icon: Boxes,
    tone: 'lime',
  },
  {
    number: '03',
    name: '能力层',
    detail: 'Nacos · Prometheus · CAT · Script · gRPC',
    icon: Blocks,
    tone: 'blue',
  },
  {
    number: '02',
    name: '协议层',
    detail: 'HTTP/1.1 · HTTP/2 · HTTP/3 · QUIC · DNS · TLS',
    icon: Layers3,
    tone: 'orange',
  },
  {
    number: '01',
    name: '运行时',
    detail: 'EventLoop · Coroutine · Async primitives · Buffers',
    icon: Cpu,
    tone: 'neutral',
  },
]

const repoModules = [
  ['event', '事件循环 / poller / timer'],
  ['async', '协程任务与同步原语'],
  ['net', 'Socket / stream / TLS'],
  ['http', 'HTTP 1.1 / 2 / 3'],
  ['quic', 'QUIC transport / recovery'],
  ['dns', 'Resolver / client / cache'],
  ['grpc', 'Framing / stream / client'],
  ['script', 'Parser / IR / runtime'],
  ['common', 'JSON / memory / containers'],
  ['log', '结构化异步日志'],
]

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <i />
      <i />
      <i />
    </span>
  )
}

interface RepoLinkProps {
  children: ReactNode
  className?: string
  path?: string
}

function RepoLink({ children, className = '', path = '' }: RepoLinkProps) {
  const sourceType = /\.[a-z0-9-]+$/i.test(path) ? 'blob' : 'tree'
  const href = path ? `${REPO_URL}/${sourceType}/${REPO_BRANCH}/${path}` : REPO_URL
  return (
    <a className={className} href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  )
}

function Header() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const close = () => setOpen(false)
    window.addEventListener('resize', close)
    return () => window.removeEventListener('resize', close)
  }, [])

  return (
    <header className="site-header">
      <a className="brand" href="#top" aria-label="Fiber Gateway 首页">
        <BrandMark />
        <span>
          FIBER <b>GATEWAY</b>
        </span>
      </a>

      <nav className={open ? 'nav-links is-open' : 'nav-links'} aria-label="主导航">
        <a href="#overview" onClick={() => setOpen(false)}>
          项目概览
        </a>
        <a href="#capabilities" onClick={() => setOpen(false)}>
          核心能力
        </a>
        <a href="#applications" onClick={() => setOpen(false)}>
          应用矩阵
        </a>
        <a href="#architecture" onClick={() => setOpen(false)}>
          架构
        </a>
      </nav>

      <RepoLink className="header-github">
        <Github size={16} />
        <span>GitHub</span>
        <ExternalLink size={13} />
      </RepoLink>

      <button
        className="menu-button"
        type="button"
        aria-expanded={open}
        aria-label={open ? '关闭菜单' : '打开菜单'}
        onClick={() => setOpen((value) => !value)}
      >
        {open ? <X /> : <Menu />}
      </button>
    </header>
  )
}

function HeroDiagram() {
  return (
    <div className="hero-diagram" aria-label="请求经过 Fiber Gateway 到达服务">
      <div className="diagram-head">
        <span>
          <CircleDot size={13} /> request.pipeline
        </span>
        <span className="diagram-live">
          <i /> LIVE
        </span>
      </div>

      <div className="traffic-map">
        <div className="traffic-node source-node">
          <span>CLIENT</span>
          <strong>01</strong>
        </div>
        <div className="traffic-line line-one">
          <i />
        </div>
        <div className="gateway-core">
          <div className="core-rings">
            <span className="ring ring-one" />
            <span className="ring ring-two" />
            <span className="core-symbol">
              <BrandMark />
            </span>
          </div>
          <p>FIBER CORE</p>
          <small>C++23 / EVENT DRIVEN</small>
        </div>
        <div className="traffic-line line-two">
          <i />
        </div>
        <div className="target-stack">
          <div className="traffic-node target-node">
            <Bot size={15} />
            <span>LLM</span>
          </div>
          <div className="traffic-node target-node">
            <Server size={15} />
            <span>HTTP</span>
          </div>
          <div className="traffic-node target-node">
            <Boxes size={15} />
            <span>SERVICE</span>
          </div>
        </div>
      </div>

      <div className="diagram-console">
        <div>
          <span>protocol</span>
          <b>HTTP/1.1 · H2 · H3</b>
        </div>
        <div>
          <span>runtime</span>
          <b>epoll + coroutine</b>
        </div>
        <div>
          <span>status</span>
          <b className="is-ready">● ready</b>
        </div>
      </div>
    </div>
  )
}

function Hero() {
  return (
    <main id="top">
      <section className="hero section-shell">
        <div className="hero-copy">
          <div className="eyebrow">
            <Sparkles size={15} /> PERFORMANCE-FIRST GATEWAY FRAMEWORK
          </div>
          <h1>
            把协议复杂度，
            <span>压进一套 C++23 运行时。</span>
          </h1>
          <p className="hero-lead">
            Fiber Gateway 面向网关、反向代理与异步网络服务， 从协程调度到
            HTTP/3，提供一条可组合、可观测的高性能数据路径。
          </p>
          <div className="hero-actions">
            <a className="button button-primary" href="#applications">
              探索三大应用 <ArrowDown size={17} />
            </a>
            <RepoLink className="button button-secondary">
              <Github size={18} /> 查看源代码 <ArrowRight size={16} />
            </RepoLink>
          </div>
          <div className="hero-proof">
            <div>
              <strong>C++23</strong>
              <span>现代协程运行时</span>
            </div>
            <div>
              <strong>H1 → H3</strong>
              <span>完整 HTTP 协议栈</span>
            </div>
            <div>
              <strong>MIT</strong>
              <span>开放源代码</span>
            </div>
          </div>
        </div>
        <HeroDiagram />
      </section>
    </main>
  )
}

function Overview() {
  return (
    <section className="overview section-shell reveal" id="overview">
      <div className="section-label">
        <span>01</span> PROJECT OVERVIEW
      </div>
      <div className="overview-grid">
        <div className="overview-title">
          <h2>
            不是一个可执行文件，
            <br />
            而是一套网关构建基座。
          </h2>
        </div>
        <div className="overview-copy">
          <p>
            仓库以可复用的 <code>fiber_lib</code> 静态库为中心。事件、异步、网络、QUIC、HTTP、
            DNS、gRPC、脚本与日志模块共享同一运行时和所有权模型。
          </p>
          <p>
            上层应用不需要重新拼装协议细节：它们复用同一条经过测试的底座，
            把注意力留给路由、配置、流控与业务兼容。
          </p>
          <RepoLink className="text-link" path="src">
            浏览核心源码 <ArrowRight size={15} />
          </RepoLink>
        </div>
      </div>
      <div className="overview-statement">
        <span className="quote-mark">“</span>
        <p>一个运行时，多种网关形态。</p>
        <div className="statement-rule" />
        <span>ONE RUNTIME · MANY GATEWAYS</span>
      </div>
    </section>
  )
}

function Capabilities() {
  return (
    <section className="capabilities" id="capabilities">
      <div className="section-shell reveal">
        <div className="section-heading">
          <div>
            <div className="section-label light">
              <span>02</span> CORE CAPABILITIES
            </div>
            <h2>
              热路径所需的能力，
              <br />
              从底层开始构建。
            </h2>
          </div>
          <p>不是胶水式组装，而是围绕事件循环、内存与连接所有权协同设计。</p>
        </div>
        <div className="capability-grid">
          {capabilities.map(({ icon: Icon, ...item }) => (
            <article className="capability-card" key={item.title}>
              <div className="card-top">
                <span className="cap-number">{item.index}</span>
                <Icon size={25} strokeWidth={1.6} />
              </div>
              <span className="cap-kicker">{item.kicker}</span>
              <h3>{item.title}</h3>
              <p>{item.description}</p>
              <div className="tag-row">
                {item.tags.map((tag) => (
                  <span key={tag}>{tag}</span>
                ))}
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  )
}

function ApplicationPanel({ app }: { app: Application }) {
  const Icon = app.icon
  return (
    <div className="application-panel" style={{ '--app-accent': app.accent } as AccentStyle}>
      <div className="app-copy">
        <div className="app-status">
          <i /> {app.status}
        </div>
        <Icon className="app-icon" size={34} strokeWidth={1.6} />
        <div className="app-index">APPLICATION / {app.number}</div>
        <h3>{app.title}</h3>
        <p>{app.summary}</p>
        <ul className="feature-list">
          {app.features.map((feature) => (
            <li key={feature}>
              <Check size={15} /> {feature}
            </li>
          ))}
        </ul>
        <RepoLink className="button app-button" path={app.sourcePath}>
          查看 {app.id} 源码 <ExternalLink size={15} />
        </RepoLink>
      </div>
      <div className="app-visual">
        <div className="app-terminal">
          <div className="terminal-bar">
            <span>
              <i />
              <i />
              <i />
            </span>
            <b>{app.id} / request-flow</b>
          </div>
          <div className="terminal-body">
            <div className="terminal-command">
              <span>$</span> {app.route}
            </div>
            <div className="flow-stack">
              {app.flow.map((step, index) => (
                <React.Fragment key={step}>
                  <div className="flow-step">
                    <span>{String(index + 1).padStart(2, '0')}</span>
                    <b>{step}</b>
                    <Activity size={15} />
                  </div>
                  {index < app.flow.length - 1 && (
                    <div className="flow-connector">
                      <i />
                    </div>
                  )}
                </React.Fragment>
              ))}
            </div>
          </div>
        </div>
        <div className="app-stats">
          <div>
            <strong>{app.statA[0]}</strong>
            <span>{app.statA[1]}</span>
          </div>
          <div>
            <strong>{app.statB[0]}</strong>
            <span>{app.statB[1]}</span>
          </div>
        </div>
      </div>
    </div>
  )
}

function Applications() {
  const [active, setActive] = useState(0)
  const app = apps[active]

  return (
    <section className="applications section-shell reveal" id="applications">
      <div className="section-heading app-heading">
        <div>
          <div className="section-label">
            <span>03</span> APPLICATION MATRIX
          </div>
          <h2>同一底座，三种真实流量场景。</h2>
        </div>
        <p>选择一个应用，查看它如何把框架能力组织成可运行的数据路径。</p>
      </div>

      <div className="app-tabs" role="tablist" aria-label="重点应用">
        {apps.map((item, index) => {
          const Icon = item.icon
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active === index}
              className={active === index ? 'app-tab is-active' : 'app-tab'}
              style={{ '--tab-accent': item.accent } as AccentStyle}
              onClick={() => setActive(index)}
            >
              <span>{item.number}</span>
              <Icon size={18} />
              <b>{item.label}</b>
              <ChevronRight size={17} />
            </button>
          )
        })}
      </div>
      <ApplicationPanel key={app.id} app={app} />
    </section>
  )
}

function Architecture() {
  return (
    <section className="architecture" id="architecture">
      <div className="section-shell reveal">
        <div className="section-heading architecture-heading">
          <div>
            <div className="section-label light">
              <span>04</span> ARCHITECTURE
            </div>
            <h2>
              从 EventLoop 到业务应用，
              <br />
              复杂度逐层收敛。
            </h2>
          </div>
          <p>每层只暴露上层真正需要的语义；应用共享运行时、协议实现和工程约束。</p>
        </div>

        <div className="architecture-grid">
          <div className="layer-stack">
            {layers.map(({ icon: Icon, ...layer }) => (
              <div className={`layer layer-${layer.tone}`} key={layer.name}>
                <span className="layer-number">{layer.number}</span>
                <Icon size={22} />
                <strong>{layer.name}</strong>
                <span className="layer-detail">{layer.detail}</span>
                <ArrowRight size={17} />
              </div>
            ))}
          </div>
          <div className="module-map">
            <div className="module-map-head">
              <span>
                <Terminal size={15} /> src/
              </span>
              <span>10 CORE MODULES</span>
            </div>
            <div className="module-grid">
              {repoModules.map(([name, description], index) => (
                <RepoLink className="module-item" path={`src/${name}`} key={name}>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <div>
                    <strong>{name}/</strong>
                    <small>{description}</small>
                  </div>
                  <ArrowRight size={14} />
                </RepoLink>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function QuickStart() {
  const command =
    'git clone https://github.com/fiber-net-gateway/fiber-gateway-cpp.git\ncd fiber-gateway-cpp\ncmake -S . -B build\ncmake --build build'
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      setCopied(false)
    }
  }

  return (
    <section className="quick-start section-shell reveal" id="quick-start">
      <div className="quick-card">
        <div className="quick-copy">
          <div className="section-label">
            <span>05</span> QUICK START
          </div>
          <h2>
            四条命令，
            <br />
            进入 Fiber Gateway。
          </h2>
          <p>需要 Linux、CMake 4.1+，以及支持项目所需 C++23 特性的 GCC 13+ 或 Clang 17+。</p>
          <div className="requirement-row">
            <span>
              <ShieldCheck size={15} /> Linux / epoll
            </span>
            <span>
              <Gauge size={15} /> CMake 4.1+
            </span>
            <span>
              <Zap size={15} /> C++23
            </span>
          </div>
        </div>
        <div className="code-window">
          <div className="code-head">
            <span>
              <i />
              <i />
              <i />
            </span>
            <b>terminal</b>
            <button type="button" onClick={copy} aria-label="复制构建命令">
              {copied ? <Check size={15} /> : <Clipboard size={15} />}
              {copied ? '已复制' : '复制'}
            </button>
          </div>
          <pre>
            {command.split('\n').map((line) => (
              <code key={line}>
                <span>$</span> {line}
              </code>
            ))}
          </pre>
          <div className="code-foot">
            <span>build/apps/</span>
            <b>ready</b>
          </div>
        </div>
      </div>
    </section>
  )
}

function ProjectStatus() {
  return (
    <section className="status-section section-shell reveal">
      <div className="status-card">
        <div className="status-icon">
          <Radio size={24} />
        </div>
        <div>
          <span>PROJECT STATUS · 2026.08</span>
          <h2>广阔的协议面，仍在持续演进。</h2>
          <p>
            项目拥有覆盖运行时、网络与协议的测试体系，但 API 和应用契约仍可能变化。
            <code>access-server</code> 当前可用于继续联调，尚未满足生产切流条件。
          </p>
        </div>
        <RepoLink className="button button-dark">
          跟踪开发进展 <ArrowRight size={16} />
        </RepoLink>
      </div>
    </section>
  )
}

function Footer() {
  return (
    <footer>
      <div className="footer-main section-shell">
        <div className="footer-brand">
          <a className="brand" href="#top">
            <BrandMark />
            <span>
              FIBER <b>GATEWAY</b>
            </span>
          </a>
          <p>为真实网关负载而构建的 C++23 网络框架。</p>
        </div>
        <div className="footer-links">
          <div>
            <span>EXPLORE</span>
            <a href="#overview">项目概览</a>
            <a href="#capabilities">核心能力</a>
            <a href="#applications">应用矩阵</a>
          </div>
          <div>
            <span>SOURCE</span>
            <RepoLink>GitHub 仓库</RepoLink>
            <RepoLink path="README.zh-CN.md">项目文档</RepoLink>
            <RepoLink path="apps">应用目录</RepoLink>
          </div>
        </div>
      </div>
      <div className="footer-bottom section-shell">
        <span>INTRODUCTION SITE / CONTENT FROM SOURCE</span>
        <span>UPSTREAM LICENSED UNDER MIT</span>
      </div>
    </footer>
  )
}

function App() {
  useEffect(() => {
    const nodes = document.querySelectorAll('.reveal')
    const observer = new IntersectionObserver(
      (entries) =>
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('is-visible')
            observer.unobserve(entry.target)
          }
        }),
      { threshold: 0.1 },
    )
    nodes.forEach((node) => observer.observe(node))
    return () => observer.disconnect()
  }, [])

  return (
    <>
      <Header />
      <Hero />
      <Overview />
      <Capabilities />
      <Applications />
      <Architecture />
      <QuickStart />
      <ProjectStatus />
      <Footer />
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
