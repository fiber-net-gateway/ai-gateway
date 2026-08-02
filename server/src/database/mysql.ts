import { createPool, type Pool } from 'mysql2/promise'

import type { MySqlConfig } from '../config/env.js'

export function createMySqlPool(config: MySqlConfig): Pool {
  return createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    connectionLimit: config.connectionLimit,
    supportBigNumbers: true,
    bigNumberStrings: true,
    timezone: 'Z',
  })
}
