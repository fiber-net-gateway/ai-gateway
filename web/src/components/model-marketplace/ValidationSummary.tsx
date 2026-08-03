import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react'
import { forwardRef } from 'react'

import type { ValidationIssue } from '../../api/model-marketplace'

export const ValidationSummary = forwardRef<HTMLElement, { issues: ValidationIssue[] }>(
  function ValidationSummary({ issues }, ref) {
    if (issues.length === 0) {
      return (
        <section className="validation-summary valid" ref={ref} tabIndex={-1}>
          <CheckCircle2 size={18} />
          <div>
            <b>静态校验通过</b>
            <span>字段、关系和协议覆盖没有阻塞错误。</span>
          </div>
        </section>
      )
    }
    return (
      <section className="validation-summary" ref={ref} tabIndex={-1} aria-live="polite">
        {issues.some((issue) => issue.severity === 'ERROR') ? (
          <XCircle size={18} />
        ) : (
          <AlertTriangle size={18} />
        )}
        <div>
          <b>
            {issues.filter((issue) => issue.severity === 'ERROR').length} 个错误，
            {issues.filter((issue) => issue.severity === 'WARNING').length} 个提醒
          </b>
          <ul>
            {issues.map((issue) => (
              <li key={`${issue.code}:${issue.field}`}>
                <span>{issue.severity === 'ERROR' ? '错误' : '提醒'}</span>
                {issue.message}
                <code>{issue.field}</code>
              </li>
            ))}
          </ul>
        </div>
      </section>
    )
  },
)
