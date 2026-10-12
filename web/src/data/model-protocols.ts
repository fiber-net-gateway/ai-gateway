import type { ProviderProtocolType } from '../api/model-marketplace'

export const modelProtocols: ReadonlyArray<{
  type: ProviderProtocolType
  coverageKey: 'openai' | 'anthropic' | 'responses' | 'embedding'
  auditName: string
  label: string
  shortLabel: string
  defaultPath: string
  help: string
}> = [
  {
    type: 'OPENAI_CHAT_COMPLETIONS',
    coverageKey: 'openai',
    auditName: 'openai',
    label: 'OpenAI Chat Completions',
    shortLabel: 'OpenAI Chat',
    defaultPath: '/v1/chat/completions',
    help: '仅处理 Chat Completions 请求，不转换为 Responses 或 Anthropic。',
  },
  {
    type: 'ANTHROPIC_MESSAGES',
    coverageKey: 'anthropic',
    auditName: 'anthropic',
    label: 'Anthropic Messages',
    shortLabel: 'Anthropic',
    defaultPath: '/v1/messages',
    help: '仅处理 Anthropic 入站请求，供应商必须原生兼容该协议。',
  },
  {
    type: 'OPENAI_RESPONSES',
    coverageKey: 'responses',
    auditName: 'openai-responses',
    label: 'OpenAI Responses',
    shortLabel: 'Responses',
    defaultPath: '/v1/responses',
    help: '强制无状态：不保存响应，不使用历史 ID；每次请求需提交完整上下文。',
  },
  {
    type: 'OPENAI_EMBEDDING',
    coverageKey: 'embedding',
    auditName: 'openai-embedding',
    label: 'OpenAI Embeddings',
    shortLabel: 'Embeddings',
    defaultPath: '/v1/embeddings',
    help: '同步向量接口，支持 float 和 base64；主备候选必须产生兼容的向量。',
  },
]
