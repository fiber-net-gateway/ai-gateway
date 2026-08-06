import { request } from './client'

export type KeyRingPublicationState =
  'UNAVAILABLE' | 'NOT_PUBLISHED' | 'PUBLISHED' | 'DRIFTED' | 'UNKNOWN'

export interface KeyRingView {
  dataId: 'ploto.ai-llm.auth.bt1.keys'
  group: 'LLM-SERVER'
  target: null | {
    environmentId: string
    namespaceId: string
    tenant: string
    group: 'LLM-SERVER'
  }
  publicationState: KeyRingPublicationState
  targetMd5: string
  readbackMd5: string | null
  contentBytes: number
  errorCode: string | null
  activationState: 'UNKNOWN'
  activationEvidence: 'NONE'
  keys: Array<{
    id: string
    kid: string
    keyState: 'DRAFT' | 'PUBLISHED_UNVERIFIED' | 'ACTIVE' | 'RETIRING' | 'RETIRED'
    issuanceEnabled: boolean
    clockSkewSeconds: number
    retireAfter: string | null
    revision: number
    fingerprintSuffix: string
  }>
}

export const keyRingApi = {
  inspect: (environmentId: string) =>
    request<KeyRingView>(`/api/environments/${environmentId}/bt1-key-ring`),
  publish: (environmentId: string) =>
    request<KeyRingView>(`/api/environments/${environmentId}/bt1-key-ring/publish`, {
      method: 'POST',
    }),
}
