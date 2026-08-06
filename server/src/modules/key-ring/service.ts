import { createHash } from 'node:crypto'

import type { Clock } from '../users/crypto.js'
import { sha256Hex } from '../users/crypto.js'
import { DomainError } from '../users/errors.js'
import type { AuthenticatedActor } from '../users/services.js'
import type { SigningKeyRecord, UserStore } from '../users/types.js'
import type { MarketplaceConfigPublisher, RnacosConfigRead } from '../rnacos/config-client.js'
import { RnacosConfigError } from '../rnacos/config-client.js'

const dataId = 'ploto.ai-llm.auth.bt1.keys'

type PublicationState = 'UNAVAILABLE' | 'NOT_PUBLISHED' | 'PUBLISHED' | 'DRIFTED' | 'UNKNOWN'

interface RenderedKeyRing {
  content: string
  targetMd5: string
  contentBytes: number
  keys: SigningKeyRecord[]
}

function isPublishable(key: SigningKeyRecord, now: Date): boolean {
  if (
    key.keyState !== 'ACTIVE' &&
    key.keyState !== 'PUBLISHED_UNVERIFIED' &&
    key.keyState !== 'RETIRING'
  ) {
    return false
  }
  return !key.retireAfter || Date.parse(key.retireAfter) > now.getTime()
}

function safeKey(key: SigningKeyRecord) {
  return {
    id: key.id,
    kid: key.kid,
    keyState: key.keyState,
    issuanceEnabled: key.issuanceEnabled,
    clockSkewSeconds: key.clockSkewSeconds,
    retireAfter: key.retireAfter,
    revision: key.revision,
    fingerprintSuffix: sha256Hex(key.secret).slice(-12),
  }
}

function safeReadError(error: unknown): string {
  return error instanceof RnacosConfigError ? error.code : 'RNACOS_UNAVAILABLE'
}

export class KeyRingService {
  constructor(
    private readonly store: UserStore,
    private readonly clock: Clock,
    private readonly publisher: MarketplaceConfigPublisher | null,
  ) {}

  async inspect(environmentId: string) {
    const rendered = await this.render(environmentId)
    try {
      if (!this.publisher || this.publisher.target().environmentId !== environmentId) {
        return this.view(rendered, 'UNAVAILABLE', null, 'RNACOS_ENVIRONMENT_UNBOUND')
      }
      let readback: RnacosConfigRead
      try {
        readback = await this.publisher.read({ environmentId, group: 'LLM-SERVER', dataId })
      } catch (error) {
        return this.view(rendered, 'UNKNOWN', null, safeReadError(error))
      }
      const state: PublicationState =
        readback.state === 'NOT_FOUND'
          ? 'NOT_PUBLISHED'
          : readback.md5 === rendered.targetMd5
            ? 'PUBLISHED'
            : 'DRIFTED'
      return this.view(rendered, state, readback.md5, null)
    } finally {
      this.dispose(rendered.keys)
    }
  }

  async publish(input: {
    environmentId: string
    actor: AuthenticatedActor
    correlationId: string
  }) {
    if (!this.publisher) {
      throw new DomainError('RNACOS_PUBLISHER_UNAVAILABLE', 503, '当前进程未配置 rnacos 发布能力')
    }
    if (this.publisher.target().environmentId !== input.environmentId) {
      throw new DomainError(
        'RNACOS_ENVIRONMENT_UNBOUND',
        409,
        '当前环境未绑定到本进程的 rnacos 目标',
      )
    }
    const rendered = await this.render(input.environmentId)
    try {
      const current = await this.publisher.read({
        environmentId: input.environmentId,
        group: 'LLM-SERVER',
        dataId,
      })
      const published = await this.publisher.publish({
        environmentId: input.environmentId,
        group: 'LLM-SERVER',
        dataId,
        content: rendered.content,
        expectedMd5: rendered.targetMd5,
        expectedOldMd5: current.md5,
      })
      const now = this.clock.now().toISOString()
      await this.store.markSigningKeysPublished(input.environmentId, now)
      await this.store.appendAudit({
        actor: input.actor.user,
        eventType: 'bt1_key_ring.published',
        targetType: 'nacos_config',
        targetId: null,
        environmentId: input.environmentId,
        correlationId: input.correlationId,
        payload: {
          dataId,
          group: 'LLM-SERVER',
          targetMd5: rendered.targetMd5,
          readbackMd5: published.readbackMd5,
          keyCount: rendered.keys.length,
          contentBytes: rendered.contentBytes,
        },
        occurredAt: now,
      })
      const refreshed = await this.render(input.environmentId)
      try {
        return this.view(refreshed, 'PUBLISHED', published.readbackMd5, null)
      } finally {
        this.dispose(refreshed.keys)
      }
    } catch (error) {
      if (error instanceof DomainError) throw error
      if (error instanceof RnacosConfigError) {
        throw new DomainError(
          error.code,
          error.code === 'RNACOS_CAS_CONFLICT' ? 409 : 503,
          error.message,
        )
      }
      throw new DomainError('RNACOS_UNAVAILABLE', 503, 'rnacos 暂时不可用')
    } finally {
      this.dispose(rendered.keys)
    }
  }

  private async render(environmentId: string): Promise<RenderedKeyRing> {
    const keys = await this.store.listSigningKeys(environmentId)
    const publishable = keys.filter((key) => isPublishable(key, this.clock.now()))
    if (publishable.length === 0) {
      this.dispose(keys)
      throw new DomainError('BT1_KEY_RING_EMPTY', 409, '当前环境没有可发布的 BT1 key')
    }
    const skews = new Set(publishable.map((key) => key.clockSkewSeconds))
    if (skews.size !== 1) {
      this.dispose(keys)
      throw new DomainError('BT1_KEY_RING_SKEW_CONFLICT', 409, '可发布 key 的 clock skew 不一致')
    }
    const content = JSON.stringify({
      version: 1,
      data: {
        clockSkewSec: publishable[0]!.clockSkewSeconds,
        keys: publishable
          .slice()
          .sort((left, right) => Buffer.from(left.kid).compare(Buffer.from(right.kid)))
          .map((key) => ({ kid: key.kid, secret: `base64:${key.secret.toString('base64')}` })),
      },
    })
    return {
      content,
      targetMd5: createHash('md5').update(content, 'utf8').digest('hex'),
      contentBytes: Buffer.byteLength(content, 'utf8'),
      keys,
    }
  }

  private view(
    rendered: RenderedKeyRing,
    publicationState: PublicationState,
    readbackMd5: string | null,
    errorCode: string | null,
  ) {
    return {
      dataId,
      group: 'LLM-SERVER' as const,
      target: this.publisher?.target() ?? null,
      publicationState,
      targetMd5: rendered.targetMd5,
      readbackMd5,
      contentBytes: rendered.contentBytes,
      errorCode,
      activationState: 'UNKNOWN' as const,
      activationEvidence: 'NONE' as const,
      keys: rendered.keys.map(safeKey),
    }
  }

  private dispose(keys: SigningKeyRecord[]): void {
    for (const key of keys) key.secret.fill(0)
  }
}
