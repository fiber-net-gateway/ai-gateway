import { randomUUID } from 'node:crypto'

import { loadDemoBootstrapConfig } from './config/demo.js'

interface EnvironmentAccess {
  environment: { id: string; name: string }
}

interface ProviderSummary {
  id: string
  displayName: string
  baseUrl: string
  protocols: ProviderProtocol[]
}

interface ProviderProtocol {
  type: 'OPENAI_CHAT_COMPLETIONS' | 'ANTHROPIC_MESSAGES'
  path: string
  upstreamModelName: string
}

interface ModelSummary {
  id: string
  logicalModelName: string
}

interface Release {
  id: string
  releaseNumber: number
  state: 'PENDING' | 'PUBLISHING' | 'COMPLETED' | 'FAILED' | 'CANCELLED'
  publicationState: 'NEVER' | 'PUBLISHED' | 'PARTIAL' | 'FAILED' | 'DRIFTED'
}

class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

class ConsoleClient {
  private readonly cookies = new Map<string, string>()

  constructor(private readonly baseUrl: string) {}

  async request<T>(
    path: string,
    init: RequestInit = {},
  ): Promise<{ data: T; etag: string | null }> {
    const method = init.method?.toUpperCase() ?? 'GET'
    const headers = new Headers(init.headers)
    const cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
    if (cookie) headers.set('Cookie', cookie)
    if (init.body) headers.set('Content-Type', 'application/json')
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      const csrf = this.cookies.get('fg_csrf')
      if (csrf) headers.set('X-CSRF-Token', decodeURIComponent(csrf))
    }
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(10_000),
    })
    for (const header of response.headers.getSetCookie()) {
      const pair = header.split(';', 1)[0]
      const separator = pair.indexOf('=')
      if (separator > 0) this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1))
    }
    const body = (await response.json().catch(() => null)) as
      (T & { code?: string; message?: string }) | null
    if (!response.ok) {
      throw new ApiRequestError(
        response.status,
        body?.code ?? 'REQUEST_FAILED',
        body?.message ?? `request failed with ${response.status}`,
      )
    }
    return { data: body as T, etag: response.headers.get('ETag') }
  }
}

const config = loadDemoBootstrapConfig()
const client = new ConsoleClient(config.consoleUrl)
const deadline = Date.now() + config.timeoutMillis
const demoProviderProtocols: ProviderProtocol[] = [
  {
    type: 'OPENAI_CHAT_COMPLETIONS',
    path: '/v1/chat/completions',
    upstreamModelName: 'fiber-demo-upstream',
  },
  {
    type: 'ANTHROPIC_MESSAGES',
    path: '/v1/messages',
    upstreamModelName: 'fiber-demo-upstream',
  },
]

function demoProviderMutation() {
  return {
    displayName: 'Fiber Demo Provider',
    baseUrl: config.providerBaseUrl,
    protocols: demoProviderProtocols,
    authentication: {
      mode: 'NO_CREDENTIALS',
      tokens: [],
      confirmUnauthenticated: true,
    },
    confirmProviderImpact: true,
  }
}

function demoProviderIsCurrent(provider: ProviderSummary): boolean {
  return (
    provider.baseUrl === config.providerBaseUrl &&
    provider.protocols.length === demoProviderProtocols.length &&
    demoProviderProtocols.every((expected) =>
      provider.protocols.some(
        (actual) =>
          actual.type === expected.type &&
          actual.path === expected.path &&
          actual.upstreamModelName === expected.upstreamModelName,
      ),
    )
  )
}

function log(message: string): void {
  process.stdout.write(`[demo-bootstrap] ${message}\n`)
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function retry<T>(label: string, operation: () => Promise<T>): Promise<T> {
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      return await operation()
    } catch (error) {
      lastError = error
      if (error instanceof ApiRequestError && error.status < 500) throw error
      await delay(1_000)
    }
  }
  throw new Error(
    `${label} timed out: ${lastError instanceof Error ? lastError.message : 'unknown error'}`,
  )
}

async function waitForRelease(environmentId: string, releaseId: string): Promise<Release> {
  while (Date.now() < deadline) {
    const release = (
      await client.request<Release>(`/api/environments/${environmentId}/releases/${releaseId}`)
    ).data
    if (release.state !== 'PENDING' && release.state !== 'PUBLISHING') return release
    await delay(1_000)
  }
  throw new Error(`Release ${releaseId} did not reach a terminal state`)
}

async function executeUntilPublished(environmentId: string, initial: Release): Promise<Release> {
  let release = initial
  while (Date.now() < deadline) {
    if (release.state === 'COMPLETED' && release.publicationState === 'PUBLISHED') return release
    if (release.state === 'CANCELLED')
      throw new Error(`Release #${release.releaseNumber} was cancelled`)
    if (release.state === 'PENDING' || release.state === 'FAILED') {
      const action = release.state === 'FAILED' ? 'retry' : 'execute'
      release = (
        await client.request<Release>(
          `/api/environments/${environmentId}/releases/${release.id}/${action}`,
          { method: 'POST' },
        )
      ).data
    }
    release = await waitForRelease(environmentId, release.id)
    if (release.state === 'FAILED') await delay(1_000)
  }
  throw new Error(`Release #${release.releaseNumber} could not be published`)
}

async function main(): Promise<void> {
  await retry('console login', () =>
    client.request('/api/auth/development-login', {
      method: 'POST',
      body: JSON.stringify({ username: config.username }),
    }),
  )
  const environments = (
    await client.request<{ items: EnvironmentAccess[] }>('/api/me/environments')
  ).data.items
  const environmentId = environments[0]?.environment.id
  if (!environmentId) throw new Error('bootstrap administrator has no environment')

  await retry('BT1 Key Ring publication', () =>
    client.request(`/api/environments/${environmentId}/bt1-key-ring/publish`, { method: 'POST' }),
  )
  log('BT1 Key Ring published and read back')

  let changed = false
  let providers = await client.request<{
    items: ProviderSummary[]
    draft: { id: string; revision: number }
  }>(`/api/environments/${environmentId}/providers`)
  let provider = providers.data.items.find((item) => item.displayName === 'Fiber Demo Provider')
  if (!provider) {
    provider = (
      await client.request<ProviderSummary>(
        `/api/environments/${environmentId}/drafts/${providers.data.draft.id}/providers`,
        {
          method: 'POST',
          headers: {
            'If-Match': providers.etag ?? `"${providers.data.draft.revision}"`,
            'Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify(demoProviderMutation()),
        },
      )
    ).data
    changed = true
    log(`created demo Provider ${provider.id}`)
  } else if (!demoProviderIsCurrent(provider)) {
    provider = (
      await client.request<{ provider: ProviderSummary }>(
        `/api/environments/${environmentId}/drafts/${providers.data.draft.id}/providers/${provider.id}`,
        {
          method: 'PATCH',
          headers: { 'If-Match': providers.etag ?? `"${providers.data.draft.revision}"` },
          body: JSON.stringify(demoProviderMutation()),
        },
      )
    ).data.provider
    changed = true
    log(`updated demo Provider ${provider.id}`)
  }

  let models = await client.request<{
    items: ModelSummary[]
    draft: { id: string; revision: number }
  }>(`/api/environments/${environmentId}/models?view=admin`)
  let model = models.data.items.find((item) => item.logicalModelName === 'fiber-demo')
  if (!model) {
    model = (
      await client.request<ModelSummary>(
        `/api/environments/${environmentId}/drafts/${models.data.draft.id}/models`,
        {
          method: 'POST',
          headers: {
            'If-Match': models.etag ?? `"${models.data.draft.revision}"`,
            'Idempotency-Key': randomUUID(),
          },
          body: JSON.stringify({
            displayName: 'Fiber Demo Model',
            logicalModelName: 'fiber-demo',
            description: 'Docker Compose 内置的 OpenAI/Anthropic-compatible 演示模型',
            tags: ['demo', 'local'],
            providers: [{ providerId: provider.id, routeRole: 'PRIMARY', sortOrder: 0 }],
            accessMode: 'ALL_AUTHENTICATED',
            loadBalance: {
              prefixMaxBytes: 2_048,
              maxPrimaryAttempts: 1,
              fallbackEnabled: false,
              retryableStatuses: [429, 500, 502, 503, 504],
            },
            rateLimit: null,
          }),
        },
      )
    ).data
    changed = true
    log(`created demo model ${model.id}`)
  }

  const releases = (
    await client.request<{ items: Release[] }>(`/api/environments/${environmentId}/releases`)
  ).data.items
  const successful = releases.find(
    (release) => release.state === 'COMPLETED' && release.publicationState === 'PUBLISHED',
  )
  let active = releases.find(
    (release) => release.state === 'PENDING' || release.state === 'PUBLISHING',
  )
  active ??= releases.find((release) => release.state === 'FAILED')
  if (!changed && successful) {
    log(`Release #${successful.releaseNumber} is already published`)
    return
  }
  if (!active) {
    models = await client.request<{
      items: ModelSummary[]
      draft: { id: string; revision: number }
    }>(`/api/environments/${environmentId}/models?view=admin`)
    const validation = (
      await client.request<{ valid: boolean; issues: unknown[] }>(
        `/api/environments/${environmentId}/drafts/${models.data.draft.id}/validate`,
        { method: 'POST' },
      )
    ).data
    if (!validation.valid)
      throw new Error(`demo draft has ${validation.issues.length} blocking issues`)
    active = (
      await client.request<{ release: Release }>(
        `/api/environments/${environmentId}/drafts/${models.data.draft.id}/submit`,
        {
          method: 'POST',
          headers: { 'If-Match': models.etag ?? `"${models.data.draft.revision}"` },
        },
      )
    ).data.release
    log(`created Release #${active.releaseNumber}`)
  }
  const published = await executeUntilPublished(environmentId, active)
  log(`Release #${published.releaseNumber} published and read back`)
}

main().catch((error) => {
  process.stderr.write(
    `[demo-bootstrap] failed: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  )
  process.exitCode = 1
})
