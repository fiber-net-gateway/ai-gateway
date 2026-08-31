export type LlmCallOutcome = 'SUCCEEDED' | 'FAILED' | 'ABORTED'

interface AuditInputBase {
  event: 'llm_request'
  request_id: string
  auth_user: string
  requested_model: string
  client_protocol: string
  method: string
  path: string
  stream: boolean
  status: number
  duration_ms: number
  client_aborted?: boolean
  error_json?: string
  capture_complete?: boolean
  message_count?: number
  tool_count?: number
  request_body_bytes?: number
  response_body_bytes?: number
  [key: string]: unknown
}

export interface V5AuditInput extends AuditInputBase {
  schema_version: 5
  usage_json: {
    promptTokens: number
    completionTokens: number
    total_tokens: number
  }
}

export interface V6AuditInput extends AuditInputBase {
  schema_version: 6
  usage_json: {
    in_cache: number | null
    in_nocache: number | null
    out: number | null
  }
}

export type LlmAuditInput = V5AuditInput | V6AuditInput

export interface AuditIngestEnvelope {
  schemaVersion: 1
  instanceId: string
  sentAt: string
  records: Array<{
    occurredAt: string
    audit: LlmAuditInput
  }>
}

export interface NewLlmCallAuditRecord {
  id: string
  eventKey: string
  environmentId: string
  ownerUserId: string | null
  subjectUsername: string
  sourceInstanceId: string
  sourceRequestId: string
  sourceSchemaVersion: 5 | 6
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
  inCacheTokens: number | null
  inNoCacheTokens: number | null
  outTokens: number | null
  promptTokens: number | null
  completionTokens: number | null
  totalTokens: number | null
  clientAborted: boolean
  captureComplete: boolean
  messageCount: number
  toolCount: number
  requestBodyBytes: number
  responseBodyBytes: number
  errorCode: string
}

export interface LlmCallAuditRecord extends NewLlmCallAuditRecord {}

export interface LlmCallAuditCursor {
  occurredAt: string
  id: string
}

export interface LlmCallAuditListQuery {
  environmentId: string
  ownerUserId: string
  limit: number
  cursor?: LlmCallAuditCursor
  from?: string
  to?: string
  outcome?: LlmCallOutcome
  protocol?: string
  search?: string
}

export interface LlmCallAuditView {
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
    inCache: number | null
    inNoCache: number | null
    out: number | null
    promptTokens: number | null
    completionTokens: number | null
    totalTokens: number | null
  }
  clientAborted: boolean
  captureComplete: boolean
  messageCount: number
  toolCount: number
  requestBodyBytes: number
  responseBodyBytes: number
}

export interface LlmCallAuditStore {
  appendBatch(records: NewLlmCallAuditRecord[]): Promise<{
    accepted: number
    duplicates: number
  }>
  listForOwner(query: LlmCallAuditListQuery): Promise<LlmCallAuditRecord[]>
}
