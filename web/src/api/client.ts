export type SystemRole = 'USER' | 'ADMIN'
export type UserStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'DELETED'

export interface User {
  id: string
  username: string
  displayName: string
  email: string | null
  systemRole: SystemRole
  status: UserStatus
  authProvider: string
  externalSubject: string
  revision: number
  lastLoginAt: string | null
  createdAt: string
  updatedAt: string
}

export interface EnvironmentAccess {
  environment: {
    id: string
    name: string
    stage: 'development' | 'staging' | 'production'
    revision: number
  }
  access: {
    canIssueTokens: boolean
    maxTokenTtlSeconds: number | null
    maxActiveTokens: number | null
  }
  policy: {
    selfServiceEnabled: boolean
    minTtlSeconds: number
    defaultTtlSeconds: number
    maxTtlSeconds: number
    maxActiveTokensPerUser: number
    requireEffectiveKey: boolean
    deliveryTtlSeconds: number
  }
}

export interface TokenView {
  id: string
  name: string
  environmentId: string
  kid: string
  fingerprint: string
  issuedAt: string
  expiresAt: string
  acceptedUntil: string
  disabledAt: string | null
  compromiseSuspected: boolean
  state: 'ACTIVE' | 'GRACE' | 'EXPIRED' | 'DISABLED'
  lastUsedAt: string | null
}

export interface IssuedToken extends TokenView {
  username: string
  token: string
  deliveryExpiresAt: string
  replayed: boolean
  runtimeState: 'KEY_EFFECTIVE' | 'KEY_PUBLISHED_UNVERIFIED'
}

export interface AuditEvent {
  id: string
  sequenceNo: number
  actorUserId: string | null
  actorRole: SystemRole | null
  eventType: string
  targetType: string
  targetId: string | null
  environmentId: string | null
  correlationId: string
  reason: string | null
  payload: Record<string, unknown>
  occurredAt: string
}

export type LlmCallOutcome = 'SUCCEEDED' | 'FAILED' | 'ABORTED'

export interface LlmCallAudit {
  id: string
  requestId: string
  occurredAt: string
  receivedAt: string
  method: string
  path: string
  requestedModel: string
  clientProtocol: string
  stream: boolean
  responseStatus: number
  outcome: LlmCallOutcome
  durationMs: number
  usage: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  clientAborted: boolean
  captureComplete: boolean
  messageCount: number
  toolCount: number
  requestBodyBytes: number
  responseBodyBytes: number
}

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly correlationId?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
  }
}

export function readCookie(name: string): string | undefined {
  return document.cookie
    .split('; ')
    .find((entry) => entry.startsWith(`${name}=`))
    ?.slice(name.length + 1)
}

function createIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID()

  const bytes = new Uint8Array(16)
  if (typeof cryptoApi?.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes)
  } else {
    const timestamp = Date.now()
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256) ^ ((timestamp >> ((index % 6) * 8)) & 0xff)
    }
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const value = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`
}

async function performRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const method = init.method?.toUpperCase() ?? 'GET'
  const headers = new Headers(init.headers)
  if (init.body) headers.set('Content-Type', 'application/json')
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const csrf = readCookie('fg_csrf')
    if (csrf) headers.set('X-CSRF-Token', decodeURIComponent(csrf))
  }
  return fetch(path, { ...init, headers, credentials: 'same-origin' })
}

async function parseResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      code?: string
      message?: string
      correlationId?: string
      details?: Record<string, unknown>
      error?: {
        code?: string
        message?: string
        correlationId?: string
        details?: Record<string, unknown>
      }
    }
    throw new ApiError(
      body.error?.code ?? body.code ?? 'REQUEST_FAILED',
      body.error?.message ?? body.message ?? `请求失败（${response.status}）`,
      response.status,
      body.error?.correlationId ?? body.correlationId,
      body.error?.details ?? body.details,
    )
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  return parseResponse<T>(await performRequest(path, init))
}

export async function requestWithMetadata<T>(
  path: string,
  init: RequestInit = {},
): Promise<{ data: T; etag: string | null }> {
  const response = await performRequest(path, init)
  return { data: await parseResponse<T>(response), etag: response.headers.get('ETag') }
}

export const api = {
  authStatus: () => request<{ mode: 'development' | 'oidc' }>('/api/auth/status'),
  developmentLogin: (username: string) =>
    request<{ user: User }>('/api/auth/development-login', {
      method: 'POST',
      body: JSON.stringify({ username }),
    }),
  me: () => request<{ user: User }>('/api/me'),
  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),
  environments: () => request<{ items: EnvironmentAccess[] }>('/api/me/environments'),
  tokens: () => request<{ items: TokenView[] }>('/api/me/tokens'),
  issueToken: (body: { environmentId: string; name: string; ttlSeconds: number }) =>
    request<IssuedToken>('/api/me/tokens', {
      method: 'POST',
      headers: { 'Idempotency-Key': createIdempotencyKey() },
      body: JSON.stringify(body),
    }),
  disableToken: (id: string, reason: string, compromiseSuspected: boolean) =>
    request<TokenView & { runtimeEnforced: false; message: string }>(
      `/api/me/tokens/${id}/disable`,
      {
        method: 'POST',
        body: JSON.stringify({ reason, compromiseSuspected }),
      },
    ),
  purgeDelivery: (id: string) =>
    request<void>(`/api/me/tokens/${id}/purge-delivery`, { method: 'POST' }),
  users: (search = '') =>
    request<{ items: User[] }>(`/api/admin/users?search=${encodeURIComponent(search)}`),
  createUser: (body: {
    username: string
    displayName: string
    email: string | null
    systemRole: SystemRole
    externalSubject?: string
    environmentIds: string[]
  }) =>
    request<{ user: User }>('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  user: (id: string) =>
    request<{ user: User; environments: EnvironmentAccess[]; tokens: TokenView[] }>(
      `/api/admin/users/${id}`,
    ),
  updateUser: (
    id: string,
    body: Partial<Pick<User, 'displayName' | 'email' | 'systemRole' | 'status' | 'revision'>>,
  ) =>
    request<{ user: User }>(`/api/admin/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  issueUserToken: (
    id: string,
    body: { environmentId: string; name: string; ttlSeconds: number; reason: string },
  ) =>
    request<IssuedToken>(`/api/admin/users/${id}/tokens`, {
      method: 'POST',
      headers: { 'Idempotency-Key': createIdempotencyKey() },
      body: JSON.stringify(body),
    }),
  disableUserToken: (
    userId: string,
    tokenId: string,
    reason: string,
    compromiseSuspected: boolean,
  ) =>
    request<TokenView & { managementState: 'DISABLED'; runtimeEnforced: false; message: string }>(
      `/api/admin/users/${userId}/tokens/${tokenId}/disable`,
      {
        method: 'POST',
        body: JSON.stringify({ reason, compromiseSuspected }),
      },
    ),
  auditEvents: () => request<{ items: AuditEvent[] }>('/api/admin/audit-events'),
  llmCallAudits: (query: {
    environmentId: string
    cursor?: string
    limit?: number
    outcome?: LlmCallOutcome
    protocol?: string
    search?: string
  }) => {
    const parameters = new URLSearchParams({ environmentId: query.environmentId })
    if (query.cursor) parameters.set('cursor', query.cursor)
    if (query.limit) parameters.set('limit', String(query.limit))
    if (query.outcome) parameters.set('outcome', query.outcome)
    if (query.protocol) parameters.set('protocol', query.protocol)
    if (query.search) parameters.set('search', query.search)
    return request<{ items: LlmCallAudit[]; nextCursor: string | null }>(
      `/api/me/llm-call-audits?${parameters.toString()}`,
    )
  },
}
