export type LlmCallOutcome = 'SUCCEEDED' | 'FAILED' | 'ABORTED'

export interface V5AuditInput {
  schema_version: 5
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
  usage_json: {
    promptTokens: number
    completionTokens: number
    total_tokens: number
  }
  client_aborted?: boolean
  error_json?: string
  capture_complete?: boolean
  message_count?: number
  tool_count?: number
  request_body_bytes?: number
  response_body_bytes?: number
  [key: string]: unknown
}

export interface AuditIngestEnvelope {
  schemaVersion: 1
  instanceId: string
  sentAt: string
  records: Array<{
    occurredAt: string
    audit: V5AuditInput
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
  sourceSchemaVersion: number
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
  promptTokens: number
  completionTokens: number
  totalTokens: number
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

export interface LlmCallAuditStore {
  appendBatch(records: NewLlmCallAuditRecord[]): Promise<{
    accepted: number
    duplicates: number
  }>
  listForOwner(query: LlmCallAuditListQuery): Promise<LlmCallAuditRecord[]>
}
