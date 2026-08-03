import { Modal } from '../Modal'

export function ProviderImpactDialog({
  open,
  affectedModels,
  onClose,
  onConfirm,
}: {
  open: boolean
  affectedModels: Array<{ id: string; displayName: string }>
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <Modal open={open} title="确认共享 Provider 影响" eyebrow="HIGH RISK CHANGE" onClose={onClose}>
      <div className="modal-body">
        <p className="center-copy">
          此 Provider 被多个模型引用。保存会同时改变以下模型的供应商配置，但不会自动证明 rnacos
          发布或实例生效。
        </p>
        <ul className="impact-model-list">
          {affectedModels.map((model) => (
            <li key={model.id}>
              <b>{model.displayName}</b>
              <code>{model.id}</code>
            </li>
          ))}
        </ul>
        <div className="modal-actions">
          <button className="secondary-button" type="button" onClick={onClose}>
            取消
          </button>
          <button className="danger-button" type="button" onClick={onConfirm}>
            确认影响并继续
          </button>
        </div>
      </div>
    </Modal>
  )
}
