export type ConfigVersionKind = 'DRAFT' | 'RELEASE'
export type ConfigVersionState = 'OPEN' | 'FROZEN' | 'ABANDONED'
export type ProviderRouteRole = 'PRIMARY' | 'FALLBACK'
export type ProviderOwnership = 'DEDICATED' | 'SHARED'
export type ProviderProtocolType = 'OPENAI_CHAT_COMPLETIONS' | 'ANTHROPIC_MESSAGES'
export type DraftState = 'NONE' | 'MODIFIED' | 'INVALID' | 'CONFLICTED'
export type PublicationState = 'NEVER' | 'PUBLISHED' | 'PARTIAL' | 'FAILED' | 'DRIFTED'
export type ActivationState = 'UNKNOWN' | 'PENDING' | 'EFFECTIVE' | 'PARTIAL' | 'REJECTED'
export type ProtocolCoverage = 'SUPPORTED' | 'UNSUPPORTED' | 'INVALID'
export type ModelAccessMode = 'ALL_AUTHENTICATED' | 'APPROVAL_REQUIRED'
export type ReleaseWorkflowState = 'PENDING' | 'PUBLISHING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
export type ReleaseResourceState = 'PENDING' | 'WRITING' | 'PUBLISHED' | 'FAILED' | 'SKIPPED'

export interface MarketplaceTokenRecord {
  id: string
  name: string
  secretId: string
  fingerprintSuffix: string
  updatedAt: string
}

export interface MarketplaceProtocolRecord {
  type: ProviderProtocolType
  path: string
  upstreamModelName: string
}

export interface MarketplaceProviderRecord {
  id: string
  providerName: string
  ownership: ProviderOwnership
  ownerModelId: string | null
  displayName: string
  baseUrl: string
  protocols: MarketplaceProtocolRecord[]
  tokens: MarketplaceTokenRecord[]
  createdBy: string
  createdAt: string
  updatedBy: string
  updatedAt: string
  archivedAt: string | null
}

export interface MarketplaceModelProviderBindingRecord {
  providerId: string
  routeRole: ProviderRouteRole
  sortOrder: number
}

export interface MarketplaceModelRecord {
  id: string
  logicalModelName: string
  displayName: string
  description: string
  tags: string[]
  prefixMaxBytes: number
  maxPrimaryAttempts: number
  fallbackEnabled: boolean
  retryableStatuses: number[]
  rateLimit: null | {
    windowDurationMillis: string
    maxTokensPerWindow: string
  }
  allowUserGroups: Array<{ id: string; name: string }>
  providerBindings: MarketplaceModelProviderBindingRecord[]
  createdBy: string
  createdAt: string
  updatedBy: string
  updatedAt: string
  archivedAt: string | null
}

export interface MarketplaceVersionRecord {
  id: string
  environmentId: string
  kind: ConfigVersionKind
  state: ConfigVersionState
  baseReleaseVersionId: string | null
  schemaVersion: number
  revision: number
  providers: MarketplaceProviderRecord[]
  models: MarketplaceModelRecord[]
  createdBy: string
  createdAt: string
  updatedAt: string
  frozenAt: string | null
}

export interface MarketplaceReleaseRecord {
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
  resources: MarketplaceReleaseResourceRecord[]
}

export interface MarketplaceReleaseResourceRecord {
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

export interface MarketplaceEnvironmentRecord {
  draft: MarketplaceVersionRecord
  publishedVersion: MarketplaceVersionRecord | null
  publishedRelease: MarketplaceReleaseRecord | null
  latestRelease: MarketplaceReleaseRecord | null
  publicationState: PublicationState
  activationState: ActivationState
}

export interface MarketplaceStore {
  ensureEnvironment(input: {
    environmentId: string
    actorId: string
    now: string
  }): Promise<MarketplaceEnvironmentRecord>
  getEnvironment(environmentId: string): Promise<MarketplaceEnvironmentRecord | null>
  saveDraft(input: {
    environmentId: string
    expectedRevision: number
    actorId: string
    now: string
    providers: MarketplaceProviderRecord[]
    models: MarketplaceModelRecord[]
  }): Promise<MarketplaceVersionRecord>
  createRelease(input: {
    environmentId: string
    expectedRevision: number
    actorId: string
    now: string
  }): Promise<{
    draft: MarketplaceVersionRecord
    frozenVersion: MarketplaceVersionRecord
    release: MarketplaceReleaseRecord
  }>
  getVersion(versionId: string): Promise<MarketplaceVersionRecord>
  getRelease(environmentId: string, releaseId: string): Promise<MarketplaceReleaseRecord | null>
  listReleases(environmentId: string, limit: number): Promise<MarketplaceReleaseRecord[]>
  listPublishingReleases(): Promise<MarketplaceReleaseRecord[]>
  acquireReleaseLock(environmentId: string): Promise<() => Promise<void>>
  startRelease(input: { releaseId: string; now: string }): Promise<MarketplaceReleaseRecord>
  updateReleaseResource(input: {
    releaseId: string
    resourceId: string
    state: ReleaseResourceState
    oldSafeDigest?: string | null
    newSafeDigest?: string | null
    oldMd5?: string | null
    newMd5?: string | null
    contentBytes?: number | null
    errorCode?: string | null
    safeErrorMessage?: string | null
    incrementRetry?: boolean
    now: string
  }): Promise<void>
  finishRelease(input: {
    releaseId: string
    workflowState: 'COMPLETED' | 'FAILED'
    publicationState: PublicationState
    now: string
  }): Promise<MarketplaceReleaseRecord>
}

export interface SecretMetadata {
  id: string
  fingerprintSuffix: string
  createdAt: string
}

export interface DisposableSecret {
  bytes: Uint8Array
  dispose(): void
}

export interface MarketplaceSecretService {
  createProviderToken(input: {
    environmentId: string
    providerId: string
    tokenId: string
    value: Uint8Array
    actorId: string
    now: string
  }): Promise<SecretMetadata>
  decryptForPublication(input: {
    environmentId: string
    providerId: string
    tokenId: string
    secretId: string
  }): Promise<DisposableSecret>
  getMetadata(secretId: string): Promise<SecretMetadata | null>
  discardOrphan(secretId: string, now: string): Promise<void>
}

export type TokenMutationInput =
  | { id: string; name: string; secretAction: 'keep' }
  | { id: string; name: string; secretAction: 'replace'; value: string }
  | { id: string; name: string; secretAction: 'delete' }
  | { name: string; secretAction: 'replace'; value: string }

export interface ProviderMutationInput {
  displayName: string
  baseUrl: string
  protocols: MarketplaceProtocolRecord[]
  authentication: {
    mode: 'BEARER_TOKEN_POOL' | 'NO_CREDENTIALS'
    tokens: TokenMutationInput[]
    confirmUnauthenticated?: boolean
  }
  confirmProviderImpact?: boolean
}

export interface ModelProviderBindingInput {
  providerId: string
  routeRole: ProviderRouteRole
  sortOrder: number
}

export interface ModelMutationInput {
  displayName: string
  logicalModelName: string
  description?: string
  tags?: string[]
  providers: ModelProviderBindingInput[]
  accessMode: ModelAccessMode
  loadBalance: {
    prefixMaxBytes: number
    maxPrimaryAttempts: number
    fallbackEnabled: boolean
    retryableStatuses: number[]
  }
  rateLimit: null | {
    windowDurationMillis: string
    maxTokensPerWindow: string
  }
}

export interface ValidationIssue {
  code: string
  message: string
  field: string
  severity: 'ERROR' | 'WARNING'
}

export interface ProviderTokenSafeView {
  id: string
  name: string
  configured: true
  fingerprintSuffix: string
  updatedAt: string
}

export interface ProviderAdminView {
  id: string
  providerName: string
  displayName: string
  baseUrl: string
  protocols: MarketplaceProtocolRecord[]
  tokens: ProviderTokenSafeView[]
}

export interface ProviderAdminSummaryView extends ProviderAdminView {
  referencedModelCount: number
  referencedModels: Array<{ id: string; logicalModelName: string; displayName: string }>
  draftState: DraftState
  publicationState: PublicationState
  activationState: ActivationState
  updatedAt: string
}

export interface ModelProviderAdminView extends ProviderAdminView {
  routeRole: ProviderRouteRole
  sortOrder: number
}

export interface AdminModelView {
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

export interface AvailableModelView {
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

export interface AdminModelDetailView extends AdminModelView {
  prefixMaxBytes: number
  maxPrimaryAttempts: number
  fallbackEnabled: boolean
  retryableStatuses: number[]
  rateLimit: MarketplaceModelRecord['rateLimit']
  allowUserGroups: MarketplaceModelRecord['allowUserGroups']
  providers: ModelProviderAdminView[]
  draft: {
    versionId: string
    revision: number
    state: DraftState
  }
  published: {
    versionId: string | null
    releaseId: string | null
    releaseNumber: number | null
    state: PublicationState
    publishedAt: string | null
  }
  activation: { state: ActivationState; evidence: 'NONE' }
}

export interface RenderedResource {
  group: 'LLM-SERVER'
  dataId: string
  content: string
  containsSecret: boolean
}
