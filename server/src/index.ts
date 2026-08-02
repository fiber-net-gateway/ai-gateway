import 'dotenv/config'

import { buildApp } from './app.js'
import { loadConfig } from './config/env.js'
import { runMigrations } from './database/migrate.js'
import { createMySqlPool } from './database/mysql.js'
import { ValueCipher } from './modules/users/crypto.js'
import { MemoryUserStore } from './modules/users/memory-store.js'
import { MySqlUserStore } from './modules/users/mysql-store.js'

const config = loadConfig()
const pool = config.dataMode === 'mysql' ? createMySqlPool(config.mysql) : null

if (pool) await runMigrations(pool)

const store = pool
  ? new MySqlUserStore(pool, new ValueCipher(config.security.encryptionKey))
  : new MemoryUserStore()
const app = buildApp({
  config,
  store,
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
