import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

import type { Clock, RandomSource } from '../users/crypto.js'
import { DomainError } from '../users/errors.js'
import type { AuthenticatedActor } from '../users/services.js'
import type { UserStore } from '../users/types.js'
import { generateProviderName } from './provider-name.js'
import type {
  AdminModelDetailView,
  AdminModelView,
  AvailableModelView,
  MarketplaceEnvironmentRecord,
  MarketplaceModelRecord,
  MarketplaceProviderRecord,
  MarketplaceSecretService,
  MarketplaceStore,
  ModelMutationInput,
  ProviderAdminView,
  ProviderMutationInput,
  TokenMutationInput,
  ValidationIssue,
} from './types.js'
import {
  normalizeBaseUrl,
  protocolCoverage,
  validateModelGraph,
  validateModelMutation,
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
  modelId: string
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
    ownership: provider.ownership,
    displayName: provider.displayName,
    baseUrl: provider.baseUrl,
    routeRole: provider.routeRole,
    sortOrder: provider.sortOrder,
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

  constructor(
    private readonly store: MarketplaceStore,
    private readonly secrets: MarketplaceSecretService,
    private readonly userStore: UserStore,
    private readonly clock: Clock,
    private readonly random: RandomSource,
    private readonly cursorKey: Buffer,
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
      models = models.filter((model) => protocolCoverage(model).openai === 'SUPPORTED')
    }
    if (query.protocol === 'anthropic') {
      models = models.filter((model) => protocolCoverage(model).anthropic === 'SUPPORTED')
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
    const available = models.map((model) => {
      const coverage = protocolCoverage(model)
      return {
        id: model.id,
        displayName: model.displayName,
        logicalModelName: model.logicalModelName,
        description: model.description,
        protocols: coverage,
        accessible: model.allowUserGroups.length === 0,
        activationState: environment.activationState,
        publishedAt: environment.latestRelease?.createdAt ?? null,
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
    const sharedProviderIds = new Set(
      model.providers
        .filter((provider) => provider.ownership === 'SHARED')
        .map((provider) => provider.id),
    )
    const affectedModels = activeModels(environment)
      .filter((candidate) =>
        candidate.providers.some((provider) => sharedProviderIds.has(provider.id)),
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
        models: [...environment.draft.models, model],
      })
    } catch (error) {
      await this.discardNewSecrets(model, environment, now)
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
        providerIds: model.providers.map((provider) => provider.id),
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
        models,
      })
    } catch (error) {
      await this.discardNewSecrets(model, environment, now)
      throw error
    }
    await this.audit(
      input.actor,
      input.correlationId,
      'marketplace.model.updated',
      model.id,
      input.environmentId,
      {
        providerIds: model.providers.map((provider) => provider.id),
        revision: String(draft.revision),
      },
    )
    const latest = await this.store.getEnvironment(input.environmentId)
    return { model: this.toAdminDetail(model, latest!), revision: draft.revision }
  }

  async addProvider(input: {
    environmentId: string
    actor: AuthenticatedActor
    modelId: string
    provider: ProviderMutationInput
    expectedRevision: number
    idempotencyKey: string
    correlationId: string
  }): Promise<{ model: AdminModelDetailView; revision: number; replayed: boolean }> {
    this.validateIdempotencyKey(input.idempotencyKey)
    const environment = await this.ensureEnvironment(input.environmentId, input.actor.user.id)
    const model = environment.draft.models.find((candidate) => candidate.id === input.modelId)
    if (!model || model.archivedAt) throw new DomainError('MODEL_NOT_FOUND', 404, '模型不存在')
    const requestHash = hashRequest(input.provider)
    const key = `${input.actor.user.id}:${input.environmentId}:provider:${input.idempotencyKey}`
    const replay = this.providerIdempotency.get(key)
    if (replay) {
      if (replay.requestHash !== requestHash) {
        throw new DomainError('IDEMPOTENCY_CONFLICT', 409, 'Idempotency-Key 已用于其他请求')
      }
      const current = await this.getAdminDetail(
        input.environmentId,
        input.actor.user.id,
        replay.modelId,
      )
      return { model: current, revision: current.draft.revision, replayed: true }
    }
    const previousProviderIds = new Set(model.providers.map((provider) => provider.id))
    const mutation = this.mutationFromRecord(model)
    mutation.providers.push(input.provider)
    const result = await this.updateModel({
      environmentId: input.environmentId,
      actor: input.actor,
      modelId: input.modelId,
      mutation,
      expectedRevision: input.expectedRevision,
      correlationId: input.correlationId,
    })
    const providerId =
      result.model.providers.find((provider) => !previousProviderIds.has(provider.id))?.id ??
      input.provider.providerId
    if (!providerId) throw new Error('provider save did not return a provider identity')
    this.providerIdempotency.set(key, {
      requestHash,
      modelId: input.modelId,
      providerId,
    })
    return { ...result, replayed: false }
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
      model.providers.some((provider) => provider.id === input.providerId),
    )
    if (affectedModels.length === 0)
      throw new DomainError('PROVIDER_NOT_FOUND', 404, '供应商不存在')
    const previous = affectedModels[0].providers.find(
      (provider) => provider.id === input.providerId,
    )!
    if (
      previous.ownership === 'SHARED' &&
      affectedModels.length > 1 &&
      !input.provider.confirmSharedImpact
    ) {
      throw new DomainError(
        'SHARED_PROVIDER_CONFIRMATION_REQUIRED',
        409,
        '共享 Provider 变更需要确认影响范围',
        {
          affectedModels: affectedModels.map((model) => ({
            id: model.id,
            displayName: model.displayName,
          })),
        },
      )
    }
    if (input.provider.id !== input.providerId || input.provider.mode !== 'UPDATE_EXISTING') {
      throw new DomainError('PROVIDER_ID_MISMATCH', 422, 'Provider 路径和请求身份不一致')
    }
    const ownerModel = affectedModels[0]
    const mutation = this.mutationFromRecord(ownerModel)
    const index = mutation.providers.findIndex((provider) => provider.id === input.providerId)
    mutation.providers[index] = input.provider
    validateModelMutation(mutation, false)
    const now = this.clock.now().toISOString()
    const built = await this.buildProvider({
      input: mutation,
      modelId: ownerModel.id,
      actorId: input.actor.user.id,
      now,
      environment,
      previous: ownerModel,
      provider: input.provider,
      index,
    })
    const affectedIds = new Set(affectedModels.map((model) => model.id))
    const models = environment.draft.models.map((model) => ({
      ...model,
      providers: model.providers.map((provider) =>
        provider.id === input.providerId
          ? {
              ...copy(built),
              routeRole: provider.routeRole,
              sortOrder: provider.sortOrder,
            }
          : provider,
      ),
      updatedBy: affectedIds.has(model.id) ? input.actor.user.id : model.updatedBy,
      updatedAt: affectedIds.has(model.id) ? now : model.updatedAt,
    }))
    let draft
    try {
      draft = await this.store.saveDraft({
        environmentId: input.environmentId,
        expectedRevision: input.expectedRevision,
        actorId: input.actor.user.id,
        now,
        models,
      })
    } catch (error) {
      await this.discardNewSecrets({ ...ownerModel, providers: [built] }, environment, now)
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
        affectedModelIds: [...affectedIds],
        revision: String(draft.revision),
      },
    )
    return {
      provider: safeProvider(built),
      revision: draft.revision,
      affectedModelIds: [...affectedIds],
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
    confirmSharedImpact?: boolean
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
      model.providers.some((provider) => provider.id === input.providerId),
    )
    if (affectedModels.length === 0)
      throw new DomainError('PROVIDER_NOT_FOUND', 404, '供应商不存在')
    const provider = affectedModels[0].providers.find(
      (candidate) => candidate.id === input.providerId,
    )!
    if (
      provider.ownership === 'SHARED' &&
      affectedModels.length > 1 &&
      !input.confirmSharedImpact
    ) {
      throw new DomainError(
        'SHARED_PROVIDER_CONFIRMATION_REQUIRED',
        409,
        '共享 Provider 变更需要确认影响范围',
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
    const models = environment.draft.models.map((model) => ({
      ...model,
      providers: model.providers.map((candidate) =>
        candidate.id === input.providerId ? { ...candidate, tokens: copy(nextTokens) } : candidate,
      ),
      updatedBy: affectedModels.some((affected) => affected.id === model.id)
        ? input.actor.user.id
        : model.updatedBy,
      updatedAt: affectedModels.some((affected) => affected.id === model.id)
        ? now
        : model.updatedAt,
    }))
    let draft
    try {
      draft = await this.store.saveDraft({
        environmentId: input.environmentId,
        expectedRevision: input.expectedRevision,
        actorId: input.actor.user.id,
        now,
        models,
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
    const issues = activeModels(environment).flatMap(validateModelGraph)
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
              model.providers.map((provider) => provider.id),
            ),
          ).size + 1,
      },
    )
    return {
      release: result.release,
      draftRevision: result.draft.revision,
      publicationState: 'NEVER' as const,
      activationState: 'UNKNOWN' as const,
      message: '冻结版本和待发布 release 已创建；rnacos 写入与实例生效仍需发布编排器提供证据',
    }
  }

  private toAdminView(
    model: MarketplaceModelRecord,
    environment: MarketplaceEnvironmentRecord,
  ): AdminModelView {
    const issues = validateModelGraph(model)
    return {
      id: model.id,
      logicalModelName: model.logicalModelName,
      displayName: model.displayName,
      description: model.description,
      tags: [...model.tags],
      protocols: protocolCoverage(model),
      providerCount: model.providers.length,
      primaryProviderCount: model.providers.filter((provider) => provider.routeRole === 'PRIMARY')
        .length,
      fallbackConfigured: model.providers.some((provider) => provider.routeRole === 'FALLBACK'),
      configuredTokenCount: model.providers.reduce(
        (sum, provider) => sum + provider.tokens.length,
        0,
      ),
      draftState: issues.some((issue) => issue.severity === 'ERROR') ? 'INVALID' : 'MODIFIED',
      publicationState: environment.publicationState,
      activationState: environment.activationState,
      validationErrorCount: issues.filter((issue) => issue.severity === 'ERROR').length,
      validationWarningCount: issues.filter((issue) => issue.severity === 'WARNING').length,
      latestReleaseId: environment.latestRelease?.id ?? null,
      latestReleaseNumber: environment.latestRelease?.releaseNumber ?? null,
      updatedBy: model.updatedBy,
      updatedAt: model.updatedAt,
    }
  }

  private toAdminDetail(
    model: MarketplaceModelRecord,
    environment: MarketplaceEnvironmentRecord,
  ): AdminModelDetailView {
    return {
      ...this.toAdminView(model, environment),
      prefixMaxBytes: model.prefixMaxBytes,
      maxPrimaryAttempts: model.maxPrimaryAttempts,
      fallbackEnabled: model.fallbackEnabled,
      retryableStatuses: [...model.retryableStatuses],
      rateLimit: copy(model.rateLimit),
      allowUserGroups: copy(model.allowUserGroups),
      providers: model.providers.map(safeProvider),
      draft: {
        versionId: environment.draft.id,
        revision: environment.draft.revision,
        state: 'MODIFIED',
      },
      published: {
        versionId: environment.publishedVersion?.id ?? null,
        releaseId: environment.latestRelease?.id ?? null,
        releaseNumber: environment.latestRelease?.releaseNumber ?? null,
        state: environment.publicationState,
        publishedAt: environment.publishedVersion?.frozenAt ?? null,
      },
      activation: { state: environment.activationState, evidence: 'NONE' },
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
    if (input.input.allowUserGroupIds?.length) {
      throw new DomainError(
        'USER_GROUP_MODULE_UNAVAILABLE',
        503,
        '用户组模块尚未接入，不能把未解析的用户组 ID 写入 ai-server 配置',
        { field: '/allowUserGroupIds' },
      )
    }
    const providers: MarketplaceProviderRecord[] = []
    for (const [index, provider] of input.input.providers.entries()) {
      providers.push(await this.buildProvider({ ...input, provider, index }))
    }
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
      allowUserGroups: (input.input.allowUserGroupIds ?? []).map((id) => ({ id, name: id })),
      providers,
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
      providers: model.providers.map((provider) => ({
        id: provider.id,
        mode: 'UPDATE_EXISTING',
        displayName: provider.displayName,
        baseUrl: provider.baseUrl,
        routeRole: provider.routeRole,
        sortOrder: provider.sortOrder,
        protocols: copy(provider.protocols),
        authentication: provider.tokens.length
          ? {
              mode: 'BEARER_TOKEN_POOL',
              tokens: provider.tokens.map((token) => ({
                id: token.id,
                name: token.name,
                secretAction: 'keep' as const,
              })),
            }
          : { mode: 'NO_CREDENTIALS', tokens: [], confirmUnauthenticated: true },
      })),
      allowUserGroupIds: model.allowUserGroups.map((group) => group.id),
      loadBalance: {
        prefixMaxBytes: model.prefixMaxBytes,
        maxPrimaryAttempts: model.maxPrimaryAttempts,
        fallbackEnabled: model.fallbackEnabled,
        retryableStatuses: [...model.retryableStatuses],
      },
      rateLimit: copy(model.rateLimit),
    }
  }

  private async buildProvider(input: {
    input: ModelMutationInput
    modelId: string
    actorId: string
    now: string
    environment: MarketplaceEnvironmentRecord
    previous: MarketplaceModelRecord | null
    provider: ProviderMutationInput
    index: number
  }): Promise<MarketplaceProviderRecord> {
    if (input.provider.mode === 'BIND_EXISTING') {
      const existing = activeModels(input.environment)
        .flatMap((model) => model.providers)
        .find((provider) => provider.id === input.provider.providerId)
      if (!existing) throw new DomainError('PROVIDER_NOT_FOUND', 404, '要绑定的供应商不存在')
      if (existing.ownership === 'DEDICATED' && existing.ownerModelId !== input.modelId) {
        throw new DomainError(
          'DEDICATED_PROVIDER_OWNERSHIP_CONFLICT',
          409,
          '专属供应商不能绑定其他模型',
        )
      }
      return {
        ...copy(existing),
        routeRole: input.provider.routeRole,
        sortOrder: input.provider.sortOrder,
      }
    }
    const oldProvider = input.provider.id
      ? input.previous?.providers.find((provider) => provider.id === input.provider.id)
      : undefined
    if (input.provider.mode === 'UPDATE_EXISTING' && !oldProvider) {
      throw new DomainError('PROVIDER_NOT_FOUND', 404, '要更新的供应商不存在')
    }
    const providerId = oldProvider?.id ?? randomUUID()
    const providerName =
      oldProvider?.providerName ??
      this.uniqueProviderName(input.input.logicalModelName, input.environment)
    const tokens = await this.buildTokens({
      environmentId: input.environment.draft.environmentId,
      providerId,
      actorId: input.actorId,
      now: input.now,
      oldTokens: oldProvider?.tokens ?? [],
      authentication: input.provider.authentication!,
    })
    return {
      id: providerId,
      providerName,
      ownership: oldProvider?.ownership ?? 'DEDICATED',
      ownerModelId: oldProvider?.ownerModelId ?? input.modelId,
      displayName: input.provider.displayName!.trim(),
      baseUrl: normalizeBaseUrl(input.provider.baseUrl!, `/providers/${input.index}/baseUrl`),
      routeRole: input.provider.routeRole,
      sortOrder: input.provider.sortOrder,
      protocols: input.provider.protocols!.map((protocol) => ({
        ...protocol,
        upstreamModelName: protocol.upstreamModelName.trim(),
      })),
      tokens,
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
    for (const mutation of input.authentication.tokens ?? []) {
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

  private uniqueProviderName(logicalModelName: string, environment: MarketplaceEnvironmentRecord) {
    const names = new Set(
      environment.draft.models.flatMap((model) =>
        model.providers.map((provider) => provider.providerName),
      ),
    )
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const candidate = generateProviderName(logicalModelName, this.random)
      if (!names.has(candidate)) return candidate
    }
    throw new DomainError('PROVIDER_NAME_CONFLICT', 409, '无法生成唯一 Provider 标识')
  }

  private async discardNewSecrets(
    model: MarketplaceModelRecord,
    environment: MarketplaceEnvironmentRecord,
    now: string,
  ): Promise<void> {
    const referenced = new Set(
      environment.draft.models.flatMap((candidate) =>
        candidate.providers.flatMap((provider) => provider.tokens.map((token) => token.secretId)),
      ),
    )
    const newSecretIds = new Set(
      model.providers
        .flatMap((provider) => provider.tokens.map((token) => token.secretId))
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
    actor: AuthenticatedActor,
    correlationId: string,
    eventType: string,
    targetId: string,
    environmentId: string,
    payload: Record<string, unknown>,
  ) {
    await this.userStore.appendAudit({
      actor: actor.user,
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
