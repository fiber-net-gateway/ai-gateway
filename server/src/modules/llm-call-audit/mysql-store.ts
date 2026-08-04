import type { Pool, RowDataPacket } from 'mysql2/promise'

import type {
  LlmCallAuditListQuery,
  LlmCallAuditRecord,
  LlmCallAuditStore,
  NewLlmCallAuditRecord,
} from './types.js'

interface LlmCallAuditRow extends RowDataPacket {
  id: string
  event_key: string
  environment_id: string
  owner_user_id: string | null
  subject_username: string
  source_instance_id: string
  source_request_id: string
  source_schema_version: number
  occurred_at: Date
  received_at: Date
  method: string
  request_path: string
  requested_model: string
  client_protocol: string
  is_stream: number
  response_status: number
  outcome: LlmCallAuditRecord['outcome']
  duration_ms: string | number
  prompt_tokens: string | number
  completion_tokens: string | number
  total_tokens: string | number
  client_aborted: number
  capture_complete: number
  message_count: number
  tool_count: number
  request_body_bytes: string | number
  response_body_bytes: string | number
  error_code: string
}

const auditSelect = `
  SELECT BIN_TO_UUID(id) AS id, HEX(event_key) AS event_key,
    BIN_TO_UUID(environment_id) AS environment_id, BIN_TO_UUID(owner_user_id) AS owner_user_id,
    subject_username, source_instance_id, source_request_id, source_schema_version,
    occurred_at, received_at, method, request_path, requested_model, client_protocol,
    is_stream, response_status, outcome, duration_ms, prompt_tokens, completion_tokens,
    total_tokens, client_aborted, capture_complete, message_count, tool_count,
    request_body_bytes, response_body_bytes, error_code
  FROM llm_call_audits`

function date(value: string): Date {
  return new Date(value)
}

function isDuplicateError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'ER_DUP_ENTRY'
  )
}

function mapRow(row: LlmCallAuditRow): LlmCallAuditRecord {
  return {
    id: row.id,
    eventKey: row.event_key.toLowerCase(),
    environmentId: row.environment_id,
    ownerUserId: row.owner_user_id,
    subjectUsername: row.subject_username,
    sourceInstanceId: row.source_instance_id,
    sourceRequestId: row.source_request_id,
    sourceSchemaVersion: row.source_schema_version,
    occurredAt: row.occurred_at.toISOString(),
    receivedAt: row.received_at.toISOString(),
    method: row.method,
    path: row.request_path,
    requestedModel: row.requested_model,
    clientProtocol: row.client_protocol,
    stream: Boolean(row.is_stream),
    responseStatus: row.response_status,
    outcome: row.outcome,
    durationMs: Number(row.duration_ms),
    promptTokens: Number(row.prompt_tokens),
    completionTokens: Number(row.completion_tokens),
    totalTokens: Number(row.total_tokens),
    clientAborted: Boolean(row.client_aborted),
    captureComplete: Boolean(row.capture_complete),
    messageCount: row.message_count,
    toolCount: row.tool_count,
    requestBodyBytes: Number(row.request_body_bytes),
    responseBodyBytes: Number(row.response_body_bytes),
    errorCode: row.error_code,
  }
}

function escapeLike(value: string): string {
  return value.replace(/[=%_]/gu, (character) => `=${character}`)
}

export class MySqlLlmCallAuditStore implements LlmCallAuditStore {
  constructor(private readonly pool: Pool) {}

  async appendBatch(records: NewLlmCallAuditRecord[]) {
    const connection = await this.pool.getConnection()
    let accepted = 0
    let duplicates = 0
    try {
      await connection.beginTransaction()
      for (const record of records) {
        try {
          await connection.query(
            `INSERT INTO llm_call_audits
              (id, event_key, environment_id, owner_user_id, subject_username,
               source_instance_id, source_request_id, source_schema_version, occurred_at,
               received_at, method, request_path, requested_model, client_protocol, is_stream,
               response_status, outcome, duration_ms, prompt_tokens, completion_tokens,
               total_tokens, client_aborted, capture_complete, message_count, tool_count,
               request_body_bytes, response_body_bytes, error_code)
             VALUES
              (UUID_TO_BIN(?), UNHEX(?), UUID_TO_BIN(?), UUID_TO_BIN(?), ?, ?, ?, ?, ?, ?, ?, ?,
               ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              record.id,
              record.eventKey,
              record.environmentId,
              record.ownerUserId,
              record.subjectUsername,
              record.sourceInstanceId,
              record.sourceRequestId,
              record.sourceSchemaVersion,
              date(record.occurredAt),
              date(record.receivedAt),
              record.method,
              record.path,
              record.requestedModel,
              record.clientProtocol,
              record.stream,
              record.responseStatus,
              record.outcome,
              record.durationMs,
              record.promptTokens,
              record.completionTokens,
              record.totalTokens,
              record.clientAborted,
              record.captureComplete,
              record.messageCount,
              record.toolCount,
              record.requestBodyBytes,
              record.responseBodyBytes,
              record.errorCode,
            ],
          )
          accepted += 1
        } catch (error) {
          if (!isDuplicateError(error)) throw error
          duplicates += 1
        }
      }
      await connection.commit()
      return { accepted, duplicates }
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async listForOwner(query: LlmCallAuditListQuery): Promise<LlmCallAuditRecord[]> {
    const clauses = ['environment_id = UUID_TO_BIN(?)', 'owner_user_id = UUID_TO_BIN(?)']
    const parameters: unknown[] = [query.environmentId, query.ownerUserId]
    if (query.cursor) {
      clauses.push('(occurred_at < ? OR (occurred_at = ? AND id < UUID_TO_BIN(?)))')
      parameters.push(date(query.cursor.occurredAt), date(query.cursor.occurredAt), query.cursor.id)
    }
    if (query.from) {
      clauses.push('occurred_at >= ?')
      parameters.push(date(query.from))
    }
    if (query.to) {
      clauses.push('occurred_at <= ?')
      parameters.push(date(query.to))
    }
    if (query.outcome) {
      clauses.push('outcome = ?')
      parameters.push(query.outcome)
    }
    if (query.protocol) {
      clauses.push('client_protocol = ?')
      parameters.push(query.protocol)
    }
    if (query.search) {
      clauses.push(
        `(source_request_id LIKE ? ESCAPE '='
          OR request_path LIKE ? ESCAPE '='
          OR requested_model LIKE ? ESCAPE '=')`,
      )
      const pattern = `%${escapeLike(query.search)}%`
      parameters.push(pattern, pattern, pattern)
    }
    parameters.push(query.limit)
    const [rows] = await this.pool.query<LlmCallAuditRow[]>(
      `${auditSelect}
       WHERE ${clauses.join(' AND ')}
       ORDER BY occurred_at DESC, id DESC
       LIMIT ?`,
      parameters,
    )
    return rows.map(mapRow)
  }
}
