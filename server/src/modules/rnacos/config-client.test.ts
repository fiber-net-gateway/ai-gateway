import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { RnacosConfigClient, RnacosConfigError } from './config-client.js'

const options = {
  environmentId: '00000000-0000-4000-8000-000000000001',
  baseUrl: 'http://127.0.0.1:8848',
  namespaceId: 'namespace-a',
  tenant: 'tenant-a',
  username: '',
  password: '',
  configGroup: 'LLM-SERVER',
}

test('rnacos config client sends CAS and verifies the exact target readback', async () => {
  const content = '{"version":1,"data":[]}'
  const expectedMd5 = createHash('md5').update(content, 'utf8').digest('hex')
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const client = new RnacosConfigClient(options, async (input, init) => {
    calls.push({ url: String(input), init })
    return calls.length === 1 ? new Response('true') : new Response(content)
  })

  const result = await client.publish({
    environmentId: options.environmentId,
    group: 'LLM-SERVER',
    dataId: 'ploto.ai-llm.models',
    content,
    expectedMd5,
    expectedOldMd5: '0123456789abcdef0123456789abcdef',
  })

  assert.equal(result.readbackMd5, expectedMd5)
  const form = calls[0].init?.body as URLSearchParams
  assert.equal(form.get('casMd5'), '0123456789abcdef0123456789abcdef')
  assert.equal(form.get('dataId'), 'ploto.ai-llm.models')
  assert.equal(form.get('group'), 'LLM-SERVER')
  assert.equal(form.get('tenant'), 'tenant-a')
  assert.equal(calls[1].url.includes('dataId=ploto.ai-llm.models'), true)
})

test('rnacos config client rejects an environment that is not bound to the process', async () => {
  let called = false
  const client = new RnacosConfigClient(options, async () => {
    called = true
    return new Response('unexpected')
  })

  await assert.rejects(
    client.read({
      environmentId: '00000000-0000-4000-8000-000000000099',
      group: 'LLM-SERVER',
      dataId: 'ploto.ai-llm.models',
    }),
    (error: unknown) =>
      error instanceof RnacosConfigError && error.code === 'RNACOS_ENVIRONMENT_UNBOUND',
  )
  assert.equal(called, false)
})

test('rnacos config client identifies a CAS conflict from safe readback evidence', async () => {
  const foreign = '{"version":1,"data":["foreign"]}'
  let call = 0
  const client = new RnacosConfigClient(options, async () => {
    call += 1
    return call === 1 ? new Response('false') : new Response(foreign)
  })

  await assert.rejects(
    client.publish({
      environmentId: options.environmentId,
      group: 'LLM-SERVER',
      dataId: 'ploto.ai-llm.models',
      content: '{"version":1,"data":[]}',
      expectedMd5: '0123456789abcdef0123456789abcdef',
      expectedOldMd5: 'abcdef0123456789abcdef0123456789',
    }),
    (error: unknown) => error instanceof RnacosConfigError && error.code === 'RNACOS_CAS_CONFLICT',
  )
  assert.equal(call, 2)
})
