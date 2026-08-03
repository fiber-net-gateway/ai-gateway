import { Copy } from 'lucide-react'

import { modelProtocols } from '../../data/model-protocols'
import type { ProtocolDraft } from './types'

export function ProtocolEditor({
  protocols,
  onChange,
}: {
  protocols: ProtocolDraft[]
  onChange: (protocols: ProtocolDraft[]) => void
}) {
  const update = (type: ProtocolDraft['type'], values: Partial<ProtocolDraft>) =>
    onChange(
      protocols.map((protocol) => (protocol.type === type ? { ...protocol, ...values } : protocol)),
    )
  const openai = protocols.find((protocol) => protocol.type === 'OPENAI_CHAT_COMPLETIONS')
  return (
    <div className="protocol-editor-list">
      {modelProtocols.map((definition) => {
        const protocol = protocols.find((candidate) => candidate.type === definition.type)!
        return (
          <section
            className={`protocol-editor ${protocol.enabled ? 'enabled' : ''}`}
            key={definition.type}
          >
            <header>
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={protocol.enabled}
                  onChange={(event) => update(protocol.type, { enabled: event.target.checked })}
                />
                <span>
                  <b>{definition.label}</b>
                  <small>{definition.help}</small>
                </span>
              </label>
              {definition.type === 'ANTHROPIC_MESSAGES' && openai?.enabled && protocol.enabled && (
                <button
                  className="text-action"
                  type="button"
                  onClick={() =>
                    update(protocol.type, {
                      upstreamModelName: openai.upstreamModelName,
                    })
                  }
                >
                  <Copy size={13} /> 复制 OpenAI 上游模型名
                </button>
              )}
            </header>
            {protocol.enabled && (
              <div className="form-grid two-columns">
                <label>
                  <span>请求路径</span>
                  <input
                    value={protocol.path}
                    onChange={(event) => update(protocol.type, { path: event.target.value })}
                  />
                </label>
                <label>
                  <span>供应商上游模型名</span>
                  <input
                    value={protocol.upstreamModelName}
                    onChange={(event) =>
                      update(protocol.type, { upstreamModelName: event.target.value })
                    }
                  />
                </label>
              </div>
            )}
          </section>
        )
      })}
    </div>
  )
}
