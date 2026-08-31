import assert from 'node:assert/strict'
import test from 'node:test'

import { scanAuditBuffer } from './audit-forwarder-core.js'

function audit(requestId: string) {
  return {
    schema_version: 6,
    event: 'llm_request',
    request_id: requestId,
    auth_user: 'admin',
    requested_model: 'fiber-demo',
    client_protocol: 'openai-chat-completions',
    method: 'POST',
    path: '/v1/chat/completions',
    stream: false,
    status: 200,
    duration_ms: 25,
    usage_json: { in_cache: 1, in_nocache: 2, out: 3 },
    request_json: 'must not leave the sidecar',
    response_json: 'must not leave the sidecar',
    remote_addr: '10.0.0.1',
  }
}

test('audit scanner consumes complete lines, keeps partial tail and strips sensitive fields', () => {
  const first = JSON.stringify(audit('request-1'))
  const second = JSON.stringify(audit('request-2'))
  const invalidIdentity = JSON.stringify({ ...audit('request-invalid'), auth_user: 'a'.repeat(65) })
  const buffer = Buffer.from(
    `${first}\nnot-json\n${invalidIdentity}\n${second.slice(0, 40)}`,
    'utf8',
  )
  const observedAt = new Date('2026-08-05T12:00:00.000Z')

  const result = scanAuditBuffer(buffer, 10, 100, observedAt)

  assert.equal(result.records.length, 1)
  assert.equal(result.records[0]?.occurredAt, '2026-08-05T11:59:59.975Z')
  assert.equal(result.records[0]?.audit.request_id, 'request-1')
  assert.deepEqual(result.records[0]?.audit.usage_json, { in_cache: 1, in_nocache: 2, out: 3 })
  assert.equal('request_json' in result.records[0]!.audit, false)
  assert.equal('response_json' in result.records[0]!.audit, false)
  assert.equal('remote_addr' in result.records[0]!.audit, false)
  assert.equal(result.skipped, 2)
  assert.equal(result.incompleteTail, true)
  assert.equal(
    result.commitOffset,
    10 + Buffer.byteLength(`${first}\nnot-json\n${invalidIdentity}\n`),
  )
})

test('audit scanner forwards legacy v5 usage during a rolling upgrade', () => {
  const current = audit('request-v5')
  const legacy = {
    ...current,
    schema_version: 5,
    usage_json: { promptTokens: 2, completionTokens: 3, total_tokens: 5 },
  }

  const result = scanAuditBuffer(Buffer.from(`${JSON.stringify(legacy)}\n`), 0, 1, new Date())

  assert.equal(result.records.length, 1)
  assert.deepEqual(result.records[0]?.audit.usage_json, legacy.usage_json)
})

test('audit scanner preserves unknown v6 usage components as null', () => {
  const partial = {
    ...audit('request-partial'),
    usage_json: { in_cache: null, in_nocache: null, out: 3 },
  }

  const result = scanAuditBuffer(Buffer.from(`${JSON.stringify(partial)}\n`), 0, 1, new Date())

  assert.equal(result.records.length, 1)
  assert.deepEqual(result.records[0]?.audit.usage_json, partial.usage_json)
})

test('audit scanner rejects derived fields in v6 usage', () => {
  const redundant = {
    ...audit('request-redundant'),
    usage_json: { in_cache: 1, in_nocache: 2, out: 3, total_tokens: 6 },
  }

  const result = scanAuditBuffer(Buffer.from(`${JSON.stringify(redundant)}\n`), 0, 1, new Date())

  assert.equal(result.records.length, 0)
  assert.equal(result.skipped, 1)
})

test('audit scanner stops at batch limit without consuming the next line', () => {
  const first = `${JSON.stringify(audit('request-1'))}\n`
  const second = `${JSON.stringify(audit('request-2'))}\n`

  const result = scanAuditBuffer(Buffer.from(first + second), 0, 1, new Date())

  assert.equal(result.records.length, 1)
  assert.equal(result.commitOffset, Buffer.byteLength(first))
  assert.equal(result.incompleteTail, true)
})
