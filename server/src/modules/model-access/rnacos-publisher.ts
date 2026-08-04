import { createHash, timingSafeEqual } from 'node:crypto'

import type { AccessGroupPublisher, RnacosPublisherOptions } from './types.js'

export class AccessGroupPublisherError extends Error {
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

export class RnacosAccessGroupPublisher implements AccessGroupPublisher {
  private token: CachedToken | null = null

  constructor(private readonly options: RnacosPublisherOptions) {
    if (options.configGroup !== 'LLM-SERVER') {
      throw new Error('RNACOS_CONFIG_GROUP must be LLM-SERVER')
    }
    if (Boolean(options.username) !== Boolean(options.password)) {
      throw new Error('RNACOS_USERNAME and RNACOS_PASSWORD must both be empty or both be set')
    }
  }

  async publish(input: {
    group: 'LLM-SERVER'
    dataId: string
    content: string
    expectedMd5: string
  }): Promise<{ readbackMd5: string }> {
    if (input.group !== this.options.configGroup) {
      throw new AccessGroupPublisherError('RNACOS_TARGET_INVALID', 'rnacos 配置组不合法')
    }
    const accessToken = await this.accessToken()
    const form = this.parameters(input.dataId, accessToken)
    form.set('content', input.content)
    form.set('type', 'json')
    let response: Response
    try {
      response = await fetch(`${this.options.baseUrl}/nacos/v1/cs/configs`, {
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
      throw new AccessGroupPublisherError('RNACOS_AUTH_FAILED', 'rnacos 拒绝了发布身份')
    }
    if (!response.ok || result.trim() !== 'true') {
      throw new AccessGroupPublisherError('RNACOS_WRITE_REJECTED', 'rnacos 拒绝写入用户组配置')
    }

    const query = this.parameters(input.dataId, accessToken)
    let readback: Response
    try {
      readback = await fetch(`${this.options.baseUrl}/nacos/v1/cs/configs?${query}`, {
        signal: AbortSignal.timeout(this.options.timeoutMillis ?? 10_000),
      })
    } catch (error) {
      throw this.networkError(error)
    }
    if (readback.status === 401 || readback.status === 403) {
      this.token = null
      throw new AccessGroupPublisherError('RNACOS_AUTH_FAILED', 'rnacos 拒绝了回读身份')
    }
    if (!readback.ok) {
      throw new AccessGroupPublisherError('RNACOS_READ_FAILED', 'rnacos 用户组配置回读失败')
    }
    const content = await readback.text()
    const readbackMd5 = createHash('md5').update(content, 'utf8').digest('hex')
    const expected = Buffer.from(input.expectedMd5, 'hex')
    const actual = Buffer.from(readbackMd5, 'hex')
    if (
      expected.length !== actual.length ||
      expected.length === 0 ||
      !timingSafeEqual(expected, actual)
    ) {
      throw new AccessGroupPublisherError(
        'RNACOS_READBACK_MISMATCH',
        'rnacos 回读内容与审批目标不一致',
      )
    }
    return { readbackMd5 }
  }

  private parameters(dataId: string, accessToken: string | null): URLSearchParams {
    const parameters = new URLSearchParams({
      dataId,
      group: 'LLM-SERVER',
    })
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
      response = await fetch(`${this.options.baseUrl}/nacos/v1/auth/users/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: AbortSignal.timeout(this.options.timeoutMillis ?? 10_000),
      })
    } catch (error) {
      throw this.networkError(error)
    }
    if (!response.ok) {
      throw new AccessGroupPublisherError('RNACOS_AUTH_FAILED', 'rnacos 登录失败')
    }
    const body = (await response.json().catch(() => null)) as {
      accessToken?: unknown
      tokenTtl?: unknown
    } | null
    if (!body || typeof body.accessToken !== 'string' || !body.accessToken) {
      throw new AccessGroupPublisherError('RNACOS_AUTH_FAILED', 'rnacos 登录响应不合法')
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

  private networkError(error: unknown): AccessGroupPublisherError {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      return new AccessGroupPublisherError('RNACOS_TIMEOUT', 'rnacos 请求超时')
    }
    return new AccessGroupPublisherError('RNACOS_UNAVAILABLE', 'rnacos 暂时不可用')
  }
}
