import { randomUUID } from 'node:crypto'

import type { Clock } from '../users/crypto.js'
import { constantTimeEqual, sha256Hex } from '../users/crypto.js'
import { DomainError } from '../users/errors.js'
import type { UserRecord, UserStore } from '../users/types.js'
import { projectAudit } from './projection.js'
import type {
  AuditIngestEnvelope,
  LlmCallAuditCursor,
  LlmCallAuditStore,
  LlmCallAuditView,
  LlmCallOutcome,
} from './types.js'

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

function encodeCursor(cursor: LlmCallAuditCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url')
}

function decodeCursor(value: string | undefined): LlmCallAuditCursor | undefined {
  if (!value) return undefined
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    if (typeof decoded !== 'object' || decoded === null) throw new Error('invalid cursor')
    const cursor = decoded as Record<string, unknown>
    if (
      typeof cursor.occurredAt !== 'string' ||
      !Number.isFinite(Date.parse(cursor.occurredAt)) ||
      typeof cursor.id !== 'string' ||
      !uuidPattern.test(cursor.id)
    ) {
      throw new Error('invalid cursor')
    }
    return { occurredAt: new Date(cursor.occurredAt).toISOString(), id: cursor.id }
  } catch {
    throw new DomainError('INVALID_CURSOR', 400, '分页游标不合法')
  }
}

function toView(
  record: Awaited<ReturnType<LlmCallAuditStore['listForOwner']>>[number],
): LlmCallAuditView {
  const add = (...values: Array<number | null>): number | null => {
    if (values.some((value) => value === null)) return null
    const sum = values.reduce<number>((total, value) => total + (value ?? 0), 0)
    return Number.isSafeInteger(sum) ? sum : null
  }
  const componentPromptTokens = add(record.inCacheTokens, record.inNoCacheTokens)
  const componentTotalTokens = add(record.inCacheTokens, record.inNoCacheTokens, record.outTokens)
  const out = record.outTokens ?? record.completionTokens
  return {
    id: record.id,
    requestId: record.sourceRequestId,
    occurredAt: record.occurredAt,
    receivedAt: record.receivedAt,
    method: record.method,
    path: record.path,
    requestedModel: record.requestedModel,
    clientProtocol: record.clientProtocol,
    stream: record.stream,
    responseStatus: record.responseStatus,
    outcome: record.outcome,
    durationMs: record.durationMs,
    usage: {
      inCache: record.inCacheTokens,
      inNoCache: record.inNoCacheTokens,
      out,
      promptTokens: componentPromptTokens ?? record.promptTokens,
      completionTokens: out,
      totalTokens: componentTotalTokens ?? record.totalTokens,
    },
    clientAborted: record.clientAborted,
    captureComplete: record.captureComplete,
    messageCount: record.messageCount,
    toolCount: record.toolCount,
    requestBodyBytes: record.requestBodyBytes,
    responseBodyBytes: record.responseBodyBytes,
  }
}

export class LlmCallAuditService {
  constructor(
    private readonly store: LlmCallAuditStore,
    private readonly users: UserStore,
    private readonly clock: Clock,
    private readonly environmentId: string,
    private readonly ingestToken: string,
  ) {}

  authenticate(authorization: string | undefined): void {
    if (!this.ingestToken) {
      throw new DomainError('AUDIT_INGEST_DISABLED', 503, '调用审计上报入口未启用')
    }
    const match = authorization?.match(/^Bearer ([^\s]+)$/iu)
    const actual = match?.[1] ?? ''
    const valid = constantTimeEqual(sha256Hex(actual), sha256Hex(this.ingestToken))
    if (!valid) {
      throw new DomainError('AUDIT_INGEST_UNAUTHORIZED', 401, '调用审计上报凭据无效')
    }
  }

  async ingest(input: AuditIngestEnvelope) {
    const receivedAt = this.clock.now().toISOString()
    for (const record of input.records) {
      if (
        Buffer.byteLength(record.audit.auth_user, 'utf8') > 64 ||
        /[\u0000-\u001f\u007f]/u.test(record.audit.auth_user)
      ) {
        throw new DomainError(
          'VALIDATION_FAILED',
          422,
          '审计 username 必须为 1..64 字节且不能包含控制字符',
        )
      }
    }
    const usernames = [...new Set(input.records.map((record) => record.audit.auth_user))]
    const owners = new Map<string, string | null>()
    await Promise.all(
      usernames.map(async (username) => {
        const user = await this.users.getUserByUsername(username)
        owners.set(username, user?.id ?? null)
      }),
    )
    const records = input.records.map((record) =>
      projectAudit({
        id: randomUUID(),
        environmentId: this.environmentId,
        ownerUserId: owners.get(record.audit.auth_user) ?? null,
        instanceId: input.instanceId,
        occurredAt: record.occurredAt,
        receivedAt,
        audit: record.audit,
      }),
    )
    return this.store.appendBatch(records)
  }

  async listForUser(input: {
    actor: UserRecord
    environmentId: string
    cursor?: string
    limit?: number
    from?: string
    to?: string
    outcome?: LlmCallOutcome
    protocol?: string
    search?: string
  }): Promise<{ items: LlmCallAuditView[]; nextCursor: string | null }> {
    const environments = await this.users.listEnvironmentsForUser(input.actor.id)
    if (!environments.some((item) => item.environment.id === input.environmentId)) {
      throw new DomainError('ENVIRONMENT_NOT_FOUND', 404, '环境不存在或无权访问')
    }
    const from = input.from ? new Date(input.from).toISOString() : undefined
    const to = input.to ? new Date(input.to).toISOString() : undefined
    if (from && to && from > to) {
      throw new DomainError('INVALID_TIME_RANGE', 422, '开始时间不能晚于结束时间')
    }
    const pageSize = input.limit ?? 25
    const rows = await this.store.listForOwner({
      environmentId: input.environmentId,
      ownerUserId: input.actor.id,
      limit: pageSize + 1,
      cursor: decodeCursor(input.cursor),
      from,
      to,
      outcome: input.outcome,
      protocol: input.protocol,
      search: input.search?.trim() || undefined,
    })
    const hasMore = rows.length > pageSize
    const page = hasMore ? rows.slice(0, pageSize) : rows
    const last = page.at(-1)
    return {
      items: page.map(toView),
      nextCursor:
        hasMore && last ? encodeCursor({ occurredAt: last.occurredAt, id: last.id }) : null,
    }
  }
}
