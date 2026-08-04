import type {
  MarketplaceModelRecord,
  MarketplaceSecretService,
  MarketplaceVersionRecord,
  RenderedResource,
} from './types.js'

const protocolOrder = {
  OPENAI_CHAT_COMPLETIONS: 0,
  ANTHROPIC_MESSAGES: 1,
} as const

const protocolType = {
  OPENAI_CHAT_COMPLETIONS: 'openai-chat-completions',
  ANTHROPIC_MESSAGES: 'anthropic-messages',
} as const

function uint64(value: string): string {
  return `__marketplace_uint64_${value}`
}

function stringifyConfig(value: unknown): string {
  return JSON.stringify(value).replace(/"__marketplace_uint64_([0-9]+)"/gu, '$1')
}

export async function renderProviderResources(
  version: MarketplaceVersionRecord,
  secrets: MarketplaceSecretService,
): Promise<RenderedResource[]> {
  const providers = new Map(
    version.models.flatMap((model) => model.providers.map((provider) => [provider.id, provider])),
  )
  const resources: RenderedResource[] = []
  for (const provider of [...providers.values()].sort((left, right) =>
    left.providerName.localeCompare(right.providerName, 'en'),
  )) {
    resources.push(await renderProvider(version, provider, secrets))
  }
  return resources
}

export async function renderProviderResource(
  version: MarketplaceVersionRecord,
  providerName: string,
  secrets: MarketplaceSecretService,
): Promise<RenderedResource> {
  const provider = version.models
    .flatMap((model) => model.providers)
    .find((candidate) => candidate.providerName === providerName)
  if (!provider) throw new Error(`frozen Provider is missing: ${providerName}`)
  return renderProvider(version, provider, secrets)
}

async function renderProvider(
  version: MarketplaceVersionRecord,
  provider: MarketplaceModelRecord['providers'][number],
  secrets: MarketplaceSecretService,
): Promise<RenderedResource> {
  const tokens: Array<{ name: string; token: string }> = []
  try {
    for (const token of [...provider.tokens].sort((left, right) =>
      left.name.localeCompare(right.name, 'en'),
    )) {
      const secret = await secrets.decryptForPublication({
        environmentId: version.environmentId,
        providerId: provider.id,
        tokenId: token.id,
        secretId: token.secretId,
      })
      try {
        tokens.push({ name: token.name, token: Buffer.from(secret.bytes).toString('utf8') })
      } finally {
        secret.dispose()
      }
    }
    const content = stringifyConfig({
      version: version.schemaVersion,
      data: {
        provider: provider.providerName,
        baseurl: provider.baseUrl.replace(/\/+$/u, ''),
        'api-tokens': tokens,
        protocol: [...provider.protocols]
          .sort((left, right) => protocolOrder[left.type] - protocolOrder[right.type])
          .map((protocol) => ({
            type: protocolType[protocol.type],
            path: protocol.path,
            model: protocol.upstreamModelName,
          })),
      },
    })
    return {
      group: 'LLM-SERVER',
      dataId: `ploto.ai-llm.provider.${provider.providerName}`,
      content,
      containsSecret: tokens.length > 0,
    }
  } finally {
    for (const token of tokens) token.token = ''
    tokens.length = 0
  }
}

function renderModel(model: MarketplaceModelRecord) {
  const primaryProviders = model.providers
    .filter((provider) => provider.routeRole === 'PRIMARY')
    .sort(
      (left, right) =>
        left.sortOrder - right.sortOrder ||
        left.providerName.localeCompare(right.providerName, 'en'),
    )
    .map((provider) => provider.providerName)
  const fallback = model.providers.find((provider) => provider.routeRole === 'FALLBACK')
  const result: Record<string, unknown> = {
    'model-name': model.logicalModelName,
    providers: primaryProviders,
    'fallback-provider': fallback?.providerName ?? '',
    'allow-user-groups': model.allowUserGroups
      .map((group) => group.name)
      .sort((left, right) => left.localeCompare(right, 'en')),
    'load-balance': {
      policy: 'rendezvous-hash',
      'hash-source': 'prompt-prefix',
      'prefix-max-bytes': model.prefixMaxBytes,
      'max-primary-attempts': model.maxPrimaryAttempts,
      'fallback-enabled': model.fallbackEnabled,
      'retryable-status': [...new Set(model.retryableStatuses)].sort((left, right) => left - right),
    },
  }
  if (model.rateLimit) {
    result['rate-limit'] = {
      'window-duration-millis': uint64(model.rateLimit.windowDurationMillis),
      'max-tokens-per-window': uint64(model.rateLimit.maxTokensPerWindow),
    }
  }
  return result
}

export function renderModelsResource(version: MarketplaceVersionRecord): RenderedResource {
  return {
    group: 'LLM-SERVER',
    dataId: 'ploto.ai-llm.models',
    content: stringifyConfig({
      version: version.schemaVersion,
      data: [...version.models]
        .filter((model) => !model.archivedAt)
        .sort((left, right) => left.logicalModelName.localeCompare(right.logicalModelName, 'en'))
        .map(renderModel),
    }),
    containsSecret: false,
  }
}
