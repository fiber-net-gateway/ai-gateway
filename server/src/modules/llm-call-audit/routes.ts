import type { FastifyInstance, FastifyRequest } from 'fastify'

import type { SessionService } from '../users/services.js'
import type { LlmCallAuditService } from './service.js'
import { auditIngestBodySchema, llmCallAuditListQuerySchema } from './schemas.js'
import type { AuditIngestEnvelope, LlmCallOutcome } from './types.js'

const sessionCookieName = 'fg_session'

interface Dependencies {
  audit: LlmCallAuditService
  sessions: SessionService
  bodyLimitBytes: number
}

function authorizationFor(request: FastifyRequest): string | undefined {
  const value = request.headers.authorization
  return Array.isArray(value) ? value[0] : value
}

export function registerLlmCallAuditRoutes(app: FastifyInstance, dependencies: Dependencies): void {
  app.post(
    '/api/internal/llm-call-audits/batches',
    {
      bodyLimit: dependencies.bodyLimitBytes,
      schema: { body: auditIngestBodySchema },
      onRequest: async (request) => {
        dependencies.audit.authenticate(authorizationFor(request))
      },
    },
    async (request, reply) => {
      const result = await dependencies.audit.ingest(request.body as AuditIngestEnvelope)
      return reply.status(202).send(result)
    },
  )

  app.get(
    '/api/me/llm-call-audits',
    { schema: { querystring: llmCallAuditListQuerySchema } },
    async (request, reply) => {
      const actor = await dependencies.sessions.authenticate(request.cookies[sessionCookieName])
      const query = request.query as {
        environmentId: string
        cursor?: string
        limit?: number
        from?: string
        to?: string
        outcome?: LlmCallOutcome
        protocol?: string
        search?: string
      }
      const result = await dependencies.audit.listForUser({ actor: actor.user, ...query })
      reply.header('Cache-Control', 'no-store, private')
      return result
    },
  )
}
