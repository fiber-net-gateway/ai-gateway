import { LoaderCircle, Send, ShieldCheck } from 'lucide-react'
import { useEffect, useId, useState } from 'react'

import { modelAccessApi, type ApplicantAccessRequest } from '../../api/model-access'
import type { AvailableModelSummary } from '../../api/model-marketplace'
import { Modal } from '../Modal'

export function AccessRequestDialog({
  open,
  environmentId,
  model,
  onClose,
  onCreated,
  onError,
}: {
  open: boolean
  environmentId: string
  model: AvailableModelSummary
  onClose: () => void
  onCreated: (request: ApplicantAccessRequest) => void
  onError: (message: string) => void
}) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const helpId = useId()

  useEffect(() => {
    if (!open) setReason('')
  }, [open])

  const submit = async () => {
    const normalized = reason.trim()
    if (normalized.length < 10 || normalized.length > 500) {
      onError('用途说明需要 10 到 500 个字符')
      return
    }
    setBusy(true)
    try {
      const request = await modelAccessApi.create(environmentId, model.id, normalized)
      setReason('')
      onCreated(request)
      onClose()
    } catch (error) {
      onError(error instanceof Error ? error.message : '权限申请提交失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal open={open} title="申请模型调用权限" eyebrow="MODEL ACCESS" onClose={onClose}>
      <div className="modal-body access-request-dialog">
        <div className="access-request-target">
          <ShieldCheck size={20} />
          <span>
            <b>{model.displayName}</b>
            <code>{model.logicalModelName}</code>
          </span>
        </div>
        <p id={helpId} className="field-help">
          管理员批准后会把你的精确 username 加入模型申请授权组。Provider 只托管该组；实际请求仍可能
          路由到模型配置的其他主 Provider 或 Fallback。
        </p>
        <label className="stacked-field">
          <span>用途说明</span>
          <textarea
            autoFocus
            value={reason}
            maxLength={500}
            aria-describedby={helpId}
            placeholder="说明业务场景、使用团队和预期用途（至少 10 个字符）"
            onChange={(event) => setReason(event.target.value)}
          />
          <small>{reason.trim().length} / 500</small>
        </label>
      </div>
      <footer className="modal-actions">
        <button className="secondary-button" type="button" disabled={busy} onClick={onClose}>
          取消
        </button>
        <button
          className="primary-button"
          type="button"
          disabled={busy}
          onClick={() => void submit()}
        >
          {busy ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}
          提交申请
        </button>
      </footer>
    </Modal>
  )
}
