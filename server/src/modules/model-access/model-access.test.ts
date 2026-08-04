import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { buildApp } from '../../app.js'
import { MemoryMarketplaceStore } from '../model-marketplace/memory-store.js'
import type {
  MarketplaceEnvironmentRecord,
  MarketplaceStore,
  MarketplaceVersionRecord,
  ModelMutationInput,
} from '../model-marketplace/types.js'
import { MemoryModelAccessStore } from './memory-store.js'
import { renderAccessGroup } from './renderer.js'
import { AccessGroupPublisherError } from './rnacos-publisher.js'
import type { AccessGroupPublisher } from './types.js'

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

class PublishedMarketplaceStore implements MarketplaceStore {
  private readonly delegate = new MemoryMarketplaceStore()
  private readonly published = new Map<string, MarketplaceVersionRecord>()

  async ensureEnvironment(input: Parameters<MarketplaceStore['ensureEnvironment']>[0]) {
    const environment = await this.delegate.ensureEnvironment(input)
    environment.publishedVersion = this.published.get(input.environmentId) ?? null
    return environment
  }

  async getEnvironment(environmentId: string): Promise<MarketplaceEnvironmentRecord | null> {
    const environment = await this.delegate.getEnvironment(environmentId)
    if (!environment) return null
    environment.publishedVersion = this.published.get(environmentId) ?? null
    return environment
  }

  saveDraft(input: Parameters<MarketplaceStore['saveDraft']>[0]) {
    return this.delegate.saveDraft(input)
  }

  async createRelease(input: Parameters<MarketplaceStore['createRelease']>[0]) {
    const result = await this.delegate.createRelease(input)
    this.published.set(input.environmentId, structuredClone(result.frozenVersion))
    return result
  }
}

class FailOncePublisher implements AccessGroupPublisher {
  calls: Array<{ dataId: string; content: string; expectedMd5: string }> = []

  async publish(input: {
    group: 'LLM-SERVER'
    dataId: string
    content: string
    expectedMd5: string
  }): Promise<{ readbackMd5: string }> {
    this.calls.push({
      dataId: input.dataId,
      content: input.content,
      expectedMd5: input.expectedMd5,
    })
    if (this.calls.length === 1) {
      throw new AccessGroupPublisherError('RNACOS_UNAVAILABLE', 'rnacos 暂时不可用')
    }
    return { readbackMd5: input.expectedMd5 }
  }
}

function modelMutation(): ModelMutationInput {
  return {
    displayName: '受控对话模型',
    logicalModelName: 'controlled-chat',
    description: '需要管理员审批后调用',
    tags: ['controlled'],
    providers: [
      {
        mode: 'CREATE_DEDICATED',
        displayName: '受控供应商',
        baseUrl: 'https://provider.example',
        routeRole: 'PRIMARY',
        sortOrder: 0,
        protocols: [
          {
            type: 'OPENAI_CHAT_COMPLETIONS',
            path: '/v1/chat/completions',
            upstreamModelName: 'controlled-upstream',
          },
        ],
        authentication: {
          mode: 'NO_CREDENTIALS',
          tokens: [],
          confirmUnauthenticated: true,
        },
      },
    ],
    accessMode: 'APPROVAL_REQUIRED',
    loadBalance: {
      prefixMaxBytes: 2_048,
      maxPrimaryAttempts: 0,
      fallbackEnabled: true,
      retryableStatuses: [429, 502, 503, 504],
    },
    rateLimit: null,
  }
}

test('model access approval preserves failure, retries publication and does not claim activation', async (context) => {
  const publisher = new FailOncePublisher()
  const app = buildApp({
    marketplaceStore: new PublishedMarketplaceStore(),
    modelAccessStore: new MemoryModelAccessStore(),
    accessGroupPublisher: publisher,
  })
  context.after(() => app.close())

  const adminLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/development-login',
    payload: { username: 'admin' },
  })
  const adminCookie = cookieHeader(adminLogin.headers['set-cookie'])
  const adminCsrf = cookieValue(adminCookie, 'fg_csrf')
  const environments = await app.inject({
    method: 'GET',
    url: '/api/me/environments',
    headers: { cookie: adminCookie },
  })
  const environmentId = environments.json().items[0].environment.id as string

  const user = await app.inject({
    method: 'POST',
    url: '/api/admin/users',
    headers: { cookie: adminCookie, 'x-csrf-token': adminCsrf },
    payload: {
      username: 'alice-access',
      displayName: 'Alice Access',
      systemRole: 'USER',
      environmentIds: [environmentId],
    },
  })
  assert.equal(user.statusCode, 201, user.body)

  const adminList = await app.inject({
    method: 'GET',
    url: `/api/environments/${environmentId}/models?view=admin`,
    headers: { cookie: adminCookie },
  })
  const draftId = adminList.json().draft.id as string
  const key = await app.inject({
    method: 'POST',
    url: '/api/idempotency-keys',
    headers: { cookie: adminCookie, 'x-csrf-token': adminCsrf },
  })
  const created = await app.inject({
    method: 'POST',
    url: `/api/environments/${environmentId}/drafts/${draftId}/models`,
    headers: {
      cookie: adminCookie,
      'x-csrf-token': adminCsrf,
      'idempotency-key': key.json().key,
      'if-match': adminList.headers.etag!,
    },
    payload: modelMutation(),
  })
  assert.equal(created.statusCode, 201, created.body)
  assert.equal(created.json().accessMode, 'APPROVAL_REQUIRED')
  assert.equal(created.json().allowUserGroups.length, 1)
  const modelId = created.json().id as string

  const submitted = await app.inject({
    method: 'POST',
    url: `/api/environments/${environmentId}/drafts/${draftId}/submit`,
    headers: {
      cookie: adminCookie,
      'x-csrf-token': adminCsrf,
      'if-match': created.headers.etag!,
    },
  })
  assert.equal(submitted.statusCode, 202, submitted.body)

  const aliceLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/development-login',
    payload: { username: 'alice-access' },
  })
  const aliceCookie = cookieHeader(aliceLogin.headers['set-cookie'])
  const aliceCsrf = cookieValue(aliceCookie, 'fg_csrf')
  const availableBefore = await app.inject({
    method: 'GET',
    url: `/api/environments/${environmentId}/models?view=available`,
    headers: { cookie: aliceCookie },
  })
  assert.equal(availableBefore.statusCode, 200, availableBefore.body)
  assert.equal(availableBefore.json().items[0].accessible, false)
  assert.equal(availableBefore.json().items[0].requestable, true)

  const requested = await app.inject({
    method: 'POST',
    url: `/api/environments/${environmentId}/models/${modelId}/access-requests`,
    headers: {
      cookie: aliceCookie,
      'x-csrf-token': aliceCsrf,
      'idempotency-key': 'alice-controlled-chat-0001',
    },
    payload: { reason: '用于团队内部知识库问答和文档摘要' },
  })
  assert.equal(requested.statusCode, 201, requested.body)
  assert.equal(requested.json().status, 'PENDING')
  assert.equal('groupName' in requested.json(), false)
  const requestId = requested.json().id as string

  const pending = await app.inject({
    method: 'GET',
    url: `/api/admin/model-access-requests?environmentId=${environmentId}&status=PENDING`,
    headers: { cookie: adminCookie },
  })
  assert.equal(pending.statusCode, 200, pending.body)
  assert.equal(pending.json().items[0].affectedModels[0].id, modelId)

  const approved = await app.inject({
    method: 'POST',
    url: `/api/admin/model-access-requests/${requestId}/approve`,
    headers: {
      cookie: adminCookie,
      'x-csrf-token': adminCsrf,
      'if-match': `"${requested.json().revision}"`,
    },
    payload: { reason: '用途与影响范围确认通过' },
  })
  assert.equal(approved.statusCode, 200, approved.body)
  assert.equal(approved.json().status, 'APPROVED')
  assert.equal(approved.json().publicationState, 'FAILED')
  assert.equal(approved.json().activationState, 'UNKNOWN')
  assert.equal(publisher.calls.length, 1)
  assert.match(publisher.calls[0].dataId, /^ploto\.ai-llm\.user-group\.pa_/u)
  assert.deepEqual(JSON.parse(publisher.calls[0].content).data.users, ['alice-access'])

  const unavailableAfterApproval = await app.inject({
    method: 'GET',
    url: `/api/environments/${environmentId}/models?view=available`,
    headers: { cookie: aliceCookie },
  })
  assert.equal(unavailableAfterApproval.json().items[0].accessible, false)

  const retried = await app.inject({
    method: 'POST',
    url: `/api/admin/model-access-requests/${requestId}/retry-publication`,
    headers: {
      cookie: adminCookie,
      'x-csrf-token': adminCsrf,
    },
  })
  assert.equal(retried.statusCode, 200, retried.body)
  assert.equal(retried.json().status, 'APPROVED')
  assert.equal(retried.json().publicationState, 'PUBLISHED')
  assert.equal(retried.json().activationState, 'UNKNOWN')
  assert.equal(publisher.calls.length, 2)
  assert.deepEqual(publisher.calls[1], publisher.calls[0])

  const availableAfter = await app.inject({
    method: 'GET',
    url: `/api/environments/${environmentId}/models?view=available`,
    headers: { cookie: aliceCookie },
  })
  assert.equal(availableAfter.json().items[0].accessible, true)
  assert.equal(availableAfter.json().items[0].activationState, 'UNKNOWN')

  const adminRequest = await app.inject({
    method: 'POST',
    url: `/api/environments/${environmentId}/models/${modelId}/access-requests`,
    headers: {
      cookie: adminCookie,
      'x-csrf-token': adminCsrf,
      'idempotency-key': 'admin-controlled-chat-0001',
    },
    payload: { reason: '用于管理员验证受控模型的返回契约' },
  })
  assert.equal(adminRequest.statusCode, 201, adminRequest.body)
  const selfApproval = await app.inject({
    method: 'POST',
    url: `/api/admin/model-access-requests/${adminRequest.json().id}/approve`,
    headers: {
      cookie: adminCookie,
      'x-csrf-token': adminCsrf,
      'if-match': `"${adminRequest.json().revision}"`,
    },
    payload: {},
  })
  assert.equal(selfApproval.statusCode, 409, selfApproval.body)
  assert.equal(selfApproval.json().code, 'SELF_APPROVAL_FORBIDDEN')
})

test('access group renderer is byte-stable and MySQL SQL stays single-table', async () => {
  const rendered = renderAccessGroup(
    {
      id: '00000000-0000-4000-8000-000000000010',
      environmentId: '00000000-0000-4000-8000-000000000001',
      providerId: '00000000-0000-4000-8000-000000000011',
      providerName: 'provider-a',
      groupName: 'pa_provider_a_0123456789',
      revision: 7,
      publishedRevision: 0,
      createdBy: '00000000-0000-4000-8000-000000000001',
      createdAt: '2026-08-03T00:00:00.000Z',
      updatedAt: '2026-08-03T00:00:00.000Z',
    },
    ['zoe', 'alice', 'zoe'],
  )
  assert.equal(
    rendered.content,
    '{"version":7,"data":{"name":"pa_provider_a_0123456789","users":["alice","zoe"]}}',
  )
  const source = await readFile(new URL('./mysql-store.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\bJOIN\b|\bUNION\b|\bWITH\s+[A-Za-z_]/u)
  assert.doesNotMatch(source, /\(\s*SELECT\b/u)
})
