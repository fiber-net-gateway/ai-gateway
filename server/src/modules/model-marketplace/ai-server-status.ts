export interface AiServerConfigResourceEvidence {
  dataId: string
  group: 'LLM-SERVER'
  md5: string
  version: number
}

export interface AiServerConfigStatus {
  schemaVersion: 1
  state: 'ACTIVE' | 'CATCHING_UP'
  generation: number
  workerIndex: number
  workers: {
    count: number
    converged: boolean
    generations: number[]
  }
  resources: AiServerConfigResourceEvidence[]
}

export interface AiServerConfigStatusReader {
  readonly instanceId: string
  read(): Promise<AiServerConfigStatus>
}

export class AiServerConfigStatusError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export class HttpAiServerConfigStatusReader implements AiServerConfigStatusReader {
  readonly instanceId: string

  constructor(
    baseUrl: string,
    private readonly fetcher: typeof fetch = globalThis.fetch,
    private readonly timeoutMillis = 3_000,
  ) {
    this.instanceId = baseUrl.replace(/\/$/u, '')
  }

  async read(): Promise<AiServerConfigStatus> {
    let response: Response
    try {
      response = await this.fetcher(`${this.instanceId}/internal/config/status`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMillis),
      })
    } catch {
      throw new AiServerConfigStatusError('AI_SERVER_UNAVAILABLE', 'ai-server 配置状态不可用')
    }
    if (!response.ok) {
      throw new AiServerConfigStatusError(
        'AI_SERVER_STATUS_REJECTED',
        `ai-server 配置状态返回 ${response.status}`,
      )
    }
    const body = (await response.json().catch(() => null)) as unknown
    if (!validStatus(body)) {
      throw new AiServerConfigStatusError(
        'AI_SERVER_STATUS_INVALID',
        'ai-server 配置状态响应不符合契约',
      )
    }
    return body
  }
}

function validStatus(value: unknown): value is AiServerConfigStatus {
  if (!value || typeof value !== 'object') return false
  const status = value as Partial<AiServerConfigStatus>
  if (
    status.schemaVersion !== 1 ||
    (status.state !== 'ACTIVE' && status.state !== 'CATCHING_UP') ||
    typeof status.generation !== 'number' ||
    !Number.isSafeInteger(status.generation) ||
    status.generation < 0 ||
    typeof status.workerIndex !== 'number' ||
    !Number.isSafeInteger(status.workerIndex) ||
    status.workerIndex < 0 ||
    !status.workers ||
    !Number.isSafeInteger(status.workers.count) ||
    status.workers.count < 1 ||
    status.workerIndex >= status.workers.count ||
    typeof status.workers.converged !== 'boolean' ||
    !Array.isArray(status.workers.generations) ||
    status.workers.generations.some(
      (generation) => !Number.isSafeInteger(generation) || generation < 0,
    ) ||
    status.workers.generations.length !== status.workers.count ||
    !Array.isArray(status.resources)
  ) {
    return false
  }
  const validResources = status.resources.every(
    (resource) =>
      resource &&
      typeof resource === 'object' &&
      typeof resource.dataId === 'string' &&
      resource.group === 'LLM-SERVER' &&
      typeof resource.md5 === 'string' &&
      /^[0-9a-f]{32}$/u.test(resource.md5) &&
      Number.isInteger(resource.version) &&
      resource.version >= -2_147_483_648 &&
      resource.version <= 2_147_483_647,
  )
  return (
    validResources &&
    new Set(status.resources.map((resource) => resource.dataId)).size === status.resources.length
  )
}
