import { FileClock, Search } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import { api, type AuditEvent } from '../api/client'
import { formatDateTime } from '../i18n'

const eventLabels: Record<string, string> = {
  'session.created': '创建登录会话',
  'user.created': '创建用户',
  'user.updated': '更新用户',
  'token.issued': '签发 Token',
  'token.disabled': '停用 Token',
  'model_access.request.created': '提交模型权限申请',
  'model_access.request.cancelled': '取消模型权限申请',
  'model_access.request.approved': '批准模型权限申请',
  'model_access.request.rejected': '拒绝模型权限申请',
  'model_access.group.publication_succeeded': '发布模型授权组',
  'model_access.group.publication_failed': '模型授权组发布失败',
}
const dateTimeOptions: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
}

export function AuditPage({ onError }: { onError: (message: string) => void }) {
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    api
      .auditEvents()
      .then((result) => setEvents(result.items))
      .catch((error: unknown) =>
        onError(error instanceof Error ? error.message : '加载审计事件失败'),
      )
      .finally(() => setLoading(false))
  }, [])
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase()
    if (!normalized) return events
    return events.filter((event) =>
      `${event.eventType} ${event.targetType} ${event.reason ?? ''} ${event.correlationId}`
        .toLowerCase()
        .includes(normalized),
    )
  }, [events, query])
  return (
    <div className="page-shell">
      <header className="page-header">
        <div>
          <span className="eyebrow">IMMUTABLE TRAIL</span>
          <h1>审计事件</h1>
          <p>查看用户、会话与 BT1 Token 的安全操作记录。</p>
        </div>
      </header>
      <section className="data-card audit-card">
        <div className="card-heading users-heading">
          <div>
            <h2>最近事件</h2>
            <p>按服务端序列号倒序展示，敏感值不会进入事件载荷。</p>
          </div>
          <label className="search-field">
            <Search size={16} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="筛选事件或关联 ID"
              aria-label="筛选审计事件"
            />
          </label>
        </div>
        <div className="audit-list">
          {loading && <div className="empty-cell">正在加载…</div>}
          {!loading && visible.length === 0 && (
            <div className="empty-cell">
              <FileClock size={22} />
              暂无匹配事件
            </div>
          )}
          {visible.map((event) => (
            <article key={event.id}>
              <div className="audit-sequence">#{String(event.sequenceNo).padStart(4, '0')}</div>
              <span className={`audit-icon event-${event.eventType.split('.')[0]}`}>
                <FileClock size={17} />
              </span>
              <div className="audit-copy">
                <div>
                  <h3>{eventLabels[event.eventType] ?? event.eventType}</h3>
                  <code>{event.eventType}</code>
                </div>
                <p>
                  {event.actorRole ? `${event.actorRole} · ` : 'SYSTEM · '}
                  {event.targetType}
                  {event.targetId ? ` / ${event.targetId.slice(0, 8)}` : ''}
                </p>
                {event.reason && <blockquote>{event.reason}</blockquote>}
              </div>
              <div className="audit-meta">
                <time>{formatDateTime(event.occurredAt, dateTimeOptions)}</time>
                <code title={event.correlationId}>{event.correlationId.slice(0, 12)}</code>
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  )
}
