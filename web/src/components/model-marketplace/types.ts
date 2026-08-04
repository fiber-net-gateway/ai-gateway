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
