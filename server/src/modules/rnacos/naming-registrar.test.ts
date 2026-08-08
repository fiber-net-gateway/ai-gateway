import assert from 'node:assert/strict'
import test from 'node:test'

import type { RnacosConfig, RnacosRegistrationConfig } from '../../config/env.js'
import { RnacosNamingHttpClient } from './naming-registrar.js'

const config: RnacosConfig & { registration: RnacosRegistrationConfig } = {
  environmentId: '00000000-0000-4000-8000-000000000001',
  baseUrl: 'http://rnacos:8848',
  namespaceId: 'public',
  tenant: '',
  username: 'console',
  password: 'secret',
  configGroup: 'LLM-SERVER',
  registration: {
    enabled: true,
    advertiseAddress: '172.28.0.40',
    advertisePort: 3000,
    serviceName: 'ai-server-console-api',
    serviceGroup: 'AI-GATEWAY',
    clusterName: 'DEFAULT',
    heartbeatIntervalMillis: 5_000,
  },
}

test('rnacos naming client registers, beats, and deregisters only the fixed console service', async () => {
  const requests: Array<{ url: string; method: string; form: URLSearchParams }> = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    const form = init?.body as URLSearchParams
    requests.push({ url, method: init?.method ?? 'GET', form })
    if (url.endsWith('/nacos/v1/auth/users/login')) {
      return Response.json({ accessToken: 'access-token', tokenTtl: 3600 })
    }
    if (url.endsWith('/beat')) {
      return Response.json({ clientBeatInterval: 7_500 })
    }
    return new Response('ok')
  }
  const client = new RnacosNamingHttpClient(config, fetcher)

  await client.register(config.registration)
  assert.equal(await client.heartbeat(config.registration), 7_500)
  await client.deregister(config.registration)

  assert.deepEqual(
    requests.map(({ url, method }) => [url.replace(config.baseUrl, ''), method]),
    [
      ['/nacos/v1/auth/users/login', 'POST'],
      ['/nacos/v1/ns/instance', 'POST'],
      ['/nacos/v1/ns/instance/beat', 'PUT'],
      ['/nacos/v1/ns/instance', 'DELETE'],
    ],
  )
  for (const request of requests.slice(1)) {
    assert.equal(request.form.get('serviceName'), 'AI-GATEWAY@@ai-server-console-api')
    assert.equal(request.form.get('groupName'), 'AI-GATEWAY')
    assert.equal(request.form.get('accessToken'), 'access-token')
  }
  assert.equal(requests[1]?.form.get('ip'), '172.28.0.40')
  assert.equal(requests[1]?.form.get('port'), '3000')
})
