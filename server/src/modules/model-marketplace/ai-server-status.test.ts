import assert from 'node:assert/strict'
import test from 'node:test'

import { AiServerConfigStatusError, HttpAiServerConfigStatusReader } from './ai-server-status.js'

test('ai-server config status reader accepts exact safe evidence without configuration content', async () => {
  const reader = new HttpAiServerConfigStatusReader('http://ai-server.test/', async (input) => {
    assert.equal(String(input), 'http://ai-server.test/internal/config/status')
    return Response.json({
      schemaVersion: 1,
      state: 'ACTIVE',
      generation: 9,
      workerIndex: 0,
      workers: { count: 2, converged: true, generations: [9, 9] },
      resources: [
        {
          dataId: 'ploto.ai-llm.models',
          group: 'LLM-SERVER',
          md5: '0123456789abcdef0123456789abcdef',
          version: 4,
        },
      ],
    })
  })

  const status = await reader.read()
  assert.equal(reader.instanceId, 'http://ai-server.test')
  assert.equal(status.workers.converged, true)
  assert.equal(status.resources[0].dataId, 'ploto.ai-llm.models')
})

test('ai-server config status reader rejects malformed MD5 evidence', async () => {
  const reader = new HttpAiServerConfigStatusReader('http://ai-server.test', async () =>
    Response.json({
      schemaVersion: 1,
      state: 'ACTIVE',
      generation: 9,
      workerIndex: 0,
      workers: { count: 1, converged: true, generations: [9] },
      resources: [
        {
          dataId: 'ploto.ai-llm.models',
          group: 'LLM-SERVER',
          md5: 'not-an-md5',
          version: 4,
        },
      ],
    }),
  )

  await assert.rejects(
    reader.read(),
    (error: unknown) =>
      error instanceof AiServerConfigStatusError && error.code === 'AI_SERVER_STATUS_INVALID',
  )
})
