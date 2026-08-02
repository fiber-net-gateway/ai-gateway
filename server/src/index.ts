import 'dotenv/config'

import { buildApp } from './app.js'
import { loadConfig } from './config/env.js'

const config = loadConfig()
const app = buildApp({ logger: true })

try {
  await app.listen({ host: config.host, port: config.port })
} catch (error) {
  app.log.error(error)
  process.exitCode = 1
}
