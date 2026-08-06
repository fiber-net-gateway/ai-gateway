import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { buildApp } from '../../app.js'
import type { MarketplaceConfigPublisher, RnacosConfigRead } from '../rnacos/config-client.js'

const environmentId = '00000000-0000-4000-8000-000000000001'

class FakePublisher implements MarketplaceConfigPublisher {
  content: string | null = null

  target() {
    return { environmentId, namespaceId: 'public', tenant: '', group: 'LLM-SERVER' as const }
  }

  async read(): Promise<RnacosConfigRead> {
    return this.content === null
      ? { state: 'NOT_FOUND', content: null, md5: null }
      : { state: 'PRESENT', content: this.content, md5: md5(this.content) }
  }

  async publish(input: {
    environmentId: string
    group: 'LLM-SERVER'
    dataId: string
    content: string
    expectedMd5: string
    expectedOldMd5: string | null
  }): Promise<{ readbackMd5: string }> {
    assert.equal(input.environmentId, environmentId)
    assert.equal(input.group, 'LLM-SERVER')
    assert.equal(input.dataId, 'ploto.ai-llm.auth.bt1.keys')
    assert.equal(input.expectedOldMd5, this.content === null ? null : md5(this.content))
    assert.equal(input.expectedMd5, md5(input.content))
    this.content = input.content
    return { readbackMd5: input.expectedMd5 }
  }
}

function md5(value: string): string {
  return createHash('md5').update(value, 'utf8').digest('hex')
}

function cookieHeader(value: string | string[] | undefined): string {
  const values = Array.isArray(value) ? value : value ? [value] : []
  return values.map((entry) => entry.split(';', 1)[0]).join('; ')
}

function csrfFrom(cookie: string): string {
  const value = cookie
    .split('; ')
    .find((entry) => entry.startsWith('fg_csrf='))
    ?.slice('fg_csrf='.length)
  assert.ok(value)
  return decodeURIComponent(value)
}

test('BT1 Key Ring publishes fixed target and never returns secret material', async (context) => {
  const publisher = new FakePublisher()
  const app = buildApp({ marketplacePublisher: publisher })
  context.after(() => app.close())

  const login = await app.inject({
    method: 'POST',
    url: '/api/auth/development-login',
    payload: { username: 'admin' },
  })
  const cookie = cookieHeader(login.headers['set-cookie'])
  const csrf = csrfFrom(cookie)

  const before = await app.inject({
    method: 'GET',
    url: `/api/environments/${environmentId}/bt1-key-ring`,
    headers: { cookie },
  })
  assert.equal(before.statusCode, 200)
  assert.equal(before.json().publicationState, 'NOT_PUBLISHED')
  assert.equal(before.json().activationState, 'UNKNOWN')
  assert.equal(before.json().activationEvidence, 'NONE')
  assert.equal(before.json().keys[0].kid, 'dev-key')
  assert.equal(before.body.includes('QkJCQkJCQkJCQkJC'), false)
  assert.equal(before.body.includes('secret'), false)

  const published = await app.inject({
    method: 'POST',
    url: `/api/environments/${environmentId}/bt1-key-ring/publish`,
    headers: { cookie, 'x-csrf-token': csrf },
  })
  assert.equal(published.statusCode, 200, published.body)
  assert.equal(published.json().publicationState, 'PUBLISHED')
  assert.equal(published.json().targetMd5, published.json().readbackMd5)
  assert.equal(published.body.includes('QkJCQkJCQkJCQkJC'), false)
  assert.match(publisher.content ?? '', /"data":\{"clockSkewSec":60,"keys":\[/u)
  assert.match(publisher.content ?? '', /"kid":"dev-key"/u)
  assert.match(publisher.content ?? '', /"secret":"base64:/u)

  const after = await app.inject({
    method: 'GET',
    url: `/api/environments/${environmentId}/bt1-key-ring`,
    headers: { cookie },
  })
  assert.equal(after.statusCode, 200)
  assert.equal(after.json().publicationState, 'PUBLISHED')

  const audit = await app.inject({
    method: 'GET',
    url: '/api/admin/audit-events',
    headers: { cookie },
  })
  const event = audit
    .json()
    .items.find(
      (candidate: { eventType: string }) => candidate.eventType === 'bt1_key_ring.published',
    )
  assert.ok(event)
  assert.equal(JSON.stringify(event).includes('QkJCQkJCQkJCQkJC'), false)
})
