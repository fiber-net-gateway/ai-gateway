import { CircleAlert, CloudUpload, Database, Radio } from 'lucide-react'

import type { ActivationState, DraftState, PublicationState } from '../../api/model-marketplace'

const labels = {
  draft: {
    NONE: '无草稿',
    MODIFIED: '草稿已修改',
    INVALID: '草稿有错误',
    CONFLICTED: '草稿有冲突',
  },
  publication: {
    NEVER: '尚未发布',
    PUBLISHED: 'rnacos 已发布',
    PARTIAL: '部分发布',
    FAILED: '发布失败',
    DRIFTED: '配置已漂移',
  },
  activation: {
    UNKNOWN: '实例状态未知',
    PENDING: '等待实例确认',
    EFFECTIVE: '实例已生效',
    PARTIAL: '部分实例生效',
    REJECTED: '实例拒绝配置',
  },
} as const

export function ModelStateStrip({
  draft,
  publication,
  activation,
}: {
  draft: DraftState
  publication: PublicationState
  activation: ActivationState
}) {
  return (
    <div className="model-state-strip" aria-label="配置状态证据">
      <span className={`state-${draft.toLowerCase()}`}>
        {draft === 'INVALID' || draft === 'CONFLICTED' ? (
          <CircleAlert size={13} />
        ) : (
          <Database size={13} />
        )}
        <small>MySQL 草稿</small>
        <b>{labels.draft[draft]}</b>
      </span>
      <span className={`state-${publication.toLowerCase()}`}>
        <CloudUpload size={13} />
        <small>rnacos 发布</small>
        <b>{labels.publication[publication]}</b>
      </span>
      <span className={`state-${activation.toLowerCase()}`}>
        <Radio size={13} />
        <small>ai-server 生效</small>
        <b>{labels.activation[activation]}</b>
      </span>
    </div>
  )
}
