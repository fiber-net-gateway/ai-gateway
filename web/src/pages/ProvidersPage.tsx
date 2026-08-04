import { ArrowLeft, Cloud, Edit3, Plus, Save, Server, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import {
  modelMarketplaceApi,
  type ProviderDetail,
  type ProviderMutation,
  type ProviderSummary,
} from '../api/model-marketplace'
import { ProtocolEditor } from '../components/model-marketplace/ProtocolEditor'
import { TokenPoolEditor, existingTokenRow } from '../components/model-marketplace/TokenPoolEditor'
import type { ProtocolDraft, TokenDraftRow } from '../components/model-marketplace/types'
import { modelProtocols } from '../data/model-protocols'

interface ProviderEditorState {
  id?: string
  displayName: string
  baseUrl: string
  protocols: ProtocolDraft[]
  authenticationMode: 'BEARER_TOKEN_POOL' | 'NO_CREDENTIALS'
  tokens: TokenDraftRow[]
  referencedModelCount: number
}

function emptyEditor(): ProviderEditorState {
  return {
    displayName: '',
    baseUrl: '',
    protocols: modelProtocols.map((protocol, index) => ({
      type: protocol.type,
      enabled: index === 0,
      path: protocol.type === 'OPENAI_CHAT_COMPLETIONS' ? '/v1/chat/completions' : '/v1/messages',
      upstreamModelName: '',
    })),
    authenticationMode: 'BEARER_TOKEN_POOL',
    tokens: [],
    referencedModelCount: 0,
  }
}

function editorFromDetail(provider: ProviderDetail): ProviderEditorState {
  return {
    id: provider.id,
    displayName: provider.displayName,
    baseUrl: provider.baseUrl,
    protocols: modelProtocols.map((definition) => {
      const current = provider.protocols.find((protocol) => protocol.type === definition.type)
      return {
        type: definition.type,
        enabled: Boolean(current),
        path:
          current?.path ??
          (definition.type === 'OPENAI_CHAT_COMPLETIONS' ? '/v1/chat/completions' : '/v1/messages'),
        upstreamModelName: current?.upstreamModelName ?? '',
      }
    }),
    authenticationMode: provider.tokens.length ? 'BEARER_TOKEN_POOL' : 'NO_CREDENTIALS',
    tokens: provider.tokens.map((token) => existingTokenRow(token.id, token.name)),
    referencedModelCount: provider.referencedModelCount,
  }
}

function mutationFromEditor(editor: ProviderEditorState): ProviderMutation {
  return {
    displayName: editor.displayName.trim(),
    baseUrl: editor.baseUrl.trim(),
    protocols: editor.protocols
      .filter((protocol) => protocol.enabled)
      .map(({ type, path, upstreamModelName }) => ({
        type,
        path: path.trim(),
        upstreamModelName: upstreamModelName.trim(),
      })),
    authentication: {
      mode: editor.authenticationMode,
      tokens: editor.tokens.map((token) =>
        token.kind === 'new'
          ? {
              name: token.name,
              secretAction: 'replace' as const,
              value: token.value,
            }
          : token.action === 'replace'
            ? {
                id: token.id,
                name: token.name,
                secretAction: 'replace' as const,
                value: token.value,
              }
            : token.action === 'delete'
              ? {
                  id: token.id,
                  name: token.name,
                  secretAction: 'delete' as const,
                }
              : {
                  id: token.id,
                  name: token.name,
                  secretAction: 'keep' as const,
                },
      ),
      confirmUnauthenticated: editor.authenticationMode === 'NO_CREDENTIALS' || undefined,
    },
  }
}

export function ProvidersPage({
  environmentId,
  onError,
  onNotice,
}: {
  environmentId: string
  onError: (message: string) => void
  onNotice: (message: string) => void
}) {
  const [providers, setProviders] = useState<ProviderSummary[]>([])
  const [draftId, setDraftId] = useState('')
  const [etag, setEtag] = useState('')
  const [editor, setEditor] = useState<ProviderEditorState | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await modelMarketplaceApi.listProviders(environmentId)
      setProviders(result.data.items)
      setDraftId(result.data.draft.id)
      setEtag(result.etag ?? '')
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Provider 列表加载失败')
    } finally {
      setLoading(false)
    }
  }, [environmentId, onError])

  useEffect(() => {
    void load()
  }, [load])

  const openProvider = async (providerId: string) => {
    setBusy(true)
    try {
      const result = await modelMarketplaceApi.providerDetail(environmentId, providerId)
      setEditor(editorFromDetail(result.data))
      setDraftId(result.data.draft.id)
      setEtag(result.etag ?? '')
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Provider 详情加载失败')
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (!editor) return
    if (!editor.displayName.trim() || !editor.baseUrl.trim()) {
      onError('请填写 Provider 展示名称和 Base URL')
      return
    }
    if (!editor.protocols.some((protocol) => protocol.enabled)) {
      onError('至少启用一种协议')
      return
    }
    const mutation = mutationFromEditor(editor)
    if (
      editor.authenticationMode === 'BEARER_TOKEN_POOL' &&
      !mutation.authentication.tokens.length
    ) {
      onError('Bearer Token 池至少需要一个 Token')
      return
    }
    if (
      editor.referencedModelCount > 1 &&
      !window.confirm(
        `此 Provider 被 ${editor.referencedModelCount} 个模型引用，确认保存并影响全部模型？`,
      )
    ) {
      return
    }
    mutation.confirmProviderImpact = editor.referencedModelCount > 1 || undefined
    setBusy(true)
    try {
      if (editor.id) {
        await modelMarketplaceApi.updateProvider(environmentId, draftId, editor.id, etag, mutation)
      } else {
        await modelMarketplaceApi.createProvider(environmentId, draftId, etag, mutation)
      }
      onNotice('Provider 草稿已保存；尚未发布到 rnacos，也未证明实例生效。')
      setEditor(null)
      await load()
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Provider 保存失败')
    } finally {
      setBusy(false)
    }
  }

  const archive = async () => {
    if (!editor?.id || !window.confirm(`归档 Provider“${editor.displayName}”？`)) return
    setBusy(true)
    try {
      await modelMarketplaceApi.archiveProvider(environmentId, draftId, editor.id, etag)
      onNotice('Provider 已从当前草稿归档；历史 Release 不受影响。')
      setEditor(null)
      await load()
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Provider 归档失败')
    } finally {
      setBusy(false)
    }
  }

  if (editor) {
    return (
      <div className="page-shell model-editor-page">
        <button className="back-link" type="button" onClick={() => setEditor(null)}>
          <ArrowLeft size={15} /> 返回 Provider 列表
        </button>
        <header className="page-heading">
          <div>
            <span className="eyebrow">PROVIDER DRAFT</span>
            <h1>{editor.id ? '编辑 Provider' : '新增 Provider'}</h1>
            <p>独立维护接入地址、协议映射、上游模型名和 Token 池。</p>
          </div>
          <button
            className="primary-button"
            type="button"
            disabled={busy}
            onClick={() => void save()}
          >
            <Save size={16} /> {busy ? '保存中…' : '保存 Provider 草稿'}
          </button>
        </header>

        <section className="data-card editor-stage">
          <div className="card-heading">
            <div>
              <h2>接入信息</h2>
              <p>技术标识由服务端生成并映射到固定 Provider Data ID。</p>
            </div>
          </div>
          <div className="editor-stage-body form-grid two-columns">
            <label>
              <span>展示名称</span>
              <input
                autoFocus
                value={editor.displayName}
                onChange={(event) => setEditor({ ...editor, displayName: event.target.value })}
              />
            </label>
            <label>
              <span>Base URL</span>
              <input
                placeholder="https://api.vendor.example"
                value={editor.baseUrl}
                onChange={(event) => setEditor({ ...editor, baseUrl: event.target.value })}
              />
            </label>
          </div>
        </section>

        <section className="data-card editor-stage">
          <div className="card-heading">
            <div>
              <h2>协议与上游模型</h2>
              <p>每种入站协议独立配置请求路径和实际供应商模型名。</p>
            </div>
          </div>
          <div className="editor-stage-body">
            <ProtocolEditor
              protocols={editor.protocols}
              onChange={(protocols) => setEditor({ ...editor, protocols })}
            />
          </div>
        </section>

        <section className="data-card editor-stage">
          <div className="card-heading">
            <div>
              <h2>凭据</h2>
              <p>Token 是只写值，页面只保留配置状态和安全指纹。</p>
            </div>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={editor.authenticationMode === 'NO_CREDENTIALS'}
                onChange={(event) =>
                  setEditor({
                    ...editor,
                    authenticationMode: event.target.checked
                      ? 'NO_CREDENTIALS'
                      : 'BEARER_TOKEN_POOL',
                  })
                }
              />
              <span>明确使用无凭据调用</span>
            </label>
          </div>
          <div className="editor-stage-body">
            {editor.authenticationMode === 'NO_CREDENTIALS' ? (
              <p className="editor-empty">保存后当前草稿不会为此 Provider 输出 Token。</p>
            ) : (
              <TokenPoolEditor
                rows={editor.tokens}
                onChange={(tokens) => setEditor({ ...editor, tokens })}
              />
            )}
          </div>
        </section>

        {editor.id && (
          <section className="danger-zone data-card">
            <div>
              <b>归档 Provider</b>
              <span>只有未被模型引用的 Provider 才能归档。</span>
            </div>
            <button
              className="danger-button"
              type="button"
              disabled={busy}
              onClick={() => void archive()}
            >
              <Trash2 size={15} /> 归档
            </button>
          </section>
        )}
      </div>
    )
  }

  return (
    <div className="page-shell">
      <header className="page-heading">
        <div>
          <span className="eyebrow">PROVIDER REGISTRY</span>
          <h1>Provider 管理</h1>
          <p>独立维护 ai-server Provider；模型只通过稳定标识引用这里的配置。</p>
        </div>
        <button className="primary-button" type="button" onClick={() => setEditor(emptyEditor())}>
          <Plus size={16} /> 新增 Provider
        </button>
      </header>

      {loading ? (
        <div className="marketplace-loading">正在读取 Provider 草稿…</div>
      ) : providers.length === 0 ? (
        <div className="marketplace-empty">
          <Server size={28} />
          <b>尚未维护 Provider</b>
          <span>先配置供应商接入，再到模型广场建立路由关联。</span>
        </div>
      ) : (
        <div className="provider-registry-grid">
          {providers.map((provider) => (
            <article className="data-card provider-registry-card" key={provider.id}>
              <header>
                <div>
                  <span className="model-identity">{provider.providerName}</span>
                  <h2>{provider.displayName}</h2>
                </div>
                <button
                  type="button"
                  aria-label={`编辑 ${provider.displayName}`}
                  disabled={busy}
                  onClick={() => void openProvider(provider.id)}
                >
                  <Edit3 size={17} />
                </button>
              </header>
              <p className="provider-base-url">
                <Cloud size={14} /> {provider.baseUrl}
              </p>
              <dl className="model-card-facts">
                <div>
                  <dt>协议</dt>
                  <dd>{provider.protocols.length} 项</dd>
                </div>
                <div>
                  <dt>Token</dt>
                  <dd>{provider.tokens.length} 个</dd>
                </div>
                <div>
                  <dt>引用模型</dt>
                  <dd>{provider.referencedModelCount} 个</dd>
                </div>
              </dl>
              <footer>
                <span>发布：{provider.publicationState}</span>
                <time dateTime={provider.updatedAt}>
                  {new Date(provider.updatedAt).toLocaleString('zh-CN')}
                </time>
              </footer>
            </article>
          ))}
        </div>
      )}
    </div>
  )
}
