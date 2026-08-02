import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

import { DomainError } from './errors.js'

export interface Clock {
  now(): Date
}

export interface RandomSource {
  bytes(size: number): Buffer
}

export const systemClock: Clock = {
  now: () => new Date(),
}

export const systemRandom: RandomSource = {
  bytes: (size) => randomBytes(size),
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

export function hmacSha256Hex(key: Buffer, value: string): string {
  return createHmac('sha256', key).update(value).digest('hex')
}

export function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left)
  const rightBuffer = Buffer.from(right)
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer)
}

export interface SealedValue {
  ciphertext: string
  nonce: string
}

export class ValueCipher {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) {
      throw new Error('ValueCipher requires a 32-byte key')
    }
  }

  seal(value: string, context: string): SealedValue {
    const nonce = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce)
    cipher.setAAD(Buffer.from(context))
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return {
      ciphertext: Buffer.concat([encrypted, tag]).toString('base64url'),
      nonce: nonce.toString('base64url'),
    }
  }

  open(value: SealedValue, context: string): string {
    try {
      const payload = Buffer.from(value.ciphertext, 'base64url')
      const nonce = Buffer.from(value.nonce, 'base64url')
      const tag = payload.subarray(payload.length - 16)
      const encrypted = payload.subarray(0, payload.length - 16)
      const decipher = createDecipheriv('aes-256-gcm', this.key, nonce)
      decipher.setAAD(Buffer.from(context))
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8')
    } catch {
      throw new DomainError('TOKEN_DELIVERY_UNAVAILABLE', 410, 'Token 交付内容已失效')
    }
  }
}

export interface IssuedBt1Token {
  rawToken: string
  nonce: string
  fingerprint: string
  expiresAt: Date
  acceptedUntil: Date
}

export function issueBt1Token(input: {
  username: string
  kid: string
  secret: Buffer
  ttlSeconds: number
  clockSkewSeconds: number
  now: Date
  random: RandomSource
}): IssuedBt1Token {
  const usernameBytes = Buffer.from(input.username, 'utf8')
  if (usernameBytes.length === 0 || usernameBytes.length > 64) {
    throw new DomainError('INVALID_USERNAME', 422, 'username 的 UTF-8 编码必须为 1..64 字节')
  }
  if (!/^[A-Za-z0-9_-]{1,16}$/.test(input.kid)) {
    throw new DomainError('SIGNING_KEY_UNAVAILABLE', 503, 'BT1 kid 不符合 ai-server 契约')
  }
  const nowSeconds = Math.floor(input.now.getTime() / 1000)
  const expiresSeconds = nowSeconds + input.ttlSeconds
  const user = usernameBytes.toString('base64url')
  const nonce = input.random.bytes(16).toString('base64url')
  const signingInput = `BT1.${input.kid}.${user}.${expiresSeconds}.${nonce}`
  const mac = createHmac('sha256', input.secret).update(signingInput).digest('base64url')
  const rawToken = `${signingInput}.${mac}`
  if (nonce.length !== 22 || mac.length !== 43 || rawToken.length > 512) {
    throw new DomainError('TOKEN_GENERATION_FAILED', 500, '生成的 BT1 Token 不符合 ai-server 契约')
  }
  return {
    rawToken,
    nonce,
    fingerprint: sha256Hex(rawToken),
    expiresAt: new Date(expiresSeconds * 1000),
    acceptedUntil: new Date((expiresSeconds + input.clockSkewSeconds) * 1000),
  }
}
