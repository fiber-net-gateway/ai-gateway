import { randomUUID } from 'node:crypto'

import { DomainError } from './errors.js'
import type {
  AppendAuditInput,
  AuditEventRecord,
  BootstrapInput,
  CommitTokenInput,
  CreateSessionInput,
  CreateUserInput,
  DisableTokenInput,
  EncryptedDelivery,
  EnvironmentAccessRecord,
  EnvironmentRecord,
  SessionRecord,
  SigningKeyRecord,
  TokenCommitResult,
  TokenIssuanceContext,
  TokenPolicyRecord,
  UpdateUserInput,
  UserListQuery,
  UserRecord,
  UserStore,
  UserTokenRecord,
} from './types.js'

function copy<T>(value: T): T {
  return structuredClone(value)
}

export class MemoryUserStore implements UserStore {
  private readonly users = new Map<string, UserRecord>()
  private readonly environments = new Map<string, EnvironmentRecord>()
  private readonly access = new Map<string, EnvironmentAccessRecord>()
  private readonly policies = new Map<string, TokenPolicyRecord>()
  private readonly signingKeys = new Map<string, SigningKeyRecord>()
  private readonly sessions = new Map<string, SessionRecord>()
  private readonly sessionByHash = new Map<string, string>()
  private readonly tokens = new Map<string, UserTokenRecord>()
  private readonly deliveries = new Map<string, EncryptedDelivery>()
  private readonly deliveryByIdempotency = new Map<string, string>()
  private readonly auditEvents: AuditEventRecord[] = []
  private auditSequence = 0

  async bootstrap(input: BootstrapInput): Promise<void> {
    if (this.environments.size === 0) {
      this.environments.set(input.environment.id, {
        id: input.environment.id,
        name: input.environment.name,
        stage: input.environment.stage,
        revision: 1,
        createdAt: input.now,
        updatedAt: input.now,
      })
      this.policies.set(input.environment.id, { ...input.policy, revision: 1 })
      const signingKey: SigningKeyRecord = {
        id: randomUUID(),
        environmentId: input.environment.id,
        kid: input.signingKey.kid,
        secret: Buffer.from(input.signingKey.secret),
        keyState: input.signingKey.keyState,
        issuanceEnabled: true,
        clockSkewSeconds: input.signingKey.clockSkewSeconds,
        retireAfter: null,
        revision: 1,
      }
      this.signingKeys.set(signingKey.id, signingKey)
    }

    let admin = [...this.users.values()].find((user) => user.username === input.admin.username)
    if (!admin) {
      admin = {
        id: randomUUID(),
        username: input.admin.username,
        displayName: input.admin.displayName,
        email: input.admin.email,
        systemRole: 'ADMIN',
        status: 'ACTIVE',
        authProvider: input.admin.authProvider,
        externalSubject: input.admin.externalSubject,
        revision: 1,
        lastLoginAt: null,
        createdAt: input.now,
        updatedAt: input.now,
        deletedAt: null,
      }
      this.users.set(admin.id, admin)
    }
    this.ensureAccess(admin.id, input.environment.id, admin.id, input.now)
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    const user = this.users.get(id)
    return user ? copy(user) : null
  }

  async getUserByUsername(username: string): Promise<UserRecord | null> {
    const user = [...this.users.values()].find((candidate) => candidate.username === username)
    return user ? copy(user) : null
  }

  async getUserByExternalSubject(provider: string, subject: string): Promise<UserRecord | null> {
    const user = [...this.users.values()].find(
      (candidate) => candidate.authProvider === provider && candidate.externalSubject === subject,
    )
    return user ? copy(user) : null
  }

  async listUsers(query: UserListQuery): Promise<UserRecord[]> {
    const search = query.search?.toLocaleLowerCase()
    return [...this.users.values()]
      .filter((user) => {
        if (query.role && user.systemRole !== query.role) return false
        if (query.status && user.status !== query.status) return false
        if (
          search &&
          !user.username.toLocaleLowerCase().includes(search) &&
          !user.displayName.toLocaleLowerCase().includes(search) &&
          !user.email?.toLocaleLowerCase().includes(search)
        ) {
          return false
        }
        return true
      })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map(copy)
  }

  async createUser(input: CreateUserInput, actor: UserRecord, now: string): Promise<UserRecord> {
    if ([...this.users.values()].some((user) => user.username === input.username)) {
      throw new DomainError('USERNAME_CONFLICT', 409, 'username 已存在')
    }
    if (
      [...this.users.values()].some(
        (user) =>
          user.authProvider === input.authProvider &&
          user.externalSubject === input.externalSubject,
      )
    ) {
      throw new DomainError('AUTH_SUBJECT_CONFLICT', 409, 'SSO 身份已绑定其他用户')
    }
    const user: UserRecord = {
      id: randomUUID(),
      username: input.username,
      displayName: input.displayName,
      email: input.email,
      systemRole: input.systemRole,
      status: 'PENDING',
      authProvider: input.authProvider,
      externalSubject: input.externalSubject,
      revision: 1,
      lastLoginAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    }
    this.users.set(user.id, user)
    for (const environmentId of input.environmentIds) {
      this.ensureAccess(user.id, environmentId, actor.id, now)
    }
    await this.appendAudit({
      actor,
      eventType: 'user.created',
      targetType: 'user',
      targetId: user.id,
      correlationId: randomUUID(),
      payload: { username: user.username, role: user.systemRole },
      occurredAt: now,
    })
    return copy(user)
  }

  async updateUser(
    id: string,
    input: UpdateUserInput,
    actor: UserRecord,
    now: string,
  ): Promise<UserRecord> {
    const user = this.users.get(id)
    if (!user) throw new DomainError('USER_NOT_FOUND', 404, '用户不存在')
    if (input.expectedRevision && input.expectedRevision !== user.revision) {
      throw new DomainError('REVISION_CONFLICT', 412, '用户信息已被其他操作更新')
    }
    if (id === actor.id && input.systemRole && input.systemRole !== user.systemRole) {
      throw new DomainError('SELF_ROLE_CHANGE_FORBIDDEN', 409, '管理员不能修改自己的角色')
    }
    const removesAdmin =
      user.systemRole === 'ADMIN' &&
      user.status === 'ACTIVE' &&
      (input.systemRole === 'USER' || input.status === 'SUSPENDED' || input.status === 'DELETED')
    if (removesAdmin) {
      const activeAdmins = [...this.users.values()].filter(
        (candidate) => candidate.systemRole === 'ADMIN' && candidate.status === 'ACTIVE',
      ).length
      if (activeAdmins <= 1) {
        throw new DomainError('LAST_ADMIN_REQUIRED', 409, '系统必须至少保留一个有效管理员')
      }
    }
    const previousStatus = user.status
    user.displayName = input.displayName ?? user.displayName
    user.email = input.email === undefined ? user.email : input.email
    user.systemRole = input.systemRole ?? user.systemRole
    user.status = input.status ?? user.status
    user.deletedAt = user.status === 'DELETED' ? now : null
    user.revision += 1
    user.updatedAt = now
    if (
      previousStatus !== user.status &&
      (user.status === 'SUSPENDED' || user.status === 'DELETED')
    ) {
      await this.revokeAllSessions(user.id, now)
    }
    await this.appendAudit({
      actor,
      eventType: 'user.updated',
      targetType: 'user',
      targetId: user.id,
      correlationId: randomUUID(),
      payload: { role: user.systemRole, status: user.status, revision: user.revision },
      occurredAt: now,
    })
    return copy(user)
  }

  async markUserLogin(id: string, now: string): Promise<UserRecord> {
    const user = this.users.get(id)
    if (!user) throw new DomainError('USER_NOT_FOUND', 404, '用户不存在')
    if (user.status === 'PENDING') user.status = 'ACTIVE'
    user.lastLoginAt = now
    user.updatedAt = now
    user.revision += 1
    return copy(user)
  }

  async listEnvironmentsForUser(userId: string) {
    const result: Array<{
      environment: EnvironmentRecord
      access: EnvironmentAccessRecord
      policy: TokenPolicyRecord
    }> = []
    for (const access of this.access.values()) {
      if (access.userId !== userId || access.revokedAt) continue
      const environment = this.environments.get(access.environmentId)
      const policy = this.policies.get(access.environmentId)
      if (environment && policy) {
        result.push({ environment: copy(environment), access: copy(access), policy: copy(policy) })
      }
    }
    return result.sort((left, right) => left.environment.name.localeCompare(right.environment.name))
  }

  async grantEnvironmentAccess(
    userId: string,
    environmentId: string,
    actor: UserRecord,
    now: string,
  ): Promise<EnvironmentAccessRecord> {
    return copy(this.ensureAccess(userId, environmentId, actor.id, now))
  }

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const session: SessionRecord = {
      id: randomUUID(),
      userId: input.userId,
      sessionTokenHash: input.sessionTokenHash,
      csrfTokenHash: input.csrfTokenHash,
      authTime: input.now,
      mfaTime: input.mfaTime,
      createdAt: input.now,
      lastSeenAt: input.now,
      idleExpiresAt: input.idleExpiresAt,
      absoluteExpiresAt: input.absoluteExpiresAt,
      revokedAt: null,
    }
    this.sessions.set(session.id, session)
    this.sessionByHash.set(session.sessionTokenHash, session.id)
    return copy(session)
  }

  async getSessionByTokenHash(hash: string, now: string): Promise<SessionRecord | null> {
    const id = this.sessionByHash.get(hash)
    const session = id ? this.sessions.get(id) : undefined
    if (
      !session ||
      session.revokedAt ||
      Date.parse(now) > Date.parse(session.idleExpiresAt) ||
      Date.parse(now) > Date.parse(session.absoluteExpiresAt)
    ) {
      return null
    }
    session.lastSeenAt = now
    session.idleExpiresAt = new Date(
      Math.min(Date.parse(now) + 30 * 60_000, Date.parse(session.absoluteExpiresAt)),
    ).toISOString()
    return copy(session)
  }

  async revokeSession(id: string, userId: string, now: string): Promise<void> {
    const session = this.sessions.get(id)
    if (session?.userId === userId) session.revokedAt = now
  }

  async revokeAllSessions(userId: string, now: string): Promise<void> {
    for (const session of this.sessions.values()) {
      if (session.userId === userId && !session.revokedAt) session.revokedAt = now
    }
  }

  async listSigningKeys(environmentId: string): Promise<SigningKeyRecord[]> {
    return [...this.signingKeys.values()]
      .filter((key) => key.environmentId === environmentId)
      .sort((left, right) => left.kid.localeCompare(right.kid, 'en'))
      .map((key) => ({ ...copy(key), secret: Buffer.from(key.secret) }))
  }

  async markSigningKeysPublished(environmentId: string, _now: string): Promise<void> {
    for (const key of this.signingKeys.values()) {
      if (key.environmentId !== environmentId || key.keyState !== 'PUBLISHED_UNVERIFIED') continue
      key.keyState = 'ACTIVE'
      key.revision += 1
    }
  }

  async getTokenIssuanceContext(
    userId: string,
    environmentId: string,
    now: string,
  ): Promise<TokenIssuanceContext | null> {
    const user = this.users.get(userId)
    const environment = this.environments.get(environmentId)
    const access = this.access.get(this.accessKey(userId, environmentId))
    const policy = this.policies.get(environmentId)
    const signingKey = [...this.signingKeys.values()].find(
      (key) => key.environmentId === environmentId && key.issuanceEnabled,
    )
    if (!user || !environment || !access || access.revokedAt || !policy || !signingKey) return null
    const activeTokenCount = [...this.tokens.values()].filter(
      (token) =>
        token.userId === userId &&
        token.environmentId === environmentId &&
        !token.disabledAt &&
        Date.parse(token.acceptedUntil) >= Date.parse(now),
    ).length
    return {
      user: copy(user),
      environment: copy(environment),
      access: copy(access),
      policy: copy(policy),
      signingKey: { ...copy(signingKey), secret: Buffer.from(signingKey.secret) },
      activeTokenCount,
    }
  }

  async commitToken(input: CommitTokenInput): Promise<TokenCommitResult> {
    const idempotencyKey = `${input.delivery.sessionId}:${input.delivery.idempotencyKeyHash}`
    const existingId = this.deliveryByIdempotency.get(idempotencyKey)
    if (existingId) {
      const existingDelivery = this.deliveries.get(existingId)
      const existingToken = this.tokens.get(existingId)
      if (!existingDelivery || !existingToken) throw new Error('invalid in-memory token delivery')
      if (existingDelivery.requestHash !== input.delivery.requestHash) {
        throw new DomainError('IDEMPOTENCY_CONFLICT', 409, '幂等键已用于不同的 Token 请求')
      }
      return { token: copy(existingToken), delivery: copy(existingDelivery), replayed: true }
    }
    const context = await this.getTokenIssuanceContext(
      input.token.userId,
      input.token.environmentId,
      input.token.issuedAt,
    )
    if (!context) throw new DomainError('SIGNING_KEY_UNAVAILABLE', 503, '签发上下文已变化')
    if (context.activeTokenCount >= input.maxActiveTokens) {
      throw new DomainError('TOKEN_POLICY_VIOLATION', 422, '活跃 Token 数已达到上限')
    }
    if (
      [...this.tokens.values()].some(
        (token) =>
          token.userId === input.token.userId &&
          token.environmentId === input.token.environmentId &&
          token.tokenName === input.token.tokenName,
      )
    ) {
      throw new DomainError('TOKEN_NAME_CONFLICT', 409, '同一环境中 Token 名称不能重复')
    }
    this.tokens.set(input.token.id, copy(input.token))
    this.deliveries.set(input.delivery.tokenId, copy(input.delivery))
    this.deliveryByIdempotency.set(idempotencyKey, input.delivery.tokenId)
    await this.appendAudit({
      actor: input.actor,
      eventType: 'token.issued',
      targetType: 'user_token',
      targetId: input.token.id,
      environmentId: input.token.environmentId,
      correlationId: input.correlationId,
      reason: input.token.issuedForReason,
      payload: {
        tokenName: input.token.tokenName,
        kid: input.token.kid,
        fingerprint: input.token.tokenFingerprint.slice(0, 12),
      },
      occurredAt: input.token.issuedAt,
    })
    return { token: copy(input.token), delivery: copy(input.delivery), replayed: false }
  }

  async listTokens(userId: string): Promise<UserTokenRecord[]> {
    return [...this.tokens.values()]
      .filter((token) => token.userId === userId)
      .sort((left, right) => right.issuedAt.localeCompare(left.issuedAt))
      .map(copy)
  }

  async getTokenById(id: string): Promise<UserTokenRecord | null> {
    const token = this.tokens.get(id)
    return token ? copy(token) : null
  }

  async disableToken(input: DisableTokenInput): Promise<UserTokenRecord> {
    const token = this.tokens.get(input.tokenId)
    if (!token || (input.ownerUserId && token.userId !== input.ownerUserId)) {
      throw new DomainError('TOKEN_NOT_FOUND', 404, 'Token 不存在')
    }
    if (!token.disabledAt) {
      token.disabledAt = input.now
      token.disabledBy = input.actor.id
      token.disableReason = input.reason
      token.compromiseSuspected = input.compromiseSuspected
      token.updatedAt = input.now
      await this.purgeDelivery(token.id, this.deliveries.get(token.id)?.sessionId ?? '', input.now)
      await this.appendAudit({
        actor: input.actor,
        eventType: 'token.disabled',
        targetType: 'user_token',
        targetId: token.id,
        environmentId: token.environmentId,
        correlationId: input.correlationId,
        reason: input.reason,
        payload: { runtimeEnforced: false, compromiseSuspected: input.compromiseSuspected },
        occurredAt: input.now,
      })
    }
    return copy(token)
  }

  async purgeDelivery(tokenId: string, sessionId: string, now: string): Promise<void> {
    const delivery = this.deliveries.get(tokenId)
    if (!delivery || (sessionId && delivery.sessionId !== sessionId)) return
    delivery.ciphertext = null
    delivery.nonce = null
    delivery.purgedAt = now
  }

  async listAuditEvents(limit: number): Promise<AuditEventRecord[]> {
    return this.auditEvents.slice(-limit).reverse().map(copy)
  }

  async appendAudit(input: AppendAuditInput): Promise<void> {
    this.auditEvents.push({
      id: randomUUID(),
      sequenceNo: ++this.auditSequence,
      actorUserId: input.actor?.id ?? null,
      actorRole: input.actor?.systemRole ?? null,
      eventType: input.eventType,
      targetType: input.targetType,
      targetId: input.targetId,
      environmentId: input.environmentId ?? null,
      correlationId: input.correlationId,
      reason: input.reason ?? null,
      payload: input.payload ?? {},
      occurredAt: input.occurredAt,
    })
  }

  private accessKey(userId: string, environmentId: string): string {
    return `${userId}:${environmentId}`
  }

  private ensureAccess(
    userId: string,
    environmentId: string,
    _actorId: string,
    _now: string,
  ): EnvironmentAccessRecord {
    if (!this.environments.has(environmentId)) {
      throw new DomainError('ENVIRONMENT_NOT_FOUND', 404, '环境不存在')
    }
    const key = this.accessKey(userId, environmentId)
    const existing = this.access.get(key)
    if (existing) {
      existing.revokedAt = null
      existing.revision += 1
      return existing
    }
    const access: EnvironmentAccessRecord = {
      userId,
      environmentId,
      canIssueTokens: true,
      maxTokenTtlSeconds: null,
      maxActiveTokens: null,
      revision: 1,
      revokedAt: null,
    }
    this.access.set(key, access)
    return access
  }
}
