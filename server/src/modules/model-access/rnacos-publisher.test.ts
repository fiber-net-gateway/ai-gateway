import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { RnacosAccessGroupPublisher } from './rnacos-publisher.js'

test('rnacos publisher uses the fixed config target and verifies exact readback bytes', async () => {
  const content = '{"version":1,"data":{"name":"pa_provider_a","users":["alice"]}}'
  const expectedMd5 = createHash('md5').update(content, 'utf8').digest('hex')
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init })
    return calls.length === 1 ? new Response('true') : new Response(content)
  }

  try {
    const publisher = new RnacosAccessGroupPublisher({
      baseUrl: 'http://127.0.0.1:8848',
      namespaceId: 'namespace-a',
      tenant: 'tenant-a',
      username: '',
      password: '',
      configGroup: 'LLM-SERVER',
    })
    const result = await publisher.publish({
      group: 'LLM-SERVER',
      dataId: 'ploto.ai-llm.user-group.pa_provider_a',
      content,
      expectedMd5,
    })

    assert.equal(result.readbackMd5, expectedMd5)
    assert.equal(calls.length, 2)
    assert.equal(calls[0].url, 'http://127.0.0.1:8848/nacos/v1/cs/configs')
    assert.equal(calls[0].init?.method, 'POST')
    const write = calls[0].init?.body as URLSearchParams
    assert.equal(write.get('group'), 'LLM-SERVER')
    assert.equal(write.get('tenant'), 'tenant-a')
    assert.equal(write.get('type'), 'json')
    assert.equal(write.get('content'), content)
    const read = new URL(calls[1].url)
    assert.equal(read.pathname, '/nacos/v1/cs/configs')
    assert.equal(read.searchParams.get('group'), 'LLM-SERVER')
    assert.equal(read.searchParams.get('tenant'), 'tenant-a')
    assert.equal(read.searchParams.get('dataId'), 'ploto.ai-llm.user-group.pa_provider_a')
  } finally {
    globalThis.fetch = originalFetch
  }
})
