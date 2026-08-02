import Fastify, { type FastifyInstance } from 'fastify'

export interface BuildAppOptions {
  logger?: boolean
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false })

  app.get(
    '/api/hello',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            required: ['message', 'service'],
            properties: {
              message: { type: 'string' },
              service: { type: 'string' },
            },
          },
        },
      },
    },
    async () => ({
      message: 'Hello World!',
      service: 'ai-server-console-api',
    }),
  )

  return app
}
