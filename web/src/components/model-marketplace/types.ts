import type { ProviderProtocolType } from '../../api/model-marketplace'

export type TokenDraftRow =
  | { key: number; kind: 'existing'; id: string; name: string; action: 'keep'; value: '' }
  | {
      key: number
      kind: 'existing'
      id: string
      name: string
      action: 'replace'
      value: string
    }
  | { key: number; kind: 'existing'; id: string; name: string; action: 'delete'; value: '' }
  | { key: number; kind: 'new'; name: string; action: 'replace'; value: string }

export interface ProtocolDraft {
  type: ProviderProtocolType
  enabled: boolean
  path: string
  upstreamModelName: string
}

export interface ProviderDraft {
  key: number
  id?: string
  displayName: string
  baseUrl: string
  routeRole: 'PRIMARY' | 'FALLBACK'
  protocols: ProtocolDraft[]
  authenticationMode: 'BEARER_TOKEN_POOL' | 'NO_CREDENTIALS'
  tokens: TokenDraftRow[]
}
