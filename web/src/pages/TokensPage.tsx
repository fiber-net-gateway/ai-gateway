import {
  AlertTriangle,
  Check,
  Clipboard,
  Clock3,
  KeyRound,
  Plus,
  ShieldAlert,
  Trash2,
} from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'

import { api, type EnvironmentAccess, type IssuedToken, type TokenView } from '../api/client'
import { Modal } from '../components/Modal'
import { StatusBadge } from '../components/StatusBadge'
import { formatDateTime } from '../i18n'

const dateTimeOptions: Intl.DateTimeFormatOptions = {
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
}

interface TokensPageProps {
  environments: EnvironmentAccess[]
  onEnvironmentsChange: (items: EnvironmentAccess[]) => void
  onError: (message: string) => void
}

export function TokensPage({ environments, onEnvironmentsChange, onError }: TokensPageProps) {
  const [tokens, setTokens] = useState<TokenView[]>([])
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [issued, setIssued] = useState<IssuedToken | null>(null)
  const [disableTarget, setDisableTarget] = useState<TokenView | null>(null)
  const activeCount = tokens.filter((token) => token.state === 'ACTIVE').length
  const nextExpiry = useMemo(
    () =>
      tokens
        .filter((token) => token.state === 'ACTIVE')
        .sort((left, right) => left.expiresAt.localeCompare(right.expiresAt))[0],
    [tokens],
  )

  const load = async () => {
    setLoading(true)
    try {
      const [environmentResult, tokenResult] = await Promise.all([api.environments(), api.tokens()])
      onEnvironmentsChange(environmentResult.items)
      setTokens(tokenResult.items)
    } catch (error) {
      onError(error instanceof Error ? error.message : '加载 Token 失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const closeIssued = async () => {
    const current = issued
    setIssued(null)
    if (current) await api.purgeDelivery(current.id).catch(() => undefined)
  }

  return (
    <div className="page-shell">
      <header className="page-header">
        <div>
          <span className="eyebrow">ACCESS CREDENTIALS</span>
          <h1>Token 管理</h1>
          <p>生成和管理用于调用 ai-server 的个人 BT1 凭据。</p>
        </div>
        <button
          className="primary-button"
          type="button"
          onClick={() => setCreateOpen(true)}
          disabled={!environments.length}
        >
          <Plus size={17} /> 生成 Token
        </button>
      </header>

      <section className="metric-grid">
        <article>
          <span className="metric-icon lime">
            <KeyRound size={19} />
          </span>
          <p>
            有效 Token<b>{activeCount}</b>
            <small>最多 {environments[0]?.policy.maxActiveTokensPerUser ?? 0} 个 / 环境</small>
          </p>
        </article>
        <article>
          <span className="metric-icon blue">
            <Clock3 size={19} />
          </span>
          <p>
            最近过期
            <b className="metric-date">
              {nextExpiry ? formatDateTime(nextExpiry.expiresAt, dateTimeOptions) : '—'}
            </b>
            <small>{nextExpiry?.name ?? '暂无有效 Token'}</small>
          </p>
        </article>
        <article>
          <span className="metric-icon orange">
            <ShieldAlert size={19} />
          </span>
          <p>
            运行时撤销<b>不支持</b>
            <small>停用仅影响控制台状态</small>
          </p>
        </article>
      </section>

      <div className="boundary-notice warning">
        <AlertTriangle size={18} />
        <div>
          <b>请注意停用边界</b>
          <span>
            当前 ai-server 不支持单 Token 撤销。控制台停用后，已签发 Token
            在到期前仍可能被实例接受。
          </span>
        </div>
      </div>

      <section className="data-card">
        <div className="card-heading">
          <div>
            <h2>我的 Token</h2>
            <p>这里只显示安全指纹，原始值不会被再次读取。</p>
          </div>
          <span>{tokens.length} ITEMS</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>名称</th>
                <th>环境</th>
                <th>签名 Key</th>
                <th>创建 / 过期</th>
                <th>状态</th>
                <th>
                  <span className="sr-only">操作</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {loading && (
                <tr>
                  <td colSpan={6} className="empty-cell">
                    正在加载…
                  </td>
                </tr>
              )}
              {!loading && tokens.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty-cell">
                    <KeyRound size={22} />
                    尚未生成 Token
                  </td>
                </tr>
              )}
              {tokens.map((token) => (
                <tr key={token.id}>
                  <td>
                    <div className="primary-cell">
                      <b>{token.name}</b>
                      <code>sha256:{token.fingerprint}…</code>
                    </div>
                  </td>
                  <td>
                    {environments.find((item) => item.environment.id === token.environmentId)
                      ?.environment.name ?? '未知环境'}
                  </td>
                  <td>
                    <code>{token.kid}</code>
                  </td>
                  <td>
                    <div className="date-stack">
                      <span>{formatDateTime(token.issuedAt, dateTimeOptions)}</span>
                      <small>至 {formatDateTime(token.expiresAt, dateTimeOptions)}</small>
                    </div>
                  </td>
                  <td>
                    <StatusBadge status={token.state} />
                  </td>
                  <td className="row-actions">
                    <button
                      type="button"
                      aria-label={`停用 ${token.name}`}
                      disabled={token.state === 'DISABLED' || token.state === 'EXPIRED'}
                      onClick={() => setDisableTarget(token)}
                    >
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <CreateTokenModal
        open={createOpen}
        environments={environments}
        onClose={() => setCreateOpen(false)}
        onCreated={(value) => {
          setCreateOpen(false)
          setIssued(value)
          void load()
        }}
        onError={onError}
      />
      <DisableTokenModal
        token={disableTarget}
        onClose={() => setDisableTarget(null)}
        onDisabled={() => {
          setDisableTarget(null)
          void load()
        }}
        onError={onError}
      />
      <IssuedTokenModal token={issued} onClose={() => void closeIssued()} />
    </div>
  )
}

function CreateTokenModal({
  open,
  environments,
  onClose,
  onCreated,
  onError,
}: {
  open: boolean
  environments: EnvironmentAccess[]
  onClose: () => void
  onCreated: (token: IssuedToken) => void
  onError: (message: string) => void
}) {
  const [environmentId, setEnvironmentId] = useState('')
  const [name, setName] = useState('')
  const [ttlSeconds, setTtlSeconds] = useState(3_600)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const selected =
      environments.find((item) => item.environment.id === environmentId) ?? environments[0]
    if (selected) {
      if (!environmentId) setEnvironmentId(selected.environment.id)
      setTtlSeconds(selected.policy.defaultTtlSeconds)
    }
  }, [environmentId, environments])
  const selected = environments.find((item) => item.environment.id === environmentId)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    try {
      onCreated(await api.issueToken({ environmentId, name, ttlSeconds }))
      setName('')
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Token 生成失败')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open={open} title="生成新的 BT1 Token" eyebrow="ONE-TIME DELIVERY" onClose={onClose}>
      <form className="modal-body form-grid" onSubmit={submit}>
        <label className="full-field">
          <span>目标环境</span>
          <select
            value={environmentId}
            onChange={(event) => setEnvironmentId(event.target.value)}
            required
          >
            {environments.map((item) => (
              <option value={item.environment.id} key={item.environment.id}>
                {item.environment.name} · {item.environment.stage}
              </option>
            ))}
          </select>
        </label>
        <label className="full-field">
          <span>Token 名称</span>
          <input
            value={name}
            maxLength={64}
            onChange={(event) => setName(event.target.value)}
            placeholder="例如：local-cli"
            required
          />
          <small>用于识别用途，不会写入原始 Token。</small>
        </label>
        <label className="full-field">
          <span>有效期</span>
          <select
            value={ttlSeconds}
            onChange={(event) => setTtlSeconds(Number(event.target.value))}
          >
            <option value={3600}>1 小时</option>
            <option value={86400}>1 天</option>
            <option value={604800}>7 天</option>
          </select>
          <small>
            环境策略允许{' '}
            {selected
              ? `${selected.policy.minTtlSeconds / 60} 分钟至 ${selected.policy.maxTtlSeconds / 86400} 天`
              : '—'}
            。
          </small>
        </label>
        <div className="boundary-notice compact">
          <ShieldAlert size={17} />
          <span>生成值只在下一步短暂显示。关闭后将主动销毁交付密文。</span>
        </div>
        <footer className="modal-actions">
          <button className="secondary-button" type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button" type="submit" disabled={busy || !environmentId}>
            {busy ? '正在签发…' : '确认生成'}
          </button>
        </footer>
      </form>
    </Modal>
  )
}

export function IssuedTokenModal({
  token,
  onClose,
}: {
  token: IssuedToken | null
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)
  if (!token) return null
  const copy = async () => {
    await navigator.clipboard.writeText(token.token)
    setCopied(true)
    window.setTimeout(() => setCopied(false), 1800)
  }
  return (
    <Modal open title="Token 已生成" eyebrow="COPY IT NOW" onClose={onClose}>
      <div className="modal-body">
        <div className="success-orb">
          <Check size={26} />
        </div>
        <p className="center-copy">
          这是原始 Token 的唯一交付窗口。请立即复制并存放到安全的凭据管理工具。
        </p>
        <div className="secret-box">
          <code>{token.token}</code>
          <button type="button" onClick={() => void copy()}>
            {copied ? <Check size={17} /> : <Clipboard size={17} />}
            {copied ? '已复制' : '复制'}
          </button>
        </div>
        <dl className="token-facts">
          <div>
            <dt>指纹</dt>
            <dd>
              <code>{token.fingerprint}…</code>
            </dd>
          </div>
          <div>
            <dt>过期时间</dt>
            <dd>{formatDateTime(token.expiresAt, dateTimeOptions)}</dd>
          </div>
          <div>
            <dt>Key 状态</dt>
            <dd>
              {token.runtimeState === 'KEY_EFFECTIVE' ? '实例已验证生效' : '已发布，实例未验证'}
            </dd>
          </div>
        </dl>
        <div className="boundary-notice danger compact">
          <AlertTriangle size={17} />
          <span>关闭窗口后，服务端将清除短期交付密文，无法找回此值。</span>
        </div>
        <footer className="modal-actions single">
          <button className="primary-button" type="button" onClick={onClose}>
            我已安全保存
          </button>
        </footer>
      </div>
    </Modal>
  )
}

function DisableTokenModal({
  token,
  onClose,
  onDisabled,
  onError,
}: {
  token: TokenView | null
  onClose: () => void
  onDisabled: () => void
  onError: (message: string) => void
}) {
  const [reason, setReason] = useState('')
  const [compromised, setCompromised] = useState(false)
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!token) return
    setBusy(true)
    try {
      await api.disableToken(token.id, reason, compromised)
      setReason('')
      setCompromised(false)
      onDisabled()
    } catch (error) {
      onError(error instanceof Error ? error.message : '停用失败')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open={Boolean(token)}
      title={`停用 ${token?.name ?? ''}`}
      eyebrow="MANAGEMENT STATE ONLY"
      onClose={onClose}
    >
      <form className="modal-body form-grid" onSubmit={submit}>
        <div className="boundary-notice danger compact">
          <AlertTriangle size={17} />
          <span>该操作只会停用控制台记录，不能让 ai-server 立即拒绝已签 Token。</span>
        </div>
        <label className="full-field">
          <span>停用原因</span>
          <textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={500}
            placeholder="说明停用背景，内容将进入审计日志"
            required
          />
        </label>
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={compromised}
            onChange={(event) => setCompromised(event.target.checked)}
          />
          <span>怀疑凭据已经泄露</span>
        </label>
        <footer className="modal-actions">
          <button className="secondary-button" type="button" onClick={onClose}>
            取消
          </button>
          <button className="danger-button" type="submit" disabled={busy}>
            {busy ? '正在停用…' : '确认停用'}
          </button>
        </footer>
      </form>
    </Modal>
  )
}
