import { request, requestWithMetadata } from './client'

export type DraftState = 'NONE' | 'MODIFIED' | 'INVALID' | 'CONFLICTED'
export type PublicationState = 'NEVER' | 'PUBLISHED' | 'PARTIAL' | 'FAILED' | 'DRIFTED'
export type ActivationState = 'UNKNOWN' | 'PENDING' | 'EFFECTIVE' | 'PARTIAL' | 'REJECTED'
export type ProtocolCoverage = 'SUPPORTED' | 'UNSUPPORTED' | 'INVALID'
export type ProviderProtocolType = 'OPENAI_CHAT_COMPLETIONS' | 'ANTHROPIC_MESSAGES'

export interface MarketplaceModelSummary {
  id: string
  logicalModelName: string
  displayName: string
  description: string
  tags: string[]
  protocols: { openai: ProtocolCoverage; anthropic: ProtocolCoverage }
  providerCount: number
  primaryProviderCount: number
  fallbackConfigured: boolean
  configuredTokenCount: number
  draftState: DraftState
  publicationState: PublicationState
  activationState: ActivationState
  validationErrorCount: number
  validationWarningCount: number
  latestReleaseId: string | null
  latestReleaseNumber: number | null
  updatedBy: string
  updatedAt: string
}

export interface AvailableModelSummary {
  id: string
  displayName: string
  logicalModelName: string
  description: string
  protocols: { openai: ProtocolCoverage; anthropic: ProtocolCoverage }
  accessible: boolean
  activationState: ActivationState
  publishedAt: string | null
}

export interface ProviderTokenSafeView {
  id: string
  name: string
  configured: true
  fingerprintSuffix: string
  updatedAt: string
}

export interface ProviderView {
  id: string
  providerName: string
  ownership: 'DEDICATED' | 'SHARED'
  displayName: string
  baseUrl: string
  routeRole: 'PRIMARY' | 'FALLBACK'
  sortOrder: number
  protocols: Array<{
    type: ProviderProtocolType
    path: string
    upstreamModelName: string
  }>
  tokens: ProviderTokenSafeView[]
}

export interface MarketplaceModelDetail extends MarketplaceModelSummary {
  prefixMaxBytes: number
  maxPrimaryAttempts: number
  fallbackEnabled: boolean
  retryableStatuses: number[]
  rateLimit: null | { windowDurationMillis: string; maxTokensPerWindow: string }
  allowUserGroups: Array<{ id: string; name: string }>
  providers: ProviderView[]
  draft: { versionId: string; revision: number; state: DraftState }
  published: {
    versionId: string | null
    releaseId: string | null
    releaseNumber: number | null
    state: PublicationState
    publishedAt: string | null
  }
  activation: { state: ActivationState; evidence: 'NONE' }
}

export type TokenMutation =
  | { id: string; name: string; secretAction: 'keep' }
  | { id: string; name: string; secretAction: 'replace'; value: string }
  | { id: string; name: string; secretAction: 'delete' }
  | { name: string; secretAction: 'replace'; value: string }

export interface ModelMutation {
  displayName: string
  logicalModelName: string
  description: string
  tags: string[]
  providers: Array<{
    id?: string
    mode: 'CREATE_DEDICATED' | 'UPDATE_EXISTING'
    displayName: string
    baseUrl: string
    routeRole: 'PRIMARY' | 'FALLBACK'
    sortOrder: number
    protocols: Array<{
      type: ProviderProtocolType
      path: string
      upstreamModelName: string
    }>
    authentication: {
      mode: 'BEARER_TOKEN_POOL' | 'NO_CREDENTIALS'
      tokens: TokenMutation[]
      confirmUnauthenticated?: boolean
    }
  }>
  allowUserGroupIds: string[]
  loadBalance: {
    prefixMaxBytes: number
    maxPrimaryAttempts: number
    fallbackEnabled: boolean
    retryableStatuses: number[]
  }
  rateLimit: null | { windowDurationMillis: string; maxTokensPerWindow: string }
}

export interface ValidationIssue {
  code: string
  message: string
  field: string
  severity: 'ERROR' | 'WARNING'
}

function queryString(values: Record<string, string | number | undefined>) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') query.set(key, String(value))
  }
  return query.toString()
}

async function serverIdempotencyKey(): Promise<string> {
  return (await request<{ key: string }>('/api/idempotency-keys', { method: 'POST' })).key
}

export const modelMarketplaceApi = {
  listAdmin: (environmentId: string, filters: { search?: string; protocol?: string } = {}) =>
    requestWithMetadata<{
      items: MarketplaceModelSummary[]
      nextCursor: string | null
      draft: { id: string; revision: number }
    }>(`/api/environments/${environmentId}/models?${queryString({ view: 'admin', ...filters })}`),
  listAvailable: (
    environmentId: string,
    filters: { search?: string; protocol?: string; access?: string } = {},
  ) =>
    request<{ items: AvailableModelSummary[]; nextCursor: string | null }>(
      `/api/environments/${environmentId}/models?${queryString({ view: 'available', ...filters })}`,
    ),
  detail: (environmentId: string, modelId: string) =>
    requestWithMetadata<MarketplaceModelDetail>(
      `/api/environments/${environmentId}/models/${modelId}?view=admin`,
    ),
  availableDetail: (environmentId: string, modelId: string) =>
    request<AvailableModelSummary>(
      `/api/environments/${environmentId}/models/${modelId}?view=available`,
    ),
  create: async (environmentId: string, draftId: string, etag: string, body: ModelMutation) =>
    requestWithMetadata<MarketplaceModelDetail>(
      `/api/environments/${environmentId}/drafts/${draftId}/models`,
      {
        method: 'POST',
        headers: {
          'If-Match': etag,
          'Idempotency-Key': await serverIdempotencyKey(),
        },
        body: JSON.stringify(body),
      },
    ),
  update: (
    environmentId: string,
    draftId: string,
    modelId: string,
    etag: string,
    body: ModelMutation,
  ) =>
    requestWithMetadata<MarketplaceModelDetail>(
      `/api/environments/${environmentId}/drafts/${draftId}/models/${modelId}`,
      { method: 'PATCH', headers: { 'If-Match': etag }, body: JSON.stringify(body) },
    ),
  archive: (environmentId: string, draftId: string, modelId: string, etag: string) =>
    requestWithMetadata<void>(
      `/api/environments/${environmentId}/drafts/${draftId}/models/${modelId}`,
      { method: 'DELETE', headers: { 'If-Match': etag } },
    ),
  validate: (environmentId: string, draftId: string) =>
    requestWithMetadata<{ valid: boolean; issues: ValidationIssue[]; revision: number }>(
      `/api/environments/${environmentId}/drafts/${draftId}/validate`,
      { method: 'POST' },
    ),
  submit: (environmentId: string, draftId: string, etag: string) =>
    requestWithMetadata<{
      release: {
        id: string
        releaseNumber: number
        state: 'PENDING'
        resources: Array<{
          id: string
          kind: 'PROVIDER' | 'MODELS'
          group: 'LLM-SERVER'
          dataId: string
          dependencyOrder: number
          state: 'PENDING'
        }>
      }
      draftRevision: number
      publicationState: PublicationState
      activationState: ActivationState
      message: string
    }>(`/api/environments/${environmentId}/drafts/${draftId}/submit`, {
      method: 'POST',
      headers: { 'If-Match': etag },
    }),
}
