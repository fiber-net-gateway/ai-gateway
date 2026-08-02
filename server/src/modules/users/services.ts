import { randomUUID } from 'node:crypto'

import { type Clock, issueBt1Token, type RandomSource, sha256Hex, ValueCipher } from './crypto.js'
import { assertDomain, DomainError } from './errors.js'
import type {
  CreateUserInput,
  SessionRecord,
  SystemRole,
  UpdateUserInput,
  UserListQuery,
  UserRecord,
  UserStatus,
  UserStore,
  UserTokenRecord,
} from './types.js'

const RESERVED_USERNAMES = new Set(['zhangwang'])

function iso(date: Date): string {
  return date.toISOString()
}

function addSeconds(date: Date, seconds: number): Date {
  return new Date(date.getTime() + seconds * 1000)
}

export class UserService {
  constructor(
    private readonly store: UserStore,
    private readonly clock: Clock,
  ) {}

  async getById(id: string): Promise<UserRecord> {
    const user = await this.store.getUserById(id)
    assertDomain(user, 'USER_NOT_FOUND', 404, '用户不存在')
    return user
  }

  async list(query: UserListQuery): Promise<UserRecord[]> {
    return this.store.listUsers(query)
  }

  async create(input: CreateUserInput, actor: UserRecord): Promise<UserRecord> {
    this.requireAdmin(actor)
    this.validateUsername(input.username)
    assertDomain(input.displayName.trim(), 'VALIDATION_FAILED', 422, '显示名称不能为空')
    assertDomain(
      input.systemRole === 'USER' || input.systemRole === 'ADMIN',
      'VALIDATION_FAILED',
      422,
      '角色不合法',
    )
    return this.store.createUser(
      {
        ...input,
        username: input.username.trim(),
        displayName: input.displayName.trim(),
        email: input.email?.trim() || null,
      },
      actor,
      iso(this.clock.now()),
    )
  }

  async update(id: string, input: UpdateUserInput, actor: UserRecord): Promise<UserRecord> {
    this.requireAdmin(actor)
    if (input.displayName !== undefined) {
      assertDomain(input.displayName.trim(), 'VALIDATION_FAILED', 422, '显示名称不能为空')
      input.displayName = input.displayName.trim()
    }
    return this.store.updateUser(id, input, actor, iso(this.clock.now()))
  }

  async activate(id: string, actor: UserRecord, expectedRevision?: number): Promise<UserRecord> {
    return this.update(id, { status: 'ACTIVE', expectedRevision }, actor)
  }

  async suspend(id: string, actor: UserRecord, expectedRevision?: number): Promise<UserRecord> {
    return this.update(id, { status: 'SUSPENDED', expectedRevision }, actor)
  }

  async delete(id: string, actor: UserRecord, expectedRevision?: number): Promise<UserRecord> {
    return this.update(id, { status: 'DELETED', expectedRevision }, actor)
  }

  async loginDevelopment(username: string): Promise<UserRecord> {
    const user = await this.store.getUserByUsername(username)
    assertDomain(user, 'INVALID_CREDENTIALS', 401, '用户不存在或不可登录')
    this.assertLoginAllowed(user)
    return this.store.markUserLogin(user.id, iso(this.clock.now()))
  }

  async loginOidc(provider: string, subject: string): Promise<UserRecord> {
    const user = await this.store.getUserByExternalSubject(provider, subject)
    assertDomain(user, 'SSO_ACCOUNT_NOT_PROVISIONED', 403, 'SSO 账号尚未在控制台中开通')
    this.assertLoginAllowed(user)
    return this.store.markUserLogin(user.id, iso(this.clock.now()))
  }

  requireAdmin(user: UserRecord): void {
    assertDomain(user.systemRole === 'ADMIN', 'FORBIDDEN', 403, '需要管理员权限')
  }

  private validateUsername(username: string): void {
    const normalized = username.trim()
    const size = Buffer.byteLength(normalized, 'utf8')
    assertDomain(size >= 1 && size <= 64, 'VALIDATION_FAILED', 422, 'username 必须为 1..64 字节')
    assertDomain(normalized === username, 'VALIDATION_FAILED', 422, 'username 不能包含首尾空白')
    assertDomain(
      !/[\u0000-\u001f\u007f]/u.test(username),
      'VALIDATION_FAILED',
      422,
      'username 不能包含控制字符',
    )
    assertDomain(
      !RESERVED_USERNAMES.has(username),
      'USERNAME_RESERVED',
      422,
      '该 username 为安全保留名',
    )
  }

  private assertLoginAllowed(user: UserRecord): void {
    assertDomain(
      user.status === 'ACTIVE' || user.status === 'PENDING',
      'USER_NOT_ACTIVE',
      403,
      '用户已被暂停或删除',
    )
  }
}

export interface AuthenticatedActor {
  user: UserRecord
  session: SessionRecord
}

export interface IssuedSession {
  rawSessionToken: string
  rawCsrfToken: string
  session: SessionRecord
}

export class SessionService {
  constructor(
    private readonly store: UserStore,
    private readonly clock: Clock,
    private readonly random: RandomSource,
  ) {}

  async create(user: UserRecord, mfaAuthenticated = false): Promise<IssuedSession> {
    const now = this.clock.now()
    const rawSessionToken = this.random.bytes(32).toString('base64url')
    const rawCsrfToken = this.random.bytes(24).toString('base64url')
    const absoluteExpiresAt = addSeconds(now, 8 * 60 * 60)
    const session = await this.store.createSession({
      userId: user.id,
      sessionTokenHash: sha256Hex(rawSessionToken),
      csrfTokenHash: sha256Hex(rawCsrfToken),
      mfaTime: mfaAuthenticated ? iso(now) : null,
      now: iso(now),
      idleExpiresAt: iso(addSeconds(now, 30 * 60)),
      absoluteExpiresAt: iso(absoluteExpiresAt),
    })
    return { rawSessionToken, rawCsrfToken, session }
  }

  async authenticate(rawSessionToken: string | undefined): Promise<AuthenticatedActor> {
    assertDomain(rawSessionToken, 'AUTHENTICATION_REQUIRED', 401, '请先登录')
    const now = iso(this.clock.now())
    const session = await this.store.getSessionByTokenHash(sha256Hex(rawSessionToken), now)
    assertDomain(session, 'SESSION_EXPIRED', 401, '登录会话已失效')
    const user = await this.store.getUserById(session.userId)
    assertDomain(user && user.status === 'ACTIVE', 'USER_NOT_ACTIVE', 401, '用户不可登录')
    return { user, session }
  }

  verifyCsrf(actor: AuthenticatedActor, rawCsrfToken: string | undefined): void {
    assertDomain(
      rawCsrfToken && sha256Hex(rawCsrfToken) === actor.session.csrfTokenHash,
      'CSRF_VALIDATION_FAILED',
      403,
      'CSRF 校验失败',
    )
  }

  async revoke(actor: AuthenticatedActor): Promise<void> {
    await this.store.revokeSession(actor.session.id, actor.user.id, iso(this.clock.now()))
  }
}

export interface TokenView {
  id: string
  name: string
  environmentId: string
  kid: string
  fingerprint: string
  issuedAt: string
  expiresAt: string
  acceptedUntil: string
  disabledAt: string | null
  compromiseSuspected: boolean
  state: 'ACTIVE' | 'GRACE' | 'EXPIRED' | 'DISABLED'
  lastUsedAt: string | null
}

export interface TokenIssueResult extends TokenView {
  username: string
  token: string
  deliveryExpiresAt: string
  replayed: boolean
  runtimeState: 'KEY_EFFECTIVE' | 'KEY_PUBLISHED_UNVERIFIED'
}

export class TokenService {
  constructor(
    private readonly store: UserStore,
    private readonly clock: Clock,
    private readonly random: RandomSource,
    private readonly cipher: ValueCipher,
  ) {}

  async list(userId: string): Promise<TokenView[]> {
    const now = this.clock.now()
    const tokens = await this.store.listTokens(userId)
    return tokens.map((token) => this.toView(token, now))
  }

  async issue(input: {
    ownerUserId: string
    environmentId: string
    name: string
    ttlSeconds?: number
    reason?: string
    actor: AuthenticatedActor
    idempotencyKey: string
    correlationId: string
  }): Promise<TokenIssueResult> {
    const now = this.clock.now()
    const ownerIsActor = input.ownerUserId === input.actor.user.id
    if (!ownerIsActor) {
      assertDomain(
        input.actor.user.systemRole === 'ADMIN',
        'FORBIDDEN',
        403,
        '不能为其他用户签发 Token',
      )
      assertDomain(input.reason?.trim(), 'VALIDATION_FAILED', 422, '管理员代签必须填写原因')
      assertDomain(
        input.actor.session.mfaTime && nowWithinSeconds(now, input.actor.session.mfaTime, 5 * 60),
        'REAUTHENTICATION_REQUIRED',
        403,
        '管理员代签需要五分钟内完成二次认证',
      )
    }
    assertDomain(
      input.idempotencyKey.length >= 8 && input.idempotencyKey.length <= 128,
      'IDEMPOTENCY_KEY_REQUIRED',
      400,
      'Token 签发需要有效的 Idempotency-Key',
    )
    const name = input.name.trim()
    assertDomain(
      name.length >= 1 && name.length <= 64,
      'VALIDATION_FAILED',
      422,
      'Token 名称必须为 1..64 字符',
    )
    const context = await this.store.getTokenIssuanceContext(
      input.ownerUserId,
      input.environmentId,
      iso(now),
    )
    assertDomain(context, 'ENVIRONMENT_ACCESS_DENIED', 403, '用户没有目标环境访问权限')
    assertDomain(context.user.status === 'ACTIVE', 'USER_NOT_ACTIVE', 409, '用户不是有效状态')
    assertDomain(
      context.access.canIssueTokens,
      'TOKEN_ISSUANCE_DISABLED',
      409,
      '该用户已禁用 Token 签发',
    )
    assertDomain(
      context.policy.selfServiceEnabled,
      'TOKEN_ISSUANCE_DISABLED',
      409,
      '环境未开启 Token 签发',
    )
    const keyIsEffective = context.signingKey.keyState === 'ACTIVE'
    const keyIsAllowed =
      keyIsEffective ||
      (!context.policy.requireEffectiveKey &&
        context.signingKey.keyState === 'PUBLISHED_UNVERIFIED')
    assertDomain(keyIsAllowed, 'SIGNING_KEY_NOT_EFFECTIVE', 409, '签名 key 尚未满足环境生效策略')

    const maxTtl = Math.min(
      context.policy.maxTtlSeconds,
      context.access.maxTokenTtlSeconds ?? Number.MAX_SAFE_INTEGER,
      30 * 24 * 60 * 60,
    )
    const ttlSeconds = input.ttlSeconds ?? context.policy.defaultTtlSeconds
    assertDomain(
      Number.isInteger(ttlSeconds) &&
        ttlSeconds >= context.policy.minTtlSeconds &&
        ttlSeconds <= maxTtl,
      'TOKEN_POLICY_VIOLATION',
      422,
      `Token 有效期必须在 ${context.policy.minTtlSeconds}..${maxTtl} 秒之间`,
    )
    const maxActiveTokens = Math.min(
      context.policy.maxActiveTokensPerUser,
      context.access.maxActiveTokens ?? Number.MAX_SAFE_INTEGER,
      20,
    )
    assertDomain(
      context.activeTokenCount < maxActiveTokens,
      'TOKEN_POLICY_VIOLATION',
      422,
      '活跃 Token 数已达到上限',
    )

    let issued
    try {
      issued = issueBt1Token({
        username: context.user.username,
        kid: context.signingKey.kid,
        secret: context.signingKey.secret,
        ttlSeconds,
        clockSkewSeconds: context.signingKey.clockSkewSeconds,
        now,
        random: this.random,
      })
    } finally {
      context.signingKey.secret.fill(0)
    }
    if (context.signingKey.retireAfter) {
      assertDomain(
        issued.acceptedUntil.getTime() <= Date.parse(context.signingKey.retireAfter),
        'TOKEN_POLICY_VIOLATION',
        422,
        'Token 最晚接受时间超过签名 key 的计划退役时间',
      )
    }

    const tokenId = randomUUID()
    const deliveryExpiresAt = addSeconds(now, context.policy.deliveryTtlSeconds)
    const sealed = this.cipher.seal(issued.rawToken, `token-delivery:${tokenId}`)
    const requestHash = sha256Hex(
      JSON.stringify({
        ownerUserId: input.ownerUserId,
        environmentId: input.environmentId,
        name,
        ttlSeconds,
        reason: input.reason?.trim() || null,
      }),
    )
    const token: UserTokenRecord = {
      id: tokenId,
      userId: input.ownerUserId,
      environmentId: input.environmentId,
      signingKeyId: context.signingKey.id,
      tokenName: name,
      tokenFingerprint: issued.fingerprint,
      tokenNonce: issued.nonce,
      bt1Version: 'BT1',
      kid: context.signingKey.kid,
      clockSkewSeconds: context.signingKey.clockSkewSeconds,
      issuedBy: input.actor.user.id,
      issuedForReason: input.reason?.trim() || null,
      issuedAt: iso(now),
      expiresAt: iso(issued.expiresAt),
      acceptedUntil: iso(issued.acceptedUntil),
      disabledAt: null,
      disabledBy: null,
      disableReason: null,
      compromiseSuspected: false,
      lastUsedAt: null,
      lastUsedSource: null,
      createdAt: iso(now),
      updatedAt: iso(now),
    }
    const committed = await this.store.commitToken({
      token,
      delivery: {
        tokenId,
        sessionId: input.actor.session.id,
        idempotencyKeyHash: sha256Hex(input.idempotencyKey),
        requestHash,
        ciphertext: sealed.ciphertext,
        nonce: sealed.nonce,
        createdAt: iso(now),
        expiresAt: iso(deliveryExpiresAt),
        purgedAt: null,
      },
      maxActiveTokens,
      actor: input.actor.user,
      correlationId: input.correlationId,
    })
    assertDomain(
      !committed.delivery.purgedAt &&
        Date.parse(committed.delivery.expiresAt) >= now.getTime() &&
        committed.delivery.ciphertext &&
        committed.delivery.nonce,
      'TOKEN_DELIVERY_EXPIRED',
      410,
      'Token 已签发，但一次性交付窗口已结束',
    )
    const rawToken = this.cipher.open(
      { ciphertext: committed.delivery.ciphertext, nonce: committed.delivery.nonce },
      `token-delivery:${committed.token.id}`,
    )
    return {
      ...this.toView(committed.token, now),
      username: context.user.username,
      token: rawToken,
      deliveryExpiresAt: committed.delivery.expiresAt,
      replayed: committed.replayed,
      runtimeState: keyIsEffective ? 'KEY_EFFECTIVE' : 'KEY_PUBLISHED_UNVERIFIED',
    }
  }

  async disable(input: {
    tokenId: string
    ownerUserId?: string
    actor: AuthenticatedActor
    reason: string
    compromiseSuspected: boolean
    correlationId: string
  }): Promise<
    TokenView & { managementState: 'DISABLED'; runtimeEnforced: false; message: string }
  > {
    assertDomain(input.reason.trim(), 'VALIDATION_FAILED', 422, '停用原因不能为空')
    const token = await this.store.disableToken({
      tokenId: input.tokenId,
      ownerUserId: input.ownerUserId,
      actor: input.actor.user,
      reason: input.reason.trim(),
      compromiseSuspected: input.compromiseSuspected,
      now: iso(this.clock.now()),
      correlationId: input.correlationId,
    })
    return {
      ...this.toView(token, this.clock.now()),
      managementState: 'DISABLED',
      runtimeEnforced: false,
      message: 'ai-server 当前不支持单 Token 撤销，该 Token 到期前仍可能有效',
    }
  }

  async purgeDelivery(tokenId: string, actor: AuthenticatedActor): Promise<void> {
    const token = await this.store.getTokenById(tokenId)
    assertDomain(
      token && (token.userId === actor.user.id || actor.user.systemRole === 'ADMIN'),
      'TOKEN_NOT_FOUND',
      404,
      'Token 不存在',
    )
    await this.store.purgeDelivery(tokenId, actor.session.id, iso(this.clock.now()))
  }

  private toView(token: UserTokenRecord, now: Date): TokenView {
    let state: TokenView['state']
    if (token.disabledAt) state = 'DISABLED'
    else if (now.getTime() <= Date.parse(token.expiresAt)) state = 'ACTIVE'
    else if (now.getTime() <= Date.parse(token.acceptedUntil)) state = 'GRACE'
    else state = 'EXPIRED'
    return {
      id: token.id,
      name: token.tokenName,
      environmentId: token.environmentId,
      kid: token.kid,
      fingerprint: token.tokenFingerprint.slice(0, 12),
      issuedAt: token.issuedAt,
      expiresAt: token.expiresAt,
      acceptedUntil: token.acceptedUntil,
      disabledAt: token.disabledAt,
      compromiseSuspected: token.compromiseSuspected,
      state,
      lastUsedAt: token.lastUsedAt,
    }
  }
}

export function parseRole(value: unknown): SystemRole | undefined {
  return value === 'USER' || value === 'ADMIN' ? value : undefined
}

export function parseStatus(value: unknown): UserStatus | undefined {
  return value === 'PENDING' || value === 'ACTIVE' || value === 'SUSPENDED' || value === 'DELETED'
    ? value
    : undefined
}

function nowWithinSeconds(now: Date, timestamp: string, seconds: number): boolean {
  const elapsed = now.getTime() - Date.parse(timestamp)
  return elapsed >= 0 && elapsed <= seconds * 1_000
}
