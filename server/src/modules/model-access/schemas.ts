export const accessRequestStatusValues = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const

export const createAccessRequestSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['reason'],
  properties: {
    reason: { type: 'string', minLength: 10, maxLength: 500 },
  },
} as const

export const decisionSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    reason: { type: 'string', minLength: 1, maxLength: 500 },
  },
} as const

export const rejectionSchema = {
  ...decisionSchema,
  required: ['reason'],
} as const

export const modelAccessParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['env', 'modelId'],
  properties: {
    env: { type: 'string', format: 'uuid' },
    modelId: { type: 'string', format: 'uuid' },
  },
} as const

export const accessRequestParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['requestId'],
  properties: {
    requestId: { type: 'string', format: 'uuid' },
  },
} as const

export const accessGroupParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['groupId'],
  properties: {
    groupId: { type: 'string', format: 'uuid' },
  },
} as const

export const applicantListQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    environmentId: { type: 'string', format: 'uuid' },
    status: { type: 'string', enum: accessRequestStatusValues },
    cursor: { type: 'string', maxLength: 1_024 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  },
} as const

export const adminListQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    environmentId: { type: 'string', format: 'uuid' },
    status: { type: 'string', enum: accessRequestStatusValues },
    search: { type: 'string', maxLength: 100 },
    cursor: { type: 'string', maxLength: 1_024 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
  },
} as const
