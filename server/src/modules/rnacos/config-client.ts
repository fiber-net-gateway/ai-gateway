import { createHash, timingSafeEqual } from 'node:crypto'

import type { RnacosConfig } from '../../config/env.js'

export interface RnacosConfigRead {
  state: 'PRESENT' | 'NOT_FOUND'
  content: string | null
  md5: string | null
}

export interface RnacosTargetView {
  environmentId: string
  namespaceId: string
  tenant: string
  group: 'LLM-SERVER'
}

export class RnacosConfigError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

interface CachedToken {
  value: string
  refreshAt: number
}

export interface MarketplaceConfigPublisher {
  target(): RnacosTargetView
  read(input: {
    environmentId: string
    group: 'LLM-SERVER'
    dataId: string
  }): Promise<RnacosConfigRead>
  publish(input: {
    environmentId: string
    group: 'LLM-SERVER'
    dataId: string
    content: string
    expectedMd5: string
    expectedOldMd5: string | null
  }): Promise<{ readbackMd5: string }>
}

export class RnacosConfigClient implements MarketplaceConfigPublisher {
  private token: CachedToken | null = null

  constructor(
    private readonly options: RnacosConfig & { timeoutMillis?: number },
    private readonly fetcher: typeof fetch = globalThis.fetch,
  ) {
    if (options.configGroup !== 'LLM-SERVER') {
      throw new Error('RNACOS_CONFIG_GROUP must be LLM-SERVER')
    }
    if (Boolean(options.username) !== Boolean(options.password)) {
      throw new Error('RNACOS_USERNAME and RNACOS_PASSWORD must both be empty or both be set')
    }
  }

  target(): RnacosTargetView {
    return {
      environmentId: this.options.environmentId,
      namespaceId: this.options.namespaceId,
      tenant: this.options.tenant,
      group: 'LLM-SERVER',
    }
  }

  async read(input: {
    environmentId: string
    group: 'LLM-SERVER'
    dataId: string
  }): Promise<RnacosConfigRead> {
    this.assertTarget(input)
    const accessToken = await this.accessToken()
    const query = this.parameters(input.dataId, accessToken)
    let response: Response
    try {
      response = await this.fetcher(`${this.options.baseUrl}/nacos/v1/cs/configs?${query}`, {
        signal: AbortSignal.timeout(this.options.timeoutMillis ?? 10_000),
      })
    } catch (error) {
      throw this.networkError(error)
    }
    if (response.status === 404) return { state: 'NOT_FOUND', content: null, md5: null }
    if (response.status === 401 || response.status === 403) {
      this.token = null
      throw new RnacosConfigError('RNACOS_AUTH_FAILED', 'rnacos 拒绝了回读身份')
    }
    if (!response.ok) {
      throw new RnacosConfigError('RNACOS_READ_FAILED', 'rnacos 配置回读失败')
    }
    const content = await response.text()
    return {
      state: 'PRESENT',
      content,
      md5: createHash('md5').update(content, 'utf8').digest('hex'),
    }
  }

  async publish(input: {
    environmentId: string
    group: 'LLM-SERVER'
    dataId: string
    content: string
    expectedMd5: string
    expectedOldMd5: string | null
  }): Promise<{ readbackMd5: string }> {
    this.assertTarget(input)
    const accessToken = await this.accessToken()
    const form = this.parameters(input.dataId, accessToken)
    form.set('content', input.content)
    form.set('type', 'json')
    if (input.expectedOldMd5) form.set('casMd5', input.expectedOldMd5)
    let response: Response
    try {
      response = await this.fetcher(`${this.options.baseUrl}/nacos/v1/cs/configs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: AbortSignal.timeout(this.options.timeoutMillis ?? 10_000),
      })
    } catch (error) {
      throw this.networkError(error)
    }
    const result = await response.text()
    if (response.status === 401 || response.status === 403) {
      this.token = null
      throw new RnacosConfigError('RNACOS_AUTH_FAILED', 'rnacos 拒绝了发布身份')
    }
    if (!response.ok) {
      throw new RnacosConfigError('RNACOS_WRITE_REJECTED', 'rnacos 拒绝写入配置')
    }
    if (result.trim() !== 'true') {
      const current = await this.read(input)
      if (current.md5 && sameHex(input.expectedMd5, current.md5)) {
        return { readbackMd5: current.md5 }
      }
      if (input.expectedOldMd5 && (!current.md5 || !sameHex(input.expectedOldMd5, current.md5))) {
        throw new RnacosConfigError('RNACOS_CAS_CONFLICT', 'rnacos 配置在发布期间发生漂移')
      }
      throw new RnacosConfigError('RNACOS_WRITE_REJECTED', 'rnacos 拒绝写入配置')
    }

    const readback = await this.read(input)
    if (!readback.md5 || !sameHex(input.expectedMd5, readback.md5)) {
      throw new RnacosConfigError('RNACOS_READBACK_MISMATCH', 'rnacos 回读内容与发布目标不一致')
    }
    return { readbackMd5: readback.md5 }
  }

  private assertTarget(input: {
    environmentId: string
    group: 'LLM-SERVER'
    dataId: string
  }): void {
    if (input.environmentId !== this.options.environmentId) {
      throw new RnacosConfigError(
        'RNACOS_ENVIRONMENT_UNBOUND',
        '当前环境没有绑定到本进程的 rnacos 目标',
      )
    }
    if (input.group !== this.options.configGroup || !allowedDataId(input.dataId)) {
      throw new RnacosConfigError('RNACOS_TARGET_INVALID', 'rnacos 配置目标不合法')
    }
  }

  private parameters(dataId: string, accessToken: string | null): URLSearchParams {
    const parameters = new URLSearchParams({ dataId, group: 'LLM-SERVER' })
    const tenant =
      this.options.tenant || (this.options.namespaceId === 'public' ? '' : this.options.namespaceId)
    if (tenant) parameters.set('tenant', tenant)
    if (accessToken) parameters.set('accessToken', accessToken)
    return parameters
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
      throw new RnacosConfigError('RNACOS_AUTH_FAILED', 'rnacos 登录失败')
    }
    const body = (await response.json().catch(() => null)) as {
      accessToken?: unknown
      tokenTtl?: unknown
    } | null
    if (!body || typeof body.accessToken !== 'string' || !body.accessToken) {
      throw new RnacosConfigError('RNACOS_AUTH_FAILED', 'rnacos 登录响应不合法')
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

  private networkError(error: unknown): RnacosConfigError {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      return new RnacosConfigError('RNACOS_TIMEOUT', 'rnacos 请求超时')
    }
    return new RnacosConfigError('RNACOS_UNAVAILABLE', 'rnacos 暂时不可用')
  }
}

function allowedDataId(dataId: string): boolean {
  return (
    dataId === 'ploto.ai-llm.models' ||
    dataId === 'ploto.ai-llm.auth.bt1.keys' ||
    /^ploto\.ai-llm\.provider\.[A-Za-z0-9_-]{1,128}$/u.test(dataId) ||
    /^ploto\.ai-llm\.user-group\.[A-Za-z0-9_-]{1,128}$/u.test(dataId)
  )
}

function sameHex(left: string, right: string): boolean {
  const expected = Buffer.from(left, 'hex')
  const actual = Buffer.from(right, 'hex')
  return (
    expected.length > 0 && expected.length === actual.length && timingSafeEqual(expected, actual)
  )
}
