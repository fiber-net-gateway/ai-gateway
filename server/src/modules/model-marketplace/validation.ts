import { DomainError } from '../users/errors.js'
import type {
  MarketplaceModelRecord,
  MarketplaceProviderRecord,
  MarketplaceProtocolRecord,
  ModelMutationInput,
  ProtocolCoverage,
  ProviderMutationInput,
  ValidationIssue,
} from './types.js'

const controlCharacters = /[\u0000-\u001f\u007f]/u
const unsignedInteger = /^(0|[1-9][0-9]*)$/u

function fail(code: string, message: string, field: string, statusCode = 422): never {
  throw new DomainError(code, statusCode, message, { field, severity: 'ERROR' })
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function validateProtocol(protocol: MarketplaceProtocolRecord, field: string): void {
  if (protocol.type !== 'OPENAI_CHAT_COMPLETIONS' && protocol.type !== 'ANTHROPIC_MESSAGES') {
    fail('PROTOCOL_UNSUPPORTED', '不支持的供应商协议', `${field}/type`)
  }
  if (
    !protocol.path.startsWith('/') ||
    byteLength(protocol.path) > 2_048 ||
    controlCharacters.test(protocol.path)
  ) {
    fail('PROTOCOL_PATH_INVALID', '协议路径必须以 / 开头且不含控制字符', `${field}/path`)
  }
  const upstreamModelName = protocol.upstreamModelName.trim()
  if (!upstreamModelName || byteLength(upstreamModelName) > 512) {
    fail(
      'UPSTREAM_MODEL_REQUIRED',
      '供应商上游模型名不能为空且不能超过 512 字节',
      `${field}/upstreamModelName`,
    )
  }
}

export function normalizeBaseUrl(value: string, field: string): string {
  const input = value.trim()
  if (controlCharacters.test(input) || byteLength(input) > 2_048) {
    fail('PROVIDER_ENDPOINT_INVALID', '供应商 Base URL 不合法', field)
  }
  if (input.startsWith('service://')) {
    const serviceName = input.slice('service://'.length).replace(/\/+$/u, '')
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,252}$/u.test(serviceName)) {
      fail('PROVIDER_ENDPOINT_INVALID', 'service:// 地址中的服务名不合法', field)
    }
    return `service://${serviceName}`
  }
  let url: URL
  try {
    url = new URL(input)
  } catch {
    fail('PROVIDER_ENDPOINT_INVALID', '供应商 Base URL 无法解析', field)
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    fail(
      'PROVIDER_ENDPOINT_INVALID',
      '供应商 Base URL 只能使用 http、https 或 service，且不能包含凭据、查询或片段',
      field,
    )
  }
  return input.replace(/\/+$/u, '')
}

export function validateProviderMutation(provider: ProviderMutationInput): void {
  const field = '/provider'
  if (!provider.displayName.trim() || provider.displayName.trim().length > 100) {
    fail('PROVIDER_DISPLAY_NAME_REQUIRED', '供应商显示名称不能为空', `${field}/displayName`)
  }
  if (!provider.baseUrl)
    fail('PROVIDER_ENDPOINT_REQUIRED', '供应商 Base URL 不能为空', `${field}/baseUrl`)
  normalizeBaseUrl(provider.baseUrl, `${field}/baseUrl`)
  if (!provider.protocols.length) {
    fail('PROVIDER_PROTOCOL_REQUIRED', '供应商至少需要一项协议映射', `${field}/protocols`)
  }
  const seen = new Set<string>()
  provider.protocols.forEach((protocol, protocolIndex) => {
    validateProtocol(protocol, `${field}/protocols/${protocolIndex}`)
    if (seen.has(protocol.type)) {
      fail(
        'PROVIDER_PROTOCOL_DUPLICATE',
        '同一供应商的协议类型不能重复',
        `${field}/protocols/${protocolIndex}/type`,
      )
    }
    seen.add(protocol.type)
  })
  const authentication = provider.authentication
  const activeTokens = authentication.tokens.filter((token) => token.secretAction !== 'delete')
  if (authentication.mode === 'NO_CREDENTIALS' && !authentication.confirmUnauthenticated) {
    fail(
      'UNAUTHENTICATED_PROVIDER_CONFIRMATION_REQUIRED',
      '无凭据调用需要管理员显式确认',
      `${field}/authentication/confirmUnauthenticated`,
      409,
    )
  }
  if (authentication.mode === 'BEARER_TOKEN_POOL' && activeTokens.length === 0) {
    fail(
      'PROVIDER_TOKEN_REQUIRED',
      'Bearer Token 池至少需要一个有效 Token',
      `${field}/authentication/tokens`,
    )
  }
  const tokenNames = new Set<string>()
  for (const [tokenIndex, token] of authentication.tokens.entries()) {
    const tokenField = `${field}/authentication/tokens/${tokenIndex}`
    if (
      !token.name ||
      token.name.length > 128 ||
      controlCharacters.test(token.name) ||
      tokenNames.has(token.name)
    ) {
      fail(
        'PROVIDER_TOKEN_NAME_INVALID',
        'Token 名为空、重复、过长或包含控制字符',
        `${tokenField}/name`,
      )
    }
    tokenNames.add(token.name)
    if (token.secretAction === 'replace') {
      const length = byteLength(token.value)
      if (length < 1 || length > 8_192 || /[\r\n\u0000]/u.test(token.value)) {
        fail(
          'PROVIDER_TOKEN_VALUE_INVALID',
          'Token 值长度或字符不符合安全约束',
          `${tokenField}/value`,
        )
      }
    }
  }
}

function validateInt64(value: string, field: string, positive: boolean): void {
  if (!unsignedInteger.test(value))
    fail('RATE_LIMIT_INVALID', '限流值必须是无符号十进制字符串', field)
  const parsed = BigInt(value)
  if ((positive && parsed === 0n) || parsed > 18_446_744_073_709_551_615n) {
    fail('RATE_LIMIT_INVALID', '限流值超出 uint64 范围', field)
  }
}

export function validateModelMutation(input: ModelMutationInput, creating: boolean): void {
  const displayName = input.displayName.trim()
  if (!displayName || displayName.length > 100) {
    fail('MODEL_DISPLAY_NAME_REQUIRED', '模型显示名称不能为空且不能超过 100 字符', '/displayName')
  }
  const logicalNameBytes = byteLength(input.logicalModelName)
  if (
    logicalNameBytes < 1 ||
    logicalNameBytes > 128 ||
    !/^[A-Za-z0-9_.-]+$/u.test(input.logicalModelName)
  ) {
    fail(
      'LOGICAL_MODEL_NAME_INVALID',
      '逻辑模型名必须为 1..128 字节的安全 ASCII 字符',
      '/logicalModelName',
    )
  }
  if (!creating && input.logicalModelName.length === 0) {
    fail('LOGICAL_MODEL_NAME_REQUIRED', '逻辑模型名不能为空', '/logicalModelName')
  }
  if ((input.description ?? '').length > 2_000) {
    fail('MODEL_DESCRIPTION_TOO_LONG', '模型说明不能超过 2000 字符', '/description')
  }
  const normalizedTags = (input.tags ?? []).map((tag) => tag.trim().toLocaleLowerCase())
  if (
    normalizedTags.length > 20 ||
    normalizedTags.some((tag) => !tag || tag.length > 32) ||
    new Set(normalizedTags).size !== normalizedTags.length
  ) {
    fail('MODEL_TAGS_INVALID', '标签必须唯一，最多 20 个且每项不超过 32 字符', '/tags')
  }
  if (!input.providers.length) {
    fail('MODEL_PROVIDER_REQUIRED', '模型至少需要一个供应商接入', '/providers')
  }
  if (input.accessMode !== 'ALL_AUTHENTICATED' && input.accessMode !== 'APPROVAL_REQUIRED') {
    fail('MODEL_ACCESS_MODE_INVALID', '模型访问模式不合法', '/accessMode')
  }
  for (const [index, provider] of input.providers.entries()) {
    const field = `/providers/${index}`
    if (!provider.providerId) {
      fail('PROVIDER_ID_REQUIRED', '必须选择已有供应商', `${field}/providerId`)
    }
    if (provider.routeRole !== 'PRIMARY' && provider.routeRole !== 'FALLBACK') {
      fail('PROVIDER_ROUTE_ROLE_INVALID', '供应商路由角色不合法', `${field}/routeRole`)
    }
    if (
      !Number.isInteger(provider.sortOrder) ||
      provider.sortOrder < 0 ||
      provider.sortOrder > 65_535
    ) {
      fail('PROVIDER_SORT_ORDER_INVALID', '供应商顺序必须为非负整数', `${field}/sortOrder`)
    }
  }
  if (
    new Set(input.providers.map((provider) => provider.providerId)).size !== input.providers.length
  ) {
    fail('MODEL_PROVIDER_DUPLICATE', '同一个供应商不能重复绑定', '/providers')
  }
  const fallbacks = input.providers.filter((provider) => provider.routeRole === 'FALLBACK')
  if (fallbacks.length > 1) {
    fail('MODEL_FALLBACK_DUPLICATE', '一个模型最多配置一个 Fallback', '/providers')
  }
  const primaryOrders = input.providers
    .filter((provider) => provider.routeRole === 'PRIMARY')
    .map((provider) => provider.sortOrder)
  if (new Set(primaryOrders).size !== primaryOrders.length) {
    fail('PRIMARY_SORT_ORDER_DUPLICATE', '主供应商顺序不能重复', '/providers')
  }
  if (
    !Number.isInteger(input.loadBalance.prefixMaxBytes) ||
    input.loadBalance.prefixMaxBytes < 1 ||
    input.loadBalance.prefixMaxBytes > 2_147_483_647
  ) {
    fail('PREFIX_MAX_BYTES_INVALID', 'prefixMaxBytes 超出范围', '/loadBalance/prefixMaxBytes')
  }
  if (
    !Number.isInteger(input.loadBalance.maxPrimaryAttempts) ||
    input.loadBalance.maxPrimaryAttempts < 0 ||
    input.loadBalance.maxPrimaryAttempts > 2_147_483_647
  ) {
    fail(
      'MAX_PRIMARY_ATTEMPTS_INVALID',
      'maxPrimaryAttempts 超出范围',
      '/loadBalance/maxPrimaryAttempts',
    )
  }
  const statuses = input.loadBalance.retryableStatuses
  if (statuses.some((status) => !Number.isInteger(status) || status < 100 || status > 599)) {
    fail(
      'RETRYABLE_STATUS_INVALID',
      '重试状态码必须是 100..599 的整数',
      '/loadBalance/retryableStatuses',
    )
  }
  if (input.rateLimit) {
    validateInt64(input.rateLimit.windowDurationMillis, '/rateLimit/windowDurationMillis', true)
    validateInt64(input.rateLimit.maxTokensPerWindow, '/rateLimit/maxTokensPerWindow', false)
  }
}

export function protocolCoverage(
  model: MarketplaceModelRecord,
  providers: MarketplaceProviderRecord[],
): {
  openai: ProtocolCoverage
  anthropic: ProtocolCoverage
} {
  const providerById = new Map(providers.map((provider) => [provider.id, provider]))
  const activeProviders = model.providerBindings
    .filter((binding) => binding.routeRole === 'PRIMARY' || model.fallbackEnabled)
    .flatMap((binding) => {
      const provider = providerById.get(binding.providerId)
      return provider && !provider.archivedAt ? [provider] : []
    })
  const supports = (type: MarketplaceProtocolRecord['type']) =>
    activeProviders.some((provider) =>
      provider.protocols.some((protocol) => protocol.type === type),
    )
      ? 'SUPPORTED'
      : 'UNSUPPORTED'
  return {
    openai: supports('OPENAI_CHAT_COMPLETIONS'),
    anthropic: supports('ANTHROPIC_MESSAGES'),
  }
}

export function validateModelGraph(
  model: MarketplaceModelRecord,
  providers: MarketplaceProviderRecord[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const coverage = protocolCoverage(model, providers)
  if (coverage.openai === 'UNSUPPORTED') {
    issues.push({
      code: 'OPENAI_PROTOCOL_UNSUPPORTED',
      message: '当前模型没有可执行的 OpenAI Chat Completions 候选',
      field: `/models/${model.id}/protocols/OPENAI_CHAT_COMPLETIONS`,
      severity: 'WARNING',
    })
  }
  if (coverage.anthropic === 'UNSUPPORTED') {
    issues.push({
      code: 'ANTHROPIC_PROTOCOL_UNSUPPORTED',
      message: '当前模型没有可执行的 Anthropic Messages 候选',
      field: `/models/${model.id}/protocols/ANTHROPIC_MESSAGES`,
      severity: 'WARNING',
    })
  }
  if (coverage.openai === 'UNSUPPORTED' && coverage.anthropic === 'UNSUPPORTED') {
    issues.push({
      code: 'PROTOCOL_COVERAGE_EMPTY',
      message: '模型没有任何可执行协议',
      field: `/models/${model.id}/providers`,
      severity: 'ERROR',
    })
  }
  const providerById = new Map(providers.map((provider) => [provider.id, provider]))
  if (
    model.providerBindings.some((binding) => {
      const provider = providerById.get(binding.providerId)
      return !provider || provider.archivedAt || provider.protocols.length === 0
    })
  ) {
    issues.push({
      code: 'PROVIDER_PROTOCOL_REQUIRED',
      message: '供应商至少需要一项协议映射',
      field: `/models/${model.id}/providers`,
      severity: 'ERROR',
    })
  }
  return issues
}
