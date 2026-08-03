import { createHmac, randomUUID } from 'node:crypto'

import type { Pool, RowDataPacket } from 'mysql2/promise'

import { ValueCipher } from '../users/crypto.js'
import { DomainError } from '../users/errors.js'
import type { DisposableSecret, MarketplaceSecretService, SecretMetadata } from './types.js'

interface StoredSecret extends SecretMetadata {
  ciphertext: string
  nonce: string
  context: string
}

function contextFor(input: {
  environmentId: string
  providerId: string
  tokenId: string
  secretId: string
}): string {
  return [
    'provider-token',
    input.environmentId,
    input.providerId,
    input.tokenId,
    input.secretId,
  ].join(':')
}

function disposable(value: string): DisposableSecret {
  const bytes = Uint8Array.from(Buffer.from(value, 'utf8'))
  return {
    bytes,
    dispose: () => bytes.fill(0),
  }
}

export class MemoryMarketplaceSecretService implements MarketplaceSecretService {
  private readonly secrets = new Map<string, StoredSecret>()

  constructor(
    private readonly cipher: ValueCipher,
    private readonly fingerprintKey: Buffer,
  ) {}

  async createProviderToken(input: {
    environmentId: string
    providerId: string
    tokenId: string
    value: Uint8Array
    actorId: string
    now: string
  }): Promise<SecretMetadata> {
    const id = randomUUID()
    const value = Buffer.from(input.value).toString('utf8')
    const context = contextFor({ ...input, secretId: id })
    const sealed = this.cipher.seal(value, context)
    const fingerprint = createHmac('sha256', this.fingerprintKey).update(input.value).digest('hex')
    const secret: StoredSecret = {
      id,
      ciphertext: sealed.ciphertext,
      nonce: sealed.nonce,
      context,
      fingerprintSuffix: fingerprint.slice(-6),
      createdAt: input.now,
    }
    this.secrets.set(id, secret)
    return { id, fingerprintSuffix: secret.fingerprintSuffix, createdAt: input.now }
  }

  async decryptForPublication(input: {
    environmentId: string
    providerId: string
    tokenId: string
    secretId: string
  }): Promise<DisposableSecret> {
    const secret = this.secrets.get(input.secretId)
    if (!secret || secret.context !== contextFor(input)) {
      throw new DomainError('PROVIDER_SECRET_UNAVAILABLE', 503, '供应商凭据不可用')
    }
    return disposable(this.cipher.open(secret, secret.context))
  }

  async getMetadata(secretId: string): Promise<SecretMetadata | null> {
    const secret = this.secrets.get(secretId)
    return secret
      ? { id: secret.id, fingerprintSuffix: secret.fingerprintSuffix, createdAt: secret.createdAt }
      : null
  }

  async discardOrphan(secretId: string): Promise<void> {
    this.secrets.delete(secretId)
  }
}

interface SecretRow extends RowDataPacket {
  id: string
  ciphertext: string
  nonce: string
  fingerprint: Buffer
  created_at: Date
  destroyed_at: Date | null
}

export class MySqlMarketplaceSecretService implements MarketplaceSecretService {
  constructor(
    private readonly pool: Pool,
    private readonly cipher: ValueCipher,
    private readonly fingerprintKey: Buffer,
  ) {}

  async createProviderToken(input: {
    environmentId: string
    providerId: string
    tokenId: string
    value: Uint8Array
    actorId: string
    now: string
  }): Promise<SecretMetadata> {
    const id = randomUUID()
    const context = contextFor({ ...input, secretId: id })
    const sealed = this.cipher.seal(Buffer.from(input.value).toString('utf8'), context)
    const fingerprint = createHmac('sha256', this.fingerprintKey).update(input.value).digest()
    await this.pool.query(
      `INSERT INTO managed_secrets
        (id, secret_kind, ciphertext, nonce, fingerprint, created_at, updated_at, destroyed_at)
       VALUES (UUID_TO_BIN(?), 'PROVIDER_TOKEN', ?, ?, ?, ?, ?, NULL)`,
      [id, sealed.ciphertext, sealed.nonce, fingerprint, input.now, input.now],
    )
    return { id, fingerprintSuffix: fingerprint.toString('hex').slice(-6), createdAt: input.now }
  }

  async decryptForPublication(input: {
    environmentId: string
    providerId: string
    tokenId: string
    secretId: string
  }): Promise<DisposableSecret> {
    const [rows] = await this.pool.query<SecretRow[]>(
      `SELECT BIN_TO_UUID(id) AS id, ciphertext, nonce, fingerprint, created_at, destroyed_at
       FROM managed_secrets
       WHERE id = UUID_TO_BIN(?) AND secret_kind = 'PROVIDER_TOKEN'`,
      [input.secretId],
    )
    const row = rows[0]
    if (!row || row.destroyed_at) {
      throw new DomainError('PROVIDER_SECRET_UNAVAILABLE', 503, '供应商凭据不可用')
    }
    return disposable(
      this.cipher.open({ ciphertext: row.ciphertext, nonce: row.nonce }, contextFor(input)),
    )
  }

  async getMetadata(secretId: string): Promise<SecretMetadata | null> {
    const [rows] = await this.pool.query<SecretRow[]>(
      `SELECT BIN_TO_UUID(id) AS id, ciphertext, nonce, fingerprint, created_at, destroyed_at
       FROM managed_secrets
       WHERE id = UUID_TO_BIN(?) AND secret_kind = 'PROVIDER_TOKEN'`,
      [secretId],
    )
    const row = rows[0]
    if (!row || row.destroyed_at) return null
    return {
      id: row.id,
      fingerprintSuffix: row.fingerprint.toString('hex').slice(-6),
      createdAt: row.created_at.toISOString(),
    }
  }

  async discardOrphan(secretId: string, now: string): Promise<void> {
    await this.pool.query(
      `UPDATE managed_secrets
       SET destroyed_at = ?, updated_at = ?
       WHERE id = UUID_TO_BIN(?) AND secret_kind = 'PROVIDER_TOKEN' AND destroyed_at IS NULL`,
      [now, now, secretId],
    )
  }
}
