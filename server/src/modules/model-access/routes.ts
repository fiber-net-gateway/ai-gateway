import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import { DomainError } from '../users/errors.js'
import type { AuthenticatedActor, SessionService, UserService } from '../users/services.js'
import type { EnvironmentRecord, UserStore } from '../users/types.js'
import {
  accessRequestParamsSchema,
  adminListQuerySchema,
  applicantListQuerySchema,
  createAccessRequestSchema,
  decisionSchema,
  modelAccessParamsSchema,
  rejectionSchema,
} from './schemas.js'
import { ModelAccessService } from './service.js'
import type { ModelAccessRequestStatus } from './types.js'

const sessionCookieName = 'fg_session'

interface Dependencies {
  access: ModelAccessService
  sessions: SessionService
  users: UserService
  userStore: UserStore
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

function idempotencyKey(request: FastifyRequest): string {
  const value = request.headers['idempotency-key']
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

function ifMatch(request: FastifyRequest, dependencies: Dependencies): number {
  const value = request.headers['if-match']
  return dependencies.access.parseRevision(Array.isArray(value) ? value[0] : value)
}

function setRevision(reply: FastifyReply, revision: number): void {
  reply.header('ETag', `"${revision}"`)
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

function needsFreshMfa(environment: EnvironmentRecord, actor: AuthenticatedActor): void {
  if (environment.stage !== 'production') return
  const mfaAt = actor.session.mfaTime ? Date.parse(actor.session.mfaTime) : Number.NaN
  if (!Number.isFinite(mfaAt) || Date.now() - mfaAt > 5 * 60 * 1_000) {
    throw new DomainError(
      'REAUTHENTICATION_REQUIRED',
      403,
      '生产环境权限发布需要五分钟内完成二次认证',
    )
  }
}

export function registerModelAccessRoutes(app: FastifyInstance, dependencies: Dependencies): void {
  app.get(
    '/api/me/model-access-requests',
    { schema: { querystring: applicantListQuerySchema } },
    async (request) => {
      const actor = await actorFor(request, dependencies)
      const query = request.query as {
        environmentId?: string
        status?: ModelAccessRequestStatus
        cursor?: string
        limit?: number
      }
      return dependencies.access.listForApplicant({ actor, ...query })
    },
  )

  app.post(
    '/api/environments/:env/models/:modelId/access-requests',
    { schema: { params: modelAccessParamsSchema, body: createAccessRequestSchema } },
    async (request, reply) => {
      const actor = await actorFor(request, dependencies)
      csrfFor(request, actor, dependencies)
      const { env, modelId } = request.params as { env: string; modelId: string }
      await environmentFor(actor, env, dependencies)
      const body = request.body as { reason: string }
      const result = await dependencies.access.createRequest({
        environmentId: env,
        modelId,
        reason: body.reason,
        idempotencyKey: idempotencyKey(request),
        actor,
        correlationId: request.id,
      })
      setRevision(reply, result.request.revision)
      return reply.status(result.replayed ? 200 : 201).send(result.request)
    },
  )

  app.post(
    '/api/me/model-access-requests/:requestId/cancel',
    { schema: { params: accessRequestParamsSchema } },
    async (request, reply) => {
      const actor = await actorFor(request, dependencies)
      csrfFor(request, actor, dependencies)
      const requestId = (request.params as { requestId: string }).requestId
      const result = await dependencies.access.cancel({
        requestId,
        actor,
        expectedRevision: ifMatch(request, dependencies),
        correlationId: request.id,
      })
      setRevision(reply, result.revision)
      return result
    },
  )

  app.get(
    '/api/admin/model-access-requests',
    { schema: { querystring: adminListQuerySchema } },
    async (request) => {
      const actor = await actorFor(request, dependencies)
      dependencies.users.requireAdmin(actor.user)
      const query = request.query as {
        environmentId?: string
        status?: ModelAccessRequestStatus
        search?: string
        cursor?: string
        limit?: number
      }
      if (query.environmentId) await environmentFor(actor, query.environmentId, dependencies)
      return dependencies.access.listForAdmin(query)
    },
  )

  app.post(
    '/api/admin/model-access-requests/:requestId/approve',
    { schema: { params: accessRequestParamsSchema, body: decisionSchema } },
    async (request, reply) => {
      const actor = await actorFor(request, dependencies)
      csrfFor(request, actor, dependencies)
      dependencies.users.requireAdmin(actor.user)
      const requestId = (request.params as { requestId: string }).requestId
      const target = await dependencies.access.getForAdmin(requestId)
      const environment = await environmentFor(actor, target.environmentId, dependencies)
      needsFreshMfa(environment, actor)
      const body = request.body as { reason?: string }
      const result = await dependencies.access.approve({
        requestId,
        actor,
        expectedRevision: ifMatch(request, dependencies),
        reason: body.reason,
        correlationId: request.id,
      })
      setRevision(reply, result.revision)
      return result
    },
  )

  app.post(
    '/api/admin/model-access-requests/:requestId/reject',
    { schema: { params: accessRequestParamsSchema, body: rejectionSchema } },
    async (request, reply) => {
      const actor = await actorFor(request, dependencies)
      csrfFor(request, actor, dependencies)
      dependencies.users.requireAdmin(actor.user)
      const body = request.body as { reason: string }
      const result = await dependencies.access.reject({
        requestId: (request.params as { requestId: string }).requestId,
        actor,
        expectedRevision: ifMatch(request, dependencies),
        reason: body.reason,
        correlationId: request.id,
      })
      setRevision(reply, result.revision)
      return result
    },
  )

  app.post(
    '/api/admin/model-access-requests/:requestId/retry-publication',
    { schema: { params: accessRequestParamsSchema } },
    async (request, reply) => {
      const actor = await actorFor(request, dependencies)
      csrfFor(request, actor, dependencies)
      dependencies.users.requireAdmin(actor.user)
      const requestId = (request.params as { requestId: string }).requestId
      const target = await dependencies.access.getForAdmin(requestId)
      const environment = await environmentFor(actor, target.environmentId, dependencies)
      needsFreshMfa(environment, actor)
      const result = await dependencies.access.retryPublication({
        requestId,
        actor,
        correlationId: request.id,
      })
      setRevision(reply, result.revision)
      return result
    },
  )
}
