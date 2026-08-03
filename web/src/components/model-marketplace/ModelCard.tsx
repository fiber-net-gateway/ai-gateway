import { ArrowUpRight, KeyRound, Network } from 'lucide-react'

import type { AvailableModelSummary, MarketplaceModelSummary } from '../../api/model-marketplace'
import { ModelStateStrip } from './ModelStateStrip'
import { ProtocolBadge } from './ProtocolBadge'

export function AdminModelCard({
  model,
  onOpen,
}: {
  model: MarketplaceModelSummary
  onOpen: () => void
}) {
  return (
    <article className="model-card">
      <header>
        <div>
          <span className="model-identity">{model.logicalModelName}</span>
          <h2>{model.displayName}</h2>
        </div>
        <button type="button" aria-label={`打开 ${model.displayName}`} onClick={onOpen}>
          <ArrowUpRight size={18} />
        </button>
      </header>
      <p>{model.description || '尚未填写模型说明。'}</p>
      <div className="protocol-row">
        <ProtocolBadge type="openai" coverage={model.protocols.openai} />
        <ProtocolBadge type="anthropic" coverage={model.protocols.anthropic} />
      </div>
      <dl className="model-card-facts">
        <div>
          <dt>
            <Network size={13} /> 供应商
          </dt>
          <dd>
            {model.primaryProviderCount} 主 /{' '}
            {model.fallbackConfigured ? '1 Fallback' : '无 Fallback'}
          </dd>
        </div>
        <div>
          <dt>
            <KeyRound size={13} /> 凭据摘要
          </dt>
          <dd>{model.configuredTokenCount} 个已配置 Token</dd>
        </div>
      </dl>
      <ModelStateStrip
        draft={model.draftState}
        publication={model.publicationState}
        activation={model.activationState}
      />
      <footer>
        <span>
          {model.validationErrorCount
            ? `${model.validationErrorCount} 个错误`
            : `${model.validationWarningCount} 个提醒`}
        </span>
        <time dateTime={model.updatedAt}>{new Date(model.updatedAt).toLocaleString('zh-CN')}</time>
      </footer>
    </article>
  )
}

export function AvailableModelCard({
  model,
  onOpen,
}: {
  model: AvailableModelSummary
  onOpen: () => void
}) {
  return (
    <article className="model-card available-model-card">
      <header>
        <div>
          <span className="model-identity">{model.logicalModelName}</span>
          <h2>{model.displayName}</h2>
        </div>
        <button type="button" aria-label={`打开 ${model.displayName}`} onClick={onOpen}>
          <ArrowUpRight size={18} />
        </button>
      </header>
      <p>{model.description || '尚未填写模型说明。'}</p>
      <div className="protocol-row">
        <ProtocolBadge type="openai" coverage={model.protocols.openai} />
        <ProtocolBadge type="anthropic" coverage={model.protocols.anthropic} />
      </div>
      <div className={`access-callout ${model.accessible ? 'allowed' : 'denied'}`}>
        <b>{model.accessible ? '你可以调用此模型' : '当前账号无访问权限'}</b>
        <span>
          {model.accessible
            ? '使用个人 BT1 Token 和逻辑模型名发起请求。'
            : '请联系环境管理员申请模型用户组。'}
        </span>
      </div>
      <footer>
        <span>实例生效：{model.activationState}</span>
        <time>
          {model.publishedAt ? new Date(model.publishedAt).toLocaleString('zh-CN') : '无发布证据'}
        </time>
      </footer>
    </article>
  )
}
