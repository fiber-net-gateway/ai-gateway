import Fastify, { type FastifyInstance } from 'fastify'

import { type AppConfig, loadConfig } from './config/env.js'
import { OidcService } from './modules/auth/oidc-service.js'
import {
  type Clock,
  type RandomSource,
  systemClock,
  systemRandom,
  ValueCipher,
} from './modules/users/crypto.js'
import { MemoryUserStore } from './modules/users/memory-store.js'
import { registerUserRoutes } from './modules/users/routes.js'
import { SessionService, TokenService, UserService } from './modules/users/services.js'
import type { BootstrapInput, UserStore } from './modules/users/types.js'

export interface BuildAppOptions {
  logger?: boolean
  config?: AppConfig
  store?: UserStore
  clock?: Clock
  random?: RandomSource
  closeInfrastructure?: () => Promise<void>
}

export function createBootstrapInput(config: AppConfig, now: Date): BootstrapInput {
  const authProvider = config.auth.mode === 'oidc' ? config.auth.providerName : 'development'
  return {
    admin: {
      username: config.bootstrap.adminUsername,
      displayName: config.bootstrap.adminDisplayName,
      email: config.bootstrap.adminEmail,
      authProvider,
      externalSubject: config.bootstrap.adminExternalSubject,
    },
    environment: {
      id: config.bootstrap.environmentId,
      name: config.bootstrap.environmentName,
      stage: config.bootstrap.environmentStage,
    },
    policy: {
      environmentId: config.bootstrap.environmentId,
      selfServiceEnabled: true,
      minTtlSeconds: 300,
      defaultTtlSeconds: 3_600,
      maxTtlSeconds: 7 * 24 * 60 * 60,
      maxActiveTokensPerUser: 5,
      requireEffectiveKey: config.bootstrap.environmentStage === 'production',
      deliveryTtlSeconds: 5 * 60,
    },
    signingKey: {
      kid: config.bootstrap.bt1Kid,
      secret: Buffer.from(config.bootstrap.bt1Secret),
      keyState:
        config.bootstrap.environmentStage === 'production' ? 'PUBLISHED_UNVERIFIED' : 'ACTIVE',
      clockSkewSeconds: config.bootstrap.bt1ClockSkewSeconds,
    },
    now: now.toISOString(),
  }
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const config = options.config ?? loadConfig()
  const clock = options.clock ?? systemClock
  const random = options.random ?? systemRandom
  const store = options.store ?? new MemoryUserStore()
  const cipher = new ValueCipher(config.security.encryptionKey)
  const app = Fastify({ logger: options.logger ?? false })

  const users = new UserService(store, clock)
  const sessions = new SessionService(store, clock, random)
  const tokens = new TokenService(store, clock, random, cipher)
  const oidc =
    config.auth.mode === 'oidc'
      ? new OidcService(config.auth, config.publicUrl, cipher, clock)
      : null

  app.addHook('onReady', async () => {
    await store.bootstrap(createBootstrapInput(config, clock.now()))
  })

  if (options.closeInfrastructure) {
    app.addHook('onClose', options.closeInfrastructure)
  }

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

  registerUserRoutes(app, { config, store, users, sessions, tokens, oidc })

  return app
}
