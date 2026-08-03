import { Check, Minus, X } from 'lucide-react'

import type { ProtocolCoverage } from '../../api/model-marketplace'

export function ProtocolCoverageMatrix({
  coverage,
}: {
  coverage: { openai: ProtocolCoverage; anthropic: ProtocolCoverage }
}) {
  const cell = (value: ProtocolCoverage) => {
    if (value === 'SUPPORTED')
      return (
        <span className="coverage-supported">
          <Check size={14} /> 可执行
        </span>
      )
    if (value === 'INVALID')
      return (
        <span className="coverage-invalid">
          <X size={14} /> 配置无效
        </span>
      )
    return (
      <span className="coverage-unsupported">
        <Minus size={14} /> 无候选
      </span>
    )
  }
  return (
    <div className="coverage-matrix" role="table" aria-label="静态协议覆盖矩阵">
      <div role="row">
        <b role="columnheader">入站协议</b>
        <b role="columnheader">静态候选</b>
      </div>
      <div role="row">
        <span role="cell">OpenAI Chat Completions</span>
        {cell(coverage.openai)}
      </div>
      <div role="row">
        <span role="cell">Anthropic Messages</span>
        {cell(coverage.anthropic)}
      </div>
    </div>
  )
}
