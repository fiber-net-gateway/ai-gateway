import type {
  MarketplaceModelRecord,
  MarketplaceSecretService,
  MarketplaceVersionRecord,
  RenderedResource,
} from './types.js'
import { int64JsonLiteral } from './config-contract.js'

const protocolOrder = {
  OPENAI_CHAT_COMPLETIONS: 0,
  ANTHROPIC_MESSAGES: 1,
} as const

const protocolType = {
  OPENAI_CHAT_COMPLETIONS: 'openai-chat-completions',
  ANTHROPIC_MESSAGES: 'anthropic-messages',
} as const

function stringifyConfig(value: unknown): string {
  return JSON.stringify(value).replace(/"__marketplace_int64_([0-9]+)"/gu, '$1')
}

export async function renderProviderResources(
  version: MarketplaceVersionRecord,
  secrets: MarketplaceSecretService,
  configVersion = version.schemaVersion,
): Promise<RenderedResource[]> {
  const referencedProviderIds = new Set(
    version.models.flatMap((model) => model.providerBindings.map((binding) => binding.providerId)),
  )
  const providers = version.providers.filter(
    (provider) => referencedProviderIds.has(provider.id) && !provider.archivedAt,
  )
  const resources: RenderedResource[] = []
  for (const provider of providers.sort((left, right) =>
    left.providerName.localeCompare(right.providerName, 'en'),
  )) {
    resources.push(await renderProvider(version, provider, secrets, configVersion))
  }
  return resources
}

export async function renderProviderResource(
  version: MarketplaceVersionRecord,
  providerName: string,
  secrets: MarketplaceSecretService,
  configVersion = version.schemaVersion,
): Promise<RenderedResource> {
  const provider = version.providers.find(
    (candidate) => candidate.providerName === providerName && !candidate.archivedAt,
  )
  if (!provider) throw new Error(`frozen Provider is missing: ${providerName}`)
  return renderProvider(version, provider, secrets, configVersion)
}

async function renderProvider(
  version: MarketplaceVersionRecord,
  provider: MarketplaceVersionRecord['providers'][number],
  secrets: MarketplaceSecretService,
  configVersion: number,
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
      version: configVersion,
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

function renderModel(
  model: MarketplaceModelRecord,
  providerById: Map<string, MarketplaceVersionRecord['providers'][number]>,
) {
  const primaryProviders = model.providerBindings
    .filter((binding) => binding.routeRole === 'PRIMARY')
    .sort(
      (left, right) =>
        left.sortOrder - right.sortOrder || left.providerId.localeCompare(right.providerId, 'en'),
    )
    .map((binding) => providerById.get(binding.providerId)?.providerName)
    .filter((name): name is string => Boolean(name))
  const fallback = model.providerBindings.find((binding) => binding.routeRole === 'FALLBACK')
  const result: Record<string, unknown> = {
    'model-name': model.logicalModelName,
    providers: primaryProviders,
    'fallback-provider': fallback
      ? (providerById.get(fallback.providerId)?.providerName ?? '')
      : '',
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
      'window-duration-millis': int64JsonLiteral(model.rateLimit.windowDurationMillis, true),
      'max-tokens-per-window': int64JsonLiteral(model.rateLimit.maxTokensPerWindow, false),
    }
  }
  return result
}

export function renderModelsResource(
  version: MarketplaceVersionRecord,
  configVersion = version.schemaVersion,
): RenderedResource {
  const providerById = new Map(version.providers.map((provider) => [provider.id, provider]))
  return {
    group: 'LLM-SERVER',
    dataId: 'ploto.ai-llm.models',
    content: stringifyConfig({
      version: configVersion,
      data: [...version.models]
        .filter((model) => !model.archivedAt)
        .sort((left, right) => left.logicalModelName.localeCompare(right.logicalModelName, 'en'))
        .map((model) => renderModel(model, providerById)),
    }),
    containsSecret: false,
  }
}
