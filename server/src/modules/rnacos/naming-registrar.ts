import type { RnacosConfig, RnacosRegistrationConfig } from '../../config/env.js'

interface Logger {
  info(message: string): void
  warn(message: string): void
}

interface CachedToken {
  value: string
  refreshAt: number
}

export class RnacosNamingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export class RnacosNamingHttpClient {
  private token: CachedToken | null = null

  constructor(
    private readonly options: RnacosConfig & { timeoutMillis?: number },
    private readonly fetcher: typeof fetch = globalThis.fetch,
  ) {
    if (Boolean(options.username) !== Boolean(options.password)) {
      throw new Error('RNACOS_USERNAME and RNACOS_PASSWORD must both be empty or both be set')
    }
  }

  async register(instance: RnacosRegistrationConfig): Promise<void> {
    await this.request('POST', '/nacos/v1/ns/instance', this.instanceParameters(instance))
  }

  async heartbeat(instance: RnacosRegistrationConfig): Promise<number | null> {
    const groupedServiceName = `${instance.serviceGroup}@@${instance.serviceName}`
    const parameters = this.baseParameters(instance)
    parameters.set('serviceName', groupedServiceName)
    parameters.set(
      'beat',
      JSON.stringify({
        ip: instance.advertiseAddress,
        port: instance.advertisePort,
        serviceName: groupedServiceName,
        cluster: instance.clusterName,
        weight: 1,
        scheduled: false,
        metadata: { protocol: 'http', auditSchema: '1' },
      }),
    )
    const body = await this.request('PUT', '/nacos/v1/ns/instance/beat', parameters)
    const decoded = JSON.parse(body || '{}') as { clientBeatInterval?: unknown }
    return typeof decoded.clientBeatInterval === 'number' && decoded.clientBeatInterval >= 1_000
      ? decoded.clientBeatInterval
      : null
  }

  async deregister(instance: RnacosRegistrationConfig): Promise<void> {
    await this.request('DELETE', '/nacos/v1/ns/instance', this.instanceParameters(instance))
  }

  private baseParameters(instance: RnacosRegistrationConfig): URLSearchParams {
    return new URLSearchParams({
      namespaceId: this.options.namespaceId,
      groupName: instance.serviceGroup,
    })
  }

  private instanceParameters(instance: RnacosRegistrationConfig): URLSearchParams {
    const parameters = this.baseParameters(instance)
    parameters.set('serviceName', `${instance.serviceGroup}@@${instance.serviceName}`)
    parameters.set('ip', instance.advertiseAddress)
    parameters.set('port', String(instance.advertisePort))
    parameters.set('clusterName', instance.clusterName)
    parameters.set('weight', '1')
    parameters.set('enabled', 'true')
    parameters.set('healthy', 'true')
    parameters.set('ephemeral', 'true')
    parameters.set('metadata', JSON.stringify({ protocol: 'http', auditSchema: '1' }))
    return parameters
  }

  private async request(
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    parameters: URLSearchParams,
  ): Promise<string> {
    const accessToken = await this.accessToken()
    if (accessToken) parameters.set('accessToken', accessToken)
    let response: Response
    try {
      response = await this.fetcher(`${this.options.baseUrl}${path}`, {
        method,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: parameters,
        signal: AbortSignal.timeout(this.options.timeoutMillis ?? 10_000),
      })
    } catch (error) {
      throw this.networkError(error)
    }
    if (response.status === 401 || response.status === 403) {
      this.token = null
      throw new RnacosNamingError('RNACOS_NAMING_AUTH_FAILED', 'rnacos 拒绝了服务注册身份')
    }
    if (!response.ok) {
      throw new RnacosNamingError('RNACOS_NAMING_REJECTED', 'rnacos 拒绝了服务注册请求')
    }
    return response.text()
  }

  private async accessToken(): Promise<string | null> {
    if (!this.options.username) return null
    if (this.token && Date.now() < this.token.refreshAt) return this.token.value
    const form = new URLSearchParams({
      username: this.options.username,
      password: this.options.password,
    })
    let response: Response
    try {
      response = await this.fetcher(`${this.options.baseUrl}/nacos/v1/auth/users/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: AbortSignal.timeout(this.options.timeoutMillis ?? 10_000),
      })
    } catch (error) {
      throw this.networkError(error)
    }
    if (!response.ok) {
      throw new RnacosNamingError('RNACOS_NAMING_AUTH_FAILED', 'rnacos 登录失败')
    }
    const body = (await response.json().catch(() => null)) as {
      accessToken?: unknown
      tokenTtl?: unknown
    } | null
    if (!body || typeof body.accessToken !== 'string' || !body.accessToken) {
      throw new RnacosNamingError('RNACOS_NAMING_AUTH_FAILED', 'rnacos 登录响应不合法')
    }
    const ttl =
      typeof body.tokenTtl === 'number' && Number.isFinite(body.tokenTtl)
        ? Math.max(body.tokenTtl, 1)
        : 30
    this.token = {
      value: body.accessToken,
      refreshAt: Date.now() + Math.max(ttl * 800, 500),
    }
    return this.token.value
  }

  private networkError(error: unknown): RnacosNamingError {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      return new RnacosNamingError('RNACOS_NAMING_TIMEOUT', 'rnacos 服务注册请求超时')
    }
    return new RnacosNamingError('RNACOS_NAMING_UNAVAILABLE', 'rnacos 服务注册暂时不可用')
  }
}

export class RnacosNamingRegistrar {
  private stopping = false
  private timer: NodeJS.Timeout | null = null
  private timerResolve: (() => void) | null = null
  private running: Promise<void> | null = null
  private closing: Promise<void> | null = null

  constructor(
    private readonly instance: RnacosRegistrationConfig,
    private readonly client: RnacosNamingHttpClient,
    private readonly logger: Logger,
  ) {}

  start(): void {
    if (this.running || !this.instance.enabled) return
    this.running = this.run()
  }

  async close(): Promise<void> {
    this.closing ??= this.closeOnce()
    await this.closing
  }

  private async closeOnce(): Promise<void> {
    this.stopping = true
    if (this.timer) clearTimeout(this.timer)
    this.timerResolve?.()
    await this.running
    if (!this.instance.enabled) return
    try {
      await this.client.deregister(this.instance)
      this.logger.info('console-api 已从 rnacos 注销')
    } catch {
      this.logger.warn('console-api 从 rnacos 注销失败')
    }
  }

  private async run(): Promise<void> {
    let registered = false
    let interval = this.instance.heartbeatIntervalMillis
    let failures = 0
    while (!this.stopping) {
      try {
        if (!registered) {
          await this.client.register(this.instance)
          registered = true
          this.logger.info('console-api 已注册到 rnacos')
        } else {
          interval = (await this.client.heartbeat(this.instance)) ?? interval
        }
        failures = 0
      } catch {
        registered = false
        failures += 1
        this.logger.warn(`console-api rnacos 注册/心跳失败（第 ${failures} 次）`)
      }
      const delay =
        failures === 0
          ? interval
          : Math.min(this.instance.heartbeatIntervalMillis * 2 ** Math.min(failures, 5), 30_000)
      await this.delay(delay)
    }
  }

  private async delay(milliseconds: number): Promise<void> {
    if (this.stopping) return
    await new Promise<void>((resolve) => {
      this.timerResolve = resolve
      this.timer = setTimeout(resolve, milliseconds)
      this.timer.unref()
    })
    this.timer = null
    this.timerResolve = null
  }
}
