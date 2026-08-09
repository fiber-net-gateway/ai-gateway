import { Clock3, RefreshCw, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'

import { modelAccessApi, type ApplicantAccessRequest } from '../api/model-access'
import { confirmLocalized, formatDateTime } from '../i18n'

function summary(request: ApplicantAccessRequest): string {
  if (request.status === 'PENDING') return '等待管理员审批，授权组尚未变化。'
  if (request.status === 'REJECTED') return request.decisionReason ?? '管理员已拒绝申请。'
  if (request.status === 'CANCELLED') return '申请已取消，授权组没有变化。'
  if (request.publicationState === 'FAILED') return '审批已通过，但授权组发布失败，等待管理员重试。'
  if (request.publicationState === 'PUBLISHED') return '授权组已发布；ai-server 实例生效仍未知。'
  return '审批已通过，授权组正在等待发布。'
}

export function MyAccessRequestsPage({
  environmentId,
  onOpenModel,
  onError,
  onNotice,
}: {
  environmentId: string
  onOpenModel: (modelId: string) => void
  onError: (message: string) => void
  onNotice: (message: string) => void
}) {
  const [items, setItems] = useState<ApplicantAccessRequest[]>([])
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = () =>
    modelAccessApi
      .mine({ environmentId })
      .then((result) => setItems(result.items))
      .catch((error) => onError(error instanceof Error ? error.message : '我的申请加载失败'))
      .finally(() => setLoading(false))

  useEffect(() => {
    void load()
  }, [environmentId])

  const cancel = async (request: ApplicantAccessRequest) => {
    if (!confirmLocalized('取消这条待审批申请？历史记录会保留。')) return
    setBusyId(request.id)
    try {
      await modelAccessApi.cancel(request.id, request.revision)
      onNotice('权限申请已取消，授权组没有变化。')
      await load()
    } catch (error) {
      onError(error instanceof Error ? error.message : '取消申请失败')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="page-shell my-access-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">MY MODEL ACCESS</span>
          <h1>我的权限申请</h1>
          <p>查看申请、审批、rnacos 发布和实例生效四类独立事实。</p>
        </div>
        <button className="secondary-button" type="button" onClick={() => void load()}>
          <RefreshCw size={14} /> 刷新状态
        </button>
      </header>
      <section className="data-card my-access-list">
        {loading && <div className="empty-cell">正在读取我的权限申请…</div>}
        {!loading && items.length === 0 && (
          <div className="empty-cell">
            <ShieldCheck size={23} /> 还没有提交模型权限申请
          </div>
        )}
        {items.map((request) => (
          <article key={request.id}>
            <div>
              <span className="model-identity">{request.logicalModelName}</span>
              <h2>{request.modelDisplayName}</h2>
              <p>{request.reason}</p>
            </div>
            <div className="my-access-state">
              <span className={`status-badge status-${request.status.toLowerCase()}`}>
                {request.status}
              </span>
              <span>rnacos：{request.publicationState}</span>
              <span>实例：{request.activationState}</span>
            </div>
            <p className="my-access-summary">{summary(request)}</p>
            <footer>
              <time dateTime={request.createdAt}>
                <Clock3 size={12} /> {formatDateTime(request.createdAt)}
              </time>
              <div>
                <button
                  className="secondary-button"
                  type="button"
                  onClick={() => onOpenModel(request.modelId)}
                >
                  查看模型
                </button>
                {request.status === 'PENDING' && (
                  <button
                    className="danger-button"
                    type="button"
                    disabled={busyId === request.id}
                    onClick={() => void cancel(request)}
                  >
                    取消申请
                  </button>
                )}
              </div>
            </footer>
          </article>
        ))}
      </section>
    </div>
  )
}
