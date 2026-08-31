import { Activity, LoaderCircle, Search } from 'lucide-react'
import { type FormEvent, useEffect, useRef, useState } from 'react'

import { api, type LlmCallAudit, type LlmCallOutcome } from '../api/client'
import { formatDateTime, formatInteger } from '../i18n'

const dateTimeOptions: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
}

const outcomeLabels: Record<LlmCallOutcome, string> = {
  SUCCEEDED: '成功',
  FAILED: '失败',
  ABORTED: '客户端中断',
}

function duration(value: number): string {
  if (value < 1_000) return `${formatInteger(value)} ms`
  return `${(value / 1_000).toFixed(value < 10_000 ? 2 : 1)} s`
}

function tokenCount(value: number | null): string {
  return value === null ? '—' : formatInteger(value)
}

function mergeCalls(current: LlmCallAudit[], incoming: LlmCallAudit[]): LlmCallAudit[] {
  const ids = new Set(current.map((item) => item.id))
  return [...current, ...incoming.filter((item) => !ids.has(item.id))]
}

export function MyLlmCallsPage({
  environmentId,
  onError,
}: {
  environmentId: string
  onError: (message: string) => void
}) {
  const [items, setItems] = useState<LlmCallAudit[]>([])
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [outcome, setOutcome] = useState<LlmCallOutcome | ''>('')
  const [protocol, setProtocol] = useState('')
  const generation = useRef(0)

  useEffect(() => {
    const requestGeneration = ++generation.current
    setLoading(true)
    setNextCursor(null)
    api
      .llmCallAudits({
        environmentId,
        limit: 25,
        outcome: outcome || undefined,
        protocol: protocol || undefined,
        search: search || undefined,
      })
      .then((result) => {
        if (generation.current !== requestGeneration) return
        setItems(result.items)
        setNextCursor(result.nextCursor)
      })
      .catch((error: unknown) => {
        if (generation.current !== requestGeneration) return
        onError(error instanceof Error ? error.message : '调用记录加载失败')
      })
      .finally(() => {
        if (generation.current === requestGeneration) setLoading(false)
      })
  }, [environmentId, outcome, protocol, search])

  const submitSearch = (event: FormEvent) => {
    event.preventDefault()
    setSearch(searchInput.trim())
  }

  const loadMore = async () => {
    if (!nextCursor || loadingMore) return
    const requestGeneration = generation.current
    setLoadingMore(true)
    try {
      const result = await api.llmCallAudits({
        environmentId,
        cursor: nextCursor,
        limit: 25,
        outcome: outcome || undefined,
        protocol: protocol || undefined,
        search: search || undefined,
      })
      if (generation.current !== requestGeneration) return
      setItems((current) => mergeCalls(current, result.items))
      setNextCursor(result.nextCursor)
    } catch (error) {
      if (generation.current === requestGeneration) {
        onError(error instanceof Error ? error.message : '更多调用记录加载失败')
      }
    } finally {
      if (generation.current === requestGeneration) setLoadingMore(false)
    }
  }

  const filtered = Boolean(search || outcome || protocol)
  return (
    <div className="page-shell llm-calls-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">MY API ACTIVITY</span>
          <h1>我的调用记录</h1>
          <p>查看 ai-server 已上报并由 console 接收的接口、结果、耗时和 Token 用量。</p>
        </div>
      </header>

      <aside className="call-audit-boundary" aria-label="记录范围说明">
        <Activity size={17} />
        <p>
          <b>最小审计投影</b>
          <span>
            此处不保存请求正文、模型回复或 Provider 路由详情；暂无记录只表示尚未收到上报。
          </span>
        </p>
      </aside>

      <section className="data-card call-audit-card">
        <div className="card-heading call-audit-heading">
          <div>
            <h2>最近调用</h2>
            <p>按调用时间倒序，个人接口不会返回其他用户记录。</p>
          </div>
          <form className="call-audit-filters" onSubmit={submitSearch}>
            <label className="search-field">
              <Search size={16} />
              <input
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="request ID、路径或模型"
                aria-label="筛选调用记录"
              />
            </label>
            <button className="secondary-button" type="submit">
              查询
            </button>
            <label>
              <span>结果</span>
              <select
                value={outcome}
                onChange={(event) => setOutcome(event.target.value as LlmCallOutcome | '')}
                aria-label="按调用结果筛选"
              >
                <option value="">全部结果</option>
                <option value="SUCCEEDED">成功</option>
                <option value="FAILED">失败</option>
                <option value="ABORTED">客户端中断</option>
              </select>
            </label>
            <label>
              <span>协议</span>
              <select
                value={protocol}
                onChange={(event) => setProtocol(event.target.value)}
                aria-label="按客户端协议筛选"
              >
                <option value="">全部协议</option>
                <option value="openai">OpenAI</option>
                <option value="anthropic">Anthropic</option>
              </select>
            </label>
          </form>
        </div>

        <div className="table-wrap" aria-busy={loading || loadingMore}>
          <table className="call-audit-table">
            <thead>
              <tr>
                <th>调用时间 / Request ID</th>
                <th>接口</th>
                <th>请求模型</th>
                <th>协议</th>
                <th>结果</th>
                <th>耗时</th>
                <th>Token 用量</th>
              </tr>
            </thead>
            <tbody>
              {loading && items.length === 0 && (
                <tr>
                  <td className="empty-cell" colSpan={7}>
                    <LoaderCircle className="spin" size={22} /> 正在读取调用记录…
                  </td>
                </tr>
              )}
              {!loading && items.length === 0 && (
                <tr>
                  <td className="empty-cell" colSpan={7}>
                    <Activity size={22} />
                    {filtered ? '暂无匹配记录' : '尚未收到 ai-server 上报的调用记录'}
                  </td>
                </tr>
              )}
              {items.map((call) => (
                <tr key={call.id}>
                  <td className="date-stack call-time">
                    <span>{formatDateTime(call.occurredAt, dateTimeOptions)}</span>
                    <code title={call.requestId}>{call.requestId}</code>
                  </td>
                  <td className="primary-cell call-endpoint">
                    <b>{call.method}</b>
                    <code title={call.path}>{call.path}</code>
                  </td>
                  <td>
                    <code>{call.requestedModel || '—'}</code>
                  </td>
                  <td>
                    <span className="call-protocol">{call.clientProtocol}</span>
                    <small>{call.stream ? '流式' : '非流式'}</small>
                  </td>
                  <td>
                    <span className={`status-badge call-outcome-${call.outcome.toLowerCase()}`}>
                      {outcomeLabels[call.outcome]}
                    </span>
                    <small className="call-http-status">HTTP {call.responseStatus}</small>
                  </td>
                  <td>{duration(call.durationMs)}</td>
                  <td className="call-usage">
                    <span>
                      输入 {tokenCount(call.usage.promptTokens)} · 输出 {tokenCount(call.usage.out)}
                    </span>
                    <small>
                      {call.usage.inCache === null || call.usage.inNoCache === null
                        ? '缓存明细未知'
                        : `缓存 ${tokenCount(call.usage.inCache)} · 非缓存 ${tokenCount(call.usage.inNoCache)}`}
                      {' · '}合计 {tokenCount(call.usage.totalTokens)}
                    </small>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {nextCursor && (
          <footer className="call-audit-footer">
            <button
              className="secondary-button"
              type="button"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore ? <LoaderCircle className="spin" size={14} /> : null}
              {loadingMore ? '正在加载…' : '加载更多'}
            </button>
          </footer>
        )}
      </section>
    </div>
  )
}
