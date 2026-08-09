import {
  AlertTriangle,
  KeyRound,
  Plus,
  Search,
  Shield,
  Trash2,
  UserRound,
  UsersRound,
} from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'

import {
  api,
  type EnvironmentAccess,
  type IssuedToken,
  type SystemRole,
  type TokenView,
  type User,
  type UserStatus,
} from '../api/client'
import { Modal } from '../components/Modal'
import { StatusBadge } from '../components/StatusBadge'
import { formatDateTime } from '../i18n'

const dateTimeOptions: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
}

interface UsersPageProps {
  environments: EnvironmentAccess[]
  currentUser: User
  onError: (message: string) => void
  onIssued: (token: IssuedToken) => void
}

export function UsersPage({ environments, currentUser, onError, onIssued }: UsersPageProps) {
  const [users, setUsers] = useState<User[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [createOpen, setCreateOpen] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const load = async (term = search) => {
    setLoading(true)
    try {
      setUsers((await api.users(term)).items)
    } catch (error) {
      onError(error instanceof Error ? error.message : '加载用户失败')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void load('')
  }, [])

  const submitSearch = (event: FormEvent) => {
    event.preventDefault()
    void load()
  }
  const adminCount = users.filter(
    (user) => user.systemRole === 'ADMIN' && user.status === 'ACTIVE',
  ).length
  const activeCount = users.filter((user) => user.status === 'ACTIVE').length

  return (
    <div className="page-shell">
      <header className="page-header">
        <div>
          <span className="eyebrow">IDENTITY &amp; ACCESS</span>
          <h1>用户与角色</h1>
          <p>管理控制台身份、系统角色和环境访问资格。</p>
        </div>
        <button className="primary-button" type="button" onClick={() => setCreateOpen(true)}>
          <Plus size={17} /> 新建用户
        </button>
      </header>

      <section className="metric-grid user-metrics">
        <article>
          <span className="metric-icon lime">
            <UsersRound size={19} />
          </span>
          <p>
            用户总数<b>{users.length}</b>
            <small>{activeCount} 个有效账号</small>
          </p>
        </article>
        <article>
          <span className="metric-icon blue">
            <Shield size={19} />
          </span>
          <p>
            有效管理员<b>{adminCount}</b>
            <small>系统至少保留 1 位</small>
          </p>
        </article>
        <article>
          <span className="metric-icon orange">
            <UserRound size={19} />
          </span>
          <p>
            待首次登录<b>{users.filter((user) => user.status === 'PENDING').length}</b>
            <small>登录后自动激活</small>
          </p>
        </article>
      </section>

      <section className="data-card">
        <div className="card-heading users-heading">
          <div>
            <h2>用户目录</h2>
            <p>username 创建后不可变，并作为 BT1 principal。</p>
          </div>
          <form className="search-field" onSubmit={submitSearch}>
            <Search size={16} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索用户名、姓名或邮箱"
              aria-label="搜索用户"
            />
            <button className="sr-only" type="submit">
              搜索
            </button>
          </form>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>用户</th>
                <th>系统角色</th>
                <th>认证来源</th>
                <th>最后登录</th>
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
              {!loading && users.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty-cell">
                    没有匹配的用户
                  </td>
                </tr>
              )}
              {users.map((user) => (
                <tr key={user.id}>
                  <td>
                    <div className="user-cell">
                      <span className="avatar table-avatar">
                        {user.displayName.slice(0, 1).toUpperCase()}
                      </span>
                      <p>
                        <b>{user.displayName}</b>
                        <code>@{user.username}</code>
                      </p>
                    </div>
                  </td>
                  <td>
                    <span className={`role-badge role-${user.systemRole.toLowerCase()}`}>
                      {user.systemRole === 'ADMIN' ? <Shield size={13} /> : <UserRound size={13} />}
                      {user.systemRole === 'ADMIN' ? '管理员' : '普通用户'}
                    </span>
                  </td>
                  <td>
                    <code>{user.authProvider}</code>
                  </td>
                  <td>
                    {user.lastLoginAt
                      ? formatDateTime(user.lastLoginAt, dateTimeOptions)
                      : '从未登录'}
                  </td>
                  <td>
                    <StatusBadge status={user.status} />
                  </td>
                  <td className="row-actions">
                    <button
                      className="text-button"
                      type="button"
                      onClick={() => setSelectedId(user.id)}
                    >
                      查看
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <CreateUserModal
        open={createOpen}
        environments={environments}
        onClose={() => setCreateOpen(false)}
        onCreated={() => {
          setCreateOpen(false)
          void load()
        }}
        onError={onError}
      />
      <UserDetailModal
        userId={selectedId}
        currentUser={currentUser}
        onClose={() => setSelectedId(null)}
        onChanged={() => void load()}
        onError={onError}
        onIssued={onIssued}
      />
    </div>
  )
}

function CreateUserModal({
  open,
  environments,
  onClose,
  onCreated,
  onError,
}: {
  open: boolean
  environments: EnvironmentAccess[]
  onClose: () => void
  onCreated: () => void
  onError: (message: string) => void
}) {
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<SystemRole>('USER')
  const [externalSubject, setExternalSubject] = useState('')
  const [selectedEnvironments, setSelectedEnvironments] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setBusy(true)
    try {
      await api.createUser({
        username,
        displayName,
        email: email || null,
        systemRole: role,
        externalSubject: externalSubject || undefined,
        environmentIds: selectedEnvironments,
      })
      setUsername('')
      setDisplayName('')
      setEmail('')
      setExternalSubject('')
      setRole('USER')
      setSelectedEnvironments([])
      onCreated()
    } catch (error) {
      onError(error instanceof Error ? error.message : '创建用户失败')
    } finally {
      setBusy(false)
    }
  }
  const toggleEnvironment = (id: string) => {
    setSelectedEnvironments((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    )
  }
  return (
    <Modal open={open} title="新建控制台用户" eyebrow="PROVISION IDENTITY" onClose={onClose}>
      <form className="modal-body form-grid two-columns" onSubmit={submit}>
        <label>
          <span>username</span>
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            maxLength={64}
            placeholder="li.ming"
            required
          />
          <small>创建后不可修改</small>
        </label>
        <label>
          <span>显示名称</span>
          <input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            maxLength={128}
            placeholder="李明"
            required
          />
        </label>
        <label>
          <span>邮箱</span>
          <input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="li.ming@example.com"
          />
        </label>
        <label>
          <span>系统角色</span>
          <select value={role} onChange={(event) => setRole(event.target.value as SystemRole)}>
            <option value="USER">普通用户</option>
            <option value="ADMIN">管理员</option>
          </select>
        </label>
        <label className="full-field">
          <span>SSO Subject（可选）</span>
          <input
            value={externalSubject}
            onChange={(event) => setExternalSubject(event.target.value)}
            maxLength={255}
            placeholder="开发模式下默认使用 username"
          />
        </label>
        <fieldset className="full-field checkbox-group">
          <legend>环境授权</legend>
          {environments.map((item) => (
            <label key={item.environment.id}>
              <input
                type="checkbox"
                checked={selectedEnvironments.includes(item.environment.id)}
                onChange={() => toggleEnvironment(item.environment.id)}
              />
              <span>
                <b>{item.environment.name}</b>
                <small>{item.environment.stage}</small>
              </span>
            </label>
          ))}
        </fieldset>
        <footer className="modal-actions full-field">
          <button className="secondary-button" type="button" onClick={onClose}>
            取消
          </button>
          <button className="primary-button" type="submit" disabled={busy}>
            {busy ? '正在创建…' : '创建用户'}
          </button>
        </footer>
      </form>
    </Modal>
  )
}

function UserDetailModal({
  userId,
  currentUser,
  onClose,
  onChanged,
  onError,
  onIssued,
}: {
  userId: string | null
  currentUser: User
  onClose: () => void
  onChanged: () => void
  onError: (message: string) => void
  onIssued: (token: IssuedToken) => void
}) {
  const [detail, setDetail] = useState<{
    user: User
    environments: EnvironmentAccess[]
    tokens: TokenView[]
  } | null>(null)
  const [role, setRole] = useState<SystemRole>('USER')
  const [status, setStatus] = useState<UserStatus>('ACTIVE')
  const [saving, setSaving] = useState(false)
  const [tokenName, setTokenName] = useState('')
  const [tokenReason, setTokenReason] = useState('')
  const [tokenBusy, setTokenBusy] = useState(false)
  const [disableTarget, setDisableTarget] = useState<TokenView | null>(null)
  const [disableReason, setDisableReason] = useState('')
  const [compromised, setCompromised] = useState(false)
  const [disableBusy, setDisableBusy] = useState(false)

  const load = async () => {
    if (!userId) return
    try {
      const result = await api.user(userId)
      setDetail(result)
      setRole(result.user.systemRole)
      setStatus(result.user.status)
    } catch (error) {
      onError(error instanceof Error ? error.message : '加载用户详情失败')
    }
  }
  useEffect(() => {
    setDetail(null)
    void load()
  }, [userId])
  const save = async () => {
    if (!detail) return
    setSaving(true)
    try {
      const result = await api.updateUser(detail.user.id, {
        systemRole: role,
        status,
        revision: detail.user.revision,
      })
      setDetail({ ...detail, user: result.user })
      onChanged()
    } catch (error) {
      onError(error instanceof Error ? error.message : '更新用户失败')
    } finally {
      setSaving(false)
    }
  }
  const issue = async (event: FormEvent) => {
    event.preventDefault()
    if (!detail?.environments[0]) return
    setTokenBusy(true)
    try {
      const token = await api.issueUserToken(detail.user.id, {
        environmentId: detail.environments[0].environment.id,
        name: tokenName,
        ttlSeconds: detail.environments[0].policy.defaultTtlSeconds,
        reason: tokenReason,
      })
      setTokenName('')
      setTokenReason('')
      onIssued(token)
      await load()
    } catch (error) {
      onError(error instanceof Error ? error.message : '管理员代签失败')
    } finally {
      setTokenBusy(false)
    }
  }
  const disable = async (event: FormEvent) => {
    event.preventDefault()
    if (!detail || !disableTarget) return
    setDisableBusy(true)
    try {
      await api.disableUserToken(detail.user.id, disableTarget.id, disableReason, compromised)
      setDisableTarget(null)
      setDisableReason('')
      setCompromised(false)
      await load()
      onChanged()
    } catch (error) {
      onError(error instanceof Error ? error.message : '停用 Token 失败')
    } finally {
      setDisableBusy(false)
    }
  }
  return (
    <>
      <Modal
        open={Boolean(userId)}
        title={detail?.user.displayName ?? '用户详情'}
        eyebrow={detail ? `@${detail.user.username}` : 'LOADING'}
        wide
        onClose={onClose}
      >
        {!detail ? (
          <div className="modal-loading">正在加载…</div>
        ) : (
          <div className="modal-body detail-layout">
            <section className="detail-section">
              <h3>身份与角色</h3>
              <dl className="identity-facts">
                <div>
                  <dt>邮箱</dt>
                  <dd>{detail.user.email ?? '未设置'}</dd>
                </div>
                <div>
                  <dt>认证来源</dt>
                  <dd>
                    <code>{detail.user.authProvider}</code>
                  </dd>
                </div>
                <div>
                  <dt>最后登录</dt>
                  <dd>
                    {detail.user.lastLoginAt
                      ? formatDateTime(detail.user.lastLoginAt, dateTimeOptions)
                      : '从未登录'}
                  </dd>
                </div>
                <div>
                  <dt>数据版本</dt>
                  <dd>rev.{detail.user.revision}</dd>
                </div>
              </dl>
              <div className="form-grid two-columns inset-form">
                <label>
                  <span>系统角色</span>
                  <select
                    value={role}
                    disabled={detail.user.id === currentUser.id}
                    onChange={(event) => setRole(event.target.value as SystemRole)}
                  >
                    <option value="USER">普通用户</option>
                    <option value="ADMIN">管理员</option>
                  </select>
                </label>
                <label>
                  <span>账号状态</span>
                  <select
                    value={status}
                    onChange={(event) => setStatus(event.target.value as UserStatus)}
                  >
                    <option value="PENDING">待首次登录</option>
                    <option value="ACTIVE">有效</option>
                    <option value="SUSPENDED">暂停</option>
                    <option value="DELETED">删除</option>
                  </select>
                </label>
                <button
                  className="secondary-button full-field"
                  type="button"
                  onClick={() => void save()}
                  disabled={saving}
                >
                  {saving ? '正在保存…' : '保存角色与状态'}
                </button>
              </div>
            </section>
            <section className="detail-section">
              <div className="section-inline">
                <h3>BT1 Token</h3>
                <span>{detail.tokens.length} ITEMS</span>
              </div>
              <div className="mini-token-list">
                {detail.tokens.length === 0 && <p className="subtle">该用户尚无 Token。</p>}
                {detail.tokens.map((token) => (
                  <div key={token.id}>
                    <span className="metric-icon tiny">
                      <KeyRound size={14} />
                    </span>
                    <p>
                      <b>{token.name}</b>
                      <code>{token.fingerprint}…</code>
                    </p>
                    <span className="mini-token-actions">
                      <StatusBadge status={token.state} />
                      <button
                        type="button"
                        aria-label={`停用 ${token.name}`}
                        disabled={token.state === 'DISABLED' || token.state === 'EXPIRED'}
                        onClick={() => setDisableTarget(token)}
                      >
                        <Trash2 size={14} />
                      </button>
                    </span>
                  </div>
                ))}
              </div>
              <form className="admin-issue-form" onSubmit={issue}>
                <h4>管理员代签</h4>
                {detail.environments.length ? (
                  <>
                    <label>
                      <span>Token 名称</span>
                      <input
                        value={tokenName}
                        onChange={(event) => setTokenName(event.target.value)}
                        maxLength={64}
                        required
                      />
                    </label>
                    <label>
                      <span>代签原因</span>
                      <textarea
                        value={tokenReason}
                        onChange={(event) => setTokenReason(event.target.value)}
                        maxLength={500}
                        required
                      />
                    </label>
                    <button className="primary-button" type="submit" disabled={tokenBusy}>
                      {tokenBusy ? '正在签发…' : '生成一次性交付 Token'}
                    </button>
                  </>
                ) : (
                  <p className="subtle">用户没有环境授权，不能代签。</p>
                )}
              </form>
            </section>
          </div>
        )}
      </Modal>
      <Modal
        open={Boolean(disableTarget)}
        title={`停用 ${disableTarget?.name ?? ''}`}
        eyebrow="ADMINISTRATOR ACTION"
        onClose={() => setDisableTarget(null)}
      >
        <form className="modal-body form-grid" onSubmit={disable}>
          <div className="boundary-notice danger compact">
            <AlertTriangle size={17} />
            <span>停用会记录管理员和原因，但不能让 ai-server 立即撤销已签凭据。</span>
          </div>
          <label className="full-field">
            <span>停用原因</span>
            <textarea
              value={disableReason}
              onChange={(event) => setDisableReason(event.target.value)}
              maxLength={500}
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
            <button
              className="secondary-button"
              type="button"
              onClick={() => setDisableTarget(null)}
            >
              取消
            </button>
            <button className="danger-button" type="submit" disabled={disableBusy}>
              {disableBusy ? '正在停用…' : '确认停用'}
            </button>
          </footer>
        </form>
      </Modal>
    </>
  )
}
