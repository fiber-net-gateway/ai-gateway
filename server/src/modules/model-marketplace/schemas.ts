const protocolSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'path', 'upstreamModelName'],
  properties: {
    type: {
      type: 'string',
      enum: ['OPENAI_CHAT_COMPLETIONS', 'ANTHROPIC_MESSAGES'],
    },
    path: { type: 'string', minLength: 1, maxLength: 2_048 },
    upstreamModelName: { type: 'string', minLength: 1, maxLength: 512 },
  },
} as const

const tokenSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'name', 'secretAction'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string', minLength: 1, maxLength: 128 },
        secretAction: { const: 'keep' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'name', 'secretAction', 'value'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string', minLength: 1, maxLength: 128 },
        secretAction: { const: 'replace' },
        value: { type: 'string', minLength: 1, maxLength: 8_192 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'name', 'secretAction'],
      properties: {
        id: { type: 'string', format: 'uuid' },
        name: { type: 'string', minLength: 1, maxLength: 128 },
        secretAction: { const: 'delete' },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'secretAction', 'value'],
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 128 },
        secretAction: { const: 'replace' },
        value: { type: 'string', minLength: 1, maxLength: 8_192 },
      },
    },
  ],
} as const

export const providerSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['mode', 'routeRole', 'sortOrder'],
  properties: {
    id: { type: 'string', format: 'uuid' },
    mode: {
      type: 'string',
      enum: ['CREATE_DEDICATED', 'UPDATE_EXISTING', 'BIND_EXISTING'],
    },
    providerId: { type: 'string', format: 'uuid' },
    displayName: { type: 'string', minLength: 1, maxLength: 100 },
    baseUrl: { type: 'string', minLength: 1, maxLength: 2_048 },
    routeRole: { type: 'string', enum: ['PRIMARY', 'FALLBACK'] },
    sortOrder: { type: 'integer', minimum: 0, maximum: 65_535 },
    protocols: { type: 'array', minItems: 1, maxItems: 2, items: protocolSchema },
    authentication: {
      type: 'object',
      additionalProperties: false,
      required: ['mode'],
      properties: {
        mode: { type: 'string', enum: ['BEARER_TOKEN_POOL', 'NO_CREDENTIALS'] },
        tokens: { type: 'array', maxItems: 100, items: tokenSchema },
        confirmUnauthenticated: { type: 'boolean' },
      },
    },
    confirmSharedImpact: { type: 'boolean' },
  },
} as const

export const modelMutationSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'displayName',
    'logicalModelName',
    'providers',
    'accessMode',
    'loadBalance',
    'rateLimit',
  ],
  properties: {
    displayName: { type: 'string', minLength: 1, maxLength: 100 },
    logicalModelName: { type: 'string', minLength: 1, maxLength: 128 },
    description: { type: 'string', maxLength: 2_000 },
    tags: {
      type: 'array',
      maxItems: 20,
      items: { type: 'string', minLength: 1, maxLength: 32 },
    },
    providers: { type: 'array', minItems: 1, maxItems: 100, items: providerSchema },
    accessMode: {
      type: 'string',
      enum: ['ALL_AUTHENTICATED', 'APPROVAL_REQUIRED'],
    },
    loadBalance: {
      type: 'object',
      additionalProperties: false,
      required: ['prefixMaxBytes', 'maxPrimaryAttempts', 'fallbackEnabled', 'retryableStatuses'],
      properties: {
        prefixMaxBytes: { type: 'integer', minimum: 1, maximum: 2_147_483_647 },
        maxPrimaryAttempts: { type: 'integer', minimum: 0, maximum: 2_147_483_647 },
        fallbackEnabled: { type: 'boolean' },
        retryableStatuses: {
          type: 'array',
          maxItems: 500,
          items: { type: 'integer', minimum: 100, maximum: 599 },
        },
      },
    },
    rateLimit: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          required: ['windowDurationMillis', 'maxTokensPerWindow'],
          properties: {
            windowDurationMillis: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
            maxTokensPerWindow: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
          },
        },
      ],
    },
  },
} as const

export const environmentParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['env'],
  properties: { env: { type: 'string', format: 'uuid' } },
} as const

export const modelParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['env', 'modelId'],
  properties: {
    env: { type: 'string', format: 'uuid' },
    modelId: { type: 'string', format: 'uuid' },
  },
} as const

export const draftParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['env', 'draftId'],
  properties: {
    env: { type: 'string', format: 'uuid' },
    draftId: { type: 'string', format: 'uuid' },
  },
} as const

export const draftModelParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['env', 'draftId', 'modelId'],
  properties: {
    env: { type: 'string', format: 'uuid' },
    draftId: { type: 'string', format: 'uuid' },
    modelId: { type: 'string', format: 'uuid' },
  },
} as const

export const draftModelProviderParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['env', 'draftId', 'modelId'],
  properties: draftModelParamsSchema.properties,
} as const

export const draftProviderParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['env', 'draftId', 'providerId'],
  properties: {
    env: { type: 'string', format: 'uuid' },
    draftId: { type: 'string', format: 'uuid' },
    providerId: { type: 'string', format: 'uuid' },
  },
} as const

export const draftProviderTokenParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['env', 'draftId', 'providerId', 'tokenId'],
  properties: {
    ...draftProviderParamsSchema.properties,
    tokenId: { type: 'string', format: 'uuid' },
  },
} as const

export const createProviderTokenSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'secretAction', 'value', 'reason'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 128 },
    secretAction: { const: 'replace' },
    value: { type: 'string', minLength: 1, maxLength: 8_192 },
    reason: { type: 'string', minLength: 1, maxLength: 500 },
    confirmSharedImpact: { type: 'boolean' },
  },
} as const

export const updateProviderTokenSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['secretAction', 'reason'],
  properties: {
    secretAction: { type: 'string', enum: ['replace', 'delete'] },
    value: { type: 'string', minLength: 1, maxLength: 8_192 },
    reason: { type: 'string', minLength: 1, maxLength: 500 },
    confirmUnauthenticated: { type: 'boolean' },
    confirmSharedImpact: { type: 'boolean' },
  },
  allOf: [
    {
      if: {
        required: ['secretAction'],
        properties: { secretAction: { const: 'replace' } },
      },
      then: { required: ['value'] },
    },
    {
      if: {
        required: ['secretAction'],
        properties: { secretAction: { const: 'delete' } },
      },
      then: { not: { required: ['value'] } },
    },
  ],
} as const
