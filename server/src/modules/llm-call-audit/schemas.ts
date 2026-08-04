const safeIntegerMaximum = Number.MAX_SAFE_INTEGER

const nonNegativeInteger = {
  type: 'integer',
  minimum: 0,
  maximum: safeIntegerMaximum,
} as const

export const auditIngestBodySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['schemaVersion', 'instanceId', 'sentAt', 'records'],
  properties: {
    schemaVersion: { const: 1 },
    instanceId: {
      type: 'string',
      minLength: 1,
      maxLength: 128,
      pattern: '^[A-Za-z0-9._:-]+$',
    },
    sentAt: { type: 'string', format: 'date-time' },
    records: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['occurredAt', 'audit'],
        properties: {
          occurredAt: { type: 'string', format: 'date-time' },
          audit: {
            type: 'object',
            additionalProperties: true,
            required: [
              'schema_version',
              'event',
              'request_id',
              'auth_user',
              'requested_model',
              'client_protocol',
              'method',
              'path',
              'stream',
              'status',
              'duration_ms',
              'usage_json',
            ],
            properties: {
              schema_version: { const: 5 },
              event: { const: 'llm_request' },
              request_id: { type: 'string', minLength: 1, maxLength: 1024 },
              auth_user: { type: 'string', minLength: 1, maxLength: 64 },
              requested_model: { type: 'string', maxLength: 255 },
              client_protocol: { type: 'string', minLength: 1, maxLength: 32 },
              method: {
                type: 'string',
                minLength: 1,
                maxLength: 16,
                pattern: '^[A-Za-z]+$',
              },
              path: { type: 'string', minLength: 1, maxLength: 2048 },
              stream: { type: 'boolean' },
              status: { type: 'integer', minimum: 0, maximum: 999 },
              duration_ms: nonNegativeInteger,
              usage_json: {
                type: 'object',
                additionalProperties: true,
                required: ['promptTokens', 'completionTokens', 'total_tokens'],
                properties: {
                  promptTokens: nonNegativeInteger,
                  completionTokens: nonNegativeInteger,
                  total_tokens: nonNegativeInteger,
                },
              },
              client_aborted: { type: 'boolean' },
              error_json: { type: 'string' },
              capture_complete: { type: 'boolean' },
              message_count: nonNegativeInteger,
              tool_count: nonNegativeInteger,
              request_body_bytes: nonNegativeInteger,
              response_body_bytes: nonNegativeInteger,
            },
          },
        },
      },
    },
  },
} as const

export const llmCallAuditListQuerySchema = {
  type: 'object',
  additionalProperties: false,
  required: ['environmentId'],
  properties: {
    environmentId: { type: 'string', format: 'uuid' },
    cursor: { type: 'string', minLength: 1, maxLength: 2048 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
    from: { type: 'string', format: 'date-time' },
    to: { type: 'string', format: 'date-time' },
    outcome: { enum: ['SUCCEEDED', 'FAILED', 'ABORTED'] },
    protocol: { type: 'string', minLength: 1, maxLength: 32 },
    search: { type: 'string', maxLength: 128 },
  },
} as const
