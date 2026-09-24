import type { MarketplaceProtocolRecord } from './modules/model-marketplace/types.js'

export const demoProviderProtocols: MarketplaceProtocolRecord[] = [
  {
    type: 'OPENAI_CHAT_COMPLETIONS',
    path: '/v1/chat/completions',
    upstreamModelName: 'fiber-demo-upstream',
  },
  { type: 'ANTHROPIC_MESSAGES', path: '/v1/messages', upstreamModelName: 'fiber-demo-upstream' },
  { type: 'OPENAI_RESPONSES', path: '/v1/responses', upstreamModelName: 'fiber-demo-upstream' },
]

export function demoProviderUpdate(
  provider: {
    baseUrl: string
    protocols: MarketplaceProtocolRecord[]
    tokens: ReadonlyArray<unknown>
  },
  baseUrl: string,
): 'CURRENT' | 'UPGRADE' | 'CUSTOM' {
  if (provider.baseUrl !== baseUrl || provider.tokens.length !== 0) return 'CUSTOM'
  const matches = (expected: MarketplaceProtocolRecord[]) =>
    provider.protocols.length === expected.length &&
    expected.every((protocol) =>
      provider.protocols.some(
        (actual) =>
          actual.type === protocol.type &&
          actual.path === protocol.path &&
          actual.upstreamModelName === protocol.upstreamModelName,
      ),
    )
  if (matches(demoProviderProtocols)) return 'CURRENT'
  if (matches(demoProviderProtocols.filter((p) => p.type !== 'OPENAI_RESPONSES'))) return 'UPGRADE'
  return 'CUSTOM'
}
