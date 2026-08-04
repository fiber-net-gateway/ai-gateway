import { Check, Clock3, FileCheck2, RefreshCw, Search, ShieldQuestion, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import {
  modelAccessApi,
  type AdminAccessRequest,
  type ModelAccessRequestStatus,
} from '../api/model-access'
import { Modal } from '../components/Modal'

const statusLabel: Record<ModelAccessRequestStatus, string> = {
  PENDING: '待审批',
  APPROVED: '已批准',
  REJECTED: '已拒绝',
  CANCELLED: '已取消',
}

export function AccessRequestsPage({
  environmentId,
  onError,
  onNotice,
}: {
  environmentId: string
  onError: (message: string) => void
  onNotice: (message: string) => void
}) {
  const [items, setItems] = useState<AdminAccessRequest[]>([])
  const [status, setStatus] = useState<ModelAccessRequestStatus | ''>('PENDING')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [decision, setDecision] = useState<{
    request: AdminAccessRequest
    kind: 'approve' | 'reject'
  } | null>(null)
  const [reason, setReason] = useState('')

  const load = () => {
    setLoading(true)
    return modelAccessApi
      .listAdmin({ environmentId, status: status || undefined, search })
      .then((result) => setItems(result.items))
      .catch((error) => onError(error instanceof Error ? error.message : '权限申请加载失败'))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 150)
    return () => window.clearTimeout(timer)
  }, [environmentId, search, status])

  const pendingCount = useMemo(
    () => items.filter((request) => request.status === 'PENDING').length,
    [items],
  )

  const decide = async () => {
    if (!decision) return
    if (decision.kind === 'reject' && !reason.trim()) {
      onError('拒绝申请必须填写原因')
      return
    }
    setBusy(true)
    try {
      const result =
        decision.kind === 'approve'
          ? await modelAccessApi.approve(decision.request.id, decision.request.revision, reason)
          : await modelAccessApi.reject(decision.request.id, decision.request.revision, reason)
      setDecision(null)
      setReason('')
      if (result.status === 'APPROVED') {
        onNotice(
          result.publicationState === 'PUBLISHED'
            ? '审批已通过，授权组已发布；实例生效仍未知。'
            : result.publicationState === 'FAILED'
              ? '审批已通过，但授权组发布失败，请重试发布。'
              : '审批已通过，授权组正在等待发布。',
        )
      } else {
        onNotice('申请已拒绝，授权组没有变化。')
      }
      await load()
    } catch (error) {
      onError(error instanceof Error ? error.message : '审批操作失败')
    } finally {
      setBusy(false)
    }
  }

  const retry = async (request: AdminAccessRequest) => {
    setBusy(true)
    try {
      const result = await modelAccessApi.retryPublication(request.id)
      onNotice(
        result.publicationState === 'PUBLISHED'
          ? '授权组重新发布成功；实例生效仍未知。'
          : '授权组仍未发布成功，请检查 rnacos 状态。',
      )
      await load()
    } catch (error) {
      onError(error instanceof Error ? error.message : '重试发布失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page-shell access-requests-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">MODEL ACCESS / APPROVAL</span>
          <h1>模型权限审批</h1>
          <p>批准申请会更新模型专属授权组；审批、rnacos 发布和实例生效分别记录。</p>
        </div>
        <div className="request-summary">
          <Clock3 size={18} />
          <span>
            <b>{pendingCount}</b>
            <small>当前筛选中的待审批</small>
          </span>
        </div>
      </header>
      <section className="marketplace-boundary" aria-label="权限状态边界">
        <span>
          <b>01</b> 管理员审批 <small>MySQL 期望成员</small>
        </span>
        <i />
        <span>
          <b>02</b> 授权组发布 <small>rnacos 回读 MD5</small>
        </span>
        <i />
        <span>
          <b>03</b> 实例生效 <small>需要 ai-server 接受证据</small>
        </span>
      </section>
      <div className="marketplace-toolbar">
        <label className="search-field">
          <Search size={15} />
          <span className="sr-only">搜索权限申请</span>
          <input
            value={search}
            placeholder="搜索申请人或模型"
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label className="marketplace-filter">
          <span className="sr-only">审批状态</span>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as ModelAccessRequestStatus | '')}
          >
            <option value="">全部状态</option>
            <option value="PENDING">待审批</option>
            <option value="APPROVED">已批准</option>
            <option value="REJECTED">已拒绝</option>
            <option value="CANCELLED">已取消</option>
          </select>
        </label>
      </div>
      <section className="data-card access-request-list">
        {loading && <div className="empty-cell">正在读取审批队列…</div>}
        {!loading && items.length === 0 && (
          <div className="empty-cell">
            <ShieldQuestion size={23} /> 当前筛选没有权限申请
          </div>
        )}
        {items.map((request) => (
          <article key={request.id}>
            <header>
              <div className="request-applicant">
                <span className="avatar small">
                  {request.applicantDisplayName.slice(0, 1).toUpperCase()}
                </span>
                <span>
                  <b>{request.applicantDisplayName}</b>
                  <code>{request.applicantUsername}</code>
                </span>
              </div>
              <span className={`status-badge status-${request.status.toLowerCase()}`}>
                {statusLabel[request.status]}
              </span>
            </header>
            <div className="request-main">
              <div>
                <span className="model-identity">{request.logicalModelName}</span>
                <h2>{request.modelDisplayName}</h2>
                <blockquote>{request.reason}</blockquote>
              </div>
              <dl>
                <div>
                  <dt>申请授权组</dt>
                  <dd>{request.groupName}</dd>
                </div>
                <div>
                  <dt>rnacos 发布</dt>
                  <dd>{request.publicationState}</dd>
                </div>
                <div>
                  <dt>实例生效</dt>
                  <dd>{request.activationState}</dd>
                </div>
              </dl>
            </div>
            <div className="request-impact">
              <b>批准后的模型权限范围</b>
              <span>
                {request.affectedModels.length
                  ? request.affectedModels
                      .map((model) => `${model.displayName} (${model.logicalModelName})`)
                      .join('、')
                  : '当前已发布快照未找到引用模型，不能安全批准'}
              </span>
            </div>
            <footer>
              <time dateTime={request.createdAt}>
                申请于 {new Date(request.createdAt).toLocaleString('zh-CN')}
              </time>
              <div>
                {request.status === 'PENDING' && (
                  <>
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => {
                        setReason('')
                        setDecision({ request, kind: 'reject' })
                      }}
                    >
                      <X size={14} /> 拒绝
                    </button>
                    <button
                      className="primary-button"
                      type="button"
                      disabled={request.affectedModels.length === 0}
                      onClick={() => {
                        setReason('')
                        setDecision({ request, kind: 'approve' })
                      }}
                    >
                      <Check size={14} /> 批准
                    </button>
                  </>
                )}
                {request.status === 'APPROVED' && request.publicationState === 'FAILED' && (
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={busy}
                    onClick={() => void retry(request)}
                  >
                    <RefreshCw size={14} /> 重试发布
                  </button>
                )}
              </div>
            </footer>
          </article>
        ))}
      </section>
      <Modal
        open={decision !== null}
        title={decision?.kind === 'approve' ? '批准模型权限申请' : '拒绝模型权限申请'}
        eyebrow="ACCESS DECISION"
        onClose={() => !busy && setDecision(null)}
      >
        {decision && (
          <>
            <div className="modal-body decision-dialog">
              <div className="decision-target">
                <FileCheck2 size={19} />
                <span>
                  <b>{decision.request.applicantDisplayName}</b>
                  <small>
                    {decision.request.modelDisplayName} · {decision.request.logicalModelName}
                  </small>
                </span>
              </div>
              <p>
                {decision.kind === 'approve'
                  ? `将加入 ${decision.request.groupName}，并影响 ${decision.request.affectedModels.length} 个已发布模型。审批不等于实例已生效。`
                  : '拒绝不会修改授权组，也不会创建 rnacos 发布记录。'}
              </p>
              <label className="stacked-field">
                <span>{decision.kind === 'approve' ? '审批备注（可选）' : '拒绝原因'}</span>
                <textarea
                  autoFocus
                  value={reason}
                  maxLength={500}
                  onChange={(event) => setReason(event.target.value)}
                />
              </label>
            </div>
            <footer className="modal-actions">
              <button
                className="secondary-button"
                type="button"
                disabled={busy}
                onClick={() => setDecision(null)}
              >
                取消
              </button>
              <button
                className={decision.kind === 'approve' ? 'primary-button' : 'danger-button'}
                type="button"
                disabled={busy}
                onClick={() => void decide()}
              >
                {decision.kind === 'approve' ? '确认批准并发布' : '确认拒绝'}
              </button>
            </footer>
          </>
        )}
      </Modal>
    </div>
  )
}
