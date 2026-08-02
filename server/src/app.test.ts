import assert from 'node:assert/strict'
import test from 'node:test'

import { buildApp } from './app.js'

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

test('GET /api/hello returns the service greeting', async (context) => {
  const app = buildApp()
  context.after(() => app.close())

  const response = await app.inject({
    method: 'GET',
    url: '/api/hello',
  })

  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), {
    message: 'Hello World!',
    service: 'ai-server-console-api',
  })
})

test('development session supports user administration and BT1 lifecycle', async (context) => {
  const app = buildApp()
  context.after(() => app.close())

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/development-login',
    payload: { username: 'admin' },
  })
  assert.equal(login.statusCode, 200)
  const cookie = cookieHeader(login.headers['set-cookie'])
  const csrf = cookieValue(cookie, 'fg_csrf')

  const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } })
  assert.equal(me.statusCode, 200)
  assert.equal(me.json().user.systemRole, 'ADMIN')

  const environments = await app.inject({
    method: 'GET',
    url: '/api/me/environments',
    headers: { cookie },
  })
  assert.equal(environments.statusCode, 200)
  const environmentId = environments.json().items[0].environment.id as string

  const createdUser = await app.inject({
    method: 'POST',
    url: '/api/admin/users',
    headers: { cookie, 'x-csrf-token': csrf },
    payload: {
      username: 'alice',
      displayName: 'Alice',
      email: 'alice@example.com',
      systemRole: 'USER',
      environmentIds: [environmentId],
    },
  })
  assert.equal(createdUser.statusCode, 201)
  assert.equal(createdUser.json().user.status, 'PENDING')
  const aliceId = createdUser.json().user.id as string

  const aliceLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/development-login',
    payload: { username: 'alice' },
  })
  assert.equal(aliceLogin.statusCode, 200)
  assert.equal(aliceLogin.json().user.status, 'ACTIVE')

  const reservedUser = await app.inject({
    method: 'POST',
    url: '/api/admin/users',
    headers: { cookie, 'x-csrf-token': csrf },
    payload: {
      username: 'zhangwang',
      displayName: 'Reserved',
      systemRole: 'USER',
      environmentIds: [],
    },
  })
  assert.equal(reservedUser.statusCode, 422)
  assert.equal(reservedUser.json().code, 'USERNAME_RESERVED')

  const missingAdminReason = await app.inject({
    method: 'POST',
    url: `/api/admin/users/${aliceId}/tokens`,
    headers: {
      cookie,
      'x-csrf-token': csrf,
      'idempotency-key': 'admin-issue-missing-reason',
    },
    payload: { environmentId, name: 'admin-created', ttlSeconds: 3_600 },
  })
  assert.equal(missingAdminReason.statusCode, 400)
  assert.equal(missingAdminReason.json().code, 'VALIDATION_FAILED')

  const adminIssued = await app.inject({
    method: 'POST',
    url: `/api/admin/users/${aliceId}/tokens`,
    headers: {
      cookie,
      'x-csrf-token': csrf,
      'idempotency-key': 'admin-issue-0001',
    },
    payload: {
      environmentId,
      name: 'admin-created',
      ttlSeconds: 3_600,
      reason: '为集成测试代签',
    },
  })
  assert.equal(adminIssued.statusCode, 201)
  assert.equal(adminIssued.json().username, 'alice')

  const adminDisabled = await app.inject({
    method: 'POST',
    url: `/api/admin/users/${aliceId}/tokens/${adminIssued.json().id}/disable`,
    headers: { cookie, 'x-csrf-token': csrf },
    payload: { reason: '集成测试结束', compromiseSuspected: false },
  })
  assert.equal(adminDisabled.statusCode, 200)
  assert.equal(adminDisabled.json().managementState, 'DISABLED')

  const idempotencyKey = 'test-request-0001'
  const issued = await app.inject({
    method: 'POST',
    url: '/api/me/tokens',
    headers: { cookie, 'x-csrf-token': csrf, 'idempotency-key': idempotencyKey },
    payload: { environmentId, name: 'local-cli', ttlSeconds: 3_600 },
  })
  assert.equal(issued.statusCode, 201)
  const issuedBody = issued.json()
  assert.match(
    issuedBody.token,
    /^BT1\.dev-key\.YWRtaW4\.\d+\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/,
  )
  assert.equal(issuedBody.runtimeState, 'KEY_EFFECTIVE')

  const replay = await app.inject({
    method: 'POST',
    url: '/api/me/tokens',
    headers: { cookie, 'x-csrf-token': csrf, 'idempotency-key': idempotencyKey },
    payload: { environmentId, name: 'local-cli', ttlSeconds: 3_600 },
  })
  assert.equal(replay.statusCode, 200)
  assert.equal(replay.json().token, issuedBody.token)
  assert.equal(replay.json().replayed, true)

  const conflict = await app.inject({
    method: 'POST',
    url: '/api/me/tokens',
    headers: { cookie, 'x-csrf-token': csrf, 'idempotency-key': idempotencyKey },
    payload: { environmentId, name: 'different-name', ttlSeconds: 3_600 },
  })
  assert.equal(conflict.statusCode, 409)
  assert.equal(conflict.json().code, 'IDEMPOTENCY_CONFLICT')

  const listed = await app.inject({ method: 'GET', url: '/api/me/tokens', headers: { cookie } })
  assert.equal(listed.statusCode, 200)
  assert.equal(listed.json().items.length, 1)
  assert.equal('token' in listed.json().items[0], false)

  const disabled = await app.inject({
    method: 'POST',
    url: `/api/me/tokens/${issuedBody.id}/disable`,
    headers: { cookie, 'x-csrf-token': csrf },
    payload: { reason: '本地凭据不再使用', compromiseSuspected: false },
  })
  assert.equal(disabled.statusCode, 200)
  assert.equal(disabled.json().state, 'DISABLED')
  assert.equal(disabled.json().runtimeEnforced, false)

  const audit = await app.inject({
    method: 'GET',
    url: '/api/admin/audit-events',
    headers: { cookie },
  })
  assert.equal(audit.statusCode, 200)
  assert.ok(
    audit.json().items.some((event: { eventType: string }) => event.eventType === 'token.disabled'),
  )
})

test('ordinary users cannot access administrator APIs', async (context) => {
  const app = buildApp()
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
  const created = await app.inject({
    method: 'POST',
    url: '/api/admin/users',
    headers: { cookie: adminCookie, 'x-csrf-token': adminCsrf },
    payload: {
      username: 'bob',
      displayName: 'Bob',
      systemRole: 'USER',
      environmentIds: [environmentId],
    },
  })
  assert.equal(created.statusCode, 201)

  const userLogin = await app.inject({
    method: 'POST',
    url: '/api/auth/development-login',
    payload: { username: 'bob' },
  })
  assert.equal(userLogin.statusCode, 200)
  const userCookie = cookieHeader(userLogin.headers['set-cookie'])
  const forbidden = await app.inject({
    method: 'GET',
    url: '/api/admin/users',
    headers: { cookie: userCookie },
  })
  assert.equal(forbidden.statusCode, 403)
  assert.equal(forbidden.json().code, 'FORBIDDEN')
})
