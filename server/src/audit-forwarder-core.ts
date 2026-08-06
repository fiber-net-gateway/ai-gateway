export interface ForwardedAuditRecord {
  occurredAt: string
  audit: Record<string, unknown>
}

export interface AuditScanResult {
  records: ForwardedAuditRecord[]
  commitOffset: number
  incompleteTail: boolean
  skipped: number
}

const optionalBooleanFields = ['client_aborted', 'capture_complete'] as const

const optionalIntegerFields = [
  'message_count',
  'tool_count',
  'request_body_bytes',
  'response_body_bytes',
] as const

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isBoundedText(value: unknown, minimum: number, maximum: number): value is string {
  return (
    typeof value === 'string' &&
    Buffer.byteLength(value, 'utf8') >= minimum &&
    Buffer.byteLength(value, 'utf8') <= maximum
  )
}

function projectedAudit(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const input = value as Record<string, unknown>
  if (input.schema_version !== 5 || input.event !== 'llm_request') return null
  if (
    !isBoundedText(input.request_id, 1, 1024) ||
    !isBoundedText(input.auth_user, 1, 64) ||
    /[\u0000-\u001f\u007f]/u.test(input.auth_user) ||
    !isBoundedText(input.requested_model, 0, 255) ||
    !isBoundedText(input.client_protocol, 1, 32) ||
    !isBoundedText(input.method, 1, 16) ||
    !/^[A-Za-z]+$/u.test(input.method) ||
    !isBoundedText(input.path, 1, 2048)
  ) {
    return null
  }
  if (
    typeof input.stream !== 'boolean' ||
    !isNonNegativeInteger(input.status) ||
    input.status > 999 ||
    !isNonNegativeInteger(input.duration_ms) ||
    typeof input.usage_json !== 'object' ||
    input.usage_json === null ||
    Array.isArray(input.usage_json)
  ) {
    return null
  }
  const usage = input.usage_json as Record<string, unknown>
  if (
    !isNonNegativeInteger(usage.promptTokens) ||
    !isNonNegativeInteger(usage.completionTokens) ||
    !isNonNegativeInteger(usage.total_tokens)
  ) {
    return null
  }
  const result: Record<string, unknown> = {
    schema_version: 5,
    event: 'llm_request',
    request_id: input.request_id,
    auth_user: input.auth_user,
    requested_model: input.requested_model,
    client_protocol: input.client_protocol,
    method: input.method,
    path: input.path,
    stream: input.stream,
    status: input.status,
    duration_ms: input.duration_ms,
    usage_json: {
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      total_tokens: usage.total_tokens,
    },
  }
  for (const field of optionalBooleanFields) {
    if (typeof input[field] === 'boolean') result[field] = input[field]
  }
  for (const field of optionalIntegerFields) {
    if (isNonNegativeInteger(input[field])) result[field] = input[field]
  }
  if (typeof input.error_json === 'string') result.error_json = input.error_json.slice(0, 256)
  return result
}

export function scanAuditBuffer(
  buffer: Buffer,
  startOffset: number,
  maxRecords: number,
  observedAt: Date,
): AuditScanResult {
  const records: ForwardedAuditRecord[] = []
  let cursor = 0
  let skipped = 0
  while (records.length < maxRecords) {
    const newline = buffer.indexOf(0x0a, cursor)
    if (newline < 0) break
    const lineEnd = newline + 1
    const line = buffer.subarray(cursor, newline)
    cursor = lineEnd
    if (line.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line.toString('utf8')) as unknown
    } catch {
      skipped += 1
      continue
    }
    const audit = projectedAudit(parsed)
    if (!audit) {
      skipped += 1
      continue
    }
    const duration = typeof audit.duration_ms === 'number' ? Math.max(audit.duration_ms, 0) : 0
    records.push({
      occurredAt: new Date(observedAt.getTime() - duration).toISOString(),
      audit,
    })
  }
  return {
    records,
    commitOffset: startOffset + cursor,
    incompleteTail: cursor < buffer.length,
    skipped,
  }
}
