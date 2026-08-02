export interface AppConfig {
  host: string
  port: number
  mysql: MySqlConfig
  rnacos: RnacosConfig
  aiServer: AiServerConfig
}

export interface MySqlConfig {
  host: string
  port: number
  user: string
  password: string
  database: string
  connectionLimit: number
}

export interface RnacosConfig {
  baseUrl: string
  namespaceId: string
  tenant: string
  username: string
  password: string
  configGroup: string
}

export interface AiServerConfig {
  baseUrl: string
}

function readString(name: string, fallback: string): string {
  return process.env[name]?.trim() || fallback
}

function readInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const rawValue = process.env[name]?.trim()
  const value = rawValue ? Number(rawValue) : fallback

  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }

  return value
}

function readHttpUrl(name: string, fallback: string): string {
  const value = readString(name, fallback)
  const url = new URL(value)

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must use http or https`)
  }

  return url.toString().replace(/\/$/, '')
}

export function loadConfig(): AppConfig {
  return {
    host: readString('APP_HOST', '0.0.0.0'),
    port: readInteger('APP_PORT', 3000, 1, 65_535),
    mysql: {
      host: readString('MYSQL_HOST', '127.0.0.1'),
      port: readInteger('MYSQL_PORT', 3306, 1, 65_535),
      user: readString('MYSQL_USER', 'ai_server_console'),
      password: process.env.MYSQL_PASSWORD ?? '',
      database: readString('MYSQL_DATABASE', 'ai_server_console'),
      connectionLimit: readInteger('MYSQL_CONNECTION_LIMIT', 10, 1, 100),
    },
    rnacos: {
      baseUrl: readHttpUrl('RNACOS_BASE_URL', 'http://127.0.0.1:8848'),
      namespaceId: readString('RNACOS_NAMESPACE_ID', 'public'),
      tenant: process.env.RNACOS_TENANT?.trim() ?? '',
      username: process.env.RNACOS_USERNAME?.trim() ?? '',
      password: process.env.RNACOS_PASSWORD ?? '',
      configGroup: readString('RNACOS_CONFIG_GROUP', 'LLM-SERVER'),
    },
    aiServer: {
      baseUrl: readHttpUrl('AI_SERVER_BASE_URL', 'http://127.0.0.1:8080'),
    },
  }
}
