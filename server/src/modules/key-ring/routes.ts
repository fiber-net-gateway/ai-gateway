import type { FastifyInstance, FastifyRequest } from 'fastify'

import { DomainError } from '../users/errors.js'
import type { AuthenticatedActor, SessionService, UserService } from '../users/services.js'
import type { EnvironmentRecord, UserStore } from '../users/types.js'
import type { KeyRingService } from './service.js'

const sessionCookieName = 'fg_session'

interface Dependencies {
  keyRing: KeyRingService
  sessions: SessionService
  users: UserService
  userStore: UserStore
}

const environmentParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['env'],
  properties: { env: { type: 'string', format: 'uuid' } },
} as const

const nullableMd5Schema = {
  anyOf: [{ type: 'string', pattern: '^[0-9a-f]{32}$' }, { type: 'null' }],
} as const

const keyRingResponseSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'dataId',
    'group',
    'target',
    'publicationState',
    'targetMd5',
    'readbackMd5',
    'contentBytes',
    'errorCode',
    'activationState',
    'activationEvidence',
    'keys',
  ],
  properties: {
    dataId: { const: 'ploto.ai-llm.auth.bt1.keys' },
    group: { const: 'LLM-SERVER' },
    target: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['environmentId', 'namespaceId', 'tenant', 'group'],
          properties: {
            environmentId: { type: 'string', format: 'uuid' },
            namespaceId: { type: 'string' },
            tenant: { type: 'string' },
            group: { const: 'LLM-SERVER' },
          },
        },
      ],
    },
    publicationState: {
      enum: ['UNAVAILABLE', 'NOT_PUBLISHED', 'PUBLISHED', 'DRIFTED', 'UNKNOWN'],
    },
    targetMd5: { type: 'string', pattern: '^[0-9a-f]{32}$' },
    readbackMd5: nullableMd5Schema,
    contentBytes: { type: 'integer', minimum: 1 },
    errorCode: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    activationState: { const: 'UNKNOWN' },
    activationEvidence: { const: 'NONE' },
    keys: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'kid',
          'keyState',
          'issuanceEnabled',
          'clockSkewSeconds',
          'retireAfter',
          'revision',
          'fingerprintSuffix',
        ],
        properties: {
          id: { type: 'string', format: 'uuid' },
          kid: { type: 'string', minLength: 1, maxLength: 16 },
          keyState: {
            enum: ['DRAFT', 'PUBLISHED_UNVERIFIED', 'ACTIVE', 'RETIRING', 'RETIRED'],
          },
          issuanceEnabled: { type: 'boolean' },
          clockSkewSeconds: { type: 'integer', minimum: 0, maximum: 300 },
          retireAfter: {
            anyOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }],
          },
          revision: { type: 'integer', minimum: 0 },
          fingerprintSuffix: { type: 'string', pattern: '^[0-9a-f]{12}$' },
        },
      },
    },
  },
} as const

async function actorFor(
  request: FastifyRequest,
  dependencies: Dependencies,
): Promise<AuthenticatedActor> {
  return dependencies.sessions.authenticate(request.cookies[sessionCookieName])
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

function verifyMutation(
  request: FastifyRequest,
  actor: AuthenticatedActor,
  environment: EnvironmentRecord,
  dependencies: Dependencies,
): void {
  const csrf = request.headers['x-csrf-token']
  dependencies.sessions.verifyCsrf(actor, Array.isArray(csrf) ? csrf[0] : csrf)
  if (environment.stage !== 'production') return
  const mfaAt = actor.session.mfaTime ? Date.parse(actor.session.mfaTime) : Number.NaN
  if (!Number.isFinite(mfaAt) || Date.now() - mfaAt > 5 * 60 * 1_000) {
    throw new DomainError(
      'REAUTHENTICATION_REQUIRED',
      403,
      '生产环境 Key Ring 发布需要五分钟内完成二次认证',
    )
  }
}

export function registerKeyRingRoutes(app: FastifyInstance, dependencies: Dependencies): void {
  app.get(
    '/api/environments/:env/bt1-key-ring',
    {
      schema: { params: environmentParamsSchema, response: { 200: keyRingResponseSchema } },
    },
    async (request, reply) => {
      const environmentId = (request.params as { env: string }).env
      const actor = await actorFor(request, dependencies)
      dependencies.users.requireAdmin(actor.user)
      await environmentFor(actor, environmentId, dependencies)
      reply.header('Cache-Control', 'no-store, private')
      return dependencies.keyRing.inspect(environmentId)
    },
  )

  app.post(
    '/api/environments/:env/bt1-key-ring/publish',
    {
      schema: { params: environmentParamsSchema, response: { 200: keyRingResponseSchema } },
    },
    async (request, reply) => {
      const environmentId = (request.params as { env: string }).env
      const actor = await actorFor(request, dependencies)
      dependencies.users.requireAdmin(actor.user)
      const environment = await environmentFor(actor, environmentId, dependencies)
      verifyMutation(request, actor, environment, dependencies)
      reply.header('Cache-Control', 'no-store, private')
      return dependencies.keyRing.publish({
        environmentId,
        actor,
        correlationId: request.id,
      })
    },
  )
}
