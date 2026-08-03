import { ArrowDown, ArrowUp, Plus, Server, Trash2 } from 'lucide-react'

import type { ProviderDraft } from './types'

let nextProviderKey = 1

export function newProviderDraft(): ProviderDraft {
  return {
    key: nextProviderKey++,
    displayName: '',
    baseUrl: '',
    routeRole: 'PRIMARY',
    protocols: [
      {
        type: 'OPENAI_CHAT_COMPLETIONS',
        enabled: true,
        path: '/v1/chat/completions',
        upstreamModelName: '',
      },
      {
        type: 'ANTHROPIC_MESSAGES',
        enabled: false,
        path: '/v1/messages',
        upstreamModelName: '',
      },
    ],
    authenticationMode: 'BEARER_TOKEN_POOL',
    tokens: [],
  }
}

export function ProviderEditor({
  providers,
  onChange,
}: {
  providers: ProviderDraft[]
  onChange: (providers: ProviderDraft[]) => void
}) {
  const update = (key: number, values: Partial<ProviderDraft>) =>
    onChange(
      providers.map((provider) => (provider.key === key ? { ...provider, ...values } : provider)),
    )
  const move = (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= providers.length) return
    const next = [...providers]
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange(next)
  }
  return (
    <div className="provider-editor-list">
      {providers.map((provider, index) => (
        <section className="provider-editor" key={provider.key}>
          <header>
            <div>
              <Server size={17} />
              <span>
                <b>供应商接入 {index + 1}</b>
                <small>
                  {provider.id
                    ? '稳定 Provider 标识由服务端保留'
                    : '保存后由服务端生成稳定 Provider 标识'}
                </small>
              </span>
            </div>
            <div className="provider-order-actions">
              <button
                type="button"
                aria-label="上移供应商"
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp size={14} />
              </button>
              <button
                type="button"
                aria-label="下移供应商"
                disabled={index === providers.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown size={14} />
              </button>
              <button
                type="button"
                aria-label="移除供应商"
                disabled={providers.length === 1}
                onClick={() =>
                  onChange(providers.filter((candidate) => candidate.key !== provider.key))
                }
              >
                <Trash2 size={14} />
              </button>
            </div>
          </header>
          <div className="form-grid two-columns">
            <label>
              <span>供应商显示名称</span>
              <input
                value={provider.displayName}
                onChange={(event) => update(provider.key, { displayName: event.target.value })}
              />
            </label>
            <label>
              <span>路由角色</span>
              <select
                value={provider.routeRole}
                onChange={(event) =>
                  update(provider.key, {
                    routeRole: event.target.value as ProviderDraft['routeRole'],
                  })
                }
              >
                <option value="PRIMARY">主供应商</option>
                <option value="FALLBACK">Fallback</option>
              </select>
            </label>
            <label className="full-field">
              <span>Base URL</span>
              <input
                placeholder="https://api.vendor.example"
                value={provider.baseUrl}
                onChange={(event) => update(provider.key, { baseUrl: event.target.value })}
              />
              <small>支持 http://、https:// 或 service://；保存时移除多余尾部 /。</small>
            </label>
          </div>
        </section>
      ))}
      <button
        className="add-provider-button"
        type="button"
        onClick={() => onChange([...providers, newProviderDraft()])}
      >
        <Plus size={15} /> 添加供应商接入
      </button>
    </div>
  )
}
