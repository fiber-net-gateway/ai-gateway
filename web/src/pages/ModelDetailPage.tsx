import { ArrowLeft, CloudUpload, Edit3, Radio, Send, ShieldAlert, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'

import {
  modelMarketplaceApi,
  type AvailableModelSummary,
  type MarketplaceModelDetail,
  type ValidationIssue,
} from '../api/model-marketplace'
import { modelAccessApi, type ApplicantAccessRequest } from '../api/model-access'
import { AccessRequestDialog } from '../components/model-access/AccessRequestDialog'
import { ModelStateStrip } from '../components/model-marketplace/ModelStateStrip'
import { ProtocolBadge } from '../components/model-marketplace/ProtocolBadge'
import { ProtocolCoverageMatrix } from '../components/model-marketplace/ProtocolCoverageMatrix'
import { ValidationSummary } from '../components/model-marketplace/ValidationSummary'
import { confirmLocalized, formatDateTime } from '../i18n'

export function ModelDetailPage({
  environmentId,
  modelId,
  admin,
  onBack,
  onEdit,
  onOpenReleases,
  onArchived,
  onError,
  onNotice,
}: {
  environmentId: string
  modelId: string
  admin: boolean
  onBack: () => void
  onEdit: () => void
  onOpenReleases: () => void
  onArchived: () => void
  onError: (message: string) => void
  onNotice: (message: string) => void
}) {
  const [model, setModel] = useState<MarketplaceModelDetail | AvailableModelSummary | null>(null)
  const [etag, setEtag] = useState<string | null>(null)
  const [issues, setIssues] = useState<ValidationIssue[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [accessRequest, setAccessRequest] = useState<ApplicantAccessRequest | null>(null)
  const [requestOpen, setRequestOpen] = useState(false)

  const load = () => {
    const task = admin
      ? modelMarketplaceApi.detail(environmentId, modelId).then((response) => {
          setEtag(response.etag)
          return response.data
        })
      : modelMarketplaceApi.availableDetail(environmentId, modelId)
    return task
      .then(setModel)
      .catch((error) => onError(error instanceof Error ? error.message : '模型详情加载失败'))
  }

  useEffect(() => {
    void load()
    if (!admin) {
      void modelAccessApi
        .mine({ environmentId })
        .then((result) =>
          setAccessRequest(result.items.find((request) => request.modelId === modelId) ?? null),
        )
        .catch((error) => onError(error instanceof Error ? error.message : '申请状态加载失败'))
    }
  }, [admin, environmentId, modelId])

  if (!model) return <div className="page-shell marketplace-loading">正在组装模型详情…</div>
  if (!admin) {
    const available = model as AvailableModelSummary
    const accessTitle = available.accessible
      ? '当前账号可调用'
      : accessRequest?.status === 'PENDING'
        ? '权限申请待审批'
        : accessRequest?.status === 'APPROVED'
          ? accessRequest.publicationState === 'PUBLISHED'
            ? '授权组已发布，实例生效未知'
            : accessRequest.publicationState === 'FAILED'
              ? '审批已通过，授权组发布失败'
              : '审批已通过，等待授权组发布'
          : '当前账号无访问权限'
    return (
      <div className="page-shell model-detail-page">
        <button className="back-link" type="button" onClick={onBack}>
          <ArrowLeft size={15} /> 返回模型广场
        </button>
        <header className="model-detail-hero">
          <span className="model-identity">{available.logicalModelName}</span>
          <h1>{available.displayName}</h1>
          <p>{available.description || '尚未填写模型说明。'}</p>
          <div className="protocol-row">
            <ProtocolBadge type="openai" coverage={available.protocols.openai} />
            <ProtocolBadge type="anthropic" coverage={available.protocols.anthropic} />
          </div>
        </header>
        <div
          className={`access-callout detail-access ${available.accessible ? 'allowed' : 'denied'}`}
        >
          <b>{accessTitle}</b>
          <span>
            {available.accessible
              ? `请求体使用 model: "${available.logicalModelName}"，认证使用你的 BT1 Token。`
              : accessRequest?.status === 'PENDING'
                ? `申请已于 ${formatDateTime(accessRequest.createdAt)} 提交。`
                : accessRequest?.status === 'APPROVED'
                  ? '审批、rnacos 发布和 ai-server 生效是三个独立状态；实例证据齐全前不能宣称已生效。'
                  : available.requestable
                    ? '填写用途说明后提交申请；目录不会展示其他组成员。'
                    : '当前模型没有可用的申请授权组，请联系环境管理员。'}
          </span>
          {!available.accessible &&
            available.requestable &&
            (!accessRequest || ['REJECTED', 'CANCELLED'].includes(accessRequest.status)) && (
              <button className="primary-button" type="button" onClick={() => setRequestOpen(true)}>
                <Send size={14} /> 申请调用权限
              </button>
            )}
          {accessRequest?.status === 'PENDING' && (
            <button
              className="secondary-button"
              type="button"
              disabled={busy}
              onClick={async () => {
                if (!confirmLocalized('取消这条待审批申请？历史记录会保留。')) return
                setBusy(true)
                try {
                  setAccessRequest(
                    await modelAccessApi.cancel(accessRequest.id, accessRequest.revision),
                  )
                  onNotice('权限申请已取消，授权组没有变化。')
                } catch (error) {
                  onError(error instanceof Error ? error.message : '取消申请失败')
                } finally {
                  setBusy(false)
                }
              }}
            >
              取消申请
            </button>
          )}
        </div>
        <section className="data-card model-help-card">
          <div className="card-heading">
            <div>
              <h2>调用边界</h2>
              <p>控制台不代理 LLM 流量，也不进行协议转换。</p>
            </div>
          </div>
          <div className="detail-section">
            <pre>{`curl -H "Authorization: Bearer <YOUR_BT1_TOKEN>" \\\n+  -H "Content-Type: application/json" \\\n+  -d '{"model":"${available.logicalModelName}","messages":[...]}' \\\n+  https://<ai-server>/v1/chat/completions`}</pre>
          </div>
        </section>
        <AccessRequestDialog
          open={requestOpen}
          environmentId={environmentId}
          model={available}
          onClose={() => setRequestOpen(false)}
          onCreated={(request) => {
            setAccessRequest(request)
            onNotice('权限申请已提交，正在等待管理员审批。')
          }}
          onError={onError}
        />
      </div>
    )
  }

  const detail = model as MarketplaceModelDetail
  const validate = async () => {
    setBusy(true)
    try {
      const response = await modelMarketplaceApi.validate(environmentId, detail.draft.versionId)
      setIssues(response.data.issues)
      if (response.data.valid) onNotice('静态校验通过')
      else onError('草稿存在阻塞错误')
    } catch (error) {
      onError(error instanceof Error ? error.message : '校验失败')
    } finally {
      setBusy(false)
    }
  }
  const archive = async () => {
    if (!etag || !confirmLocalized(`归档模型 ${detail.logicalModelName}？这不会删除历史 release。`))
      return
    setBusy(true)
    try {
      await modelMarketplaceApi.archive(environmentId, detail.draft.versionId, modelId, etag)
      onArchived()
    } catch (error) {
      onError(error instanceof Error ? error.message : '归档失败')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="page-shell model-detail-page">
      <button className="back-link" type="button" onClick={onBack}>
        <ArrowLeft size={15} /> 返回模型广场
      </button>
      <header className="model-detail-hero admin-detail-hero">
        <div>
          <span className="model-identity">{detail.logicalModelName}</span>
          <h1>{detail.displayName}</h1>
          <p>{detail.description || '尚未填写模型说明。'}</p>
        </div>
        <div className="detail-actions">
          <button className="secondary-button" type="button" onClick={onEdit}>
            <Edit3 size={15} /> 编辑草稿
          </button>
          <button className="primary-button" type="button" onClick={onOpenReleases}>
            <CloudUpload size={15} /> 前往发布中心
          </button>
        </div>
      </header>
      <ModelStateStrip
        draft={detail.draftState}
        publication={detail.publicationState}
        activation={detail.activationState}
      />
      <div className="model-detail-grid">
        <section className="data-card">
          <div className="card-heading">
            <div>
              <h2>静态协议覆盖</h2>
              <p>按入站协议独立计算，不做 OpenAI ↔ Anthropic 转换。</p>
            </div>
          </div>
          <div className="detail-section">
            <ProtocolCoverageMatrix coverage={detail.protocols} />
          </div>
        </section>
        <section className="data-card">
          <div className="card-heading">
            <div>
              <h2>流量策略</h2>
              <p>确定性输出到 models Data ID。</p>
            </div>
          </div>
          <div className="detail-section">
            <dl className="identity-facts">
              <div>
                <dt>Prompt 前缀字节</dt>
                <dd>{detail.prefixMaxBytes}</dd>
              </div>
              <div>
                <dt>最大主尝试数</dt>
                <dd>{detail.maxPrimaryAttempts}</dd>
              </div>
              <div>
                <dt>Fallback</dt>
                <dd>{detail.fallbackEnabled ? '启用' : '停用'}</dd>
              </div>
              <div>
                <dt>重试状态</dt>
                <dd>{detail.retryableStatuses.join(', ')}</dd>
              </div>
              <div>
                <dt>访问模式</dt>
                <dd>
                  {detail.accessMode === 'APPROVAL_REQUIRED' ? '需要管理员审批' : '所有已认证用户'}
                </dd>
              </div>
              {detail.allowUserGroups[0] && (
                <div>
                  <dt>申请授权组</dt>
                  <dd>{detail.allowUserGroups[0].name}</dd>
                </div>
              )}
            </dl>
          </div>
        </section>
      </div>
      <section className="data-card provider-detail-card">
        <div className="card-heading">
          <div>
            <h2>供应商与协议</h2>
            <p>Token 只显示安全指纹后缀，永不回显明文。</p>
          </div>
          <span>{detail.providers.length} PROVIDERS</span>
        </div>
        <div className="provider-detail-list">
          {detail.providers.map((provider) => (
            <article key={provider.id}>
              <header>
                <div>
                  <b>{provider.displayName}</b>
                  <code>{provider.providerName}</code>
                </div>
                <span>{provider.routeRole}</span>
              </header>
              <dl>
                <div>
                  <dt>Base URL</dt>
                  <dd>{provider.baseUrl}</dd>
                </div>
              </dl>
              <div className="protocol-row">
                {provider.protocols.map((protocol) => (
                  <span className="protocol-badge protocol-supported" key={protocol.type}>
                    {protocol.type === 'OPENAI_CHAT_COMPLETIONS' ? 'OpenAI' : 'Anthropic'} ·{' '}
                    {protocol.upstreamModelName}
                  </span>
                ))}
              </div>
              <ul>
                {provider.tokens.map((token) => (
                  <li key={token.id}>
                    <span>{token.name}</span>
                    <code>••••••{token.fingerprintSuffix}</code>
                  </li>
                ))}
                {provider.tokens.length === 0 && (
                  <li>
                    <span>无凭据调用</span>
                    <code>EXPLICIT</code>
                  </li>
                )}
              </ul>
            </article>
          ))}
        </div>
      </section>
      {issues && <ValidationSummary issues={issues} />}
      <section className="detail-danger-zone">
        <div>
          <ShieldAlert size={18} />
          <span>
            <b>归档边界</b>
            <small>归档仅修改草稿身份，不删除 rnacos 配置或改写历史 release。</small>
          </span>
        </div>
        <div>
          <button
            className="secondary-button"
            type="button"
            disabled={busy}
            onClick={() => void validate()}
          >
            <Radio size={15} /> 运行静态校验
          </button>
          <button
            className="danger-button"
            type="button"
            disabled={busy}
            onClick={() => void archive()}
          >
            <Trash2 size={15} /> 归档模型
          </button>
        </div>
      </section>
    </div>
  )
}
