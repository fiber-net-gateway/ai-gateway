import {
  AlertTriangle,
  CloudUpload,
  Database,
  Fingerprint,
  KeyRound,
  RefreshCw,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

import { keyRingApi, type KeyRingView } from '../api/key-ring'
import { confirmLocalized } from '../i18n'

function short(value: string | null, size = 16): string {
  if (!value) return '—'
  return value.length > size ? `${value.slice(0, size)}…` : value
}

function RingBadge({ value }: { value: string }) {
  return <span className={`release-badge state-${value.toLowerCase()}`}>{value}</span>
}

export function KeyRingPage({
  environmentId,
  onError,
  onNotice,
}: {
  environmentId: string
  onError: (message: string) => void
  onNotice: (message: string) => void
}) {
  const [view, setView] = useState<KeyRingView | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setView(await keyRingApi.inspect(environmentId))
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Key Ring 加载失败')
    } finally {
      setLoading(false)
    }
  }, [environmentId, onError])

  useEffect(() => {
    void load()
  }, [load])

  const publish = async () => {
    if (!confirmLocalized('发布当前 BT1 Key Ring 到 rnacos 并执行精确 MD5 回读？')) return
    setBusy(true)
    try {
      const result = await keyRingApi.publish(environmentId)
      setView(result)
      onNotice('BT1 Key Ring 已发布并通过 rnacos MD5 回读验证。')
    } catch (error) {
      onError(error instanceof Error ? error.message : 'Key Ring 发布失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page-shell key-ring-page">
      <header className="page-header">
        <div>
          <span className="eyebrow">BT1 SIGNING KEY CONFIGURATION</span>
          <h1>Key Ring</h1>
          <p>管理 MySQL 中的签名 key 元数据，并单独验证 rnacos 发布证据。</p>
        </div>
        <div className="page-header-actions">
          <button
            className="secondary-button"
            type="button"
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshCw size={15} /> 刷新证据
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={busy || !view?.target}
            onClick={() => void publish()}
          >
            <CloudUpload size={15} /> {busy ? '发布中…' : '发布并回读'}
          </button>
        </div>
      </header>

      <section className="key-ring-evidence" aria-label="Key Ring 发布证据">
        <article className="data-card">
          <Database size={18} />
          <span>
            <small>MySQL keys</small>
            <b>{view?.keys.length ?? '—'}</b>
          </span>
        </article>
        <article className="data-card">
          <CloudUpload size={18} />
          <span>
            <small>rnacos publication</small>
            {view ? <RingBadge value={view.publicationState} /> : <b>—</b>}
          </span>
        </article>
        <article className="data-card">
          <Fingerprint size={18} />
          <span>
            <small>target / readback MD5</small>
            <code>
              {short(view?.targetMd5 ?? null)} / {short(view?.readbackMd5 ?? null)}
            </code>
          </span>
        </article>
      </section>

      <section className="data-card key-ring-table-card">
        <div className="card-heading">
          <div>
            <h2>签名 key 安全视图</h2>
            <p>
              <code>{view?.dataId ?? 'ploto.ai-llm.auth.bt1.keys'}</code>
            </p>
          </div>
          <span>{view?.contentBytes ?? 0} BYTES</span>
        </div>
        {loading ? (
          <div className="release-list-empty">正在读取 Key Ring…</div>
        ) : (
          <div className="key-ring-list">
            {view?.keys.map((key) => (
              <article key={key.id}>
                <KeyRound size={17} />
                <span>
                  <b>{key.kid}</b>
                  <small>fingerprint …{key.fingerprintSuffix}</small>
                </span>
                <RingBadge value={key.keyState} />
                <dl>
                  <div>
                    <dt>签发</dt>
                    <dd>{key.issuanceEnabled ? 'ENABLED' : 'DISABLED'}</dd>
                  </div>
                  <div>
                    <dt>Clock skew</dt>
                    <dd>{key.clockSkewSeconds}s</dd>
                  </div>
                  <div>
                    <dt>Revision</dt>
                    <dd>{key.revision}</dd>
                  </div>
                </dl>
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="release-risk-callout">
        <AlertTriangle size={16} />
        <span>
          <b>证据边界</b>
          <small>
            MD5 回读只证明 Key Ring 已写入 rnacos；当前仍没有每个 ai-server 实例接受该 Data ID
            的证据。
          </small>
        </span>
      </section>
      {view?.errorCode && <p className="form-error">{view.errorCode}</p>}
    </div>
  )
}
