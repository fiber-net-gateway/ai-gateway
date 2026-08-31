import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { buildApp } from '../../app.js'
import { loadConfig } from '../../config/env.js'
import { MemoryLlmCallAuditStore } from './memory-store.js'

const ingestToken = 'audit-ingest-test-token-32-bytes!'

function cookieHeader(setCookie: string | string[] | undefined): string {
  const values = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []
  return values.map((value) => value.split(';', 1)[0]).join('; ')
}

function cookieValue(header: string, name: string): string {
  const value = header
    .split('; ')
    .find((entry) => entry.startsWith(`${name}=`))
    ?.slice(name.length + 1)
  assert.ok(value, `missing ${name} cookie`)
  return decodeURIComponent(value)
}

function auditRecord(input: {
  requestId: string
  username: string
  occurredAt: string
  status?: number
  protocol?: string
  secretMarker?: string
  usage?: { in_cache: number | null; in_nocache: number | null; out: number | null }
}) {
  return {
    occurredAt: input.occurredAt,
    audit: {
      schema_version: 6,
      event: 'llm_request',
      request_id: input.requestId,
      auth_user: input.username,
      requested_model: 'claude-sonnet',
      client_protocol: input.protocol ?? 'anthropic',
      method: 'POST',
      path: '/v1/messages',
      stream: true,
      status: input.status ?? 200,
      duration_ms: 842,
      usage_json: input.usage ?? {
        in_cache: 20,
        in_nocache: 100,
        out: 48,
      },
      client_aborted: false,
      error_json: input.status && input.status >= 400 ? 'upstream_error' : '',
      capture_complete: true,
      message_count: 3,
      tool_count: 1,
      request_body_bytes: 4096,
      response_body_bytes: 1024,
      request_json: `prompt-${input.secretMarker ?? 'private'}`,
      response_json: `answer-${input.secretMarker ?? 'private'}`,
      attempts_json: `provider-token-${input.secretMarker ?? 'private'}`,
      remote_addr: '203.0.113.4',
    },
  }
}

function legacyAuditRecord(input: Parameters<typeof auditRecord>[0]) {
  const record = auditRecord(input)
  return {
    ...record,
    audit: {
      ...record.audit,
      schema_version: 5,
      usage_json: {
        promptTokens: 120,
        completionTokens: 48,
        total_tokens: 168,
      },
    },
  }
}

test('audit ingest is authenticated, idempotent, minimized, and isolated by owner', async (context) => {
  const config = loadConfig()
  config.auditIngest.token = ingestToken
  const auditStore = new MemoryLlmCallAuditStore()
  const app = buildApp({ config, llmCallAuditStore: auditStore })
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

  const createdAlice = await app.inject({
    method: 'POST',
    url: '/api/admin/users',
    headers: { cookie: adminCookie, 'x-csrf-token': adminCsrf },
    payload: {
      username: 'alice',
      displayName: 'Alice',
      systemRole: 'USER',
      environmentIds: [environmentId],
    },
  })
  assert.equal(createdAlice.statusCode, 201)
  const aliceId = createdAlice.json().user.id as string

  const secretMarker = 'DO-NOT-PERSIST-7f3c0e'
  const payload = {
    schemaVersion: 1,
    instanceId: 'ai-server-daily1-dev-01',
    sentAt: '2026-08-04T08:00:04.000Z',
    records: [
      auditRecord({
        requestId: 'req-alice-003',
        username: 'alice',
        occurredAt: '2026-08-04T08:00:03.000Z',
        secretMarker,
      }),
      auditRecord({
        requestId: 'req-alice-002',
        username: 'alice',
        occurredAt: '2026-08-04T08:00:02.000Z',
        status: 500,
        protocol: 'openai',
        usage: { in_cache: null, in_nocache: null, out: 48 },
      }),
      legacyAuditRecord({
        requestId: 'req-alice-001',
        username: 'alice',
        occurredAt: '2026-08-04T08:00:01.000Z',
      }),
      auditRecord({
        requestId: 'req-future-001',
        username: 'future-user',
        occurredAt: '2026-08-04T08:00:00.000Z',
      }),
    ],
  }

  const unauthorized = await app.inject({
    method: 'POST',
    url: '/api/internal/llm-call-audits/batches',
    payload,
  })
  assert.equal(unauthorized.statusCode, 401)
  assert.equal(unauthorized.json().code, 'AUDIT_INGEST_UNAUTHORIZED')

  const ingested = await app.inject({
    method: 'POST',
    url: '/api/internal/llm-call-audits/batches',
    headers: { authorization: `Bearer ${ingestToken}` },
    payload,
  })
  assert.equal(ingested.statusCode, 202)
  assert.deepEqual(ingested.json(), { accepted: 4, duplicates: 0 })

  const replayed = await app.inject({
    method: 'POST',
    url: '/api/internal/llm-call-audits/batches',
    headers: { authorization: `Bearer ${ingestToken}` },
    payload,
  })
  assert.equal(replayed.statusCode, 202)
  assert.deepEqual(replayed.json(), { accepted: 0, duplicates: 4 })

  const aliceLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/development-login',
    payload: { username: 'alice' },
  })
  const aliceCookie = cookieHeader(aliceLogin.headers['set-cookie'])
  const firstPage = await app.inject({
    method: 'GET',
    url: `/api/me/llm-call-audits?environmentId=${environmentId}&limit=2`,
    headers: { cookie: aliceCookie },
  })
  assert.equal(firstPage.statusCode, 200)
  assert.deepEqual(
    firstPage.json().items.map((item: { requestId: string }) => item.requestId),
    ['req-alice-003', 'req-alice-002'],
  )
  assert.ok(firstPage.json().nextCursor)
  assert.equal(firstPage.headers['cache-control'], 'no-store, private')
  assert.equal(firstPage.body.includes(secretMarker), false)
  assert.equal(firstPage.body.includes('request_json'), false)
  assert.equal(firstPage.body.includes('sourceInstanceId'), false)
  assert.deepEqual(firstPage.json().items[0].usage, {
    inCache: 20,
    inNoCache: 100,
    out: 48,
    promptTokens: 120,
    completionTokens: 48,
    totalTokens: 168,
  })
  assert.deepEqual(firstPage.json().items[1].usage, {
    inCache: null,
    inNoCache: null,
    out: 48,
    promptTokens: null,
    completionTokens: 48,
    totalTokens: null,
  })

  const secondPage = await app.inject({
    method: 'GET',
    url: `/api/me/llm-call-audits?environmentId=${environmentId}&limit=2&cursor=${encodeURIComponent(firstPage.json().nextCursor)}`,
    headers: { cookie: aliceCookie },
  })
  assert.deepEqual(
    secondPage.json().items.map((item: { requestId: string }) => item.requestId),
    ['req-alice-001'],
  )
  assert.deepEqual(secondPage.json().items[0].usage, {
    inCache: null,
    inNoCache: null,
    out: 48,
    promptTokens: 120,
    completionTokens: 48,
    totalTokens: 168,
  })
  assert.equal(secondPage.json().nextCursor, null)

  const failedOpenAi = await app.inject({
    method: 'GET',
    url: `/api/me/llm-call-audits?environmentId=${environmentId}&outcome=FAILED&protocol=openai&search=002`,
    headers: { cookie: aliceCookie },
  })
  assert.deepEqual(
    failedOpenAi.json().items.map((item: { requestId: string }) => item.requestId),
    ['req-alice-002'],
  )

  const invalidCursor = await app.inject({
    method: 'GET',
    url: `/api/me/llm-call-audits?environmentId=${environmentId}&cursor=not-a-cursor`,
    headers: { cookie: aliceCookie },
  })
  assert.equal(invalidCursor.statusCode, 400)
  assert.equal(invalidCursor.json().code, 'INVALID_CURSOR')

  const invalidRange = await app.inject({
    method: 'GET',
    url: `/api/me/llm-call-audits?environmentId=${environmentId}&from=2026-08-04T08%3A00%3A03.000Z&to=2026-08-04T08%3A00%3A01.000Z`,
    headers: { cookie: aliceCookie },
  })
  assert.equal(invalidRange.statusCode, 422)
  assert.equal(invalidRange.json().code, 'INVALID_TIME_RANGE')

  const adminOwnCalls = await app.inject({
    method: 'GET',
    url: `/api/me/llm-call-audits?environmentId=${environmentId}`,
    headers: { cookie: adminCookie },
  })
  assert.deepEqual(adminOwnCalls.json().items, [])

  const futureCreated = await app.inject({
    method: 'POST',
    url: '/api/admin/users',
    headers: { cookie: adminCookie, 'x-csrf-token': adminCsrf },
    payload: {
      username: 'future-user',
      displayName: 'Future User',
      systemRole: 'USER',
      environmentIds: [environmentId],
    },
  })
  assert.equal(futureCreated.statusCode, 201)
  const futureLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/development-login',
    payload: { username: 'future-user' },
  })
  const futureCalls = await app.inject({
    method: 'GET',
    url: `/api/me/llm-call-audits?environmentId=${environmentId}`,
    headers: { cookie: cookieHeader(futureLogin.headers['set-cookie']) },
  })
  assert.deepEqual(futureCalls.json().items, [])

  const stored = await auditStore.listForOwner({
    environmentId,
    ownerUserId: aliceId,
    limit: 100,
  })
  assert.equal(stored.length, 3)
  assert.equal(JSON.stringify(stored).includes(secretMarker), false)
})

test('audit ingest rejects unsupported schema and can be explicitly disabled', async (context) => {
  const disabled = buildApp()
  context.after(() => disabled.close())
  const validPayload = {
    schemaVersion: 1,
    instanceId: 'ai-server-01',
    sentAt: '2026-08-04T08:00:01.000Z',
    records: [
      auditRecord({
        requestId: 'req-1',
        username: 'admin',
        occurredAt: '2026-08-04T08:00:00.000Z',
      }),
    ],
  }
  const disabledResponse = await disabled.inject({
    method: 'POST',
    url: '/api/internal/llm-call-audits/batches',
    headers: { authorization: `Bearer ${ingestToken}` },
    payload: validPayload,
  })
  assert.equal(disabledResponse.statusCode, 503)
  assert.equal(disabledResponse.json().code, 'AUDIT_INGEST_DISABLED')

  const config = loadConfig()
  config.auditIngest.token = ingestToken
  const enabled = buildApp({ config })
  context.after(() => enabled.close())
  const unsupported = structuredClone(validPayload)
  unsupported.records[0].audit.schema_version = 4 as 6
  const response = await enabled.inject({
    method: 'POST',
    url: '/api/internal/llm-call-audits/batches',
    headers: { authorization: `Bearer ${ingestToken}` },
    payload: unsupported,
  })
  assert.equal(response.statusCode, 400)
  assert.equal(response.json().code, 'VALIDATION_FAILED')

  const redundantUsage = structuredClone(validPayload)
  const redundantUsageFields = redundantUsage.records[0].audit.usage_json as Record<string, unknown>
  redundantUsageFields.total_tokens = 168
  const redundantUsageResponse = await enabled.inject({
    method: 'POST',
    url: '/api/internal/llm-call-audits/batches',
    headers: { authorization: `Bearer ${ingestToken}` },
    payload: redundantUsage,
  })
  assert.equal(redundantUsageResponse.statusCode, 400)
  assert.equal(redundantUsageResponse.json().code, 'VALIDATION_FAILED')

  config.auditIngest.bodyLimitBytes = 64 * 1024
  const limited = buildApp({ config })
  context.after(() => limited.close())
  const oversized = structuredClone(validPayload)
  oversized.records[0].audit.request_json = 'x'.repeat(70 * 1024)
  const oversizedResponse = await limited.inject({
    method: 'POST',
    url: '/api/internal/llm-call-audits/batches',
    headers: { authorization: `Bearer ${ingestToken}` },
    payload: oversized,
  })
  assert.equal(oversizedResponse.statusCode, 413)
  assert.equal(oversizedResponse.json().code, 'PAYLOAD_TOO_LARGE')
})

test('MySQL audit store uses strict single-table SQL', async () => {
  const source = await readFile(new URL('./mysql-store.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\bJOIN\b|\bUNION\b|\bWITH\s+[A-Za-z_]/u)
  assert.doesNotMatch(source, /\(\s*SELECT\b/u)
  assert.doesNotMatch(source, /SELECT\s+COUNT\s*\(/u)
  assert.doesNotMatch(source, /INSERT[\s\S]{0,200}\bSELECT\b/u)
})
