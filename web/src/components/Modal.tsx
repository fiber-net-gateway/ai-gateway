import { X } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'

interface ModalProps {
  open: boolean
  title: string
  eyebrow?: string
  wide?: boolean
  children: ReactNode
  onClose: () => void
}

export function Modal({ open, title, eyebrow, wide, children, onClose }: ModalProps) {
  useEffect(() => {
    if (!open) return
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    document.body.classList.add('modal-open')
    return () => {
      document.removeEventListener('keydown', handleKey)
      document.body.classList.remove('modal-open')
    }
  }, [onClose, open])

  if (!open) return null
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className={`modal-panel${wide ? ' modal-panel-wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            {eyebrow && <span className="eyebrow">{eyebrow}</span>}
            <h2 id="modal-title">{title}</h2>
          </div>
          <button className="icon-button" type="button" aria-label="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        {children}
      </section>
    </div>
  )
}
