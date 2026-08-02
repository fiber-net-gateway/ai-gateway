import assert from 'node:assert/strict'
import test from 'node:test'

import { buildApp } from './app.js'

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
