import { ArrowLeft, Plus, Save, Server, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'

import {
  modelMarketplaceApi,
  type MarketplaceModelDetail,
  type ModelMutation,
  type ProviderSummary,
} from '../api/model-marketplace'

interface BindingDraft {
  providerId: string
  routeRole: 'PRIMARY' | 'FALLBACK'
}

interface EditorState {
  displayName: string
  logicalModelName: string
  description: string
  tags: string
  bindings: BindingDraft[]
  accessMode: 'ALL_AUTHENTICATED' | 'APPROVAL_REQUIRED'
  prefixMaxBytes: string
  maxPrimaryAttempts: string
  fallbackEnabled: boolean
  retryableStatuses: string
  rateLimitEnabled: boolean
  rateLimitWindow: string
  rateLimitTokens: string
}

function emptyEditor(): EditorState {
  return {
    displayName: '',
    logicalModelName: '',
    description: '',
    tags: '',
    bindings: [],
    accessMode: 'ALL_AUTHENTICATED',
    prefixMaxBytes: '2048',
    maxPrimaryAttempts: '0',
    fallbackEnabled: true,
    retryableStatuses: '429, 502, 503, 504',
    rateLimitEnabled: false,
    rateLimitWindow: '60000',
    rateLimitTokens: '100000',
  }
}

function editorFromDetail(detail: MarketplaceModelDetail): EditorState {
  return {
    displayName: detail.displayName,
    logicalModelName: detail.logicalModelName,
    description: detail.description,
    tags: detail.tags.join(', '),
    bindings: [...detail.providers]
      .sort((left, right) => left.sortOrder - right.sortOrder)
      .map((provider) => ({
        providerId: provider.id,
        routeRole: provider.routeRole,
      })),
    accessMode: detail.accessMode,
    prefixMaxBytes: String(detail.prefixMaxBytes),
    maxPrimaryAttempts: String(detail.maxPrimaryAttempts),
    fallbackEnabled: detail.fallbackEnabled,
    retryableStatuses: detail.retryableStatuses.join(', '),
    rateLimitEnabled: detail.rateLimit !== null,
    rateLimitWindow: detail.rateLimit?.windowDurationMillis ?? '60000',
    rateLimitTokens: detail.rateLimit?.maxTokensPerWindow ?? '100000',
  }
}

function integer(value: string, fallback: number): number {
  const parsed = Number(value)
  return Number.isInteger(parsed) ? parsed : fallback
}

function mutationFromEditor(editor: EditorState): ModelMutation {
  let primaryOrder = 0
  return {
    displayName: editor.displayName.trim(),
    logicalModelName: editor.logicalModelName.trim(),
    description: editor.description.trim(),
    tags: editor.tags
      .split(',')
      .map((tag) => tag.trim().toLocaleLowerCase())
      .filter(Boolean),
    providers: editor.bindings.map((binding) => ({
      providerId: binding.providerId,
      routeRole: binding.routeRole,
      sortOrder: binding.routeRole === 'PRIMARY' ? primaryOrder++ : 0,
    })),
    accessMode: editor.accessMode,
    loadBalance: {
      prefixMaxBytes: integer(editor.prefixMaxBytes, 0),
      maxPrimaryAttempts: integer(editor.maxPrimaryAttempts, -1),
      fallbackEnabled: editor.fallbackEnabled,
      retryableStatuses: editor.retryableStatuses
        .split(',')
        .map((status) => Number(status.trim()))
        .filter(Number.isInteger),
    },
    rateLimit: editor.rateLimitEnabled
      ? {
          windowDurationMillis: editor.rateLimitWindow.trim(),
          maxTokensPerWindow: editor.rateLimitTokens.trim(),
        }
      : null,
  }
}

export function ModelEditorPage({
  environmentId,
  modelId,
  onBack,
  onSaved,
  onOpenProviders,
  onError,
  onNotice,
}: {
  environmentId: string
  modelId?: string
  onBack: () => void
  onSaved: (modelId: string) => void
  onOpenProviders: () => void
  onError: (message: string) => void
  onNotice: (message: string) => void
}) {
  const [editor, setEditor] = useState<EditorState>(emptyEditor)
  const [providers, setProviders] = useState<ProviderSummary[]>([])
  const [draftId, setDraftId] = useState('')
  const [etag, setEtag] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    setLoading(true)
    Promise.all([
      modelMarketplaceApi.listProviders(environmentId),
      modelId ? modelMarketplaceApi.detail(environmentId, modelId) : Promise.resolve(null),
    ])
      .then(([providerResult, detailResult]) => {
        if (!alive) return
        setProviders(providerResult.data.items)
        setDraftId(providerResult.data.draft.id)
        setEtag(detailResult?.etag ?? providerResult.etag ?? '')
        setEditor(detailResult ? editorFromDetail(detailResult.data) : emptyEditor())
      })
      .catch((error) => onError(error instanceof Error ? error.message : '模型草稿加载失败'))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [environmentId, modelId, onError])

  const providerById = useMemo(
    () => new Map(providers.map((provider) => [provider.id, provider])),
    [providers],
  )
  const availableProviders = providers.filter(
    (provider) => !editor.bindings.some((binding) => binding.providerId === provider.id),
  )

  const addBinding = () => {
    const provider = availableProviders[0]
    if (!provider) return
    setEditor({
      ...editor,
      bindings: [...editor.bindings, { providerId: provider.id, routeRole: 'PRIMARY' }],
    })
  }

  const save = async () => {
    if (!editor.displayName.trim() || !editor.logicalModelName.trim()) {
      onError('请填写展示名称和逻辑模型名')
      return
    }
    if (!editor.bindings.length) {
      onError('模型至少需要关联一个已有 Provider')
      return
    }
    if (editor.bindings.filter((binding) => binding.routeRole === 'FALLBACK').length > 1) {
      onError('一个模型最多只能关联一个 Fallback Provider')
      return
    }
    setBusy(true)
    try {
      const mutation = mutationFromEditor(editor)
      const result = modelId
        ? await modelMarketplaceApi.update(environmentId, draftId, modelId, etag, mutation)
        : await modelMarketplaceApi.create(environmentId, draftId, etag, mutation)
      onNotice('模型草稿已保存到 MySQL；尚未发布到 rnacos，也未证明实例生效。')
      onSaved(result.data.id)
    } catch (error) {
      onError(error instanceof Error ? error.message : '模型草稿保存失败')
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <div className="page-shell marketplace-loading">正在读取模型草稿…</div>

  return (
    <div className="page-shell model-editor-page">
      <button className="back-link" type="button" onClick={onBack}>
        <ArrowLeft size={15} /> 返回
      </button>
      <header className="page-heading">
        <div>
          <span className="eyebrow">MODEL DRAFT</span>
          <h1>{modelId ? '编辑模型信息' : '新增模型'}</h1>
          <p>模型只维护访问、限流和路由关系；接入地址、协议和凭据在 Provider 管理中维护。</p>
        </div>
        <button
          className="primary-button"
          type="button"
          disabled={busy}
          onClick={() => void save()}
        >
          <Save size={16} /> {busy ? '保存中…' : '保存模型草稿'}
        </button>
      </header>

      <section className="data-card editor-stage">
        <div className="card-heading">
          <div>
            <h2>模型信息</h2>
            <p>逻辑模型名用于客户端请求体 model，创建后保持稳定。</p>
          </div>
        </div>
        <div className="editor-stage-body form-grid">
          <label>
            <span>展示名称</span>
            <input
              autoFocus
              value={editor.displayName}
              onChange={(event) => setEditor({ ...editor, displayName: event.target.value })}
            />
          </label>
          <label>
            <span>逻辑模型名</span>
            <input
              value={editor.logicalModelName}
              disabled={Boolean(modelId)}
              onChange={(event) => setEditor({ ...editor, logicalModelName: event.target.value })}
            />
          </label>
          <label>
            <span>说明</span>
            <textarea
              value={editor.description}
              onChange={(event) => setEditor({ ...editor, description: event.target.value })}
            />
          </label>
          <label>
            <span>标签</span>
            <input
              value={editor.tags}
              placeholder="chat, general"
              onChange={(event) => setEditor({ ...editor, tags: event.target.value })}
            />
          </label>
        </div>
      </section>

      <section className="data-card editor-stage">
        <div className="card-heading">
          <div>
            <h2>Provider 路由</h2>
            <p>这里只建立关联。Provider 配置变化会影响所有引用它的模型。</p>
          </div>
          <div className="detail-actions">
            <button className="secondary-button" type="button" onClick={onOpenProviders}>
              <Server size={15} /> Provider 管理
            </button>
            <button
              className="primary-button"
              type="button"
              disabled={!availableProviders.length}
              onClick={addBinding}
            >
              <Plus size={15} /> 关联 Provider
            </button>
          </div>
        </div>
        <div className="editor-stage-body provider-binding-list">
          {!providers.length && (
            <div className="marketplace-empty compact-empty">
              <Server size={24} />
              <b>还没有可关联的 Provider</b>
              <span>请先到 Provider 管理完成 Base URL、协议和 Token 配置。</span>
            </div>
          )}
          {editor.bindings.map((binding, index) => {
            const provider = providerById.get(binding.providerId)
            return (
              <div className="provider-binding-row" key={binding.providerId}>
                <div>
                  <b>{provider?.displayName ?? 'Provider 已不可用'}</b>
                  <small>{provider?.providerName ?? binding.providerId}</small>
                </div>
                <select
                  aria-label={`${provider?.displayName ?? 'Provider'} 路由角色`}
                  value={binding.routeRole}
                  onChange={(event) =>
                    setEditor({
                      ...editor,
                      bindings: editor.bindings.map((candidate, candidateIndex) =>
                        candidateIndex === index
                          ? {
                              ...candidate,
                              routeRole: event.target.value as BindingDraft['routeRole'],
                            }
                          : candidate,
                      ),
                    })
                  }
                >
                  <option value="PRIMARY">主 Provider</option>
                  <option value="FALLBACK">Fallback</option>
                </select>
                <button
                  type="button"
                  aria-label="移除 Provider 关联"
                  onClick={() =>
                    setEditor({
                      ...editor,
                      bindings: editor.bindings.filter(
                        (_, candidateIndex) => candidateIndex !== index,
                      ),
                    })
                  }
                >
                  <Trash2 size={15} />
                </button>
              </div>
            )
          })}
        </div>
      </section>

      <section className="data-card editor-stage">
        <div className="card-heading">
          <div>
            <h2>访问与流量策略</h2>
            <p>需要审批时使用该模型专属授权组，不再依赖任何 Provider。</p>
          </div>
        </div>
        <div className="editor-stage-body form-grid two-columns">
          <label>
            <span>访问模式</span>
            <select
              value={editor.accessMode}
              onChange={(event) =>
                setEditor({
                  ...editor,
                  accessMode: event.target.value as EditorState['accessMode'],
                })
              }
            >
              <option value="ALL_AUTHENTICATED">所有已认证用户</option>
              <option value="APPROVAL_REQUIRED">申请审批后访问</option>
            </select>
          </label>
          <label>
            <span>Prompt 前缀最大字节</span>
            <input
              inputMode="numeric"
              value={editor.prefixMaxBytes}
              onChange={(event) => setEditor({ ...editor, prefixMaxBytes: event.target.value })}
            />
          </label>
          <label>
            <span>最大主 Provider 尝试数</span>
            <input
              inputMode="numeric"
              value={editor.maxPrimaryAttempts}
              onChange={(event) => setEditor({ ...editor, maxPrimaryAttempts: event.target.value })}
            />
          </label>
          <label>
            <span>可重试 HTTP 状态</span>
            <input
              value={editor.retryableStatuses}
              onChange={(event) => setEditor({ ...editor, retryableStatuses: event.target.value })}
            />
          </label>
          <label className="checkbox-field full-field">
            <input
              type="checkbox"
              checked={editor.fallbackEnabled}
              onChange={(event) => setEditor({ ...editor, fallbackEnabled: event.target.checked })}
            />
            <span>启用 Fallback 候选</span>
          </label>
          <label className="checkbox-field full-field">
            <input
              type="checkbox"
              checked={editor.rateLimitEnabled}
              onChange={(event) => setEditor({ ...editor, rateLimitEnabled: event.target.checked })}
            />
            <span>启用模型 Token 限流</span>
          </label>
          {editor.rateLimitEnabled && (
            <>
              <label>
                <span>窗口毫秒</span>
                <input
                  value={editor.rateLimitWindow}
                  onChange={(event) =>
                    setEditor({ ...editor, rateLimitWindow: event.target.value })
                  }
                />
              </label>
              <label>
                <span>窗口最大 Token</span>
                <input
                  value={editor.rateLimitTokens}
                  onChange={(event) =>
                    setEditor({ ...editor, rateLimitTokens: event.target.value })
                  }
                />
              </label>
            </>
          )}
        </div>
      </section>
    </div>
  )
}
