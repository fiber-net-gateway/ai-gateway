import { request, requestWithMetadata } from './client'

export type DraftState = 'NONE' | 'MODIFIED' | 'INVALID' | 'CONFLICTED'
export type PublicationState = 'NEVER' | 'PUBLISHED' | 'PARTIAL' | 'FAILED' | 'DRIFTED'
export type ActivationState = 'UNKNOWN' | 'PENDING' | 'EFFECTIVE' | 'PARTIAL' | 'REJECTED'
export type ProtocolCoverage = 'SUPPORTED' | 'UNSUPPORTED' | 'INVALID'
export type ProviderProtocolType = 'OPENAI_CHAT_COMPLETIONS' | 'ANTHROPIC_MESSAGES'
export type ModelAccessMode = 'ALL_AUTHENTICATED' | 'APPROVAL_REQUIRED'
export type ReleaseWorkflowState = 'PENDING' | 'PUBLISHING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
export type ReleaseResourceState = 'PENDING' | 'WRITING' | 'PUBLISHED' | 'FAILED' | 'SKIPPED'

export interface MarketplaceReleaseResource {
  id: string
  kind: 'PROVIDER' | 'MODELS'
  group: 'LLM-SERVER'
  dataId: string
  dependencyOrder: number
  state: ReleaseResourceState
  oldSafeDigest: string | null
  newSafeDigest: string | null
  oldMd5: string | null
  newMd5: string | null
  contentBytes: number | null
  errorCode: string | null
  safeErrorMessage: string | null
  retryCount: number
  startedAt: string | null
  finishedAt: string | null
}

export interface MarketplaceRelease {
  id: string
  environmentId: string
  versionId: string
  releaseNumber: number
  state: ReleaseWorkflowState
  publicationState: PublicationState
  activationState: ActivationState
  revision: number
  createdBy: string
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
  updatedAt: string
  resources: MarketplaceReleaseResource[]
  activationResults: Array<{
    instanceId: string
    activationState: 'UNKNOWN' | 'PENDING' | 'EFFECTIVE' | 'REJECTED'
    evidenceKind: 'CONFIG_STATUS_MD5'
    acceptedIdentity: string | null
    safeErrorCode: string | null
    observedAt: string | null
  }>
}

export interface MarketplaceReleaseDetail extends MarketplaceRelease {
  target: null | {
    environmentId: string
    namespaceId: string
    tenant: string
    group: 'LLM-SERVER'
  }
  groupDependencies: Array<{
    id: string
    name: string
    revision: number | null
    publishedRevision: number | null
    state: 'READY' | 'NOT_PUBLISHED'
  }>
}

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
  accessMode: ModelAccessMode
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
  accessMode: ModelAccessMode
  requestable: boolean
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
  displayName: string
  baseUrl: string
  protocols: Array<{
    type: ProviderProtocolType
    path: string
    upstreamModelName: string
  }>
  tokens: ProviderTokenSafeView[]
}

export interface ModelProviderView extends ProviderView {
  routeRole: 'PRIMARY' | 'FALLBACK'
  sortOrder: number
}

export interface ProviderSummary extends ProviderView {
  referencedModelCount: number
  referencedModels: Array<{ id: string; logicalModelName: string; displayName: string }>
  draftState: DraftState
  publicationState: PublicationState
  activationState: ActivationState
  updatedAt: string
}

export interface ProviderDetail extends ProviderSummary {
  draft: { id: string; revision: number }
}

export interface MarketplaceModelDetail extends MarketplaceModelSummary {
  prefixMaxBytes: number
  maxPrimaryAttempts: number
  fallbackEnabled: boolean
  retryableStatuses: number[]
  rateLimit: null | { windowDurationMillis: string; maxTokensPerWindow: string }
  allowUserGroups: Array<{ id: string; name: string }>
  providers: ModelProviderView[]
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
    providerId: string
    routeRole: 'PRIMARY' | 'FALLBACK'
    sortOrder: number
  }>
  accessMode: ModelAccessMode
  loadBalance: {
    prefixMaxBytes: number
    maxPrimaryAttempts: number
    fallbackEnabled: boolean
    retryableStatuses: number[]
  }
  rateLimit: null | { windowDurationMillis: string; maxTokensPerWindow: string }
}

export interface ProviderMutation {
  displayName: string
  baseUrl: string
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
  confirmProviderImpact?: boolean
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
  listProviders: (environmentId: string) =>
    requestWithMetadata<{
      items: ProviderSummary[]
      draft: { id: string; revision: number }
    }>(`/api/environments/${environmentId}/providers`),
  providerDetail: (environmentId: string, providerId: string) =>
    requestWithMetadata<ProviderDetail>(
      `/api/environments/${environmentId}/providers/${providerId}`,
    ),
  createProvider: async (
    environmentId: string,
    draftId: string,
    etag: string,
    body: ProviderMutation,
  ) =>
    requestWithMetadata<ProviderSummary>(
      `/api/environments/${environmentId}/drafts/${draftId}/providers`,
      {
        method: 'POST',
        headers: {
          'If-Match': etag,
          'Idempotency-Key': await serverIdempotencyKey(),
        },
        body: JSON.stringify(body),
      },
    ),
  updateProvider: (
    environmentId: string,
    draftId: string,
    providerId: string,
    etag: string,
    body: ProviderMutation,
  ) =>
    requestWithMetadata<{
      provider: ProviderView
      revision: number
      affectedModelIds: string[]
    }>(`/api/environments/${environmentId}/drafts/${draftId}/providers/${providerId}`, {
      method: 'PATCH',
      headers: { 'If-Match': etag },
      body: JSON.stringify(body),
    }),
  archiveProvider: (environmentId: string, draftId: string, providerId: string, etag: string) =>
    requestWithMetadata<void>(
      `/api/environments/${environmentId}/drafts/${draftId}/providers/${providerId}`,
      { method: 'DELETE', headers: { 'If-Match': etag } },
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
  listReleases: (environmentId: string) =>
    request<{ items: MarketplaceRelease[] }>(`/api/environments/${environmentId}/releases`),
  release: (environmentId: string, releaseId: string) =>
    request<MarketplaceReleaseDetail>(`/api/environments/${environmentId}/releases/${releaseId}`),
  executeRelease: (environmentId: string, releaseId: string) =>
    request<MarketplaceReleaseDetail>(
      `/api/environments/${environmentId}/releases/${releaseId}/execute`,
      { method: 'POST' },
    ),
  retryRelease: (environmentId: string, releaseId: string) =>
    request<MarketplaceReleaseDetail>(
      `/api/environments/${environmentId}/releases/${releaseId}/retry`,
      { method: 'POST' },
    ),
  refreshActivation: (environmentId: string, releaseId: string) =>
    request<MarketplaceReleaseDetail>(
      `/api/environments/${environmentId}/releases/${releaseId}/refresh-activation`,
      { method: 'POST' },
    ),
}
