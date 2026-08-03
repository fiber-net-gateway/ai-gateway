import { Braces, MessageSquareText } from 'lucide-react'

import type { ProtocolCoverage } from '../../api/model-marketplace'

export function ProtocolBadge({
  type,
  coverage,
}: {
  type: 'openai' | 'anthropic'
  coverage: ProtocolCoverage
}) {
  const label = type === 'openai' ? 'OpenAI' : 'Anthropic'
  const Icon = type === 'openai' ? MessageSquareText : Braces
  return (
    <span
      className={`protocol-badge protocol-${coverage.toLowerCase()}`}
      title={`${label}：${coverage === 'SUPPORTED' ? '支持' : coverage === 'INVALID' ? '配置无效' : '不支持'}`}
    >
      <Icon size={13} aria-hidden="true" />
      {label} · {coverage === 'SUPPORTED' ? '支持' : coverage === 'INVALID' ? '无效' : '不支持'}
    </span>
  )
}
