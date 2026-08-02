export interface AppConfig {
  host: string
  port: number
  publicUrl: string
  dataMode: 'memory' | 'mysql'
  mysql: MySqlConfig
  rnacos: RnacosConfig
  aiServer: AiServerConfig
  auth: AuthConfig
  security: SecurityConfig
  bootstrap: BootstrapConfig
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

export type AuthConfig =
  | {
      mode: 'development'
    }
  | {
      mode: 'oidc'
      issuer: string
      clientId: string
      clientSecret: string
      scopes: string
      providerName: string
    }

export interface SecurityConfig {
  encryptionKey: Buffer
  cookieSecure: boolean
}

export interface BootstrapConfig {
  adminUsername: string
  adminDisplayName: string
  adminEmail: string | null
  adminExternalSubject: string
  environmentId: string
  environmentName: string
  environmentStage: 'development' | 'staging' | 'production'
  bt1Kid: string
  bt1Secret: Buffer
  bt1ClockSkewSeconds: number
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

function readBoolean(name: string, fallback: boolean): boolean {
  const rawValue = process.env[name]?.trim().toLowerCase()
  if (!rawValue) return fallback
  if (rawValue === 'true' || rawValue === '1') return true
  if (rawValue === 'false' || rawValue === '0') return false
  throw new Error(`${name} must be true or false`)
}

function readEnum<const T extends readonly string[]>(
  name: string,
  values: T,
  fallback: T[number],
): T[number] {
  const value = readString(name, fallback)
  if (!values.includes(value)) {
    throw new Error(`${name} must be one of ${values.join(', ')}`)
  }
  return value
}

function readBase64Key(name: string, fallback: string): Buffer {
  const value = process.env[name]?.trim() || fallback
  const decoded = Buffer.from(value, 'base64')
  if (
    decoded.length !== 32 ||
    decoded.toString('base64').replace(/=+$/u, '') !== value.replace(/=+$/u, '')
  ) {
    throw new Error(`${name} must be standard Base64 for exactly 32 bytes`)
  }
  return decoded
}

function loadAuthConfig(): AuthConfig {
  const mode = readEnum('AUTH_MODE', ['development', 'oidc'] as const, 'development')
  if (mode === 'development') return { mode }
  const issuer = readString('OIDC_ISSUER', '')
  const clientId = readString('OIDC_CLIENT_ID', '')
  if (!issuer || !clientId) {
    throw new Error('OIDC_ISSUER and OIDC_CLIENT_ID are required when AUTH_MODE=oidc')
  }
  return {
    mode,
    issuer,
    clientId,
    clientSecret: process.env.OIDC_CLIENT_SECRET ?? '',
    scopes: readString('OIDC_SCOPES', 'openid profile email'),
    providerName: readString('OIDC_PROVIDER_NAME', 'enterprise-oidc'),
  }
}

export function loadConfig(): AppConfig {
  const dataMode = readEnum('APP_DATA_MODE', ['memory', 'mysql'] as const, 'memory')
  const production = process.env.NODE_ENV === 'production'
  if (production && dataMode !== 'mysql') {
    throw new Error('APP_DATA_MODE=mysql is required when NODE_ENV=production')
  }
  if (production && !process.env.APP_ENCRYPTION_KEY?.trim()) {
    throw new Error('APP_ENCRYPTION_KEY is required when NODE_ENV=production')
  }

  return {
    host: readString('APP_HOST', '0.0.0.0'),
    port: readInteger('APP_PORT', 3000, 1, 65_535),
    publicUrl: readHttpUrl('APP_PUBLIC_URL', 'http://localhost:5173'),
    dataMode,
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
    auth: loadAuthConfig(),
    security: {
      encryptionKey: readBase64Key(
        'APP_ENCRYPTION_KEY',
        'REREREREREREREREREREREREREREREREREREREREREQ=',
      ),
      cookieSecure: readBoolean('AUTH_COOKIE_SECURE', false),
    },
    bootstrap: {
      adminUsername: readString('BOOTSTRAP_ADMIN_USERNAME', 'admin'),
      adminDisplayName: readString('BOOTSTRAP_ADMIN_DISPLAY_NAME', '平台管理员'),
      adminEmail: process.env.BOOTSTRAP_ADMIN_EMAIL?.trim() || null,
      adminExternalSubject: readString('BOOTSTRAP_ADMIN_EXTERNAL_SUBJECT', 'admin'),
      environmentId: readString('BOOTSTRAP_ENVIRONMENT_ID', '00000000-0000-4000-8000-000000000001'),
      environmentName: readString('BOOTSTRAP_ENVIRONMENT_NAME', '本地开发环境'),
      environmentStage: readEnum(
        'BOOTSTRAP_ENVIRONMENT_STAGE',
        ['development', 'staging', 'production'] as const,
        'development',
      ),
      bt1Kid: readString('BOOTSTRAP_BT1_KID', 'dev-key'),
      bt1Secret: readBase64Key(
        'BOOTSTRAP_BT1_SECRET_BASE64',
        'QkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkI=',
      ),
      bt1ClockSkewSeconds: readInteger('BOOTSTRAP_BT1_CLOCK_SKEW_SECONDS', 60, 0, 300),
    },
  }
}
