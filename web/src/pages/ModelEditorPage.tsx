import { ArrowLeft, ArrowRight, Check, Clipboard, Save, ShieldAlert } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

import {
  modelMarketplaceApi,
  type MarketplaceModelDetail,
  type ModelMutation,
  type TokenMutation,
  type ValidationIssue,
} from '../api/model-marketplace'
import { ApiError } from '../api/client'
import { ProtocolCoverageMatrix } from '../components/model-marketplace/ProtocolCoverageMatrix'
import { ProtocolEditor } from '../components/model-marketplace/ProtocolEditor'
import { ProviderEditor, newProviderDraft } from '../components/model-marketplace/ProviderEditor'
import { existingTokenRow, TokenPoolEditor } from '../components/model-marketplace/TokenPoolEditor'
import type { ProviderDraft, TokenDraftRow } from '../components/model-marketplace/types'
import { ValidationSummary } from '../components/model-marketplace/ValidationSummary'
import { modelProtocols } from '../data/model-protocols'

interface EditorState {
  displayName: string
  logicalModelName: string
  description: string
  tags: string
  providers: ProviderDraft[]
  prefixMaxBytes: string
  maxPrimaryAttempts: string
  fallbackEnabled: boolean
  retryableStatuses: string
  rateLimitEnabled: boolean
  rateLimitWindowMillis: string
  rateLimitMaxTokens: string
}

const steps = ['基本信息', '供应商接入', '协议映射', 'API Token', '访问与流量策略']

function emptyEditor(): EditorState {
  return {
    displayName: '',
    logicalModelName: '',
    description: '',
    tags: '',
    providers: [newProviderDraft()],
    prefixMaxBytes: '2048',
    maxPrimaryAttempts: '0',
    fallbackEnabled: true,
    retryableStatuses: '429, 502, 503, 504',
    rateLimitEnabled: false,
    rateLimitWindowMillis: '60000',
    rateLimitMaxTokens: '100000',
  }
}

function editorFromDetail(detail: MarketplaceModelDetail): EditorState {
  return {
    displayName: detail.displayName,
    logicalModelName: detail.logicalModelName,
    description: detail.description,
    tags: detail.tags.join(', '),
    providers: detail.providers.map((provider, index) => ({
      key: index + 10_000,
      id: provider.id,
      displayName: provider.displayName,
      baseUrl: provider.baseUrl,
      routeRole: provider.routeRole,
      protocols: modelProtocols.map((definition) => {
        const current = provider.protocols.find((protocol) => protocol.type === definition.type)
        return {
          type: definition.type,
          enabled: Boolean(current),
          path: current?.path ?? definition.defaultPath,
          upstreamModelName: current?.upstreamModelName ?? '',
        }
      }),
      authenticationMode: provider.tokens.length ? 'BEARER_TOKEN_POOL' : 'NO_CREDENTIALS',
      tokens: provider.tokens.map((token) => existingTokenRow(token.id, token.name)),
    })),
    prefixMaxBytes: String(detail.prefixMaxBytes),
    maxPrimaryAttempts: String(detail.maxPrimaryAttempts),
    fallbackEnabled: detail.fallbackEnabled,
    retryableStatuses: detail.retryableStatuses.join(', '),
    rateLimitEnabled: detail.rateLimit !== null,
    rateLimitWindowMillis: detail.rateLimit?.windowDurationMillis ?? '60000',
    rateLimitMaxTokens: detail.rateLimit?.maxTokensPerWindow ?? '100000',
  }
}

function localIssues(editor: EditorState): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const add = (code: string, message: string, field: string) =>
    issues.push({ code, message, field, severity: 'ERROR' })
  if (!editor.displayName.trim())
    add('MODEL_DISPLAY_NAME_REQUIRED', '请填写模型显示名称', '/displayName')
  if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(editor.logicalModelName))
    add('LOGICAL_MODEL_NAME_INVALID', '逻辑模型名只能使用安全 ASCII 字符', '/logicalModelName')
  if (editor.providers.length === 0)
    add('MODEL_PROVIDER_REQUIRED', '至少添加一个供应商', '/providers')
  if (editor.providers.filter((provider) => provider.routeRole === 'FALLBACK').length > 1)
    add('MODEL_FALLBACK_DUPLICATE', '最多配置一个 Fallback', '/providers')
  editor.providers.forEach((provider, index) => {
    if (!provider.displayName.trim())
      add(
        'PROVIDER_DISPLAY_NAME_REQUIRED',
        '请填写供应商显示名称',
        `/providers/${index}/displayName`,
      )
    if (!provider.baseUrl.trim())
      add('PROVIDER_ENDPOINT_REQUIRED', '请填写 Base URL', `/providers/${index}/baseUrl`)
    if (!provider.protocols.some((protocol) => protocol.enabled))
      add('PROVIDER_PROTOCOL_REQUIRED', '至少启用一项协议', `/providers/${index}/protocols`)
    provider.protocols
      .filter((protocol) => protocol.enabled)
      .forEach((protocol) => {
        if (!protocol.upstreamModelName.trim())
          add(
            'UPSTREAM_MODEL_REQUIRED',
            '请填写供应商上游模型名',
            `/providers/${index}/protocols/${protocol.type}/upstreamModelName`,
          )
      })
    if (
      provider.authenticationMode === 'BEARER_TOKEN_POOL' &&
      provider.tokens.filter((token) => token.action !== 'delete').length === 0
    )
      add(
        'PROVIDER_TOKEN_REQUIRED',
        'Token 池至少需要一个 Token',
        `/providers/${index}/authentication/tokens`,
      )
    provider.tokens.forEach((token, tokenIndex) => {
      if (!token.name.trim())
        add(
          'PROVIDER_TOKEN_NAME_INVALID',
          '请填写 Token 名',
          `/providers/${index}/authentication/tokens/${tokenIndex}/name`,
        )
      if (token.action === 'replace' && !token.value)
        add(
          'PROVIDER_TOKEN_VALUE_INVALID',
          '请填写新的 Token 值',
          `/providers/${index}/authentication/tokens/${tokenIndex}/value`,
        )
    })
  })
  return issues
}

function tokenMutation(row: TokenDraftRow): TokenMutation {
  if (row.kind === 'new') return { name: row.name, secretAction: 'replace', value: row.value }
  if (row.action === 'keep') return { id: row.id, name: row.name, secretAction: 'keep' }
  if (row.action === 'delete') return { id: row.id, name: row.name, secretAction: 'delete' }
  return { id: row.id, name: row.name, secretAction: 'replace', value: row.value }
}

function mutationFromEditor(editor: EditorState): ModelMutation {
  let primaryOrder = 0
  return {
    displayName: editor.displayName,
    logicalModelName: editor.logicalModelName,
    description: editor.description,
    tags: editor.tags
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean),
    providers: editor.providers.map((provider) => ({
      id: provider.id,
      mode: provider.id ? 'UPDATE_EXISTING' : 'CREATE_DEDICATED',
      displayName: provider.displayName,
      baseUrl: provider.baseUrl,
      routeRole: provider.routeRole,
      sortOrder: provider.routeRole === 'PRIMARY' ? primaryOrder++ : 0,
      protocols: provider.protocols
        .filter((protocol) => protocol.enabled)
        .map(({ type, path, upstreamModelName }) => ({ type, path, upstreamModelName })),
      authentication: {
        mode: provider.authenticationMode,
        tokens:
          provider.authenticationMode === 'BEARER_TOKEN_POOL'
            ? provider.tokens.map(tokenMutation)
            : [],
        confirmUnauthenticated: provider.authenticationMode === 'NO_CREDENTIALS' ? true : undefined,
      },
    })),
    allowUserGroupIds: [],
    loadBalance: {
      prefixMaxBytes: Number(editor.prefixMaxBytes),
      maxPrimaryAttempts: Number(editor.maxPrimaryAttempts),
      fallbackEnabled: editor.fallbackEnabled,
      retryableStatuses: editor.retryableStatuses
        .split(',')
        .map((value) => Number(value.trim()))
        .filter(Number.isInteger),
    },
    rateLimit: editor.rateLimitEnabled
      ? {
          windowDurationMillis: editor.rateLimitWindowMillis,
          maxTokensPerWindow: editor.rateLimitMaxTokens,
        }
      : null,
  }
}

export function ModelEditorPage({
  environmentId,
  modelId,
  onBack,
  onSaved,
  onError,
  onNotice,
}: {
  environmentId: string
  modelId?: string
  onBack: () => void
  onSaved: (modelId: string) => void
  onError: (message: string) => void
  onNotice: (message: string) => void
}) {
  const [editor, setEditor] = useState<EditorState>(emptyEditor)
  const [step, setStep] = useState(0)
  const [draftId, setDraftId] = useState<string | null>(null)
  const [etag, setEtag] = useState<string | null>(null)
  const [baseline, setBaseline] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [conflictRevision, setConflictRevision] = useState<number | null>(null)
  const [issues, setIssues] = useState<ValidationIssue[]>([])
  const validationRef = useRef<HTMLElement>(null)
  const editorRef = useRef(editor)
  const allowNavigationRef = useRef(false)
  editorRef.current = editor
  const dirty = baseline !== '' && JSON.stringify(editor) !== baseline

  useEffect(() => {
    let alive = true
    const task = modelId
      ? modelMarketplaceApi.detail(environmentId, modelId).then((response) => ({
          editor: editorFromDetail(response.data),
          draftId: response.data.draft.versionId,
          etag: response.etag,
        }))
      : modelMarketplaceApi.listAdmin(environmentId).then((response) => ({
          editor: emptyEditor(),
          draftId: response.data.draft.id,
          etag: response.etag,
        }))
    void task
      .then((loaded) => {
        if (!alive) return
        setEditor(loaded.editor)
        setBaseline(JSON.stringify(loaded.editor))
        setDraftId(loaded.draftId)
        setEtag(loaded.etag)
      })
      .catch((error) => onError(error instanceof Error ? error.message : '编辑器加载失败'))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
      for (const provider of editorRef.current.providers) {
        for (const token of provider.tokens) {
          if (token.action === 'replace') token.value = ''
        }
      }
    }
  }, [environmentId, modelId, onError])

  useEffect(() => {
    if (!dirty) return
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', protect)
    return () => window.removeEventListener('beforeunload', protect)
  }, [dirty])

  useEffect(() => {
    const editorHash = window.location.hash
    const protectHashNavigation = () => {
      if (allowNavigationRef.current || !dirty) return
      if (window.confirm('放弃尚未保存的本地修改？未提交的 Token 输入会被清空。')) {
        allowNavigationRef.current = true
        return
      }
      allowNavigationRef.current = true
      window.location.hash = editorHash
      window.setTimeout(() => {
        allowNavigationRef.current = false
      }, 0)
    }
    window.addEventListener('hashchange', protectHashNavigation)
    return () => window.removeEventListener('hashchange', protectHashNavigation)
  }, [dirty])

  const coverage = useMemo(
    () => ({
      openai: editor.providers.some((provider) =>
        provider.protocols.some(
          (protocol) => protocol.type === 'OPENAI_CHAT_COMPLETIONS' && protocol.enabled,
        ),
      )
        ? ('SUPPORTED' as const)
        : ('UNSUPPORTED' as const),
      anthropic: editor.providers.some((provider) =>
        provider.protocols.some(
          (protocol) => protocol.type === 'ANTHROPIC_MESSAGES' && protocol.enabled,
        ),
      )
        ? ('SUPPORTED' as const)
        : ('UNSUPPORTED' as const),
    }),
    [editor.providers],
  )

  const save = async () => {
    const foundIssues = localIssues(editor)
    setIssues(foundIssues)
    if (foundIssues.length) {
      validationRef.current?.focus()
      return
    }
    if (!draftId || !etag) return
    setBusy(true)
    setConflictRevision(null)
    try {
      const mutation = mutationFromEditor(editor)
      const response = modelId
        ? await modelMarketplaceApi.update(environmentId, draftId, modelId, etag, mutation)
        : await modelMarketplaceApi.create(environmentId, draftId, etag, mutation)
      const clean = editorFromDetail(response.data)
      setEditor(clean)
      setBaseline(JSON.stringify(clean))
      setEtag(response.etag)
      setIssues([])
      onNotice('模型草稿已保存到 MySQL；尚未发布到 rnacos，也未证明实例生效。')
      allowNavigationRef.current = true
      onSaved(response.data.id)
    } catch (error) {
      if (error instanceof ApiError && error.status === 412) {
        setConflictRevision(
          typeof error.details?.serverRevision === 'number' ? error.details.serverRevision : 0,
        )
      } else {
        onError(error instanceof Error ? error.message : '保存草稿失败')
      }
    } finally {
      setBusy(false)
    }
  }

  const back = () => {
    if (!dirty || window.confirm('放弃尚未保存的本地修改？未提交的 Token 输入会被清空。')) {
      allowNavigationRef.current = true
      onBack()
    }
  }

  const reload = async () => {
    if (!modelId) return window.location.reload()
    setBusy(true)
    try {
      const response = await modelMarketplaceApi.detail(environmentId, modelId)
      const clean = editorFromDetail(response.data)
      setEditor(clean)
      setBaseline(JSON.stringify(clean))
      setEtag(response.etag)
      setConflictRevision(null)
    } finally {
      setBusy(false)
    }
  }

  const copyRedacted = async () => {
    const mutation = mutationFromEditor(editor)
    for (const provider of mutation.providers) {
      for (const token of provider.authentication.tokens) {
        if (token.secretAction === 'replace') token.value = '[REDACTED]'
      }
    }
    await navigator.clipboard.writeText(JSON.stringify(mutation, null, 2))
    onNotice('已复制脱敏本地 JSON；Token 值未写入剪贴板。')
  }

  if (loading) return <div className="page-shell marketplace-loading">正在准备完整环境草稿…</div>
  return (
    <div className="page-shell model-editor-page">
      <button className="back-link" type="button" onClick={back}>
        <ArrowLeft size={15} /> 返回模型详情
      </button>
      <header className="page-header editor-header">
        <div>
          <span className="eyebrow">MODEL CONFIGURATION / {modelId ? 'EDIT' : 'CREATE'}</span>
          <h1>{modelId ? '编辑模型草稿' : '新增模型'}</h1>
          <p>五个步骤始终编辑 MySQL 开放草稿；保存不会直接写 rnacos。</p>
        </div>
        <button
          className="primary-button"
          type="button"
          disabled={busy}
          onClick={() => void save()}
        >
          <Save size={15} /> 保存草稿
        </button>
      </header>
      <ol className="editor-steps" aria-label="新增模型步骤">
        {steps.map((label, index) => (
          <li
            key={label}
            aria-current={step === index ? 'step' : undefined}
            className={step === index ? 'active' : index < step ? 'complete' : ''}
          >
            <button type="button" onClick={() => setStep(index)}>
              <span>{index < step ? <Check size={13} /> : index + 1}</span>
              <b>{label}</b>
            </button>
          </li>
        ))}
      </ol>
      {conflictRevision !== null && (
        <section className="revision-conflict" role="alert">
          <ShieldAlert size={19} />
          <div>
            <b>
              服务器草稿 revision 已变化
              {conflictRevision > 0 ? `（当前为 ${conflictRevision}）` : ''}
            </b>
            <span>本地输入没有被覆盖。你可以重新加载服务端事实，或先复制脱敏本地 JSON。</span>
          </div>
          <button className="secondary-button" type="button" onClick={() => void copyRedacted()}>
            <Clipboard size={14} /> 复制脱敏 JSON
          </button>
          <button className="danger-button" type="button" onClick={() => void reload()}>
            重新加载
          </button>
        </section>
      )}
      {issues.length > 0 && <ValidationSummary ref={validationRef} issues={issues} />}
      <section className="data-card editor-stage">
        <div className="card-heading">
          <div>
            <span className="eyebrow">STEP {String(step + 1).padStart(2, '0')}</span>
            <h2>{steps[step]}</h2>
            <p>
              {step === 0 && '区分控制台展示名称和客户端请求使用的逻辑模型名。'}
              {step === 1 && 'Provider 标识由服务端生成，显示名称变化不会改变 Data ID。'}
              {step === 2 && '每种入站协议独立配置路径和供应商上游模型名。'}
              {step === 3 && '供应商 Token 是只写值；已保存内容只显示配置状态。'}
              {step === 4 && '检查静态协议覆盖并配置确定性的负载均衡参数。'}
            </p>
          </div>
          <span>{step + 1} / 5</span>
        </div>
        <div className="editor-stage-body">
          {step === 0 && (
            <div className="form-grid">
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
                  onChange={(event) =>
                    setEditor({ ...editor, logicalModelName: event.target.value })
                  }
                />
                <small>
                  {modelId
                    ? '逻辑模型名不可原地修改；请复制为新模型。'
                    : '客户端请求体 model 使用此值，创建后永久稳定。'}
                </small>
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
                <small>使用逗号分隔，最多 20 个。</small>
              </label>
            </div>
          )}
          {step === 1 && (
            <ProviderEditor
              providers={editor.providers}
              onChange={(providers) => setEditor({ ...editor, providers })}
            />
          )}
          {step === 2 && (
            <div className="protocol-provider-stack">
              {editor.providers.map((provider, index) => (
                <section key={provider.key}>
                  <h3>{provider.displayName || `供应商接入 ${index + 1}`}</h3>
                  <ProtocolEditor
                    protocols={provider.protocols}
                    onChange={(protocols) =>
                      setEditor({
                        ...editor,
                        providers: editor.providers.map((candidate) =>
                          candidate.key === provider.key ? { ...candidate, protocols } : candidate,
                        ),
                      })
                    }
                  />
                </section>
              ))}
            </div>
          )}
          {step === 3 && (
            <div className="token-provider-stack">
              {editor.providers.map((provider, index) => (
                <section key={provider.key}>
                  <div className="token-mode-heading">
                    <div>
                      <h3>{provider.displayName || `供应商接入 ${index + 1}`}</h3>
                      <p>ai-server 固定使用 Authorization: Bearer。</p>
                    </div>
                    <label className="checkbox-field">
                      <input
                        type="checkbox"
                        checked={provider.authenticationMode === 'NO_CREDENTIALS'}
                        onChange={(event) =>
                          setEditor({
                            ...editor,
                            providers: editor.providers.map((candidate) =>
                              candidate.key === provider.key
                                ? {
                                    ...candidate,
                                    authenticationMode: event.target.checked
                                      ? 'NO_CREDENTIALS'
                                      : 'BEARER_TOKEN_POOL',
                                    tokens: event.target.checked
                                      ? candidate.tokens.map((token) =>
                                          token.kind === 'new'
                                            ? { ...token, value: '' }
                                            : token.action === 'replace'
                                              ? { ...token, action: 'keep', value: '' }
                                              : token,
                                        )
                                      : candidate.tokens,
                                  }
                                : candidate,
                            ),
                          })
                        }
                      />
                      <span>明确使用无凭据调用</span>
                    </label>
                  </div>
                  {provider.authenticationMode === 'NO_CREDENTIALS' ? (
                    <div className="unauthenticated-confirmation">
                      <ShieldAlert size={17} />
                      <span>
                        <b>已显式选择无凭据调用</b>
                        <small>
                          保存后当前草稿不会引用任何 Provider Token；历史 release 不受影响。
                        </small>
                      </span>
                    </div>
                  ) : (
                    <TokenPoolEditor
                      rows={provider.tokens}
                      onChange={(tokens) =>
                        setEditor({
                          ...editor,
                          providers: editor.providers.map((candidate) =>
                            candidate.key === provider.key ? { ...candidate, tokens } : candidate,
                          ),
                        })
                      }
                    />
                  )}
                </section>
              ))}
            </div>
          )}
          {step === 4 && (
            <div className="policy-editor">
              <ProtocolCoverageMatrix coverage={coverage} />
              <div className="form-grid two-columns">
                <label>
                  <span>Prompt 前缀最大字节</span>
                  <input
                    inputMode="numeric"
                    value={editor.prefixMaxBytes}
                    onChange={(event) =>
                      setEditor({ ...editor, prefixMaxBytes: event.target.value })
                    }
                  />
                </label>
                <label>
                  <span>最大主供应商尝试数</span>
                  <input
                    inputMode="numeric"
                    value={editor.maxPrimaryAttempts}
                    onChange={(event) =>
                      setEditor({ ...editor, maxPrimaryAttempts: event.target.value })
                    }
                  />
                </label>
                <label className="full-field">
                  <span>可重试 HTTP 状态</span>
                  <input
                    value={editor.retryableStatuses}
                    onChange={(event) =>
                      setEditor({ ...editor, retryableStatuses: event.target.value })
                    }
                  />
                </label>
                <label className="checkbox-field full-field">
                  <input
                    type="checkbox"
                    checked={editor.fallbackEnabled}
                    onChange={(event) =>
                      setEditor({ ...editor, fallbackEnabled: event.target.checked })
                    }
                  />
                  <span>启用 Fallback 候选</span>
                </label>
                <label className="checkbox-field full-field">
                  <input
                    type="checkbox"
                    checked={editor.rateLimitEnabled}
                    onChange={(event) =>
                      setEditor({ ...editor, rateLimitEnabled: event.target.checked })
                    }
                  />
                  <span>启用模型 Token 限流</span>
                </label>
                {editor.rateLimitEnabled && (
                  <>
                    <label>
                      <span>窗口毫秒数（uint64 字符串）</span>
                      <input
                        value={editor.rateLimitWindowMillis}
                        onChange={(event) =>
                          setEditor({ ...editor, rateLimitWindowMillis: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      <span>窗口最大 Token（uint64 字符串）</span>
                      <input
                        value={editor.rateLimitMaxTokens}
                        onChange={(event) =>
                          setEditor({ ...editor, rateLimitMaxTokens: event.target.value })
                        }
                      />
                    </label>
                  </>
                )}
              </div>
              <div className="boundary-notice compact">
                <ShieldAlert size={16} />
                <div>
                  <b>访问范围</b>
                  <span>
                    用户组模块尚未开放选择器，本次保存保持“所有已认证用户”；不能用控制台 ADMIN/USER
                    角色替代模型用户组。
                  </span>
                </div>
              </div>
            </div>
          )}
        </div>
        <footer className="editor-stage-actions">
          <button
            className="secondary-button"
            type="button"
            disabled={step === 0}
            onClick={() => setStep((current) => current - 1)}
          >
            <ArrowLeft size={14} /> 上一步
          </button>
          {step < steps.length - 1 ? (
            <button
              className="primary-button"
              type="button"
              onClick={() => setStep((current) => current + 1)}
            >
              下一步 <ArrowRight size={14} />
            </button>
          ) : (
            <button
              className="primary-button"
              type="button"
              disabled={busy}
              onClick={() => void save()}
            >
              <Save size={14} /> 保存完整草稿
            </button>
          )}
        </footer>
      </section>
    </div>
  )
}
