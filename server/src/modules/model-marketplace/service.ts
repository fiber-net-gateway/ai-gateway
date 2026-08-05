import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

import type { Clock, RandomSource } from '../users/crypto.js'
import { DomainError } from '../users/errors.js'
import type { AuthenticatedActor } from '../users/services.js'
import type { UserStore } from '../users/types.js'
import type { ModelAccessDirectory } from '../model-access/types.js'
import {
  RnacosConfigError,
  type MarketplaceConfigPublisher,
  type RnacosConfigRead,
} from '../rnacos/config-client.js'
import { generateProviderName } from './provider-name.js'
import { renderModelsResource, renderProviderResource } from './renderer.js'
import type {
  AdminModelDetailView,
  AdminModelView,
  AvailableModelView,
  MarketplaceEnvironmentRecord,
  MarketplaceModelRecord,
  MarketplaceProviderRecord,
  MarketplaceReleaseRecord,
  MarketplaceReleaseResourceRecord,
  MarketplaceSecretService,
  MarketplaceStore,
  ModelMutationInput,
  ProviderAdminView,
  ProviderAdminSummaryView,
  ProviderMutationInput,
  RenderedResource,
  TokenMutationInput,
  ValidationIssue,
} from './types.js'
import {
  normalizeBaseUrl,
  protocolCoverage,
  validateModelGraph,
  validateModelMutation,
  validateProviderMutation,
} from './validation.js'

interface IdempotencyResult {
  requestHash: string
  modelId: string
}

interface TokenIdempotencyResult {
  requestHash: string
  providerId: string
  tokenId: string
  deleted: boolean
}

interface ProviderIdempotencyResult {
  requestHash: string
  providerId: string
}

function copy<T>(value: T): T {
  return structuredClone(value)
}

function hashRequest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

function activeModels(environment: MarketplaceEnvironmentRecord): MarketplaceModelRecord[] {
  return environment.draft.models.filter((model) => !model.archivedAt)
}

function activeProviders(environment: MarketplaceEnvironmentRecord): MarketplaceProviderRecord[] {
  return environment.draft.providers.filter((provider) => !provider.archivedAt)
}

function beforeCursor(
  model: MarketplaceModelRecord,
  cursor: { updatedAt: string; id: string },
): boolean {
  return (
    model.updatedAt < cursor.updatedAt ||
    (model.updatedAt === cursor.updatedAt && model.id < cursor.id)
  )
}

function revisionFromEtag(etag: string | undefined): number {
  const match = etag?.trim().match(/^(?:W\/)?"([0-9]+)"$/u)
  if (!match) throw new DomainError('IF_MATCH_REQUIRED', 428, '写操作需要有效的 If-Match')
  const value = Number(match[1])
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DomainError('IF_MATCH_INVALID', 400, 'If-Match revision 不合法')
  }
  return value
}

function safeProvider(provider: MarketplaceProviderRecord): ProviderAdminView {
  return {
    id: provider.id,
    providerName: provider.providerName,
    displayName: provider.displayName,
    baseUrl: provider.baseUrl,
    protocols: copy(provider.protocols),
    tokens: provider.tokens.map((token) => ({
      id: token.id,
      name: token.name,
      configured: true,
      fingerprintSuffix: token.fingerprintSuffix,
      updatedAt: token.updatedAt,
    })),
  }
}

export class ModelMarketplaceService {
  private readonly idempotency = new Map<string, IdempotencyResult>()
  private readonly tokenIdempotency = new Map<string, TokenIdempotencyResult>()
  private readonly providerIdempotency = new Map<string, ProviderIdempotencyResult>()
  private readonly releaseJobs = new Map<string, Promise<void>>()

  constructor(
    private readonly store: MarketplaceStore,
    private readonly secrets: MarketplaceSecretService,
    private readonly userStore: UserStore,
    private readonly clock: Clock,
    private readonly random: RandomSource,
    private readonly cursorKey: Buffer,
    private readonly accessDirectory: ModelAccessDirectory,
    private readonly publisher: MarketplaceConfigPublisher | null,
  ) {}

  parseRevision(etag: string | undefined): number {
    return revisionFromEtag(etag)
  }

  async ensureEnvironment(environmentId: string, actorId: string) {
    return this.store.ensureEnvironment({
      environmentId,
      actorId,
      now: this.clock.now().toISOString(),
    })
  }

  async listAdmin(
    environmentId: string,
    actorId: string,
    query: { search?: string; protocol?: string; cursor?: string; limit?: number },
  ): Promise<{
    items: AdminModelView[]
    nextCursor: string | null
    draft: { id: string; revision: number }
  }> {
    const environment = await this.ensureEnvironment(environmentId, actorId)
    const search = query.search?.trim().toLocaleLowerCase()
    let models = activeModels(environment)
    if (search) {
      models = models.filter(
        (model) =>
          model.displayName.toLocaleLowerCase().includes(search) ||
          model.logicalModelName.toLocaleLowerCase().includes(search),
      )
    }
    if (query.protocol === 'openai') {
      models = models.filter(
        (model) => protocolCoverage(model, environment.draft.providers).openai === 'SUPPORTED',
      )
    }
    if (query.protocol === 'anthropic') {
      models = models.filter(
        (model) => protocolCoverage(model, environment.draft.providers).anthropic === 'SUPPORTED',
      )
    }
    models.sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id),
    )
    if (query.cursor) {
      const cursor = this.decodeCursor(query.cursor)
      models = models.filter((model) => beforeCursor(model, cursor))
    }
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100)
    const page = models.slice(0, limit + 1)
    const items = page.slice(0, limit)
    return {
      items: items.map((model) => this.toAdminView(model, environment)),
      nextCursor:
        page.length > limit && items.length ? this.encodeCursor(items[items.length - 1]) : null,
      draft: { id: environment.draft.id, revision: environment.draft.revision },
    }
  }

  async listAvailable(
    environmentId: string,
    actorId: string,
    query: {
      search?: string
      protocol?: string
      access?: string
      cursor?: string
      limit?: number
    },
  ): Promise<{ items: AvailableModelView[]; nextCursor: string | null }> {
    const environment = await this.ensureEnvironment(environmentId, actorId)
    if (!environment.publishedVersion) return { items: [], nextCursor: null }
    const search = query.search?.trim().toLocaleLowerCase()
    let models = environment.publishedVersion.models.filter((model) => !model.archivedAt)
    if (search) {
      models = models.filter(
        (model) =>
          model.displayName.toLocaleLowerCase().includes(search) ||
          model.logicalModelName.toLocaleLowerCase().includes(search),
      )
    }
    models.sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id),
    )
    if (query.cursor) {
      const cursor = this.decodeCursor(query.cursor)
      models = models.filter((model) => beforeCursor(model, cursor))
    }
    const groupIds = [
      ...new Set(models.flatMap((model) => model.allowUserGroups.map((group) => group.id))),
    ]
    const [managedGroups, publishedMembershipGroupIds] = await Promise.all([
      this.accessDirectory.getGroupsByIds(groupIds),
      this.accessDirectory.getPublishedMembershipGroupIds({ groupIds, userId: actorId }),
    ])
    const managedGroupById = new Map(managedGroups.map((group) => [group.id, group]))
    const publishedMemberships = new Set(publishedMembershipGroupIds)
    const available = models.map((model) => {
      const coverage = protocolCoverage(model, environment.publishedVersion!.providers)
      const accessMode = model.allowUserGroups.length
        ? ('APPROVAL_REQUIRED' as const)
        : ('ALL_AUTHENTICATED' as const)
      const managedGroup =
        model.allowUserGroups.length === 1
          ? managedGroupById.get(model.allowUserGroups[0].id)
          : undefined
      const requestable = Boolean(managedGroup && managedGroup.modelId === model.id)
      return {
        id: model.id,
        displayName: model.displayName,
        logicalModelName: model.logicalModelName,
        description: model.description,
        protocols: coverage,
        accessible:
          accessMode === 'ALL_AUTHENTICATED' ||
          model.allowUserGroups.some((group) => publishedMemberships.has(group.id)),
        accessMode,
        requestable,
        activationState: environment.publishedRelease?.activationState ?? 'UNKNOWN',
        publishedAt: environment.publishedRelease?.finishedAt ?? null,
      } satisfies AvailableModelView
    })
    const filtered = available
      .filter(
        (model) =>
          !query.protocol ||
          model.protocols[query.protocol as 'openai' | 'anthropic'] === 'SUPPORTED',
      )
      .filter((model) => query.access !== 'accessible' || model.accessible)
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100)
    const page = filtered.slice(0, limit + 1)
    const items = page.slice(0, limit)
    return {
      items,
      nextCursor:
        page.length > limit && items.length
          ? this.encodeCursor(models.find((model) => model.id === items[items.length - 1].id)!)
          : null,
    }
  }

  async getAdminDetail(
    environmentId: string,
    actorId: string,
    modelId: string,
  ): Promise<AdminModelDetailView> {
    const environment = await this.ensureEnvironment(environmentId, actorId)
    const model = environment.draft.models.find((candidate) => candidate.id === modelId)
    if (!model || model.archivedAt) throw new DomainError('MODEL_NOT_FOUND', 404, '模型不存在')
    return this.toAdminDetail(model, environment)
  }

  async getAvailableDetail(
    environmentId: string,
    actorId: string,
    modelId: string,
  ): Promise<AvailableModelView> {
    const list = await this.listAvailable(environmentId, actorId, {})
    const model = list.items.find((candidate) => candidate.id === modelId)
    if (!model) throw new DomainError('MODEL_NOT_FOUND', 404, '模型不存在')
    return model
  }

  async impact(environmentId: string, actorId: string, modelId: string) {
    const environment = await this.ensureEnvironment(environmentId, actorId)
    const model = environment.draft.models.find((candidate) => candidate.id === modelId)
    if (!model || model.archivedAt) throw new DomainError('MODEL_NOT_FOUND', 404, '模型不存在')
    const sharedProviderIds = new Set(model.providerBindings.map((binding) => binding.providerId))
    const affectedModels = activeModels(environment)
      .filter((candidate) =>
        candidate.providerBindings.some((binding) => sharedProviderIds.has(binding.providerId)),
      )
      .map((candidate) => ({ id: candidate.id, displayName: candidate.displayName }))
    return {
      modelId,
      sharedProviderCount: sharedProviderIds.size,
      affectedModels,
      publishedProviderEarlyEffectRisk: environment.publishedVersion !== null,
    }
  }

  async createModel(input: {
    environmentId: string
    actor: AuthenticatedActor
    mutation: ModelMutationInput
    expectedRevision: number
    idempotencyKey: string
    correlationId: string
  }): Promise<{ model: AdminModelDetailView; revision: number; replayed: boolean }> {
    this.validateIdempotencyKey(input.idempotencyKey)
    validateModelMutation(input.mutation, true)
    const requestHash = hashRequest(input.mutation)
    const key = `${input.actor.user.id}:${input.environmentId}:${input.idempotencyKey}`
    const replay = this.idempotency.get(key)
    if (replay) {
      if (replay.requestHash !== requestHash) {
        throw new DomainError('IDEMPOTENCY_CONFLICT', 409, 'Idempotency-Key 已用于其他请求')
      }
      const model = await this.getAdminDetail(
        input.environmentId,
        input.actor.user.id,
        replay.modelId,
      )
      return { model, revision: model.draft.revision, replayed: true }
    }
    const environment = await this.ensureEnvironment(input.environmentId, input.actor.user.id)
    if (
      activeModels(environment).some(
        (model) => model.logicalModelName === input.mutation.logicalModelName,
      )
    ) {
      throw new DomainError('LOGICAL_MODEL_NAME_CONFLICT', 409, '逻辑模型名已存在', {
        field: '/logicalModelName',
      })
    }
    const now = this.clock.now().toISOString()
    const modelId = randomUUID()
    const model = await this.buildModel({
      input: input.mutation,
      modelId,
      actorId: input.actor.user.id,
      now,
      environment,
      previous: null,
    })
    let draft
    try {
      draft = await this.store.saveDraft({
        environmentId: input.environmentId,
        expectedRevision: input.expectedRevision,
        actorId: input.actor.user.id,
        now,
        providers: environment.draft.providers,
        models: [...environment.draft.models, model],
      })
    } catch (error) {
      throw error
    }
    this.idempotency.set(key, { requestHash, modelId })
    await this.audit(
      input.actor,
      input.correlationId,
      'marketplace.model.created',
      modelId,
      input.environmentId,
      {
        logicalModelName: model.logicalModelName,
        providerIds: model.providerBindings.map((binding) => binding.providerId),
        revision: String(draft.revision),
      },
    )
    const latest = await this.store.getEnvironment(input.environmentId)
    return {
      model: this.toAdminDetail(model, latest!),
      revision: draft.revision,
      replayed: false,
    }
  }

  async updateModel(input: {
    environmentId: string
    actor: AuthenticatedActor
    modelId: string
    mutation: ModelMutationInput
    expectedRevision: number
    correlationId: string
  }): Promise<{ model: AdminModelDetailView; revision: number }> {
    validateModelMutation(input.mutation, false)
    const environment = await this.ensureEnvironment(input.environmentId, input.actor.user.id)
    const previous = environment.draft.models.find((model) => model.id === input.modelId)
    if (!previous || previous.archivedAt)
      throw new DomainError('MODEL_NOT_FOUND', 404, '模型不存在')
    if (input.mutation.logicalModelName !== previous.logicalModelName) {
      throw new DomainError(
        'LOGICAL_MODEL_NAME_IMMUTABLE',
        409,
        '逻辑模型名不可原地修改，请复制为新模型',
        { field: '/logicalModelName' },
      )
    }
    const now = this.clock.now().toISOString()
    const model = await this.buildModel({
      input: input.mutation,
      modelId: input.modelId,
      actorId: input.actor.user.id,
      now,
      environment,
      previous,
    })
    const models = environment.draft.models.map((candidate) =>
      candidate.id === input.modelId ? model : candidate,
    )
    let draft
    try {
      draft = await this.store.saveDraft({
        environmentId: input.environmentId,
        expectedRevision: input.expectedRevision,
        actorId: input.actor.user.id,
        now,
        providers: environment.draft.providers,
        models,
      })
    } catch (error) {
      throw error
    }
    await this.audit(
      input.actor,
      input.correlationId,
      'marketplace.model.updated',
      model.id,
      input.environmentId,
      {
        providerIds: model.providerBindings.map((binding) => binding.providerId),
        revision: String(draft.revision),
      },
    )
    const latest = await this.store.getEnvironment(input.environmentId)
    return { model: this.toAdminDetail(model, latest!), revision: draft.revision }
  }

  async listProviders(
    environmentId: string,
    actorId: string,
  ): Promise<{
    items: ProviderAdminSummaryView[]
    draft: { id: string; revision: number }
  }> {
    const environment = await this.ensureEnvironment(environmentId, actorId)
    return {
      items: activeProviders(environment)
        .sort(
          (left, right) =>
            right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id),
        )
        .map((provider) => this.toProviderSummary(provider, environment)),
      draft: { id: environment.draft.id, revision: environment.draft.revision },
    }
  }

  async getProvider(
    environmentId: string,
    actorId: string,
    providerId: string,
  ): Promise<ProviderAdminSummaryView & { draft: { id: string; revision: number } }> {
    const environment = await this.ensureEnvironment(environmentId, actorId)
    const provider = activeProviders(environment).find((candidate) => candidate.id === providerId)
    if (!provider) throw new DomainError('PROVIDER_NOT_FOUND', 404, '供应商不存在')
    return {
      ...this.toProviderSummary(provider, environment),
      draft: { id: environment.draft.id, revision: environment.draft.revision },
    }
  }

  async createProvider(input: {
    environmentId: string
    actor: AuthenticatedActor
    provider: ProviderMutationInput
    expectedRevision: number
    idempotencyKey: string
    correlationId: string
  }): Promise<{ provider: ProviderAdminSummaryView; revision: number; replayed: boolean }> {
    this.validateIdempotencyKey(input.idempotencyKey)
    validateProviderMutation(input.provider)
    const environment = await this.ensureEnvironment(input.environmentId, input.actor.user.id)
    const requestHash = hashRequest(input.provider)
    const key = `${input.actor.user.id}:${input.environmentId}:provider:${input.idempotencyKey}`
    const replay = this.providerIdempotency.get(key)
    if (replay) {
      if (replay.requestHash !== requestHash) {
        throw new DomainError('IDEMPOTENCY_CONFLICT', 409, 'Idempotency-Key 已用于其他请求')
      }
      const current = await this.getProvider(
        input.environmentId,
        input.actor.user.id,
        replay.providerId,
      )
      return { provider: current, revision: current.draft.revision, replayed: true }
    }
    const now = this.clock.now().toISOString()
    const built = await this.buildProvider({
      environment,
      actorId: input.actor.user.id,
      now,
      mutation: input.provider,
      previous: null,
    })
    let draft
    try {
      draft = await this.store.saveDraft({
        environmentId: input.environmentId,
        expectedRevision: input.expectedRevision,
        actorId: input.actor.user.id,
        now,
        providers: [...environment.draft.providers, built],
        models: environment.draft.models,
      })
    } catch (error) {
      await this.discardProviderSecrets(built, environment, now)
      throw error
    }
    this.providerIdempotency.set(key, { requestHash, providerId: built.id })
    await this.audit(
      input.actor,
      input.correlationId,
      'marketplace.provider.created',
      built.id,
      input.environmentId,
      { providerName: built.providerName, revision: String(draft.revision) },
    )
    const latest = (await this.store.getEnvironment(input.environmentId))!
    return {
      provider: this.toProviderSummary(built, latest),
      revision: draft.revision,
      replayed: false,
    }
  }

  async updateProvider(input: {
    environmentId: string
    actor: AuthenticatedActor
    providerId: string
    provider: ProviderMutationInput
    expectedRevision: number
    correlationId: string
  }): Promise<{
    provider: ProviderAdminView
    revision: number
    affectedModelIds: string[]
  }> {
    const environment = await this.ensureEnvironment(input.environmentId, input.actor.user.id)
    const affectedModels = activeModels(environment).filter((model) =>
      model.providerBindings.some((binding) => binding.providerId === input.providerId),
    )
    const previous = activeProviders(environment).find(
      (provider) => provider.id === input.providerId,
    )
    if (!previous) throw new DomainError('PROVIDER_NOT_FOUND', 404, '供应商不存在')
    if (affectedModels.length > 1 && !input.provider.confirmProviderImpact) {
      throw new DomainError(
        'PROVIDER_IMPACT_CONFIRMATION_REQUIRED',
        409,
        'Provider 变更需要确认全部引用模型的影响范围',
        {
          affectedModels: affectedModels.map((model) => ({
            id: model.id,
            displayName: model.displayName,
          })),
        },
      )
    }
    validateProviderMutation(input.provider)
    const now = this.clock.now().toISOString()
    const built = await this.buildProvider({
      environment,
      actorId: input.actor.user.id,
      now,
      mutation: input.provider,
      previous,
    })
    const providers = environment.draft.providers.map((provider) =>
      provider.id === input.providerId ? built : provider,
    )
    let draft
    try {
      draft = await this.store.saveDraft({
        environmentId: input.environmentId,
        expectedRevision: input.expectedRevision,
        actorId: input.actor.user.id,
        now,
        providers,
        models: environment.draft.models,
      })
    } catch (error) {
      await this.discardProviderSecrets(built, environment, now)
      throw error
    }
    await this.audit(
      input.actor,
      input.correlationId,
      'marketplace.provider.updated',
      input.providerId,
      input.environmentId,
      {
        providerId: input.providerId,
        providerName: built.providerName,
        affectedModelIds: affectedModels.map((model) => model.id),
        revision: String(draft.revision),
      },
    )
    return {
      provider: safeProvider(built),
      revision: draft.revision,
      affectedModelIds: affectedModels.map((model) => model.id),
    }
  }

  async mutateProviderToken(input: {
    environmentId: string
    actor: AuthenticatedActor
    providerId: string
    tokenId?: string
    action: 'replace' | 'delete'
    name?: string
    value?: string
    reason: string
    confirmUnauthenticated?: boolean
    confirmProviderImpact?: boolean
    expectedRevision: number
    idempotencyKey?: string
    correlationId: string
  }): Promise<{
    token: ReturnType<typeof safeProvider>['tokens'][number] | null
    deleted: boolean
    revision: number
    affectedModelIds: string[]
    replayed: boolean
  }> {
    if (!input.reason.trim()) {
      throw new DomainError('TOKEN_CHANGE_REASON_REQUIRED', 422, '供应商凭据变更必须填写原因')
    }
    const environment = await this.ensureEnvironment(input.environmentId, input.actor.user.id)
    const affectedModels = activeModels(environment).filter((model) =>
      model.providerBindings.some((binding) => binding.providerId === input.providerId),
    )
    const provider = activeProviders(environment).find(
      (candidate) => candidate.id === input.providerId,
    )
    if (!provider) throw new DomainError('PROVIDER_NOT_FOUND', 404, '供应商不存在')
    if (affectedModels.length > 1 && !input.confirmProviderImpact) {
      throw new DomainError(
        'PROVIDER_IMPACT_CONFIRMATION_REQUIRED',
        409,
        'Provider 变更需要确认全部引用模型的影响范围',
        {
          affectedModels: affectedModels.map((model) => ({
            id: model.id,
            displayName: model.displayName,
          })),
        },
      )
    }
    const existing = input.tokenId
      ? provider.tokens.find((token) => token.id === input.tokenId)
      : undefined
    if (input.tokenId && !existing) {
      throw new DomainError('PROVIDER_TOKEN_NOT_FOUND', 404, '供应商 Token 不存在')
    }
    let replacement: MarketplaceProviderRecord['tokens'][number] | null = null
    this.validateIdempotencyKey(input.idempotencyKey ?? '')
    const idempotencyStorageKey = `${input.actor.user.id}:${input.environmentId}:token:${input.idempotencyKey}`
    const requestHash = hashRequest({
      providerId: input.providerId,
      tokenId: input.tokenId,
      action: input.action,
      name: input.name,
      value: input.value,
      reason: input.reason,
    })
    const previous = this.tokenIdempotency.get(idempotencyStorageKey)
    if (previous) {
      if (previous.requestHash !== requestHash) {
        throw new DomainError('IDEMPOTENCY_CONFLICT', 409, 'Idempotency-Key 已用于其他请求')
      }
      const currentToken = provider.tokens.find((token) => token.id === previous.tokenId)
      if (!previous.deleted && !currentToken) {
        throw new DomainError('IDEMPOTENCY_RESULT_UNAVAILABLE', 409, '幂等结果已不可用')
      }
      return {
        token: currentToken
          ? safeProvider({ ...provider, tokens: [currentToken] }).tokens[0]
          : null,
        deleted: previous.deleted,
        revision: environment.draft.revision,
        affectedModelIds: affectedModels.map((model) => model.id),
        replayed: true,
      }
    }
    if (input.action === 'delete' && input.value !== undefined) {
      throw new DomainError('PROVIDER_TOKEN_VALUE_FORBIDDEN', 422, '删除 Token 时不能携带 value')
    }
    if (input.action === 'replace') {
      if (
        !input.value ||
        /[\r\n\u0000]/u.test(input.value) ||
        Buffer.byteLength(input.value) > 8_192
      ) {
        throw new DomainError(
          'PROVIDER_TOKEN_VALUE_INVALID',
          422,
          'Token 值长度或字符不符合安全约束',
        )
      }
      const name = existing?.name ?? input.name?.trim()
      if (!name || name.length > 128 || /[\u0000-\u001f\u007f]/u.test(name)) {
        throw new DomainError('PROVIDER_TOKEN_NAME_INVALID', 422, 'Token 名不符合约束')
      }
      const mutation: Extract<TokenMutationInput, { secretAction: 'replace' }> = existing
        ? { id: existing.id, name, secretAction: 'replace', value: input.value }
        : { name, secretAction: 'replace', value: input.value }
      replacement = await this.replaceToken(
        {
          environmentId: input.environmentId,
          providerId: input.providerId,
          actorId: input.actor.user.id,
          now: this.clock.now().toISOString(),
          oldTokens: provider.tokens,
        },
        mutation,
      )
    } else if (provider.tokens.length === 1 && !input.confirmUnauthenticated) {
      throw new DomainError(
        'UNAUTHENTICATED_PROVIDER_CONFIRMATION_REQUIRED',
        409,
        '删除最后一个 Token 需要确认无凭据调用风险',
        { affectedModels: affectedModels.map((model) => model.id) },
      )
    }
    const now = this.clock.now().toISOString()
    const nextTokens = provider.tokens
      .filter((token) => token.id !== input.tokenId)
      .concat(replacement ? [replacement] : [])
    const providers = environment.draft.providers.map((candidate) =>
      candidate.id === input.providerId
        ? { ...candidate, tokens: copy(nextTokens), updatedBy: input.actor.user.id, updatedAt: now }
        : candidate,
    )
    let draft
    try {
      draft = await this.store.saveDraft({
        environmentId: input.environmentId,
        expectedRevision: input.expectedRevision,
        actorId: input.actor.user.id,
        now,
        providers,
        models: environment.draft.models,
      })
    } catch (error) {
      if (replacement) await this.secrets.discardOrphan(replacement.secretId, now)
      throw error
    }
    this.tokenIdempotency.set(idempotencyStorageKey, {
      requestHash,
      providerId: input.providerId,
      tokenId: replacement?.id ?? input.tokenId!,
      deleted: input.action === 'delete',
    })
    await this.audit(
      input.actor,
      input.correlationId,
      input.action === 'replace'
        ? existing
          ? 'marketplace.provider_token.replaced'
          : 'marketplace.provider_token.created'
        : 'marketplace.provider_token.deleted',
      replacement?.id ?? input.tokenId!,
      input.environmentId,
      {
        providerId: input.providerId,
        tokenId: replacement?.id ?? input.tokenId,
        tokenName: replacement?.name ?? existing?.name,
        secretAction: input.action,
        fingerprintSuffix: replacement?.fingerprintSuffix,
        affectedModelIds: affectedModels.map((model) => model.id),
        revision: String(draft.revision),
      },
    )
    return {
      token: replacement ? safeProvider({ ...provider, tokens: [replacement] }).tokens[0] : null,
      deleted: input.action === 'delete',
      revision: draft.revision,
      affectedModelIds: affectedModels.map((model) => model.id),
      replayed: false,
    }
  }

  async archiveProvider(input: {
    environmentId: string
    actor: AuthenticatedActor
    providerId: string
    expectedRevision: number
    correlationId: string
  }): Promise<{ revision: number }> {
    const environment = await this.ensureEnvironment(input.environmentId, input.actor.user.id)
    const provider = activeProviders(environment).find(
      (candidate) => candidate.id === input.providerId,
    )
    if (!provider) throw new DomainError('PROVIDER_NOT_FOUND', 404, '供应商不存在')
    const referencedModels = activeModels(environment).filter((model) =>
      model.providerBindings.some((binding) => binding.providerId === input.providerId),
    )
    if (referencedModels.length) {
      throw new DomainError('PROVIDER_IN_USE', 409, '供应商仍被模型引用，不能归档', {
        affectedModels: referencedModels.map((model) => ({
          id: model.id,
          displayName: model.displayName,
        })),
      })
    }
    const now = this.clock.now().toISOString()
    provider.archivedAt = now
    provider.updatedAt = now
    provider.updatedBy = input.actor.user.id
    const draft = await this.store.saveDraft({
      environmentId: input.environmentId,
      expectedRevision: input.expectedRevision,
      actorId: input.actor.user.id,
      now,
      providers: environment.draft.providers,
      models: environment.draft.models,
    })
    await this.audit(
      input.actor,
      input.correlationId,
      'marketplace.provider.archived',
      provider.id,
      input.environmentId,
      { providerName: provider.providerName, revision: String(draft.revision) },
    )
    return { revision: draft.revision }
  }

  async archiveModel(input: {
    environmentId: string
    actor: AuthenticatedActor
    modelId: string
    expectedRevision: number
    correlationId: string
  }): Promise<{ revision: number }> {
    const environment = await this.ensureEnvironment(input.environmentId, input.actor.user.id)
    const model = environment.draft.models.find((candidate) => candidate.id === input.modelId)
    if (!model || model.archivedAt) throw new DomainError('MODEL_NOT_FOUND', 404, '模型不存在')
    const now = this.clock.now().toISOString()
    model.archivedAt = now
    model.updatedAt = now
    model.updatedBy = input.actor.user.id
    const draft = await this.store.saveDraft({
      environmentId: input.environmentId,
      expectedRevision: input.expectedRevision,
      actorId: input.actor.user.id,
      now,
      providers: environment.draft.providers,
      models: environment.draft.models,
    })
    await this.audit(
      input.actor,
      input.correlationId,
      'marketplace.model.archived',
      model.id,
      input.environmentId,
      {
        logicalModelName: model.logicalModelName,
        revision: String(draft.revision),
      },
    )
    return { revision: draft.revision }
  }

  async validateEnvironment(
    environmentId: string,
    actorId: string,
  ): Promise<{
    valid: boolean
    issues: ValidationIssue[]
    revision: number
  }> {
    const environment = await this.ensureEnvironment(environmentId, actorId)
    const issues = activeModels(environment).flatMap((model) =>
      validateModelGraph(model, environment.draft.providers),
    )
    return {
      valid: !issues.some((issue) => issue.severity === 'ERROR'),
      issues,
      revision: environment.draft.revision,
    }
  }

  async submit(input: {
    environmentId: string
    actor: AuthenticatedActor
    expectedRevision: number
    correlationId: string
  }) {
    const validation = await this.validateEnvironment(input.environmentId, input.actor.user.id)
    if (!validation.valid) {
      throw new DomainError('DRAFT_VALIDATION_FAILED', 422, '草稿存在阻塞发布的配置错误', {
        issues: validation.issues,
      })
    }
    const now = this.clock.now().toISOString()
    const result = await this.store.createRelease({
      environmentId: input.environmentId,
      expectedRevision: input.expectedRevision,
      actorId: input.actor.user.id,
      now,
    })
    await this.audit(
      input.actor,
      input.correlationId,
      'marketplace.release.created',
      result.release.id,
      input.environmentId,
      {
        versionId: result.frozenVersion.id,
        releaseNumber: result.release.releaseNumber,
        resourceCount:
          new Set(
            result.frozenVersion.models.flatMap((model) =>
              model.providerBindings.map((binding) => binding.providerId),
            ),
          ).size + 1,
      },
    )
    return {
      release: result.release,
      draftRevision: result.draft.revision,
      publicationState: 'NEVER' as const,
      activationState: 'UNKNOWN' as const,
      message: '冻结版本和待发布 Release 已创建，请前往发布中心执行 rnacos 发布',
    }
  }

  async listReleases(environmentId: string, actorId: string) {
    await this.ensureEnvironment(environmentId, actorId)
    return this.store.listReleases(environmentId, 50)
  }

  async getRelease(environmentId: string, actorId: string, releaseId: string) {
    await this.ensureEnvironment(environmentId, actorId)
    const release = await this.store.getRelease(environmentId, releaseId)
    if (!release) throw new DomainError('RELEASE_NOT_FOUND', 404, 'Release 不存在')
    return this.releaseView(release)
  }

  async executeRelease(input: {
    environmentId: string
    releaseId: string
    actor: AuthenticatedActor
    correlationId: string
  }) {
    this.assertPublisherTarget(input.environmentId)
    const release = await this.store.getRelease(input.environmentId, input.releaseId)
    if (!release) throw new DomainError('RELEASE_NOT_FOUND', 404, 'Release 不存在')
    if (release.state !== 'PENDING' && release.state !== 'FAILED') {
      throw new DomainError('RELEASE_EXECUTION_NOT_ALLOWED', 409, '当前 Release 状态不能执行')
    }
    const started = await this.store.startRelease({
      releaseId: release.id,
      now: this.clock.now().toISOString(),
    })
    await this.audit(
      input.actor,
      input.correlationId,
      release.state === 'FAILED' ? 'marketplace.release.retried' : 'marketplace.release.started',
      release.id,
      input.environmentId,
      { releaseNumber: release.releaseNumber, revision: started.revision },
    )
    this.scheduleRelease(started, input.actor, input.correlationId)
    return this.releaseView(started)
  }

  async resumePublishingReleases(): Promise<void> {
    if (!this.publisher) return
    for (const release of await this.store.listPublishingReleases()) {
      if (this.publisher.target().environmentId !== release.environmentId) continue
      this.scheduleRelease(release, null, `release-recovery:${release.id}`)
    }
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled(this.releaseJobs.values())
  }

  private assertPublisherTarget(environmentId: string): void {
    if (!this.publisher) {
      throw new DomainError('RNACOS_PUBLISHER_UNAVAILABLE', 503, '当前进程未配置 rnacos 发布能力')
    }
    if (this.publisher.target().environmentId !== environmentId) {
      throw new DomainError(
        'RNACOS_ENVIRONMENT_UNBOUND',
        409,
        '当前环境未绑定到本进程的 rnacos 目标',
      )
    }
  }

  private scheduleRelease(
    release: MarketplaceReleaseRecord,
    actor: AuthenticatedActor | null,
    correlationId: string,
  ): void {
    if (this.releaseJobs.has(release.id)) return
    const job = this.runRelease(release, actor, correlationId)
      .catch(() => undefined)
      .finally(() => {
        this.releaseJobs.delete(release.id)
      })
    this.releaseJobs.set(release.id, job)
  }

  private async runRelease(
    scheduled: MarketplaceReleaseRecord,
    actor: AuthenticatedActor | null,
    correlationId: string,
  ): Promise<void> {
    let unlock: (() => Promise<void>) | null = null
    try {
      unlock = await this.store.acquireReleaseLock(scheduled.environmentId)
      const release = await this.store.getRelease(scheduled.environmentId, scheduled.id)
      if (!release || release.state !== 'PUBLISHING') return
      const version = await this.store.getVersion(release.versionId)
      const environment = await this.store.getEnvironment(release.environmentId)
      const previousByDataId = new Map(
        (environment?.publishedRelease?.resources ?? []).map((resource) => [
          resource.dataId,
          resource,
        ]),
      )
      const targetMd5ByDataId = await this.prepareTargetEvidence(release, version)
      await this.preflightResources(release, previousByDataId, targetMd5ByDataId)
      await this.assertGroupDependencies(version)
      for (const resource of [...release.resources].sort(
        (left, right) => left.dependencyOrder - right.dependencyOrder,
      )) {
        let rendered = await this.renderReleaseResource(release, version, resource)
        try {
          await this.publishResource(
            release,
            resource,
            rendered,
            previousByDataId.get(resource.dataId) ?? null,
          )
        } finally {
          rendered = { ...rendered, content: '' }
        }
      }
      const finished = await this.store.finishRelease({
        releaseId: release.id,
        workflowState: 'COMPLETED',
        publicationState: 'PUBLISHED',
        now: this.clock.now().toISOString(),
      })
      await this.audit(
        actor,
        correlationId,
        'marketplace.release.published',
        release.id,
        release.environmentId,
        {
          releaseNumber: release.releaseNumber,
          resourceCount: release.resources.length,
          revision: finished.revision,
          activationState: 'UNKNOWN',
        },
      )
    } catch (error) {
      await this.failRelease(scheduled, actor, correlationId, error)
    } finally {
      await unlock?.()
    }
  }

  private async assertGroupDependencies(
    version: Awaited<ReturnType<MarketplaceStore['getVersion']>>,
  ): Promise<void> {
    const groupRefs = new Map(
      version.models.flatMap((model) => model.allowUserGroups.map((group) => [group.id, group])),
    )
    if (groupRefs.size === 0) return
    const targets = await this.accessDirectory.getGroupPublicationTargets([...groupRefs.keys()])
    const byId = new Map(targets.map((target) => [target.group.id, target]))
    for (const [groupId, reference] of groupRefs) {
      const target = byId.get(groupId)
      if (!target || target.group.environmentId !== version.environmentId) {
        throw new ReleaseExecutionError(
          'ACCESS_GROUP_PUBLICATION_REQUIRED',
          `用户组 ${reference.name} 缺少可验证的发布内容`,
        )
      }
      if (target.group.groupName !== reference.name) {
        throw new ReleaseExecutionError(
          'ACCESS_GROUP_REFERENCE_CHANGED',
          `用户组 ${reference.name} 引用已发生变化`,
        )
      }
      const readback = await this.publisher!.read({
        environmentId: version.environmentId,
        group: 'LLM-SERVER',
        dataId: target.dataId,
      })
      if (
        target.group.publishedRevision < target.group.revision ||
        target.publishedMd5 !== target.targetMd5
      ) {
        throw new ReleaseExecutionError(
          'ACCESS_GROUP_PUBLICATION_REQUIRED',
          `用户组 ${reference.name} 当前修订尚未显式发布`,
        )
      }
      if (readback.state !== 'PRESENT' || readback.md5 !== target.targetMd5) {
        throw new ReleaseExecutionError(
          'ACCESS_GROUP_DRIFTED',
          `rnacos 中用户组 ${reference.name} 与当前修订的 MD5 不一致`,
        )
      }
    }
  }

  private async prepareTargetEvidence(
    release: MarketplaceReleaseRecord,
    version: Awaited<ReturnType<MarketplaceStore['getVersion']>>,
  ): Promise<Map<string, string>> {
    const targetMd5ByDataId = new Map<string, string>()
    for (const resource of release.resources) {
      let rendered: RenderedResource | undefined
      try {
        rendered = await this.renderReleaseResource(release, version, resource)
        const targetMd5 = createHash('md5').update(rendered.content, 'utf8').digest('hex')
        targetMd5ByDataId.set(resource.dataId, targetMd5)
        await this.store.updateReleaseResource({
          releaseId: release.id,
          resourceId: resource.id,
          state: resource.state,
          newSafeDigest: this.safeContentDigest(rendered.content),
          newMd5: targetMd5,
          contentBytes: Buffer.byteLength(rendered.content, 'utf8'),
          now: this.clock.now().toISOString(),
        })
      } catch (error) {
        await this.markResourceFailed(release, resource, error)
        throw error
      } finally {
        if (rendered) rendered = { ...rendered, content: '' }
      }
    }
    return targetMd5ByDataId
  }

  private async preflightResources(
    release: MarketplaceReleaseRecord,
    previousByDataId: Map<string, MarketplaceReleaseResourceRecord>,
    targetMd5ByDataId: Map<string, string>,
  ): Promise<void> {
    for (const resource of release.resources) {
      let current: RnacosConfigRead
      try {
        current = await this.publisher!.read({
          environmentId: release.environmentId,
          group: resource.group,
          dataId: resource.dataId,
        })
      } catch (error) {
        await this.markResourceFailed(release, resource, error)
        throw error
      }
      const targetMd5 = targetMd5ByDataId.get(resource.dataId)
      const previous = previousByDataId.get(resource.dataId)
      const expectedOldMd5 = previous?.newMd5 ?? null
      const matchesTarget = Boolean(targetMd5 && current.md5 === targetMd5)
      const drifted =
        !matchesTarget &&
        (current.state === 'PRESENT' ? current.md5 !== expectedOldMd5 : Boolean(previous))
      if (drifted) {
        const error = new ReleaseExecutionError(
          'RELEASE_DRIFTED',
          previous
            ? `${resource.dataId} 与上一成功 Release 的证据不一致`
            : `${resource.dataId} 已存在未纳管内容，不能直接覆盖`,
        )
        await this.markResourceFailed(release, resource, error, {
          oldSafeDigest: current.content ? this.safeContentDigest(current.content) : null,
          oldMd5: current.md5,
          newMd5: targetMd5 ?? null,
        })
        throw error
      }
      await this.store.updateReleaseResource({
        releaseId: release.id,
        resourceId: resource.id,
        state: resource.state,
        oldSafeDigest: current.content ? this.safeContentDigest(current.content) : null,
        oldMd5: current.md5,
        now: this.clock.now().toISOString(),
      })
    }
  }

  private renderReleaseResource(
    release: MarketplaceReleaseRecord,
    version: Awaited<ReturnType<MarketplaceStore['getVersion']>>,
    resource: MarketplaceReleaseResourceRecord,
  ): Promise<RenderedResource> {
    if (release.releaseNumber > 2_147_483_647) {
      throw new ReleaseExecutionError(
        'CONFIG_VERSION_EXHAUSTED',
        'Release 序号已超出 ai-server int32 配置版本范围',
      )
    }
    return resource.kind === 'PROVIDER'
      ? renderProviderResource(
          version,
          resource.dataId.slice('ploto.ai-llm.provider.'.length),
          this.secrets,
          release.releaseNumber,
        )
      : Promise.resolve(renderModelsResource(version, release.releaseNumber))
  }

  private async publishResource(
    release: MarketplaceReleaseRecord,
    resource: MarketplaceReleaseResourceRecord,
    rendered: { group: 'LLM-SERVER'; dataId: string; content: string },
    previous: MarketplaceReleaseResourceRecord | null,
  ): Promise<void> {
    const targetMd5 = createHash('md5').update(rendered.content, 'utf8').digest('hex')
    const targetSafeDigest = this.safeContentDigest(rendered.content)
    let current: RnacosConfigRead
    try {
      current = await this.publisher!.read({
        environmentId: release.environmentId,
        group: rendered.group,
        dataId: rendered.dataId,
      })
    } catch (error) {
      await this.markResourceFailed(release, resource, error)
      throw error
    }
    const oldSafeDigest = current.content ? this.safeContentDigest(current.content) : null
    const common = {
      oldSafeDigest,
      newSafeDigest: targetSafeDigest,
      oldMd5: current.md5,
      newMd5: targetMd5,
      contentBytes: Buffer.byteLength(rendered.content, 'utf8'),
    }
    if (current.md5 === targetMd5) {
      await this.store.updateReleaseResource({
        releaseId: release.id,
        resourceId: resource.id,
        state: resource.state === 'PUBLISHED' ? 'PUBLISHED' : 'SKIPPED',
        ...common,
        errorCode: null,
        safeErrorMessage: null,
        now: this.clock.now().toISOString(),
      })
      return
    }
    const expectedOldMd5 = previous?.newMd5 ?? null
    const drifted = current.state === 'PRESENT' ? current.md5 !== expectedOldMd5 : Boolean(previous)
    if (drifted) {
      const error = new ReleaseExecutionError(
        'RELEASE_DRIFTED',
        previous
          ? `${resource.dataId} 与上一成功 Release 的证据不一致`
          : `${resource.dataId} 已存在未纳管内容，不能直接覆盖`,
      )
      await this.markResourceFailed(release, resource, error, common)
      throw error
    }
    await this.store.updateReleaseResource({
      releaseId: release.id,
      resourceId: resource.id,
      state: 'WRITING',
      ...common,
      errorCode: null,
      safeErrorMessage: null,
      incrementRetry: true,
      now: this.clock.now().toISOString(),
    })
    try {
      const published = await this.publisher!.publish({
        environmentId: release.environmentId,
        group: rendered.group,
        dataId: rendered.dataId,
        content: rendered.content,
        expectedMd5: targetMd5,
        expectedOldMd5,
      })
      await this.store.updateReleaseResource({
        releaseId: release.id,
        resourceId: resource.id,
        state: 'PUBLISHED',
        ...common,
        newMd5: published.readbackMd5,
        errorCode: null,
        safeErrorMessage: null,
        now: this.clock.now().toISOString(),
      })
    } catch (error) {
      await this.markResourceFailed(release, resource, error, common)
      throw error
    }
  }

  private async markResourceFailed(
    release: MarketplaceReleaseRecord,
    resource: MarketplaceReleaseResourceRecord,
    error: unknown,
    metadata: Partial<
      Pick<
        MarketplaceReleaseResourceRecord,
        'oldSafeDigest' | 'newSafeDigest' | 'oldMd5' | 'newMd5' | 'contentBytes'
      >
    > = {},
  ): Promise<void> {
    const safe = releaseError(error)
    await this.store.updateReleaseResource({
      releaseId: release.id,
      resourceId: resource.id,
      state: 'FAILED',
      ...metadata,
      errorCode: safe.code,
      safeErrorMessage: safe.message,
      now: this.clock.now().toISOString(),
    })
  }

  private async failRelease(
    scheduled: MarketplaceReleaseRecord,
    actor: AuthenticatedActor | null,
    correlationId: string,
    error: unknown,
  ): Promise<void> {
    const release = await this.store.getRelease(scheduled.environmentId, scheduled.id)
    if (!release || release.state !== 'PUBLISHING') return
    const safe = releaseError(error)
    if (!release.resources.some((resource) => resource.state === 'FAILED')) {
      const resource =
        release.resources.find((candidate) => candidate.kind === 'MODELS') ?? release.resources[0]
      if (resource) await this.markResourceFailed(release, resource, error)
    }
    const current = await this.store.getRelease(scheduled.environmentId, scheduled.id)
    const hasProgress = current?.resources.some(
      (resource) => resource.state === 'PUBLISHED' || resource.state === 'SKIPPED',
    )
    const publicationState =
      safe.code === 'RELEASE_DRIFTED' || safe.code === 'RNACOS_CAS_CONFLICT'
        ? 'DRIFTED'
        : hasProgress
          ? 'PARTIAL'
          : 'FAILED'
    const finished = await this.store.finishRelease({
      releaseId: scheduled.id,
      workflowState: 'FAILED',
      publicationState,
      now: this.clock.now().toISOString(),
    })
    await this.audit(
      actor,
      correlationId,
      'marketplace.release.failed',
      scheduled.id,
      scheduled.environmentId,
      {
        releaseNumber: scheduled.releaseNumber,
        errorCode: safe.code,
        safeErrorMessage: safe.message,
        publicationState,
        revision: finished.revision,
      },
    )
  }

  private safeContentDigest(content: string): string {
    return createHmac('sha256', this.cursorKey)
      .update('marketplace-release-content\u0000')
      .update(content, 'utf8')
      .digest('hex')
  }

  private async releaseView(release: MarketplaceReleaseRecord) {
    const version = await this.store.getVersion(release.versionId)
    const references = new Map(
      version.models.flatMap((model) => model.allowUserGroups.map((group) => [group.id, group])),
    )
    const targets = await this.accessDirectory.getGroupPublicationTargets([...references.keys()])
    const byId = new Map(targets.map((target) => [target.group.id, target]))
    return {
      ...release,
      target: this.publisher?.target() ?? null,
      groupDependencies: [...references].map(([id, reference]) => {
        const target = byId.get(id)
        const group = target?.group
        return {
          id,
          name: reference.name,
          revision: group?.revision ?? null,
          publishedRevision: group?.publishedRevision ?? null,
          state:
            target &&
            group &&
            group.publishedRevision >= group.revision &&
            target.publishedMd5 === target.targetMd5
              ? ('READY' as const)
              : ('NOT_PUBLISHED' as const),
        }
      }),
    }
  }

  private toProviderSummary(
    provider: MarketplaceProviderRecord,
    environment: MarketplaceEnvironmentRecord,
  ): ProviderAdminSummaryView {
    const referencedModels = activeModels(environment)
      .filter((model) =>
        model.providerBindings.some((binding) => binding.providerId === provider.id),
      )
      .map((model) => ({
        id: model.id,
        logicalModelName: model.logicalModelName,
        displayName: model.displayName,
      }))
    const publishedReference = environment.publishedVersion?.models.some(
      (model) =>
        !model.archivedAt &&
        model.providerBindings.some((binding) => binding.providerId === provider.id),
    )
    return {
      ...safeProvider(provider),
      referencedModelCount: referencedModels.length,
      referencedModels,
      draftState: 'MODIFIED',
      publicationState: publishedReference
        ? (environment.publishedRelease?.publicationState ?? 'NEVER')
        : 'NEVER',
      activationState: publishedReference
        ? (environment.publishedRelease?.activationState ?? 'UNKNOWN')
        : 'UNKNOWN',
      updatedAt: provider.updatedAt,
    }
  }

  private toAdminView(
    model: MarketplaceModelRecord,
    environment: MarketplaceEnvironmentRecord,
  ): AdminModelView {
    const providerById = new Map(
      environment.draft.providers.map((provider) => [provider.id, provider]),
    )
    const boundProviders = model.providerBindings.flatMap((binding) => {
      const provider = providerById.get(binding.providerId)
      return provider ? [provider] : []
    })
    const issues = validateModelGraph(model, environment.draft.providers)
    return {
      id: model.id,
      logicalModelName: model.logicalModelName,
      displayName: model.displayName,
      description: model.description,
      tags: [...model.tags],
      protocols: protocolCoverage(model, environment.draft.providers),
      providerCount: model.providerBindings.length,
      primaryProviderCount: model.providerBindings.filter(
        (binding) => binding.routeRole === 'PRIMARY',
      ).length,
      fallbackConfigured: model.providerBindings.some(
        (binding) => binding.routeRole === 'FALLBACK',
      ),
      configuredTokenCount: boundProviders.reduce(
        (sum, provider) => sum + provider.tokens.length,
        0,
      ),
      accessMode: model.allowUserGroups.length ? 'APPROVAL_REQUIRED' : 'ALL_AUTHENTICATED',
      draftState: issues.some((issue) => issue.severity === 'ERROR') ? 'INVALID' : 'MODIFIED',
      publicationState: environment.publishedRelease?.publicationState ?? 'NEVER',
      activationState: environment.publishedRelease?.activationState ?? 'UNKNOWN',
      validationErrorCount: issues.filter((issue) => issue.severity === 'ERROR').length,
      validationWarningCount: issues.filter((issue) => issue.severity === 'WARNING').length,
      latestReleaseId: environment.publishedRelease?.id ?? null,
      latestReleaseNumber: environment.publishedRelease?.releaseNumber ?? null,
      updatedBy: model.updatedBy,
      updatedAt: model.updatedAt,
    }
  }

  private toAdminDetail(
    model: MarketplaceModelRecord,
    environment: MarketplaceEnvironmentRecord,
  ): AdminModelDetailView {
    const providerById = new Map(
      environment.draft.providers.map((provider) => [provider.id, provider]),
    )
    return {
      ...this.toAdminView(model, environment),
      prefixMaxBytes: model.prefixMaxBytes,
      maxPrimaryAttempts: model.maxPrimaryAttempts,
      fallbackEnabled: model.fallbackEnabled,
      retryableStatuses: [...model.retryableStatuses],
      rateLimit: copy(model.rateLimit),
      allowUserGroups: copy(model.allowUserGroups),
      providers: model.providerBindings.flatMap((binding) => {
        const provider = providerById.get(binding.providerId)
        return provider
          ? [
              {
                ...safeProvider(provider),
                routeRole: binding.routeRole,
                sortOrder: binding.sortOrder,
              },
            ]
          : []
      }),
      draft: {
        versionId: environment.draft.id,
        revision: environment.draft.revision,
        state: 'MODIFIED',
      },
      published: {
        versionId: environment.publishedVersion?.id ?? null,
        releaseId: environment.publishedRelease?.id ?? null,
        releaseNumber: environment.publishedRelease?.releaseNumber ?? null,
        state: environment.publishedRelease?.publicationState ?? 'NEVER',
        publishedAt: environment.publishedVersion?.frozenAt ?? null,
      },
      activation: {
        state: environment.publishedRelease?.activationState ?? 'UNKNOWN',
        evidence: 'NONE',
      },
    }
  }

  private async buildModel(input: {
    input: ModelMutationInput
    modelId: string
    actorId: string
    now: string
    environment: MarketplaceEnvironmentRecord
    previous: MarketplaceModelRecord | null
  }): Promise<MarketplaceModelRecord> {
    const availableProviderIds = new Set(
      activeProviders(input.environment).map((provider) => provider.id),
    )
    for (const binding of input.input.providers) {
      if (!availableProviderIds.has(binding.providerId)) {
        throw new DomainError('PROVIDER_NOT_FOUND', 404, '模型绑定的供应商不存在', {
          field: '/providers',
          providerId: binding.providerId,
        })
      }
    }
    const allowUserGroups = await this.resolveAccessGroups(input)
    return {
      id: input.modelId,
      logicalModelName: input.input.logicalModelName,
      displayName: input.input.displayName.trim(),
      description: input.input.description?.trim() ?? '',
      tags: [...new Set((input.input.tags ?? []).map((tag) => tag.trim().toLocaleLowerCase()))],
      prefixMaxBytes: input.input.loadBalance.prefixMaxBytes,
      maxPrimaryAttempts: input.input.loadBalance.maxPrimaryAttempts,
      fallbackEnabled: input.input.loadBalance.fallbackEnabled,
      retryableStatuses: [...new Set(input.input.loadBalance.retryableStatuses)].sort(
        (left, right) => left - right,
      ),
      rateLimit: copy(input.input.rateLimit),
      allowUserGroups,
      providerBindings: copy(input.input.providers),
      createdBy: input.previous?.createdBy ?? input.actorId,
      createdAt: input.previous?.createdAt ?? input.now,
      updatedBy: input.actorId,
      updatedAt: input.now,
      archivedAt: null,
    }
  }

  private mutationFromRecord(model: MarketplaceModelRecord): ModelMutationInput {
    return {
      displayName: model.displayName,
      logicalModelName: model.logicalModelName,
      description: model.description,
      tags: [...model.tags],
      providers: copy(model.providerBindings),
      accessMode: model.allowUserGroups.length ? 'APPROVAL_REQUIRED' : 'ALL_AUTHENTICATED',
      loadBalance: {
        prefixMaxBytes: model.prefixMaxBytes,
        maxPrimaryAttempts: model.maxPrimaryAttempts,
        fallbackEnabled: model.fallbackEnabled,
        retryableStatuses: [...model.retryableStatuses],
      },
      rateLimit: copy(model.rateLimit),
    }
  }

  private async resolveAccessGroups(input: {
    input: ModelMutationInput
    modelId: string
    actorId: string
    now: string
    environment: MarketplaceEnvironmentRecord
    previous: MarketplaceModelRecord | null
  }): Promise<MarketplaceModelRecord['allowUserGroups']> {
    if (input.input.accessMode === 'ALL_AUTHENTICATED') return []
    if (input.previous?.allowUserGroups.length) {
      if (input.previous.allowUserGroups.length !== 1) {
        throw new DomainError(
          'MODEL_ACCESS_GROUP_AMBIGUOUS',
          409,
          '模型存在多个访问组，不能自动启用权限申请',
        )
      }
      const previousGroup = input.previous.allowUserGroups[0]
      const group = (await this.accessDirectory.getGroupsByIds([previousGroup.id]))[0]
      if (!group || group.modelId !== input.modelId) {
        throw new DomainError('ACCESS_GROUP_MODEL_MISMATCH', 409, '申请授权组与当前模型不匹配', {
          field: '/accessMode',
        })
      }
      return [{ id: group.id, name: group.groupName }]
    }
    const group = await this.accessDirectory.ensureGroupForModel({
      environmentId: input.environment.draft.environmentId,
      modelId: input.modelId,
      logicalModelName: input.input.logicalModelName,
      actorId: input.actorId,
    })
    return [{ id: group.id, name: group.groupName }]
  }

  private async buildProvider(input: {
    environment: MarketplaceEnvironmentRecord
    actorId: string
    now: string
    mutation: ProviderMutationInput
    previous: MarketplaceProviderRecord | null
  }): Promise<MarketplaceProviderRecord> {
    const providerId = input.previous?.id ?? randomUUID()
    const providerName =
      input.previous?.providerName ??
      this.uniqueProviderName(input.mutation.displayName, input.environment)
    const tokens = await this.buildTokens({
      environmentId: input.environment.draft.environmentId,
      providerId,
      actorId: input.actorId,
      now: input.now,
      oldTokens: input.previous?.tokens ?? [],
      authentication: input.mutation.authentication,
    })
    return {
      id: providerId,
      providerName,
      ownership: 'SHARED',
      ownerModelId: null,
      displayName: input.mutation.displayName.trim(),
      baseUrl: normalizeBaseUrl(input.mutation.baseUrl, '/provider/baseUrl'),
      protocols: input.mutation.protocols.map((protocol) => ({
        ...protocol,
        upstreamModelName: protocol.upstreamModelName.trim(),
      })),
      tokens,
      createdBy: input.previous?.createdBy ?? input.actorId,
      createdAt: input.previous?.createdAt ?? input.now,
      updatedBy: input.actorId,
      updatedAt: input.now,
      archivedAt: null,
    }
  }

  private async buildTokens(input: {
    environmentId: string
    providerId: string
    actorId: string
    now: string
    oldTokens: MarketplaceProviderRecord['tokens']
    authentication: NonNullable<ProviderMutationInput['authentication']>
  }) {
    if (input.authentication.mode === 'NO_CREDENTIALS') return []
    const result: MarketplaceProviderRecord['tokens'] = []
    for (const mutation of input.authentication.tokens) {
      if (mutation.secretAction === 'delete') continue
      if (mutation.secretAction === 'keep') {
        const oldToken = input.oldTokens.find((token) => token.id === mutation.id)
        if (!oldToken || oldToken.name !== mutation.name) {
          throw new DomainError('PROVIDER_TOKEN_NOT_FOUND', 404, '要保留的 Token 不存在')
        }
        result.push(copy(oldToken))
        continue
      }
      result.push(await this.replaceToken(input, mutation))
    }
    return result
  }

  private async replaceToken(
    input: {
      environmentId: string
      providerId: string
      actorId: string
      now: string
      oldTokens: MarketplaceProviderRecord['tokens']
    },
    mutation: Extract<TokenMutationInput, { secretAction: 'replace' }>,
  ) {
    const tokenId = 'id' in mutation ? mutation.id : randomUUID()
    if ('id' in mutation && !input.oldTokens.some((token) => token.id === mutation.id)) {
      throw new DomainError('PROVIDER_TOKEN_NOT_FOUND', 404, '要替换的 Token 不存在')
    }
    const bytes = Uint8Array.from(Buffer.from(mutation.value, 'utf8'))
    try {
      const metadata = await this.secrets.createProviderToken({
        environmentId: input.environmentId,
        providerId: input.providerId,
        tokenId,
        value: bytes,
        actorId: input.actorId,
        now: input.now,
      })
      return {
        id: tokenId,
        name: mutation.name,
        secretId: metadata.id,
        fingerprintSuffix: metadata.fingerprintSuffix,
        updatedAt: input.now,
      }
    } finally {
      bytes.fill(0)
      mutation.value = ''
    }
  }

  private uniqueProviderName(seed: string, environment: MarketplaceEnvironmentRecord) {
    const names = new Set(environment.draft.providers.map((provider) => provider.providerName))
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const candidate = generateProviderName(seed, this.random)
      if (!names.has(candidate)) return candidate
    }
    throw new DomainError('PROVIDER_NAME_CONFLICT', 409, '无法生成唯一 Provider 标识')
  }

  private async discardProviderSecrets(
    provider: MarketplaceProviderRecord,
    environment: MarketplaceEnvironmentRecord,
    now: string,
  ): Promise<void> {
    const referenced = new Set(
      environment.draft.providers.flatMap((candidate) =>
        candidate.tokens.map((token) => token.secretId),
      ),
    )
    const newSecretIds = new Set(
      provider.tokens
        .map((token) => token.secretId)
        .filter((secretId) => !referenced.has(secretId)),
    )
    await Promise.allSettled(
      [...newSecretIds].map((secretId) => this.secrets.discardOrphan(secretId, now)),
    )
  }

  private validateIdempotencyKey(value: string) {
    if (value.length < 8 || value.length > 128 || /[^A-Za-z0-9._:-]/u.test(value)) {
      throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', 400, '创建操作需要有效的 Idempotency-Key')
    }
  }

  private encodeCursor(model: Pick<MarketplaceModelRecord, 'updatedAt' | 'id'>): string {
    const payload = Buffer.from(
      JSON.stringify({ updatedAt: model.updatedAt, id: model.id }),
      'utf8',
    ).toString('base64url')
    const signature = createHmac('sha256', this.cursorKey)
      .update(`marketplace-cursor:${payload}`)
      .digest('base64url')
    return `${payload}.${signature}`
  }

  private decodeCursor(value: string): { updatedAt: string; id: string } {
    try {
      const [payload, signature, extra] = value.split('.')
      if (!payload || !signature || extra) throw new Error('invalid cursor shape')
      const expected = createHmac('sha256', this.cursorKey)
        .update(`marketplace-cursor:${payload}`)
        .digest()
      const actual = Buffer.from(signature, 'base64url')
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw new Error('invalid cursor signature')
      }
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
        updatedAt?: unknown
        id?: unknown
      }
      if (
        typeof decoded.updatedAt !== 'string' ||
        !Number.isFinite(Date.parse(decoded.updatedAt)) ||
        typeof decoded.id !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          decoded.id,
        )
      ) {
        throw new Error('invalid cursor payload')
      }
      return { updatedAt: decoded.updatedAt, id: decoded.id }
    } catch {
      throw new DomainError('CURSOR_INVALID', 400, '分页 cursor 不合法或签名无效')
    }
  }

  private async audit(
    actor: AuthenticatedActor | null,
    correlationId: string,
    eventType: string,
    targetId: string,
    environmentId: string,
    payload: Record<string, unknown>,
  ) {
    await this.userStore.appendAudit({
      actor: actor?.user ?? null,
      eventType,
      targetType: eventType.includes('release') ? 'release' : 'model',
      targetId,
      environmentId,
      correlationId,
      payload,
      occurredAt: this.clock.now().toISOString(),
    })
  }
}

class ReleaseExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

function releaseError(error: unknown): { code: string; message: string } {
  if (
    error instanceof ReleaseExecutionError ||
    error instanceof RnacosConfigError ||
    error instanceof DomainError
  ) {
    return { code: error.code, message: safeReleaseMessage(error.message) }
  }
  return { code: 'RELEASE_EXECUTION_FAILED', message: '发布编排执行失败' }
}

function safeReleaseMessage(message: string): string {
  return message.replace(/[\u0000-\u001f\u007f]/gu, ' ').slice(0, 500)
}
