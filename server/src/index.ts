import 'dotenv/config'

import { buildApp } from './app.js'
import { loadConfig } from './config/env.js'
import { runMigrations } from './database/migrate.js'
import { createMySqlPool } from './database/mysql.js'
import { ValueCipher } from './modules/users/crypto.js'
import { MySqlMarketplaceStore } from './modules/model-marketplace/mysql-store.js'
import { MySqlMarketplaceSecretService } from './modules/model-marketplace/secret-service.js'
import { MemoryUserStore } from './modules/users/memory-store.js'
import { MySqlUserStore } from './modules/users/mysql-store.js'
import { MySqlModelAccessStore } from './modules/model-access/mysql-store.js'
import { MySqlLlmCallAuditStore } from './modules/llm-call-audit/mysql-store.js'
import { RnacosAccessGroupPublisher } from './modules/model-access/rnacos-publisher.js'
import { RnacosConfigClient } from './modules/rnacos/config-client.js'

const config = loadConfig()
const pool = config.dataMode === 'mysql' ? createMySqlPool(config.mysql) : null

if (pool) await runMigrations(pool)

const store = pool
  ? new MySqlUserStore(pool, new ValueCipher(config.security.encryptionKey))
  : new MemoryUserStore()
const marketplaceStore = pool ? new MySqlMarketplaceStore(pool) : undefined
const marketplaceSecrets = pool
  ? new MySqlMarketplaceSecretService(
      pool,
      new ValueCipher(config.security.encryptionKey),
      config.security.encryptionKey,
    )
  : undefined
const modelAccessStore = pool ? new MySqlModelAccessStore(pool) : undefined
const llmCallAuditStore = pool ? new MySqlLlmCallAuditStore(pool) : undefined
const rnacosClient = pool ? new RnacosConfigClient(config.rnacos) : undefined
const accessGroupPublisher =
  pool && rnacosClient ? new RnacosAccessGroupPublisher(config.rnacos, rnacosClient) : undefined
const app = buildApp({
  config,
  store,
  marketplaceStore,
  marketplaceSecrets,
  modelAccessStore,
  llmCallAuditStore,
  accessGroupPublisher,
  marketplacePublisher: rnacosClient,
  logger: true,
  closeInfrastructure: pool ? () => pool.end() : undefined,
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close()
  })
}

try {
  await app.listen({ host: config.host, port: config.port })
} catch (error) {
  app.log.error(error)
  await app.close()
  process.exitCode = 1
}
