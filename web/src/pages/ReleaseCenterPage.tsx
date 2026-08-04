import {
  AlertTriangle,
  CheckCircle2,
  CloudUpload,
  Database,
  FileLock2,
  RefreshCw,
  RotateCw,
  ServerCog,
} from 'lucide-react'
import { useEffect, useState } from 'react'

import {
  modelMarketplaceApi,
  type MarketplaceRelease,
  type MarketplaceReleaseDetail,
  type ReleaseResourceState,
  type ReleaseWorkflowState,
} from '../api/model-marketplace'

const workflowLabels: Record<ReleaseWorkflowState, string> = {
  PENDING: '待执行',
  PUBLISHING: '发布中',
  COMPLETED: '写入完成',
  FAILED: '发布失败',
  CANCELLED: '已取消',
}

const resourceLabels: Record<ReleaseResourceState, string> = {
  PENDING: '待写入',
  WRITING: '写入中',
  PUBLISHED: '已发布',
  FAILED: '失败',
  SKIPPED: '内容已一致',
}

export function ReleaseCenterPage({
  environmentId,
  releaseId,
  onOpenRelease,
  onError,
  onNotice,
  onInfo,
}: {
  environmentId: string
  releaseId: string | null
  onOpenRelease: (releaseId: string) => void
  onError: (message: string) => void
  onNotice: (message: string) => void
  onInfo: (message: string) => void
}) {
  const [releases, setReleases] = useState<MarketplaceRelease[]>([])
  const [detail, setDetail] = useState<MarketplaceReleaseDetail | null>(null)
  const [draft, setDraft] = useState<{ id: string; revision: number; etag: string } | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [refreshEpoch, setRefreshEpoch] = useState(0)

  const loadList = async () => {
    const [releaseResult, draftResult] = await Promise.all([
      modelMarketplaceApi.listReleases(environmentId),
      modelMarketplaceApi.listAdmin(environmentId),
    ])
    setReleases(releaseResult.items)
    setDraft({
      id: draftResult.data.draft.id,
      revision: draftResult.data.draft.revision,
      etag: draftResult.etag ?? `"${draftResult.data.draft.revision}"`,
    })
    return releaseResult.items
  }

  useEffect(() => {
    let alive = true
    setLoading(true)
    void loadList()
      .then((items) => {
        if (!alive) return
        if (!releaseId && items[0]) onOpenRelease(items[0].id)
      })
      .catch((error) => onError(error instanceof Error ? error.message : 'Release 列表加载失败'))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [environmentId])

  useEffect(() => {
    if (!releaseId) {
      setDetail(null)
      return
    }
    setDetail((current) => (current?.id === releaseId ? current : null))
    let alive = true
    let timer: number | undefined
    const load = async () => {
      try {
        const next = await modelMarketplaceApi.release(environmentId, releaseId)
        if (!alive) return
        setDetail(next)
        setReleases((current) =>
          current.map((release) => (release.id === next.id ? next : release)),
        )
        if (next.state === 'PUBLISHING') {
          timer = window.setTimeout(() => void load(), 1_200)
        } else {
          void loadList().catch(() => undefined)
        }
      } catch (error) {
        if (alive) onError(error instanceof Error ? error.message : 'Release 详情加载失败')
      }
    }
    void load()
    return () => {
      alive = false
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [environmentId, releaseId, refreshEpoch])

  const freeze = async () => {
    if (!draft) return
    setBusy(true)
    try {
      const validation = await modelMarketplaceApi.validate(environmentId, draft.id)
      if (!validation.data.valid) {
        onError(`草稿存在 ${validation.data.issues.length} 个阻塞问题，请先返回模型广场修正。`)
        return
      }
      const result = await modelMarketplaceApi.submit(environmentId, draft.id, draft.etag)
      setDraft({ ...draft, revision: result.data.draftRevision, etag: result.etag ?? draft.etag })
      await loadList()
      onNotice(result.data.message)
      onOpenRelease(result.data.release.id)
    } catch (error) {
      onError(error instanceof Error ? error.message : '创建 Release 失败')
    } finally {
      setBusy(false)
    }
  }

  const execute = async () => {
    if (!detail) return
    const verb = detail.state === 'FAILED' ? '重试' : '执行'
    if (
      !window.confirm(
        `${verb} Release #${detail.releaseNumber}？编排器将按 Provider → models 的顺序写入 rnacos。`,
      )
    )
      return
    setBusy(true)
    try {
      const next =
        detail.state === 'FAILED'
          ? await modelMarketplaceApi.retryRelease(environmentId, detail.id)
          : await modelMarketplaceApi.executeRelease(environmentId, detail.id)
      setDetail(next)
      setRefreshEpoch((current) => current + 1)
      onInfo(`Release #${detail.releaseNumber} 已进入发布编排。`)
    } catch (error) {
      onError(error instanceof Error ? error.message : `${verb} Release 失败`)
    } finally {
      setBusy(false)
    }
  }

  const activeRelease = releases.some(
    (release) => release.state === 'PENDING' || release.state === 'PUBLISHING',
  )

  return (
    <div className="page-shell release-center-page">
      <header className="page-header release-center-header">
        <div>
          <span className="eyebrow">ENVIRONMENT RELEASE ORCHESTRATION</span>
          <h1>发布中心</h1>
          <p>冻结 MySQL 草稿，并逐项核对 rnacos 写入证据；实例生效仍保持 UNKNOWN。</p>
        </div>
        <button
          className="primary-button"
          type="button"
          disabled={busy || activeRelease || !draft}
          onClick={() => void freeze()}
        >
          <FileLock2 size={16} /> 创建待发布 Release
        </button>
      </header>

      <section className="marketplace-boundary" aria-label="发布状态边界">
        <span>
          <b>01</b> 冻结版本 <small>MySQL immutable snapshot</small>
        </span>
        <i />
        <span>
          <b>02</b> 发布编排 <small>Provider → models</small>
        </span>
        <i />
        <span>
          <b>03</b> 实例生效 <small>等待 ai-server 接受证据</small>
        </span>
      </section>

      <div className="release-layout">
        <aside className="release-list data-card">
          <div className="card-heading">
            <div>
              <h2>Release 历史</h2>
              <p>当前草稿 revision {draft?.revision ?? '—'}</p>
            </div>
            <button
              className="icon-button"
              type="button"
              aria-label="刷新 Release 列表"
              onClick={() => {
                setRefreshEpoch((current) => current + 1)
                void loadList().catch((error) =>
                  onError(error instanceof Error ? error.message : '刷新失败'),
                )
              }}
            >
              <RefreshCw size={14} />
            </button>
          </div>
          {loading && <div className="release-list-empty">正在读取发布历史…</div>}
          {!loading && releases.length === 0 && (
            <div className="release-list-empty">尚未创建 Release。</div>
          )}
          {releases.map((release) => (
            <button
              type="button"
              className={`release-list-item${release.id === releaseId ? ' active' : ''}`}
              key={release.id}
              onClick={() => onOpenRelease(release.id)}
            >
              <span>
                <b>Release #{release.releaseNumber}</b>
                <small>{new Date(release.createdAt).toLocaleString('zh-CN')}</small>
              </span>
              <ReleaseBadge state={release.state} />
            </button>
          ))}
        </aside>

        <main className="release-detail data-card">
          {!detail ? (
            <div className="release-empty-detail">
              <CloudUpload size={28} />
              <h2>选择一个 Release 查看发布证据</h2>
              <p>Provider Token 明文不会出现在页面、审计或资源差异中。</p>
            </div>
          ) : (
            <>
              <div className="release-detail-heading">
                <div>
                  <span className="eyebrow">RELEASE #{detail.releaseNumber}</span>
                  <h2>{workflowLabels[detail.state]}</h2>
                  <p>
                    Publication: <b>{detail.publicationState}</b> · Activation:{' '}
                    <b>{detail.activationState}</b>
                  </p>
                </div>
                {(detail.state === 'PENDING' || detail.state === 'FAILED') && (
                  <button
                    className="primary-button"
                    type="button"
                    disabled={busy || !detail.target}
                    title={detail.target ? undefined : '当前进程未绑定 rnacos 发布目标'}
                    onClick={() => void execute()}
                  >
                    {detail.state === 'FAILED' ? <RotateCw size={15} /> : <CloudUpload size={15} />}
                    {detail.state === 'FAILED' ? '重试失败项' : '执行 rnacos 发布'}
                  </button>
                )}
              </div>

              <div className="release-evidence-grid">
                <div>
                  <Database size={16} />
                  <span>
                    <small>冻结版本</small>
                    <code>{short(detail.versionId, 18)}</code>
                  </span>
                </div>
                <div>
                  <ServerCog size={16} />
                  <span>
                    <small>rnacos 目标</small>
                    <code>
                      {detail.target
                        ? `${detail.target.namespaceId || 'public'} / ${detail.target.group}`
                        : '未绑定'}
                    </code>
                  </span>
                </div>
                <div>
                  <AlertTriangle size={16} />
                  <span>
                    <small>实例证据</small>
                    <code>UNKNOWN / NONE</code>
                  </span>
                </div>
              </div>

              {detail.groupDependencies.length > 0 && (
                <section className="release-dependencies">
                  <h3>用户组依赖</h3>
                  {detail.groupDependencies.map((group) => (
                    <div key={group.id}>
                      {group.state === 'READY' ? (
                        <CheckCircle2 size={15} />
                      ) : (
                        <AlertTriangle size={15} />
                      )}
                      <span>{group.name}</span>
                      <code>
                        {group.publishedRevision ?? 0} / {group.revision ?? 'missing'}
                      </code>
                    </div>
                  ))}
                </section>
              )}

              <section className="release-risk-callout">
                <AlertTriangle size={16} />
                <span>
                  <b>Provider 提前生效风险</b>
                  <small>
                    已被线上 models 引用的 Provider 会在自身 Data ID 写入后立即影响请求；多个 Data
                    ID 不构成事务。
                  </small>
                </span>
              </section>

              <section className="release-resources">
                <header>
                  <h3>逐资源写入证据</h3>
                  <span>{detail.resources.length} DATA IDS</span>
                </header>
                {detail.resources
                  .slice()
                  .sort((left, right) => left.dependencyOrder - right.dependencyOrder)
                  .map((resource) => (
                    <article
                      key={resource.id}
                      className={`resource-${resource.state.toLowerCase()}`}
                    >
                      <div className="release-resource-title">
                        <span>{resource.dependencyOrder + 1}</span>
                        <div>
                          <b>{resource.kind}</b>
                          <code>{resource.dataId}</code>
                        </div>
                        <ResourceBadge state={resource.state} />
                      </div>
                      <dl>
                        <div>
                          <dt>写前 MD5</dt>
                          <dd>{short(resource.oldMd5)}</dd>
                        </div>
                        <div>
                          <dt>回读 MD5</dt>
                          <dd>{short(resource.newMd5)}</dd>
                        </div>
                        <div>
                          <dt>内容字节</dt>
                          <dd>{resource.contentBytes ?? '—'}</dd>
                        </div>
                        <div>
                          <dt>写入次数</dt>
                          <dd>{resource.retryCount}</dd>
                        </div>
                      </dl>
                      {resource.errorCode && (
                        <p className="release-resource-error">
                          <b>{resource.errorCode}</b>
                          <span>{resource.safeErrorMessage}</span>
                        </p>
                      )}
                    </article>
                  ))}
              </section>
            </>
          )}
        </main>
      </div>
    </div>
  )
}

function ReleaseBadge({ state }: { state: ReleaseWorkflowState }) {
  return (
    <span className={`release-badge state-${state.toLowerCase()}`}>{workflowLabels[state]}</span>
  )
}

function ResourceBadge({ state }: { state: ReleaseResourceState }) {
  return (
    <span className={`release-badge state-${state.toLowerCase()}`}>{resourceLabels[state]}</span>
  )
}

function short(value: string | null, length = 12): string {
  return value ? `${value.slice(0, length)}${value.length > length ? '…' : ''}` : '—'
}
