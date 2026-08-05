import { randomUUID } from 'node:crypto'

import { DomainError } from '../users/errors.js'
import type {
  MarketplaceEnvironmentRecord,
  MarketplaceModelRecord,
  MarketplaceReleaseRecord,
  ReleaseResourceState,
  MarketplaceStore,
  MarketplaceVersionRecord,
} from './types.js'

function copy<T>(value: T): T {
  return structuredClone(value)
}

export class MemoryMarketplaceStore implements MarketplaceStore {
  private readonly environments = new Map<string, MarketplaceEnvironmentRecord>()
  private readonly frozenVersions = new Map<string, MarketplaceVersionRecord>()
  private readonly releases = new Map<string, MarketplaceReleaseRecord>()
  private readonly releaseLocks = new Map<string, Promise<void>>()

  async ensureEnvironment(input: {
    environmentId: string
    actorId: string
    now: string
  }): Promise<MarketplaceEnvironmentRecord> {
    const current = this.environments.get(input.environmentId)
    if (current) return copy(current)
    const draft: MarketplaceVersionRecord = {
      id: randomUUID(),
      environmentId: input.environmentId,
      kind: 'DRAFT',
      state: 'OPEN',
      baseReleaseVersionId: null,
      schemaVersion: 1,
      revision: 1,
      providers: [],
      models: [],
      createdBy: input.actorId,
      createdAt: input.now,
      updatedAt: input.now,
      frozenAt: null,
    }
    const environment: MarketplaceEnvironmentRecord = {
      draft,
      publishedVersion: null,
      publishedRelease: null,
      latestRelease: null,
      publicationState: 'NEVER',
      activationState: 'UNKNOWN',
    }
    this.environments.set(input.environmentId, environment)
    return copy(environment)
  }

  async getEnvironment(environmentId: string): Promise<MarketplaceEnvironmentRecord | null> {
    const environment = this.environments.get(environmentId)
    return environment ? copy(environment) : null
  }

  async saveDraft(input: {
    environmentId: string
    expectedRevision: number
    actorId: string
    now: string
    providers: MarketplaceVersionRecord['providers']
    models: MarketplaceModelRecord[]
  }): Promise<MarketplaceVersionRecord> {
    const environment = this.environments.get(input.environmentId)
    if (!environment) throw new DomainError('DRAFT_NOT_FOUND', 404, '环境草稿不存在')
    if (environment.draft.state !== 'OPEN') {
      throw new DomainError('DRAFT_NOT_OPEN', 409, '当前配置版本不可编辑')
    }
    if (environment.draft.revision !== input.expectedRevision) {
      throw new DomainError('REVISION_CONFLICT', 412, '草稿已被其他操作更新', {
        serverRevision: environment.draft.revision,
      })
    }
    environment.draft.providers = copy(input.providers)
    environment.draft.models = copy(input.models)
    environment.draft.revision += 1
    environment.draft.updatedAt = input.now
    return copy(environment.draft)
  }

  async createRelease(input: {
    environmentId: string
    expectedRevision: number
    actorId: string
    now: string
  }): Promise<{
    draft: MarketplaceVersionRecord
    frozenVersion: MarketplaceVersionRecord
    release: MarketplaceReleaseRecord
  }> {
    const environment = this.environments.get(input.environmentId)
    if (!environment) throw new DomainError('DRAFT_NOT_FOUND', 404, '环境草稿不存在')
    if (environment.draft.revision !== input.expectedRevision) {
      throw new DomainError('REVISION_CONFLICT', 412, '草稿已被其他操作更新', {
        serverRevision: environment.draft.revision,
      })
    }
    if (
      environment.latestRelease &&
      (environment.latestRelease.state === 'PENDING' ||
        environment.latestRelease.state === 'PUBLISHING')
    ) {
      throw new DomainError('ACTIVE_RELEASE_EXISTS', 409, '当前环境已有待执行或执行中的 Release', {
        releaseId: environment.latestRelease.id,
        releaseNumber: environment.latestRelease.releaseNumber,
      })
    }
    const frozenVersion: MarketplaceVersionRecord = {
      ...copy(environment.draft),
      id: randomUUID(),
      kind: 'RELEASE',
      state: 'FROZEN',
      revision: 1,
      createdBy: input.actorId,
      createdAt: input.now,
      updatedAt: input.now,
      frozenAt: input.now,
    }
    const release: MarketplaceReleaseRecord = {
      id: randomUUID(),
      environmentId: input.environmentId,
      versionId: frozenVersion.id,
      releaseNumber: (environment.latestRelease?.releaseNumber ?? 0) + 1,
      state: 'PENDING',
      publicationState: 'NEVER',
      activationState: 'UNKNOWN',
      revision: 1,
      createdBy: input.actorId,
      createdAt: input.now,
      startedAt: null,
      finishedAt: null,
      updatedAt: input.now,
      resources: releaseResources(frozenVersion),
    }
    this.frozenVersions.set(frozenVersion.id, frozenVersion)
    this.releases.set(release.id, release)
    environment.latestRelease = release
    environment.draft.revision += 1
    environment.draft.updatedAt = input.now
    return {
      draft: copy(environment.draft),
      frozenVersion: copy(frozenVersion),
      release: copy(release),
    }
  }

  async getVersion(versionId: string): Promise<MarketplaceVersionRecord> {
    const version = this.frozenVersions.get(versionId)
    if (!version) throw new DomainError('CONFIG_VERSION_NOT_FOUND', 404, '配置版本不存在')
    return copy(version)
  }

  async getRelease(
    environmentId: string,
    releaseId: string,
  ): Promise<MarketplaceReleaseRecord | null> {
    const release = this.releases.get(releaseId)
    return release?.environmentId === environmentId ? copy(release) : null
  }

  async listReleases(environmentId: string, limit: number): Promise<MarketplaceReleaseRecord[]> {
    return [...this.releases.values()]
      .filter((release) => release.environmentId === environmentId)
      .sort(
        (left, right) =>
          right.releaseNumber - left.releaseNumber || right.id.localeCompare(left.id),
      )
      .slice(0, limit)
      .map(copy)
  }

  async listPublishingReleases(): Promise<MarketplaceReleaseRecord[]> {
    return [...this.releases.values()].filter((release) => release.state === 'PUBLISHING').map(copy)
  }

  async acquireReleaseLock(environmentId: string): Promise<() => Promise<void>> {
    const previous = this.releaseLocks.get(environmentId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => current)
    this.releaseLocks.set(environmentId, tail)
    await previous
    return async () => {
      release()
      if (this.releaseLocks.get(environmentId) === tail) this.releaseLocks.delete(environmentId)
    }
  }

  async startRelease(input: { releaseId: string; now: string }): Promise<MarketplaceReleaseRecord> {
    const release = this.releases.get(input.releaseId)
    if (!release) throw new DomainError('RELEASE_NOT_FOUND', 404, 'Release 不存在')
    if (release.state !== 'PENDING' && release.state !== 'FAILED') {
      throw new DomainError('RELEASE_EXECUTION_NOT_ALLOWED', 409, '当前 Release 状态不能执行')
    }
    release.state = 'PUBLISHING'
    release.startedAt ??= input.now
    release.finishedAt = null
    release.updatedAt = input.now
    release.revision += 1
    return copy(release)
  }

  async updateReleaseResource(input: {
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
  }): Promise<void> {
    const release = this.releases.get(input.releaseId)
    const resource = release?.resources.find((candidate) => candidate.id === input.resourceId)
    if (!release || !resource)
      throw new DomainError('RELEASE_RESOURCE_NOT_FOUND', 404, '发布资源不存在')
    resource.state = input.state
    for (const key of [
      'oldSafeDigest',
      'newSafeDigest',
      'oldMd5',
      'newMd5',
      'contentBytes',
      'errorCode',
      'safeErrorMessage',
    ] as const) {
      if (input[key] !== undefined) resource[key] = input[key] as never
    }
    if (input.incrementRetry) resource.retryCount += 1
    if (input.state === 'WRITING') {
      resource.startedAt ??= input.now
      resource.finishedAt = null
    }
    if (input.state === 'PUBLISHED' || input.state === 'FAILED' || input.state === 'SKIPPED') {
      resource.finishedAt = input.now
    }
    release.updatedAt = input.now
    release.revision += 1
  }

  async finishRelease(input: {
    releaseId: string
    workflowState: 'COMPLETED' | 'FAILED'
    publicationState: MarketplaceEnvironmentRecord['publicationState']
    now: string
  }): Promise<MarketplaceReleaseRecord> {
    const release = this.releases.get(input.releaseId)
    if (!release) throw new DomainError('RELEASE_NOT_FOUND', 404, 'Release 不存在')
    release.state = input.workflowState
    release.publicationState = input.publicationState
    release.finishedAt = input.now
    release.updatedAt = input.now
    release.revision += 1
    const environment = this.environments.get(release.environmentId)!
    environment.latestRelease = release
    environment.publicationState = input.publicationState
    if (input.workflowState === 'COMPLETED' && input.publicationState === 'PUBLISHED') {
      const version = this.frozenVersions.get(release.versionId)!
      environment.publishedVersion = version
      environment.publishedRelease = release
      environment.draft.baseReleaseVersionId = version.id
      environment.draft.revision += 1
      environment.draft.updatedAt = input.now
    }
    return copy(release)
  }
}

function releaseResources(version: MarketplaceVersionRecord) {
  const referencedProviderIds = new Set(
    version.models.flatMap((model) => model.providerBindings.map((binding) => binding.providerId)),
  )
  const providerNames = version.providers
    .filter((provider) => referencedProviderIds.has(provider.id) && !provider.archivedAt)
    .map((provider) => provider.providerName)
    .sort((left, right) => left.localeCompare(right, 'en'))
  return [
    ...providerNames.map((providerName, index) => ({
      id: randomUUID(),
      kind: 'PROVIDER' as const,
      group: 'LLM-SERVER' as const,
      dataId: `ploto.ai-llm.provider.${providerName}`,
      dependencyOrder: index,
      state: 'PENDING' as const,
      ...emptyResourceResult(),
    })),
    {
      id: randomUUID(),
      kind: 'MODELS' as const,
      group: 'LLM-SERVER' as const,
      dataId: 'ploto.ai-llm.models',
      dependencyOrder: providerNames.length,
      state: 'PENDING' as const,
      ...emptyResourceResult(),
    },
  ]
}

function emptyResourceResult() {
  return {
    oldSafeDigest: null,
    newSafeDigest: null,
    oldMd5: null,
    newMd5: null,
    contentBytes: null,
    errorCode: null,
    safeErrorMessage: null,
    retryCount: 0,
    startedAt: null,
    finishedAt: null,
  }
}
