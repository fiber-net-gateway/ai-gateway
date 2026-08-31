import { sha256Hex } from '../users/crypto.js'
import type { LlmAuditInput, LlmCallOutcome, NewLlmCallAuditRecord } from './types.js'

function outcomeFor(audit: LlmAuditInput): LlmCallOutcome {
  if (audit.client_aborted === true) return 'ABORTED'
  if (audit.status >= 200 && audit.status < 400 && !audit.error_json) return 'SUCCEEDED'
  return 'FAILED'
}

function optionalCount(value: number | undefined): number {
  return value ?? 0
}

export function projectAudit(input: {
  id: string
  environmentId: string
  ownerUserId: string | null
  instanceId: string
  occurredAt: string
  receivedAt: string
  audit: LlmAuditInput
}): NewLlmCallAuditRecord {
  const { audit } = input
  const usage =
    audit.schema_version === 5
      ? {
          inCacheTokens: null,
          inNoCacheTokens: null,
          outTokens: null,
          promptTokens: audit.usage_json.promptTokens,
          completionTokens: audit.usage_json.completionTokens,
          totalTokens: audit.usage_json.total_tokens,
        }
      : {
          inCacheTokens: audit.usage_json.in_cache,
          inNoCacheTokens: audit.usage_json.in_nocache,
          outTokens: audit.usage_json.out,
          promptTokens: null,
          completionTokens: null,
          totalTokens: null,
        }
  return {
    id: input.id,
    eventKey: sha256Hex(`${input.environmentId}\0${input.instanceId}\0${audit.request_id}`),
    environmentId: input.environmentId,
    ownerUserId: input.ownerUserId,
    subjectUsername: audit.auth_user,
    sourceInstanceId: input.instanceId,
    sourceRequestId: audit.request_id,
    sourceSchemaVersion: audit.schema_version,
    occurredAt: new Date(input.occurredAt).toISOString(),
    receivedAt: input.receivedAt,
    method: audit.method,
    path: audit.path,
    requestedModel: audit.requested_model,
    clientProtocol: audit.client_protocol,
    stream: audit.stream,
    responseStatus: audit.status,
    outcome: outcomeFor(audit),
    durationMs: audit.duration_ms,
    ...usage,
    clientAborted: audit.client_aborted ?? false,
    captureComplete: audit.capture_complete ?? true,
    messageCount: optionalCount(audit.message_count),
    toolCount: optionalCount(audit.tool_count),
    requestBodyBytes: optionalCount(audit.request_body_bytes),
    responseBodyBytes: optionalCount(audit.response_body_bytes),
    errorCode: (audit.error_json ?? '').slice(0, 256),
  }
}
