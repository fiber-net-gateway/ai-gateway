import assert from 'node:assert/strict'
import test from 'node:test'

import { issueBt1Token, ValueCipher } from './crypto.js'

test('BT1 generation matches the ai-server compatible golden vector', () => {
  const result = issueBt1Token({
    username: 'alice',
    kid: 'key_2026',
    secret: Buffer.alloc(32, 0x42),
    ttlSeconds: 3_600,
    clockSkewSeconds: 60,
    now: new Date('2023-11-14T22:13:20.000Z'),
    random: { bytes: () => Buffer.from(Array.from({ length: 16 }, (_, index) => index)) },
  })

  assert.equal(
    result.rawToken,
    'BT1.key_2026.YWxpY2U.1700003600.AAECAwQFBgcICQoLDA0ODw.cEDCi4eAaiSuSW2amZNOmqOntpEDzlVQY5vzCuFQXtk',
  )
  assert.equal(
    result.fingerprint,
    'df9253d067734789d2fb852d262142a64b9595e544996b9ca36c780daf467005',
  )
  assert.equal(result.expiresAt.toISOString(), '2023-11-14T23:13:20.000Z')
  assert.equal(result.acceptedUntil.toISOString(), '2023-11-14T23:14:20.000Z')
})

test('encrypted delivery is bound to its context', () => {
  const cipher = new ValueCipher(Buffer.alloc(32, 0x44))
  const sealed = cipher.seal('BT1.sensitive-value', 'token-delivery:one')

  assert.equal(cipher.open(sealed, 'token-delivery:one'), 'BT1.sensitive-value')
  assert.throws(() => cipher.open(sealed, 'token-delivery:two'), {
    message: 'Token 交付内容已失效',
  })
})
