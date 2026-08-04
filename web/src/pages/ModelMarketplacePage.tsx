import { Box, CloudUpload, Filter, Plus, Search } from 'lucide-react'
import { useEffect, useState } from 'react'

import {
  modelMarketplaceApi,
  type AvailableModelSummary,
  type MarketplaceModelSummary,
} from '../api/model-marketplace'
import { AdminModelCard, AvailableModelCard } from '../components/model-marketplace/ModelCard'

export function ModelMarketplacePage({
  environmentId,
  admin,
  onOpen,
  onCreate,
  onOpenReleases,
  onError,
}: {
  environmentId: string
  admin: boolean
  onOpen: (modelId: string) => void
  onCreate: () => void
  onOpenReleases: () => void
  onError: (message: string) => void
}) {
  const [models, setModels] = useState<Array<MarketplaceModelSummary | AvailableModelSummary>>([])
  const [search, setSearch] = useState('')
  const [protocol, setProtocol] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    const timer = window.setTimeout(() => {
      const load = admin
        ? modelMarketplaceApi
            .listAdmin(environmentId, { search, protocol })
            .then((response) => response.data.items)
        : modelMarketplaceApi
            .listAvailable(environmentId, { search, protocol })
            .then((response) => response.items)
      void load
        .then((items) => {
          if (alive) setModels(items)
        })
        .catch(
          (error) => alive && onError(error instanceof Error ? error.message : '模型目录加载失败'),
        )
        .finally(() => alive && setLoading(false))
    }, 180)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [admin, environmentId, onError, protocol, search])

  return (
    <div className="page-shell marketplace-page">
      <header className="page-header marketplace-header">
        <div>
          <span className="eyebrow">MODEL MARKETPLACE / {admin ? 'ADMIN DRAFT' : 'AVAILABLE'}</span>
          <h1>模型广场</h1>
          <p>
            {admin
              ? '把逻辑模型、供应商接入、协议映射和凭据组织成可发布的完整草稿。'
              : '查看当前环境已经发布、且对你的账号安全可见的模型目录。'}
          </p>
        </div>
        {admin && (
          <div className="page-header-actions">
            <button className="secondary-button" type="button" onClick={onOpenReleases}>
              <CloudUpload size={16} /> 查看发布差异
            </button>
            <button className="primary-button" type="button" onClick={onCreate}>
              <Plus size={16} /> 新增模型
            </button>
          </div>
        )}
      </header>
      <section className="marketplace-boundary" aria-label="状态边界说明">
        <span>
          <b>01</b> 保存草稿 <small>仅写 MySQL</small>
        </span>
        <i />
        <span>
          <b>02</b> 发布配置 <small>逐 Data ID 写 rnacos</small>
        </span>
        <i />
        <span>
          <b>03</b> 实例生效 <small>必须有 ai-server 接受证据</small>
        </span>
      </section>
      <div className="marketplace-toolbar">
        <label className="search-field">
          <Search size={15} />
          <span className="sr-only">搜索模型</span>
          <input
            value={search}
            placeholder="搜索展示名称或逻辑模型名"
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <label className="marketplace-filter">
          <Filter size={14} />
          <span className="sr-only">按协议筛选</span>
          <select value={protocol} onChange={(event) => setProtocol(event.target.value)}>
            <option value="">全部协议</option>
            <option value="openai">支持 OpenAI</option>
            <option value="anthropic">支持 Anthropic</option>
          </select>
        </label>
        <span className="result-count">{models.length} 个模型</span>
      </div>
      {loading ? (
        <div className="marketplace-loading">正在读取模型投影…</div>
      ) : models.length === 0 ? (
        <section className="marketplace-empty">
          <Box size={28} />
          <h2>
            {search || protocol
              ? '没有符合筛选条件的模型'
              : admin
                ? '尚未配置模型'
                : '当前没有已发布模型'}
          </h2>
          <p>
            {admin
              ? '新建模型后只会保存到 MySQL 草稿，发布和实例生效仍是后续独立步骤。'
              : '管理员草稿不会出现在这里；只有可信的已发布投影会进入普通用户目录。'}
          </p>
          {admin && !search && !protocol && (
            <button className="primary-button" type="button" onClick={onCreate}>
              <Plus size={15} /> 创建第一个模型
            </button>
          )}
        </section>
      ) : (
        <div className="model-card-grid">
          {models.map((model) =>
            admin ? (
              <AdminModelCard
                key={model.id}
                model={model as MarketplaceModelSummary}
                onOpen={() => onOpen(model.id)}
              />
            ) : (
              <AvailableModelCard
                key={model.id}
                model={model as AvailableModelSummary}
                onOpen={() => onOpen(model.id)}
              />
            ),
          )}
        </div>
      )}
    </div>
  )
}
