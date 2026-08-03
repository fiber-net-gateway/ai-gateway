import { randomUUID } from 'node:crypto'

import { DomainError } from '../users/errors.js'
import type {
  MarketplaceEnvironmentRecord,
  MarketplaceModelRecord,
  MarketplaceReleaseRecord,
  MarketplaceStore,
  MarketplaceVersionRecord,
} from './types.js'

function copy<T>(value: T): T {
  return structuredClone(value)
}

export class MemoryMarketplaceStore implements MarketplaceStore {
  private readonly environments = new Map<string, MarketplaceEnvironmentRecord>()
  private readonly frozenVersions = new Map<string, MarketplaceVersionRecord>()

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
      models: [],
      createdBy: input.actorId,
      createdAt: input.now,
      updatedAt: input.now,
      frozenAt: null,
    }
    const environment: MarketplaceEnvironmentRecord = {
      draft,
      publishedVersion: null,
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
      createdBy: input.actorId,
      createdAt: input.now,
      resources: releaseResources(frozenVersion),
    }
    this.frozenVersions.set(frozenVersion.id, frozenVersion)
    environment.latestRelease = release
    environment.draft.baseReleaseVersionId = frozenVersion.id
    environment.draft.revision += 1
    environment.draft.updatedAt = input.now
    return {
      draft: copy(environment.draft),
      frozenVersion: copy(frozenVersion),
      release: copy(release),
    }
  }
}

function releaseResources(version: MarketplaceVersionRecord) {
  const providerNames = [
    ...new Set(
      version.models.flatMap((model) => model.providers.map((provider) => provider.providerName)),
    ),
  ].sort((left, right) => left.localeCompare(right, 'en'))
  return [
    ...providerNames.map((providerName, index) => ({
      id: randomUUID(),
      kind: 'PROVIDER' as const,
      group: 'LLM-SERVER' as const,
      dataId: `ploto.ai-llm.provider.${providerName}`,
      dependencyOrder: index,
      state: 'PENDING' as const,
    })),
    {
      id: randomUUID(),
      kind: 'MODELS' as const,
      group: 'LLM-SERVER' as const,
      dataId: 'ploto.ai-llm.models',
      dependencyOrder: providerNames.length,
      state: 'PENDING' as const,
    },
  ]
}
