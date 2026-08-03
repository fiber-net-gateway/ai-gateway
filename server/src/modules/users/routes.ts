import cookie from '@fastify/cookie'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'

import type { AppConfig } from '../../config/env.js'
import { OidcService } from '../auth/oidc-service.js'
import { DomainError } from './errors.js'
import { parseRole, parseStatus, SessionService, TokenService, UserService } from './services.js'
import type { AuthenticatedActor } from './services.js'
import type { SystemRole, UserStatus, UserStore } from './types.js'

const sessionCookieName = 'fg_session'
const csrfCookieName = 'fg_csrf'
const oidcCookieName = 'fg_oidc_tx'

export interface UserRouteDependencies {
  config: AppConfig
  store: UserStore
  users: UserService
  sessions: SessionService
  tokens: TokenService
  oidc: OidcService | null
}

function cookieOptions(config: AppConfig, httpOnly: boolean) {
  return {
    path: '/',
    secure: config.security.cookieSecure,
    httpOnly,
    sameSite: 'lax' as const,
  }
}

function setSessionCookies(
  reply: FastifyReply,
  config: AppConfig,
  session: { rawSessionToken: string; rawCsrfToken: string },
): void {
  reply.setCookie(sessionCookieName, session.rawSessionToken, {
    ...cookieOptions(config, true),
    maxAge: 8 * 60 * 60,
  })
  reply.setCookie(csrfCookieName, session.rawCsrfToken, {
    ...cookieOptions(config, false),
    maxAge: 8 * 60 * 60,
  })
}

function clearAuthCookies(reply: FastifyReply, config: AppConfig): void {
  reply.clearCookie(sessionCookieName, cookieOptions(config, true))
  reply.clearCookie(csrfCookieName, cookieOptions(config, false))
  reply.clearCookie(oidcCookieName, cookieOptions(config, true))
}

async function actorFor(
  request: FastifyRequest,
  dependencies: UserRouteDependencies,
): Promise<AuthenticatedActor> {
  return dependencies.sessions.authenticate(request.cookies[sessionCookieName])
}

function csrfFor(
  request: FastifyRequest,
  actor: AuthenticatedActor,
  dependencies: UserRouteDependencies,
): void {
  const value = request.headers['x-csrf-token']
  dependencies.sessions.verifyCsrf(actor, Array.isArray(value) ? value[0] : value)
}

function requireAdmin(actor: AuthenticatedActor, dependencies: UserRouteDependencies): void {
  dependencies.users.requireAdmin(actor.user)
}

function validationIssues(error: unknown): Array<{
  instancePath?: string
  params?: { missingProperty?: string }
  message?: string
}> | null {
  if (typeof error !== 'object' || error === null || !('validation' in error)) return null
  return Array.isArray(error.validation) ? error.validation : null
}

const createTokenBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['environmentId', 'name'],
  properties: {
    environmentId: { type: 'string', format: 'uuid' },
    name: { type: 'string', minLength: 1, maxLength: 64 },
    ttlSeconds: { type: 'integer', minimum: 300, maximum: 2_592_000 },
    reason: { type: 'string', minLength: 1, maxLength: 500 },
  },
} as const

const disableTokenBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['reason'],
  properties: {
    reason: { type: 'string', minLength: 1, maxLength: 500 },
    compromiseSuspected: { type: 'boolean' },
  },
} as const

const adminCreateTokenBodySchema = {
  ...createTokenBodySchema,
  required: ['environmentId', 'name', 'reason'],
} as const

const uuidIdParamsSchema = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const

export function registerUserRoutes(
  app: FastifyInstance,
  dependencies: UserRouteDependencies,
): void {
  void app.register(cookie)

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('X-Correlation-ID', request.id)
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    )
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Referrer-Policy', 'no-referrer')
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    return payload
  })

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) {
      const marketplaceError = {
        code: error.code,
        message: error.message,
        field: typeof error.details?.field === 'string' ? error.details.field : undefined,
        severity:
          error.details?.severity === 'WARNING' || error.details?.severity === 'ERROR'
            ? error.details.severity
            : 'ERROR',
        correlationId: request.id,
        details: error.details ?? {},
      }
      void reply.status(error.statusCode).send({
        code: error.code,
        message: error.message,
        retryable: error.statusCode >= 500,
        correlationId: request.id,
        details: error.details,
        error: marketplaceError,
      })
      return
    }
    const issues = validationIssues(error)
    if (issues) {
      const details = issues.map((issue) => ({
        field: issue.instancePath || issue.params?.missingProperty || '',
        message: issue.message,
      }))
      void reply.status(400).send({
        code: 'VALIDATION_FAILED',
        message: '请求参数不符合接口约束',
        retryable: false,
        correlationId: request.id,
        details,
        error: {
          code: 'VALIDATION_FAILED',
          message: '请求参数不符合接口约束',
          field: details[0]?.field ?? '',
          severity: 'ERROR',
          correlationId: request.id,
          details: { issues: details },
        },
      })
      return
    }
    request.log.error({ err: error }, 'request failed')
    void reply.status(500).send({
      code: 'INTERNAL_ERROR',
      message: '服务器内部错误',
      retryable: false,
      correlationId: request.id,
    })
  })

  app.get('/api/auth/status', async () => ({ mode: dependencies.config.auth.mode }))

  if (dependencies.config.auth.mode === 'development') {
    app.post(
      '/api/auth/development-login',
      {
        schema: {
          body: {
            type: 'object',
            additionalProperties: false,
            required: ['username'],
            properties: { username: { type: 'string', minLength: 1, maxLength: 64 } },
          },
        },
      },
      async (request, reply) => {
        const body = request.body as { username: string }
        const user = await dependencies.users.loginDevelopment(body.username)
        const session = await dependencies.sessions.create(user, true)
        setSessionCookies(reply, dependencies.config, session)
        await dependencies.store.appendAudit({
          actor: user,
          eventType: 'session.created',
          targetType: 'session',
          targetId: session.session.id,
          correlationId: request.id,
          payload: { mode: 'development' },
          occurredAt: session.session.createdAt,
        })
        return { user }
      },
    )
  }

  app.get('/api/auth/login', async (_request, reply) => {
    if (!dependencies.oidc)
      throw new DomainError('OIDC_NOT_CONFIGURED', 404, '当前未启用 OIDC 登录')
    const login = await dependencies.oidc.begin()
    reply.setCookie(oidcCookieName, login.transactionCookie, {
      ...cookieOptions(dependencies.config, true),
      maxAge: 10 * 60,
    })
    return reply.redirect(login.redirectUrl)
  })

  app.get('/api/auth/callback', async (request, reply) => {
    if (!dependencies.oidc)
      throw new DomainError('OIDC_NOT_CONFIGURED', 404, '当前未启用 OIDC 登录')
    const currentUrl = new URL(
      request.raw.url ?? '/api/auth/callback',
      dependencies.config.publicUrl,
    )
    const identity = await dependencies.oidc.complete(currentUrl, request.cookies[oidcCookieName])
    const user = await dependencies.users.loginOidc(identity.provider, identity.subject)
    const session = await dependencies.sessions.create(user, identity.mfaAuthenticated)
    setSessionCookies(reply, dependencies.config, session)
    reply.clearCookie(oidcCookieName, cookieOptions(dependencies.config, true))
    return reply.redirect(dependencies.config.publicUrl)
  })

  app.post('/api/auth/logout', async (request, reply) => {
    try {
      const actor = await actorFor(request, dependencies)
      csrfFor(request, actor, dependencies)
      await dependencies.sessions.revoke(actor)
    } finally {
      clearAuthCookies(reply, dependencies.config)
    }
    return reply.status(204).send()
  })

  app.get('/api/me', async (request) => {
    const actor = await actorFor(request, dependencies)
    return { user: actor.user }
  })

  app.get('/api/me/environments', async (request) => {
    const actor = await actorFor(request, dependencies)
    return { items: await dependencies.store.listEnvironmentsForUser(actor.user.id) }
  })

  app.get('/api/me/tokens', async (request) => {
    const actor = await actorFor(request, dependencies)
    return { items: await dependencies.tokens.list(actor.user.id) }
  })

  app.post(
    '/api/me/tokens',
    { schema: { body: createTokenBodySchema } },
    async (request, reply) => {
      const actor = await actorFor(request, dependencies)
      csrfFor(request, actor, dependencies)
      const body = request.body as { environmentId: string; name: string; ttlSeconds?: number }
      const idempotencyHeader = request.headers['idempotency-key']
      const result = await dependencies.tokens.issue({
        ownerUserId: actor.user.id,
        environmentId: body.environmentId,
        name: body.name,
        ttlSeconds: body.ttlSeconds,
        actor,
        idempotencyKey: Array.isArray(idempotencyHeader)
          ? idempotencyHeader[0]
          : (idempotencyHeader ?? ''),
        correlationId: request.id,
      })
      reply.header('Cache-Control', 'no-store, private')
      reply.header('Pragma', 'no-cache')
      reply.header('Referrer-Policy', 'no-referrer')
      return reply.status(result.replayed ? 200 : 201).send(result)
    },
  )

  app.post(
    '/api/me/tokens/:id/disable',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
        body: disableTokenBodySchema,
      },
    },
    async (request) => {
      const actor = await actorFor(request, dependencies)
      csrfFor(request, actor, dependencies)
      const { id } = request.params as { id: string }
      const body = request.body as { reason: string; compromiseSuspected?: boolean }
      return dependencies.tokens.disable({
        tokenId: id,
        ownerUserId: actor.user.id,
        actor,
        reason: body.reason,
        compromiseSuspected: body.compromiseSuspected ?? false,
        correlationId: request.id,
      })
    },
  )

  app.post(
    '/api/me/tokens/:id/purge-delivery',
    {
      schema: {
        params: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string', format: 'uuid' } },
        },
      },
    },
    async (request, reply) => {
      const actor = await actorFor(request, dependencies)
      csrfFor(request, actor, dependencies)
      await dependencies.tokens.purgeDelivery((request.params as { id: string }).id, actor)
      return reply.status(204).send()
    },
  )

  app.get(
    '/api/admin/users',
    {
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            search: { type: 'string', maxLength: 128 },
            role: { enum: ['USER', 'ADMIN'] },
            status: { enum: ['PENDING', 'ACTIVE', 'SUSPENDED', 'DELETED'] },
          },
        },
      },
    },
    async (request) => {
      const actor = await actorFor(request, dependencies)
      requireAdmin(actor, dependencies)
      const query = request.query as { search?: string; role?: string; status?: string }
      return {
        items: await dependencies.users.list({
          search: query.search,
          role: parseRole(query.role),
          status: parseStatus(query.status),
        }),
      }
    },
  )

  app.post(
    '/api/admin/users',
    {
      schema: {
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['username', 'displayName', 'systemRole', 'environmentIds'],
          properties: {
            username: { type: 'string', minLength: 1, maxLength: 64 },
            displayName: { type: 'string', minLength: 1, maxLength: 128 },
            email: {
              anyOf: [{ type: 'string', format: 'email', maxLength: 254 }, { type: 'null' }],
            },
            systemRole: { enum: ['USER', 'ADMIN'] },
            externalSubject: { type: 'string', maxLength: 255 },
            environmentIds: {
              type: 'array',
              uniqueItems: true,
              items: { type: 'string', format: 'uuid' },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const actor = await actorFor(request, dependencies)
      csrfFor(request, actor, dependencies)
      requireAdmin(actor, dependencies)
      const body = request.body as {
        username: string
        displayName: string
        email?: string | null
        systemRole: SystemRole
        externalSubject?: string
        environmentIds: string[]
      }
      const user = await dependencies.users.create(
        {
          username: body.username,
          displayName: body.displayName,
          email: body.email ?? null,
          systemRole: body.systemRole,
          authProvider:
            dependencies.config.auth.mode === 'oidc'
              ? dependencies.config.auth.providerName
              : 'development',
          externalSubject: body.externalSubject || body.username,
          environmentIds: body.environmentIds,
        },
        actor.user,
      )
      return reply.status(201).send({ user })
    },
  )

  app.get('/api/admin/users/:id', { schema: { params: uuidIdParamsSchema } }, async (request) => {
    const actor = await actorFor(request, dependencies)
    requireAdmin(actor, dependencies)
    const id = (request.params as { id: string }).id
    const user = await dependencies.users.getById(id)
    return {
      user,
      environments: await dependencies.store.listEnvironmentsForUser(id),
      tokens: await dependencies.tokens.list(id),
    }
  })

  app.patch(
    '/api/admin/users/:id',
    {
      schema: {
        params: uuidIdParamsSchema,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          required: ['revision'],
          properties: {
            displayName: { type: 'string', minLength: 1, maxLength: 128 },
            email: {
              anyOf: [{ type: 'string', format: 'email', maxLength: 254 }, { type: 'null' }],
            },
            systemRole: { enum: ['USER', 'ADMIN'] },
            status: { enum: ['PENDING', 'ACTIVE', 'SUSPENDED', 'DELETED'] },
            revision: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (request) => {
      const actor = await actorFor(request, dependencies)
      csrfFor(request, actor, dependencies)
      requireAdmin(actor, dependencies)
      const id = (request.params as { id: string }).id
      const body = request.body as {
        displayName?: string
        email?: string | null
        systemRole?: SystemRole
        status?: UserStatus
        revision: number
      }
      const user = await dependencies.users.update(
        id,
        {
          displayName: body.displayName,
          email: body.email,
          systemRole: body.systemRole,
          status: body.status,
          expectedRevision: body.revision,
        },
        actor.user,
      )
      return { user }
    },
  )

  app.post(
    '/api/admin/users/:id/tokens',
    { schema: { params: uuidIdParamsSchema, body: adminCreateTokenBodySchema } },
    async (request, reply) => {
      const actor = await actorFor(request, dependencies)
      csrfFor(request, actor, dependencies)
      requireAdmin(actor, dependencies)
      const body = request.body as {
        environmentId: string
        name: string
        ttlSeconds?: number
        reason?: string
      }
      const idempotencyHeader = request.headers['idempotency-key']
      const result = await dependencies.tokens.issue({
        ownerUserId: (request.params as { id: string }).id,
        environmentId: body.environmentId,
        name: body.name,
        ttlSeconds: body.ttlSeconds,
        reason: body.reason,
        actor,
        idempotencyKey: Array.isArray(idempotencyHeader)
          ? idempotencyHeader[0]
          : (idempotencyHeader ?? ''),
        correlationId: request.id,
      })
      reply.header('Cache-Control', 'no-store, private')
      return reply.status(result.replayed ? 200 : 201).send(result)
    },
  )

  app.post(
    '/api/admin/users/:userId/tokens/:tokenId/disable',
    {
      schema: {
        params: {
          type: 'object',
          required: ['userId', 'tokenId'],
          properties: {
            userId: { type: 'string', format: 'uuid' },
            tokenId: { type: 'string', format: 'uuid' },
          },
        },
        body: disableTokenBodySchema,
      },
    },
    async (request) => {
      const actor = await actorFor(request, dependencies)
      csrfFor(request, actor, dependencies)
      requireAdmin(actor, dependencies)
      const params = request.params as { userId: string; tokenId: string }
      const body = request.body as { reason: string; compromiseSuspected?: boolean }
      return dependencies.tokens.disable({
        tokenId: params.tokenId,
        ownerUserId: params.userId,
        actor,
        reason: body.reason,
        compromiseSuspected: body.compromiseSuspected ?? false,
        correlationId: request.id,
      })
    },
  )

  app.get('/api/admin/audit-events', async (request) => {
    const actor = await actorFor(request, dependencies)
    requireAdmin(actor, dependencies)
    return { items: await dependencies.store.listAuditEvents(100) }
  })
}
