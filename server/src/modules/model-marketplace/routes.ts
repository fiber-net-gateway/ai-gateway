import { randomUUID } from 'node:crypto'

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { DomainError } from '../users/errors.js'
import type { AuthenticatedActor, SessionService, UserService } from '../users/services.js'
import type { EnvironmentRecord, UserStore } from '../users/types.js'
import {
  draftModelParamsSchema,
  draftProviderParamsSchema,
  draftProviderTokenParamsSchema,
  draftParamsSchema,
  createProviderTokenSchema,
  environmentParamsSchema,
  modelMutationSchema,
  modelParamsSchema,
  providerSchema,
  updateProviderTokenSchema,
} from './schemas.js'
import { ModelMarketplaceService } from './service.js'
import type { ModelMutationInput, ProviderMutationInput } from './types.js'

const sessionCookieName = 'fg_session'

interface Dependencies {
  marketplace: ModelMarketplaceService
  sessions: SessionService
  users: UserService
  userStore: UserStore
}

interface EnvironmentParams {
  env: string
}

interface ModelParams extends EnvironmentParams {
  modelId: string
}

interface DraftParams extends EnvironmentParams {
  draftId: string
}

interface DraftModelParams extends DraftParams {
  modelId: string
}

interface DraftProviderParams extends DraftParams {
  providerId: string
}

interface DraftProviderTokenParams extends DraftProviderParams {
  tokenId: string
}

async function actorFor(
  request: FastifyRequest,
  dependencies: Dependencies,
): Promise<AuthenticatedActor> {
  return dependencies.sessions.authenticate(request.cookies[sessionCookieName])
}

function csrfFor(
  request: FastifyRequest,
  actor: AuthenticatedActor,
  dependencies: Dependencies,
): void {
  const value = request.headers['x-csrf-token']
  dependencies.sessions.verifyCsrf(actor, Array.isArray(value) ? value[0] : value)
}

async function environmentFor(
  actor: AuthenticatedActor,
  environmentId: string,
  dependencies: Dependencies,
): Promise<EnvironmentRecord> {
  const access = await dependencies.userStore.listEnvironmentsForUser(actor.user.id)
  const environment = access.find((item) => item.environment.id === environmentId)?.environment
  if (!environment) throw new DomainError('ENVIRONMENT_NOT_FOUND', 404, '环境不存在或无权访问')
  return environment
}

async function requireAdmin(
  request: FastifyRequest,
  environmentId: string,
  dependencies: Dependencies,
  write = false,
): Promise<{ actor: AuthenticatedActor; environment: EnvironmentRecord }> {
  const actor = await actorFor(request, dependencies)
  const environment = await environmentFor(actor, environmentId, dependencies)
  dependencies.users.requireAdmin(actor.user)
  if (write) csrfFor(request, actor, dependencies)
  return { actor, environment }
}

async function assertDraft(
  environmentId: string,
  draftId: string,
  actorId: string,
  dependencies: Dependencies,
): Promise<void> {
  const environment = await dependencies.marketplace.ensureEnvironment(environmentId, actorId)
  if (environment.draft.id !== draftId) {
    throw new DomainError('DRAFT_NOT_FOUND', 404, '草稿不存在')
  }
}

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key']
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

function ifMatch(request: FastifyRequest, dependencies: Dependencies): number {
  const value = request.headers['if-match']
  return dependencies.marketplace.parseRevision(Array.isArray(value) ? value[0] : value)
}

function secretResponse(reply: FastifyReply): void {
  reply.header('Cache-Control', 'no-store, private')
  reply.header('Pragma', 'no-cache')
  reply.header('Referrer-Policy', 'no-referrer')
}

function setRevision(reply: FastifyReply, revision: number): void {
  reply.header('ETag', `"${revision}"`)
}

function needsFreshMfa(environment: EnvironmentRecord, actor: AuthenticatedActor): void {
  if (environment.stage !== 'production') return
  const mfaAt = actor.session.mfaTime ? Date.parse(actor.session.mfaTime) : Number.NaN
  if (!Number.isFinite(mfaAt) || Date.now() - mfaAt > 5 * 60 * 1_000) {
    throw new DomainError(
      'REAUTHENTICATION_REQUIRED',
      403,
      '生产环境供应商凭据变更需要五分钟内完成二次认证',
    )
  }
}

function mutationNeedsFreshMfa(mutation: ModelMutationInput | ProviderMutationInput): boolean {
  const providers = 'providers' in mutation ? mutation.providers : [mutation]
  return providers.some(
    (provider) =>
      provider.confirmSharedImpact ||
      provider.authentication?.tokens?.some(
        (token) => token.secretAction === 'replace' || token.secretAction === 'delete',
      ),
  )
}

export function registerModelMarketplaceRoutes(
  app: FastifyInstance,
  dependencies: Dependencies,
): void {
  app.post('/api/idempotency-keys', async (request, reply) => {
    const actor = await actorFor(request, dependencies)
    csrfFor(request, actor, dependencies)
    secretResponse(reply)
    return { key: randomUUID() }
  })

  app.get(
    '/api/environments/:env/models',
    {
      schema: {
        params: environmentParamsSchema,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            view: { type: 'string', enum: ['available', 'admin'] },
            draftId: { type: 'string', format: 'uuid' },
            search: { type: 'string', maxLength: 100 },
            protocol: { type: 'string', enum: ['openai', 'anthropic'] },
            access: { type: 'string', enum: ['accessible'] },
            cursor: { type: 'string', maxLength: 1_024 },
            limit: { type: 'integer', minimum: 1, maximum: 100 },
          },
        },
      },
    },
    async (request, reply) => {
      const { env } = request.params as EnvironmentParams
      const query = request.query as {
        view?: 'available' | 'admin'
        search?: string
        protocol?: string
        access?: string
        cursor?: string
        limit?: number
      }
      const actor = await actorFor(request, dependencies)
      await environmentFor(actor, env, dependencies)
      if (query.view === 'admin') {
        dependencies.users.requireAdmin(actor.user)
        const result = await dependencies.marketplace.listAdmin(env, actor.user.id, query)
        setRevision(reply, result.draft.revision)
        return result
      }
      return dependencies.marketplace.listAvailable(env, actor.user.id, query)
    },
  )

  app.get(
    '/api/environments/:env/models/:modelId',
    {
      schema: {
        params: modelParamsSchema,
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            view: { type: 'string', enum: ['available', 'admin'] },
            draftId: { type: 'string', format: 'uuid' },
          },
        },
      },
    },
    async (request, reply) => {
      const { env, modelId } = request.params as ModelParams
      const query = request.query as { view?: 'available' | 'admin' }
      const actor = await actorFor(request, dependencies)
      await environmentFor(actor, env, dependencies)
      if (query.view === 'admin') {
        dependencies.users.requireAdmin(actor.user)
        const model = await dependencies.marketplace.getAdminDetail(env, actor.user.id, modelId)
        setRevision(reply, model.draft.revision)
        return model
      }
      return dependencies.marketplace.getAvailableDetail(env, actor.user.id, modelId)
    },
  )

  app.get(
    '/api/environments/:env/models/:modelId/impact',
    { schema: { params: modelParamsSchema } },
    async (request) => {
      const { env, modelId } = request.params as ModelParams
      const { actor } = await requireAdmin(request, env, dependencies)
      return dependencies.marketplace.impact(env, actor.user.id, modelId)
    },
  )

  app.post(
    '/api/environments/:env/drafts/:draftId/models',
    { schema: { params: draftParamsSchema, body: modelMutationSchema } },
    async (request, reply) => {
      const { env, draftId } = request.params as DraftParams
      const { actor, environment } = await requireAdmin(request, env, dependencies, true)
      await assertDraft(env, draftId, actor.user.id, dependencies)
      const mutation = request.body as ModelMutationInput
      if (mutationNeedsFreshMfa(mutation)) needsFreshMfa(environment, actor)
      secretResponse(reply)
      const result = await dependencies.marketplace.createModel({
        environmentId: env,
        actor,
        mutation,
        expectedRevision: ifMatch(request, dependencies),
        idempotencyKey: idempotencyKey(request),
        correlationId: request.id,
      })
      setRevision(reply, result.revision)
      return reply.status(result.replayed ? 200 : 201).send(result.model)
    },
  )

  app.patch(
    '/api/environments/:env/drafts/:draftId/providers/:providerId',
    { schema: { params: draftProviderParamsSchema, body: providerSchema } },
    async (request, reply) => {
      const { env, draftId, providerId } = request.params as DraftProviderParams
      const { actor, environment } = await requireAdmin(request, env, dependencies, true)
      await assertDraft(env, draftId, actor.user.id, dependencies)
      const provider = request.body as ProviderMutationInput
      if (mutationNeedsFreshMfa(provider)) needsFreshMfa(environment, actor)
      secretResponse(reply)
      const result = await dependencies.marketplace.updateProvider({
        environmentId: env,
        actor,
        providerId,
        provider,
        expectedRevision: ifMatch(request, dependencies),
        correlationId: request.id,
      })
      setRevision(reply, result.revision)
      return result
    },
  )

  app.post(
    '/api/environments/:env/drafts/:draftId/models/:modelId/copy',
    { schema: { params: draftModelParamsSchema, body: modelMutationSchema } },
    async (request, reply) => {
      const { env, draftId } = request.params as DraftModelParams
      const { actor, environment } = await requireAdmin(request, env, dependencies, true)
      await assertDraft(env, draftId, actor.user.id, dependencies)
      const mutation = request.body as ModelMutationInput
      if (mutationNeedsFreshMfa(mutation)) needsFreshMfa(environment, actor)
      secretResponse(reply)
      const result = await dependencies.marketplace.createModel({
        environmentId: env,
        actor,
        mutation,
        expectedRevision: ifMatch(request, dependencies),
        idempotencyKey: idempotencyKey(request),
        correlationId: request.id,
      })
      setRevision(reply, result.revision)
      return reply.status(result.replayed ? 200 : 201).send(result.model)
    },
  )

  app.patch(
    '/api/environments/:env/drafts/:draftId/models/:modelId',
    { schema: { params: draftModelParamsSchema, body: modelMutationSchema } },
    async (request, reply) => {
      const { env, draftId, modelId } = request.params as DraftModelParams
      const { actor, environment } = await requireAdmin(request, env, dependencies, true)
      await assertDraft(env, draftId, actor.user.id, dependencies)
      const mutation = request.body as ModelMutationInput
      if (mutationNeedsFreshMfa(mutation)) needsFreshMfa(environment, actor)
      secretResponse(reply)
      const result = await dependencies.marketplace.updateModel({
        environmentId: env,
        actor,
        modelId,
        mutation,
        expectedRevision: ifMatch(request, dependencies),
        correlationId: request.id,
      })
      setRevision(reply, result.revision)
      return result.model
    },
  )

  app.post(
    '/api/environments/:env/drafts/:draftId/models/:modelId/providers',
    { schema: { params: draftModelParamsSchema, body: providerSchema } },
    async (request, reply) => {
      const { env, draftId, modelId } = request.params as DraftModelParams
      const { actor, environment } = await requireAdmin(request, env, dependencies, true)
      await assertDraft(env, draftId, actor.user.id, dependencies)
      const provider = request.body as ProviderMutationInput
      if (mutationNeedsFreshMfa(provider)) needsFreshMfa(environment, actor)
      secretResponse(reply)
      const result = await dependencies.marketplace.addProvider({
        environmentId: env,
        actor,
        modelId,
        provider,
        expectedRevision: ifMatch(request, dependencies),
        idempotencyKey: idempotencyKey(request),
        correlationId: request.id,
      })
      setRevision(reply, result.revision)
      return reply.status(result.replayed ? 200 : 201).send(result.model)
    },
  )

  app.post(
    '/api/environments/:env/drafts/:draftId/providers/:providerId/tokens',
    { schema: { params: draftProviderParamsSchema, body: createProviderTokenSchema } },
    async (request, reply) => {
      const { env, draftId, providerId } = request.params as DraftProviderParams
      const body = request.body as {
        name: string
        secretAction: 'replace'
        value: string
        reason: string
        confirmSharedImpact?: boolean
      }
      const { actor, environment } = await requireAdmin(request, env, dependencies, true)
      await assertDraft(env, draftId, actor.user.id, dependencies)
      needsFreshMfa(environment, actor)
      secretResponse(reply)
      const result = await dependencies.marketplace.mutateProviderToken({
        environmentId: env,
        actor,
        providerId,
        action: 'replace',
        name: body.name,
        value: body.value,
        reason: body.reason,
        confirmSharedImpact: body.confirmSharedImpact,
        expectedRevision: ifMatch(request, dependencies),
        idempotencyKey: idempotencyKey(request),
        correlationId: request.id,
      })
      setRevision(reply, result.revision)
      return reply.status(result.replayed ? 200 : 201).send(result)
    },
  )

  app.patch(
    '/api/environments/:env/drafts/:draftId/providers/:providerId/tokens/:tokenId',
    { schema: { params: draftProviderTokenParamsSchema, body: updateProviderTokenSchema } },
    async (request, reply) => {
      const { env, draftId, providerId, tokenId } = request.params as DraftProviderTokenParams
      const body = request.body as
        | {
            secretAction: 'replace'
            value: string
            reason: string
            confirmSharedImpact?: boolean
          }
        | {
            secretAction: 'delete'
            reason: string
            confirmUnauthenticated?: boolean
            confirmSharedImpact?: boolean
          }
      const { actor, environment } = await requireAdmin(request, env, dependencies, true)
      await assertDraft(env, draftId, actor.user.id, dependencies)
      needsFreshMfa(environment, actor)
      secretResponse(reply)
      const result = await dependencies.marketplace.mutateProviderToken({
        environmentId: env,
        actor,
        providerId,
        tokenId,
        action: body.secretAction,
        value: body.secretAction === 'replace' ? body.value : undefined,
        reason: body.reason,
        confirmUnauthenticated:
          body.secretAction === 'delete' ? body.confirmUnauthenticated : undefined,
        confirmSharedImpact: body.confirmSharedImpact,
        expectedRevision: ifMatch(request, dependencies),
        idempotencyKey: idempotencyKey(request),
        correlationId: request.id,
      })
      setRevision(reply, result.revision)
      return result
    },
  )

  app.delete(
    '/api/environments/:env/drafts/:draftId/models/:modelId',
    { schema: { params: draftModelParamsSchema } },
    async (request, reply) => {
      const { env, draftId, modelId } = request.params as DraftModelParams
      const { actor } = await requireAdmin(request, env, dependencies, true)
      await assertDraft(env, draftId, actor.user.id, dependencies)
      const result = await dependencies.marketplace.archiveModel({
        environmentId: env,
        actor,
        modelId,
        expectedRevision: ifMatch(request, dependencies),
        correlationId: request.id,
      })
      setRevision(reply, result.revision)
      return reply.status(204).send()
    },
  )

  app.post(
    '/api/environments/:env/drafts/:draftId/models/:modelId/validate',
    { schema: { params: draftModelParamsSchema } },
    async (request, reply) => {
      const { env, draftId, modelId } = request.params as DraftModelParams
      const { actor } = await requireAdmin(request, env, dependencies, true)
      await assertDraft(env, draftId, actor.user.id, dependencies)
      const validation = await dependencies.marketplace.validateEnvironment(env, actor.user.id)
      setRevision(reply, validation.revision)
      return {
        ...validation,
        issues: validation.issues.filter((issue) => issue.field.includes(modelId)),
      }
    },
  )

  app.post(
    '/api/environments/:env/drafts/:draftId/validate',
    { schema: { params: draftParamsSchema } },
    async (request, reply) => {
      const { env, draftId } = request.params as DraftParams
      const { actor } = await requireAdmin(request, env, dependencies, true)
      await assertDraft(env, draftId, actor.user.id, dependencies)
      const result = await dependencies.marketplace.validateEnvironment(env, actor.user.id)
      setRevision(reply, result.revision)
      return result
    },
  )

  app.get(
    '/api/environments/:env/drafts/:draftId/diff',
    { schema: { params: draftParamsSchema } },
    async (request) => {
      const { env, draftId } = request.params as DraftParams
      const { actor } = await requireAdmin(request, env, dependencies)
      await assertDraft(env, draftId, actor.user.id, dependencies)
      const models = await dependencies.marketplace.listAdmin(env, actor.user.id, {})
      return {
        draftId,
        revision: String(models.draft.revision),
        resources: models.items.map((model) => ({
          modelId: model.id,
          logicalModelName: model.logicalModelName,
          change: 'MODIFIED',
          providerCount: model.providerCount,
          configuredTokenCount: model.configuredTokenCount,
        })),
        secretValuesIncluded: false,
      }
    },
  )

  app.post(
    '/api/environments/:env/drafts/:draftId/submit',
    { schema: { params: draftParamsSchema } },
    async (request, reply) => {
      const { env, draftId } = request.params as DraftParams
      const { actor, environment } = await requireAdmin(request, env, dependencies, true)
      await assertDraft(env, draftId, actor.user.id, dependencies)
      needsFreshMfa(environment, actor)
      const result = await dependencies.marketplace.submit({
        environmentId: env,
        actor,
        expectedRevision: ifMatch(request, dependencies),
        correlationId: request.id,
      })
      setRevision(reply, result.draftRevision)
      return reply.status(202).send(result)
    },
  )
}
