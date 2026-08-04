import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { buildApp } from '../../app.js'
import { ValueCipher } from '../users/crypto.js'
import type { MarketplaceConfigPublisher, RnacosConfigRead } from '../rnacos/config-client.js'
import { MemoryMarketplaceSecretService } from './secret-service.js'
import { renderModelsResource, renderProviderResources } from './renderer.js'
import type {
  MarketplaceVersionRecord,
  ModelMutationInput,
  ProviderMutationInput,
} from './types.js'

class FakeMarketplacePublisher implements MarketplaceConfigPublisher {
  readonly writes: Array<{ dataId: string; md5: string }> = []
  private readonly configs = new Map<string, string>()

  target() {
    return {
      environmentId: '00000000-0000-4000-8000-000000000001',
      namespaceId: 'public',
      tenant: '',
      group: 'LLM-SERVER' as const,
    }
  }

  seed(dataId: string, content: string): void {
    this.configs.set(dataId, content)
  }

  async read(input: {
    environmentId: string
    group: 'LLM-SERVER'
    dataId: string
  }): Promise<RnacosConfigRead> {
    assert.equal(input.environmentId, this.target().environmentId)
    const content = this.configs.get(input.dataId)
    return content === undefined
      ? { state: 'NOT_FOUND', content: null, md5: null }
      : { state: 'PRESENT', content, md5: md5(content) }
  }

  async publish(input: {
    environmentId: string
    group: 'LLM-SERVER'
    dataId: string
    content: string
    expectedMd5: string
    expectedOldMd5: string | null
  }): Promise<{ readbackMd5: string }> {
    const current = await this.read(input)
    assert.equal(current.md5, input.expectedOldMd5)
    assert.equal(md5(input.content), input.expectedMd5)
    this.configs.set(input.dataId, input.content)
    this.writes.push({ dataId: input.dataId, md5: input.expectedMd5 })
    return { readbackMd5: input.expectedMd5 }
  }
}

function md5(content: string): string {
  return createHash('md5').update(content, 'utf8').digest('hex')
}

function cookieHeader(value: string | string[] | undefined): string {
  const values = Array.isArray(value) ? value : value ? [value] : []
  return values.map((entry) => entry.split(';', 1)[0]).join('; ')
}

function cookieValue(cookie: string, name: string): string {
  const value = cookie
    .split('; ')
    .find((entry) => entry.startsWith(`${name}=`))
    ?.slice(name.length + 1)
  assert.ok(value)
  return decodeURIComponent(value)
}

function providerMutation(secret: string): ProviderMutationInput {
  return {
    displayName: '供应商 A',
    baseUrl: 'https://api.vendor.example/',
    protocols: [
      {
        type: 'OPENAI_CHAT_COMPLETIONS',
        path: '/v1/chat/completions',
        upstreamModelName: 'vendor-chat',
      },
      {
        type: 'ANTHROPIC_MESSAGES',
        path: '/v1/messages',
        upstreamModelName: 'vendor-chat',
      },
    ],
    authentication: {
      mode: 'BEARER_TOKEN_POOL',
      tokens: [{ name: 'primary', secretAction: 'replace', value: secret }],
    },
  }
}

function mutation(providerId: string): ModelMutationInput {
  return {
    displayName: '通用对话模型',
    logicalModelName: 'chat-pro',
    description: '用于验证模型广场完整保存流程',
    tags: ['chat', 'general'],
    providers: [
      {
        providerId,
        routeRole: 'PRIMARY',
        sortOrder: 0,
      },
    ],
    accessMode: 'ALL_AUTHENTICATED',
    loadBalance: {
      prefixMaxBytes: 2_048,
      maxPrimaryAttempts: 0,
      fallbackEnabled: true,
      retryableStatuses: [504, 429, 503, 429],
    },
    rateLimit: null,
  }
}

test('model marketplace keeps draft, publication, activation and secrets separate', async (context) => {
  const publisher = new FakeMarketplacePublisher()
  const app = buildApp({ marketplacePublisher: publisher })
  context.after(() => app.close())

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/development-login',
    payload: { username: 'admin' },
  })
  assert.equal(login.statusCode, 200)
  const cookie = cookieHeader(login.headers['set-cookie'])
  const csrf = cookieValue(cookie, 'fg_csrf')
  const environments = await app.inject({
    method: 'GET',
    url: '/api/me/environments',
    headers: { cookie },
  })
  const environmentId = environments.json().items[0].environment.id as string

  const empty = await app.inject({
    method: 'GET',
    url: `/api/environments/${environmentId}/models?view=admin`,
    headers: { cookie },
  })
  assert.equal(empty.statusCode, 200)
  assert.equal(empty.json().items.length, 0)
  assert.equal(empty.headers.etag, '"1"')
  const draftId = empty.json().draft.id as string

  const forgedCursor = await app.inject({
    method: 'GET',
    url: `/api/environments/${environmentId}/models?view=admin&cursor=forged.cursor`,
    headers: { cookie },
  })
  assert.equal(forgedCursor.statusCode, 400)
  assert.equal(forgedCursor.json().code, 'CURSOR_INVALID')

  const keyResponse = await app.inject({
    method: 'POST',
    url: '/api/idempotency-keys',
    headers: { cookie, 'x-csrf-token': csrf },
  })
  assert.equal(keyResponse.statusCode, 200)
  const marker = 'MARKETPLACE_SECRET_MUST_NOT_LEAK_93b15c'
  const createdProvider = await app.inject({
    method: 'POST',
    url: `/api/environments/${environmentId}/drafts/${draftId}/providers`,
    headers: {
      cookie,
      'x-csrf-token': csrf,
      'idempotency-key': keyResponse.json().key as string,
      'if-match': '"1"',
    },
    payload: providerMutation(marker),
  })
  assert.equal(createdProvider.statusCode, 201, createdProvider.body)
  assert.equal(createdProvider.headers.etag, '"2"')
  assert.equal(createdProvider.body.includes(marker), false)
  const providerId = createdProvider.json().id as string
  const providerName = createdProvider.json().providerName as string
  const originalTokenId = createdProvider.json().tokens[0].id as string

  const idempotencyKey = 'model-create-idempotency-0001'
  const created = await app.inject({
    method: 'POST',
    url: `/api/environments/${environmentId}/drafts/${draftId}/models`,
    headers: {
      cookie,
      'x-csrf-token': csrf,
      'idempotency-key': idempotencyKey,
      'if-match': '"2"',
    },
    payload: mutation(providerId),
  })
  assert.equal(created.statusCode, 201, created.body)
  assert.match(created.headers['cache-control'] ?? '', /no-store/u)
  assert.equal(created.headers.etag, '"3"')
  assert.equal(created.body.includes(marker), false)
  assert.equal(created.body.includes('secretId'), false)
  assert.equal(created.json().providers[0].baseUrl, 'https://api.vendor.example')
  assert.equal(created.json().providers[0].tokens[0].configured, true)
  assert.equal(created.json().draft.state, 'MODIFIED')
  assert.equal(created.json().published.state, 'NEVER')
  assert.equal(created.json().activation.state, 'UNKNOWN')

  const providerList = await app.inject({
    method: 'GET',
    url: `/api/environments/${environmentId}/providers`,
    headers: { cookie },
  })
  assert.equal(providerList.statusCode, 200, providerList.body)
  assert.equal(providerList.json().items[0].id, providerId)
  assert.equal(providerList.json().items[0].referencedModelCount, 1)

  const archiveInUse = await app.inject({
    method: 'DELETE',
    url: `/api/environments/${environmentId}/drafts/${draftId}/providers/${providerId}`,
    headers: { cookie, 'x-csrf-token': csrf, 'if-match': '"3"' },
  })
  assert.equal(archiveInUse.statusCode, 409, archiveInUse.body)
  assert.equal(archiveInUse.json().code, 'PROVIDER_IN_USE')

  const replay = await app.inject({
    method: 'POST',
    url: `/api/environments/${environmentId}/drafts/${draftId}/models`,
    headers: {
      cookie,
      'x-csrf-token': csrf,
      'idempotency-key': idempotencyKey,
      'if-match': '"2"',
    },
    payload: mutation(providerId),
  })
  assert.equal(replay.statusCode, 200)
  assert.equal(replay.body.includes(marker), false)

  const tokenKey = 'granular-token-create-0001'
  const granularMarker = 'GRANULAR_SECRET_MUST_NOT_LEAK_7b392a'
  const addedToken = await app.inject({
    method: 'POST',
    url: `/api/environments/${environmentId}/drafts/${draftId}/providers/${providerId}/tokens`,
    headers: {
      cookie,
      'x-csrf-token': csrf,
      'idempotency-key': tokenKey,
      'if-match': '"3"',
    },
    payload: {
      name: 'secondary',
      secretAction: 'replace',
      value: granularMarker,
      reason: '验证细粒度供应商凭据接口',
    },
  })
  assert.equal(addedToken.statusCode, 201, addedToken.body)
  assert.equal(addedToken.headers.etag, '"4"')
  assert.equal(addedToken.body.includes(granularMarker), false)
  assert.equal(addedToken.body.includes('secretId'), false)
  const secondaryTokenId = addedToken.json().token.id as string

  const tokenReplay = await app.inject({
    method: 'POST',
    url: `/api/environments/${environmentId}/drafts/${draftId}/providers/${providerId}/tokens`,
    headers: {
      cookie,
      'x-csrf-token': csrf,
      'idempotency-key': tokenKey,
      'if-match': '"3"',
    },
    payload: {
      name: 'secondary',
      secretAction: 'replace',
      value: granularMarker,
      reason: '验证细粒度供应商凭据接口',
    },
  })
  assert.equal(tokenReplay.statusCode, 200)
  assert.equal(tokenReplay.json().replayed, true)
  assert.equal(tokenReplay.body.includes(granularMarker), false)

  const replacedToken = await app.inject({
    method: 'PATCH',
    url: `/api/environments/${environmentId}/drafts/${draftId}/providers/${providerId}/tokens/${originalTokenId}`,
    headers: {
      cookie,
      'x-csrf-token': csrf,
      'idempotency-key': 'granular-token-replace-0001',
      'if-match': '"4"',
    },
    payload: {
      secretAction: 'replace',
      value: 'REPLACEMENT_SECRET_MUST_NOT_LEAK_12',
      reason: '验证同名紧急替换',
    },
  })
  assert.equal(replacedToken.statusCode, 200, replacedToken.body)
  assert.equal(replacedToken.headers.etag, '"5"')
  assert.equal(replacedToken.body.includes('REPLACEMENT_SECRET_MUST_NOT_LEAK_12'), false)

  const deletedToken = await app.inject({
    method: 'PATCH',
    url: `/api/environments/${environmentId}/drafts/${draftId}/providers/${providerId}/tokens/${secondaryTokenId}`,
    headers: {
      cookie,
      'x-csrf-token': csrf,
      'idempotency-key': 'granular-token-delete-0001',
      'if-match': '"5"',
    },
    payload: { secretAction: 'delete', reason: '验证凭据下线' },
  })
  assert.equal(deletedToken.statusCode, 200, deletedToken.body)
  assert.equal(deletedToken.headers.etag, '"6"')
  assert.equal(deletedToken.json().deleted, true)

  const conflictMutation = mutation(providerId)
  conflictMutation.logicalModelName = 'chat-pro-2'
  const conflict = await app.inject({
    method: 'POST',
    url: `/api/environments/${environmentId}/drafts/${draftId}/models`,
    headers: {
      cookie,
      'x-csrf-token': csrf,
      'idempotency-key': 'stale-revision-request',
      'if-match': '"1"',
    },
    payload: conflictMutation,
  })
  assert.equal(conflict.statusCode, 412)
  assert.equal(conflict.json().code, 'REVISION_CONFLICT')
  assert.equal(conflict.body.includes('SECOND_SECRET_MARKER_42'), false)

  const validation = await app.inject({
    method: 'POST',
    url: `/api/environments/${environmentId}/drafts/${draftId}/validate`,
    headers: { cookie, 'x-csrf-token': csrf },
  })
  assert.equal(validation.statusCode, 200)
  assert.equal(validation.json().valid, true)

  const submitted = await app.inject({
    method: 'POST',
    url: `/api/environments/${environmentId}/drafts/${draftId}/submit`,
    headers: { cookie, 'x-csrf-token': csrf, 'if-match': '"6"' },
  })
  assert.equal(submitted.statusCode, 202, submitted.body)
  assert.equal(submitted.json().publicationState, 'NEVER')
  assert.equal(submitted.json().activationState, 'UNKNOWN')
  assert.equal(submitted.headers.etag, '"7"')
  assert.deepEqual(
    submitted.json().release.resources.map((resource: { dataId: string; state: string }) => ({
      dataId: resource.dataId,
      state: resource.state,
    })),
    [
      {
        dataId: `ploto.ai-llm.provider.${providerName}`,
        state: 'PENDING',
      },
      { dataId: 'ploto.ai-llm.models', state: 'PENDING' },
    ],
  )
  const releaseId = submitted.json().release.id as string
  const releases = await app.inject({
    method: 'GET',
    url: `/api/environments/${environmentId}/releases`,
    headers: { cookie },
  })
  assert.equal(releases.statusCode, 200, releases.body)
  assert.equal(releases.json().items[0].id, releaseId)

  const executed = await app.inject({
    method: 'POST',
    url: `/api/environments/${environmentId}/releases/${releaseId}/execute`,
    headers: { cookie, 'x-csrf-token': csrf },
  })
  assert.equal(executed.statusCode, 202, executed.body)
  assert.equal(executed.json().state, 'PUBLISHING')
  assert.equal(executed.body.includes(marker), false)
  assert.equal(executed.body.includes('REPLACEMENT_SECRET_MUST_NOT_LEAK_12'), false)

  let releaseDetail
  for (let attempt = 0; attempt < 20; attempt += 1) {
    releaseDetail = await app.inject({
      method: 'GET',
      url: `/api/environments/${environmentId}/releases/${releaseId}`,
      headers: { cookie },
    })
    if (releaseDetail.json().state !== 'PUBLISHING') break
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  assert.ok(releaseDetail)
  assert.equal(releaseDetail.statusCode, 200, releaseDetail.body)
  assert.equal(releaseDetail.json().state, 'COMPLETED')
  assert.equal(releaseDetail.json().publicationState, 'PUBLISHED')
  assert.equal(releaseDetail.json().activationState, 'UNKNOWN')
  assert.deepEqual(
    publisher.writes.map((write) => write.dataId),
    [`ploto.ai-llm.provider.${providerName}`, 'ploto.ai-llm.models'],
  )
  assert.ok(
    releaseDetail
      .json()
      .resources.every(
        (resource: { state: string; newMd5: string | null }) =>
          resource.state === 'PUBLISHED' && Boolean(resource.newMd5),
      ),
  )

  const available = await app.inject({
    method: 'GET',
    url: `/api/environments/${environmentId}/models?view=available`,
    headers: { cookie },
  })
  assert.equal(available.statusCode, 200)
  assert.equal(available.json().items[0].logicalModelName, 'chat-pro')
  assert.equal(available.json().items[0].activationState, 'UNKNOWN')
  assert.equal(available.body.includes(marker), false)

  const audit = await app.inject({
    method: 'GET',
    url: '/api/admin/audit-events',
    headers: { cookie },
  })
  assert.equal(audit.statusCode, 200)
  assert.equal(audit.body.includes(marker), false)
  assert.equal(audit.body.includes(granularMarker), false)
  assert.ok(
    audit
      .json()
      .items.some(
        (event: { eventType: string }) => event.eventType === 'marketplace.model.created',
      ),
  )
  assert.ok(
    audit
      .json()
      .items.some(
        (event: { eventType: string }) => event.eventType === 'marketplace.release.published',
      ),
  )
})

test('available view never exposes administrator provider metadata', async (context) => {
  const app = buildApp()
  context.after(() => app.close())
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/development-login',
    payload: { username: 'admin' },
  })
  const cookie = cookieHeader(login.headers['set-cookie'])
  const environments = await app.inject({
    method: 'GET',
    url: '/api/me/environments',
    headers: { cookie },
  })
  const environmentId = environments.json().items[0].environment.id as string
  const response = await app.inject({
    method: 'GET',
    url: `/api/environments/${environmentId}/models?view=available`,
    headers: { cookie },
  })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), { items: [], nextCursor: null })
  assert.equal(response.body.includes('provider'), false)
})

test('release preflight stops every write when a later Data ID has drifted', async (context) => {
  const publisher = new FakeMarketplacePublisher()
  publisher.seed('ploto.ai-llm.models', '{"version":1,"data":["external-change"]}')
  const app = buildApp({ marketplacePublisher: publisher })
  context.after(() => app.close())
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/development-login',
    payload: { username: 'admin' },
  })
  const cookie = cookieHeader(login.headers['set-cookie'])
  const csrf = cookieValue(cookie, 'fg_csrf')
  const environments = await app.inject({
    method: 'GET',
    url: '/api/me/environments',
    headers: { cookie },
  })
  const environmentId = environments.json().items[0].environment.id as string
  const list = await app.inject({
    method: 'GET',
    url: `/api/environments/${environmentId}/models?view=admin`,
    headers: { cookie },
  })
  const draftId = list.json().draft.id as string
  const provider = await app.inject({
    method: 'POST',
    url: `/api/environments/${environmentId}/drafts/${draftId}/providers`,
    headers: {
      cookie,
      'x-csrf-token': csrf,
      'idempotency-key': 'release-drift-provider-create',
      'if-match': '"1"',
    },
    payload: providerMutation('DRIFT_TEST_SECRET_MUST_NOT_LEAK'),
  })
  assert.equal(provider.statusCode, 201, provider.body)
  const created = await app.inject({
    method: 'POST',
    url: `/api/environments/${environmentId}/drafts/${draftId}/models`,
    headers: {
      cookie,
      'x-csrf-token': csrf,
      'idempotency-key': 'release-drift-model-create',
      'if-match': '"2"',
    },
    payload: mutation(provider.json().id as string),
  })
  assert.equal(created.statusCode, 201, created.body)
  const submitted = await app.inject({
    method: 'POST',
    url: `/api/environments/${environmentId}/drafts/${draftId}/submit`,
    headers: { cookie, 'x-csrf-token': csrf, 'if-match': '"3"' },
  })
  const releaseId = submitted.json().release.id as string
  const executed = await app.inject({
    method: 'POST',
    url: `/api/environments/${environmentId}/releases/${releaseId}/execute`,
    headers: { cookie, 'x-csrf-token': csrf },
  })
  assert.equal(executed.statusCode, 202, executed.body)

  let detail
  for (let attempt = 0; attempt < 20; attempt += 1) {
    detail = await app.inject({
      method: 'GET',
      url: `/api/environments/${environmentId}/releases/${releaseId}`,
      headers: { cookie },
    })
    if (detail.json().state !== 'PUBLISHING') break
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  assert.equal(detail?.json().state, 'FAILED')
  assert.equal(detail?.json().publicationState, 'DRIFTED')
  assert.equal(publisher.writes.length, 0)
  assert.equal(
    detail?.json().resources.find((resource: { kind: string }) => resource.kind === 'MODELS')
      .errorCode,
    'RELEASE_DRIFTED',
  )
  assert.equal(detail?.body.includes('DRIFT_TEST_SECRET_MUST_NOT_LEAK'), false)
})

test('approval-required model publishes its empty access group before Provider resources', async (context) => {
  const publisher = new FakeMarketplacePublisher()
  const app = buildApp({
    marketplacePublisher: publisher,
    accessGroupPublisher: {
      publish: (input) => publisher.publish({ ...input, expectedOldMd5: null }),
    },
  })
  context.after(() => app.close())
  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/development-login',
    payload: { username: 'admin' },
  })
  const cookie = cookieHeader(login.headers['set-cookie'])
  const csrf = cookieValue(cookie, 'fg_csrf')
  const environments = await app.inject({
    method: 'GET',
    url: '/api/me/environments',
    headers: { cookie },
  })
  const environmentId = environments.json().items[0].environment.id as string
  const list = await app.inject({
    method: 'GET',
    url: `/api/environments/${environmentId}/models?view=admin`,
    headers: { cookie },
  })
  const draftId = list.json().draft.id as string
  const provider = await app.inject({
    method: 'POST',
    url: `/api/environments/${environmentId}/drafts/${draftId}/providers`,
    headers: {
      cookie,
      'x-csrf-token': csrf,
      'idempotency-key': 'approval-provider-create-0001',
      'if-match': '"1"',
    },
    payload: providerMutation('ACCESS_GROUP_SECRET_MUST_NOT_LEAK'),
  })
  assert.equal(provider.statusCode, 201, provider.body)
  const model = mutation(provider.json().id as string)
  model.accessMode = 'APPROVAL_REQUIRED'
  const created = await app.inject({
    method: 'POST',
    url: `/api/environments/${environmentId}/drafts/${draftId}/models`,
    headers: {
      cookie,
      'x-csrf-token': csrf,
      'idempotency-key': 'approval-model-create-0001',
      'if-match': '"2"',
    },
    payload: model,
  })
  assert.equal(created.statusCode, 201, created.body)
  const providerName = created.json().providers[0].providerName as string
  const submitted = await app.inject({
    method: 'POST',
    url: `/api/environments/${environmentId}/drafts/${draftId}/submit`,
    headers: { cookie, 'x-csrf-token': csrf, 'if-match': '"3"' },
  })
  const releaseId = submitted.json().release.id as string
  const executed = await app.inject({
    method: 'POST',
    url: `/api/environments/${environmentId}/releases/${releaseId}/execute`,
    headers: { cookie, 'x-csrf-token': csrf },
  })
  assert.equal(executed.statusCode, 202, executed.body)

  let detail
  for (let attempt = 0; attempt < 20; attempt += 1) {
    detail = await app.inject({
      method: 'GET',
      url: `/api/environments/${environmentId}/releases/${releaseId}`,
      headers: { cookie },
    })
    if (detail.json().state !== 'PUBLISHING') break
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  assert.equal(detail?.json().state, 'COMPLETED')
  assert.equal(detail?.json().groupDependencies[0].state, 'READY')
  assert.equal(publisher.writes[0].dataId.startsWith('ploto.ai-llm.user-group.'), true)
  assert.deepEqual(
    publisher.writes.slice(1).map((write) => write.dataId),
    [`ploto.ai-llm.provider.${providerName}`, 'ploto.ai-llm.models'],
  )
  assert.equal(detail?.body.includes('ACCESS_GROUP_SECRET_MUST_NOT_LEAK'), false)
})

test('renderer uses fixed Data IDs, deterministic ordering and exact uint64 JSON integers', async () => {
  const encryptionKey = Buffer.alloc(32, 7)
  const secrets = new MemoryMarketplaceSecretService(new ValueCipher(encryptionKey), encryptionKey)
  const now = '2026-08-03T00:00:00.000Z'
  const environmentId = '00000000-0000-4000-8000-000000000001'
  const providerId = '00000000-0000-4000-8000-000000000002'
  const tokenId = '00000000-0000-4000-8000-000000000003'
  const value = Uint8Array.from(Buffer.from('renderer-secret'))
  const secret = await secrets.createProviderToken({
    environmentId,
    providerId,
    tokenId,
    value,
    actorId: '00000000-0000-4000-8000-000000000004',
    now,
  })
  value.fill(0)
  const version: MarketplaceVersionRecord = {
    id: '00000000-0000-4000-8000-000000000005',
    environmentId,
    kind: 'RELEASE',
    state: 'FROZEN',
    baseReleaseVersionId: null,
    schemaVersion: 42,
    revision: 1,
    createdBy: '00000000-0000-4000-8000-000000000004',
    createdAt: now,
    updatedAt: now,
    frozenAt: now,
    providers: [
      {
        id: providerId,
        providerName: 'mp_chat_pro_abcdef123456',
        ownership: 'SHARED',
        ownerModelId: null,
        displayName: 'Provider',
        baseUrl: 'https://api.example.test/',
        protocols: [
          {
            type: 'ANTHROPIC_MESSAGES',
            path: '/v1/messages',
            upstreamModelName: 'upstream',
          },
          {
            type: 'OPENAI_CHAT_COMPLETIONS',
            path: '/v1/chat/completions',
            upstreamModelName: 'upstream',
          },
        ],
        tokens: [
          {
            id: tokenId,
            name: 'primary',
            secretId: secret.id,
            fingerprintSuffix: secret.fingerprintSuffix,
            updatedAt: now,
          },
        ],
        createdBy: '00000000-0000-4000-8000-000000000004',
        createdAt: now,
        updatedBy: '00000000-0000-4000-8000-000000000004',
        updatedAt: now,
        archivedAt: null,
      },
    ],
    models: [
      {
        id: '00000000-0000-4000-8000-000000000006',
        logicalModelName: 'chat-pro',
        displayName: 'Chat Pro',
        description: '',
        tags: [],
        prefixMaxBytes: 2_048,
        maxPrimaryAttempts: 0,
        fallbackEnabled: true,
        retryableStatuses: [504, 429, 429],
        rateLimit: {
          windowDurationMillis: '18446744073709551615',
          maxTokensPerWindow: '9007199254740993',
        },
        allowUserGroups: [],
        providerBindings: [
          {
            providerId,
            routeRole: 'PRIMARY',
            sortOrder: 0,
          },
        ],
        createdBy: '00000000-0000-4000-8000-000000000004',
        createdAt: now,
        updatedBy: '00000000-0000-4000-8000-000000000004',
        updatedAt: now,
        archivedAt: null,
      },
    ],
  }

  const providerResources = await renderProviderResources(version, secrets)
  assert.equal(providerResources[0].group, 'LLM-SERVER')
  assert.equal(providerResources[0].dataId, 'ploto.ai-llm.provider.mp_chat_pro_abcdef123456')
  const providerConfig = JSON.parse(providerResources[0].content)
  assert.equal(providerConfig.data.baseurl, 'https://api.example.test')
  assert.equal(providerConfig.data['api-tokens'][0].token, 'renderer-secret')
  assert.deepEqual(
    providerConfig.data.protocol.map((protocol: { type: string }) => protocol.type),
    ['openai-chat-completions', 'anthropic-messages'],
  )

  const models = renderModelsResource(version)
  assert.equal(models.dataId, 'ploto.ai-llm.models')
  assert.match(models.content, /"window-duration-millis":18446744073709551615/u)
  assert.match(models.content, /"max-tokens-per-window":9007199254740993/u)
  assert.deepEqual(
    JSON.parse(models.content).data[0]['load-balance']['retryable-status'],
    [429, 504],
  )
})

test('marketplace MySQL runtime SQL remains single-table and free of subqueries', async () => {
  const source = await readFile(new URL('./mysql-store.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\bJOIN\b/u)
  assert.doesNotMatch(source, /\bUNION\b/u)
  assert.doesNotMatch(source, /\bWITH\b/u)
  assert.doesNotMatch(source, /SELECT\s+COUNT\s*\(/u)
  assert.doesNotMatch(source, /\(\s*SELECT\b/u)
  assert.doesNotMatch(source, /INSERT[\s\S]{0,200}\bSELECT\b/u)
})
