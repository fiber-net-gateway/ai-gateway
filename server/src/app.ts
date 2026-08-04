import Fastify, { type FastifyInstance } from 'fastify'

import { type AppConfig, loadConfig } from './config/env.js'
import { OidcService } from './modules/auth/oidc-service.js'
import { MemoryModelAccessStore } from './modules/model-access/memory-store.js'
import { registerModelAccessRoutes } from './modules/model-access/routes.js'
import { ModelAccessService } from './modules/model-access/service.js'
import type { AccessGroupPublisher, ModelAccessStore } from './modules/model-access/types.js'
import { MemoryMarketplaceStore } from './modules/model-marketplace/memory-store.js'
import { registerModelMarketplaceRoutes } from './modules/model-marketplace/routes.js'
import { MemoryMarketplaceSecretService } from './modules/model-marketplace/secret-service.js'
import { ModelMarketplaceService } from './modules/model-marketplace/service.js'
import type {
  MarketplaceSecretService,
  MarketplaceStore,
} from './modules/model-marketplace/types.js'
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
  marketplaceStore?: MarketplaceStore
  marketplaceSecrets?: MarketplaceSecretService
  modelAccessStore?: ModelAccessStore
  accessGroupPublisher?: AccessGroupPublisher | null
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
  const marketplaceStore = options.marketplaceStore ?? new MemoryMarketplaceStore()
  const marketplaceSecrets =
    options.marketplaceSecrets ??
    new MemoryMarketplaceSecretService(cipher, config.security.encryptionKey)
  const modelAccessStore = options.modelAccessStore ?? new MemoryModelAccessStore()
  const app = Fastify({ logger: options.logger ?? false })

  const users = new UserService(store, clock)
  const sessions = new SessionService(store, clock, random)
  const tokens = new TokenService(store, clock, random, cipher)
  const oidc =
    config.auth.mode === 'oidc'
      ? new OidcService(config.auth, config.publicUrl, cipher, clock)
      : null
  const modelAccess = new ModelAccessService(
    modelAccessStore,
    marketplaceStore,
    store,
    clock,
    config.security.encryptionKey,
    options.accessGroupPublisher ?? null,
  )
  const marketplace = new ModelMarketplaceService(
    marketplaceStore,
    marketplaceSecrets,
    store,
    clock,
    random,
    config.security.encryptionKey,
    modelAccess,
  )

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
  registerModelMarketplaceRoutes(app, {
    marketplace,
    sessions,
    users,
    userStore: store,
  })
  registerModelAccessRoutes(app, {
    access: modelAccess,
    sessions,
    users,
    userStore: store,
  })

  return app
}
