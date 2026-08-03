import type { ProviderProtocolType } from '../api/model-marketplace'

export const modelProtocols: ReadonlyArray<{
  type: ProviderProtocolType
  label: string
  shortLabel: string
  defaultPath: string
  help: string
}> = [
  {
    type: 'OPENAI_CHAT_COMPLETIONS',
    label: 'OpenAI Chat Completions',
    shortLabel: 'OpenAI',
    defaultPath: '/v1/chat/completions',
    help: '仅处理 OpenAI 入站请求，不会转换为 Anthropic 协议。',
  },
  {
    type: 'ANTHROPIC_MESSAGES',
    label: 'Anthropic Messages',
    shortLabel: 'Anthropic',
    defaultPath: '/v1/messages',
    help: '仅处理 Anthropic 入站请求，供应商必须原生兼容该协议。',
  },
]
