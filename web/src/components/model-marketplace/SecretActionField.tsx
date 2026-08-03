import { Eye, EyeOff } from 'lucide-react'
import { useState } from 'react'

export function SecretActionField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (value: string) => void
}) {
  const [visible, setVisible] = useState(false)
  return (
    <label className="secret-action-field">
      <span>{label}</span>
      <span className="secret-input-wrap">
        <input
          type={visible ? 'text' : 'password'}
          value={value}
          autoComplete="new-password"
          spellCheck={false}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          aria-label={visible ? '隐藏尚未保存的 Token' : '显示尚未保存的 Token'}
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </span>
      <small>只写字段。保存成功后浏览器会立即清空该值。</small>
    </label>
  )
}
