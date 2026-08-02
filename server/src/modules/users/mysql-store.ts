import { randomUUID } from 'node:crypto'

import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'

import { sha256Hex, ValueCipher } from './crypto.js'
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

type DbExecutor = Pick<Pool, 'query'> | Pick<PoolConnection, 'query'>

interface UserRow extends RowDataPacket {
  id: string
  username: string
  display_name: string
  email: string | null
  system_role: UserRecord['systemRole']
  status: UserRecord['status']
  auth_provider: string
  external_subject: Buffer
  revision: string | number
  last_login_at: Date | null
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
}

interface TokenRow extends RowDataPacket {
  id: string
  user_id: string
  environment_id: string
  signing_key_id: string
  token_name: string
  token_fingerprint: string
  token_nonce: string
  bt1_version: 'BT1'
  kid: string
  clock_skew_seconds: number
  issued_by: string
  issued_for_reason: string | null
  issued_at: Date
  expires_at: Date
  accepted_until: Date
  disabled_at: Date | null
  disabled_by: string | null
  disable_reason: string | null
  compromise_suspected: number
  last_used_at: Date | null
  last_used_source: string | null
  created_at: Date
  updated_at: Date
}

interface DeliveryRow extends RowDataPacket {
  token_id: string
  session_id: string
  idempotency_key_hash: string
  request_hash: string
  ciphertext: string | null
  nonce: string | null
  created_at: Date
  expires_at: Date
  purged_at: Date | null
}

interface EnvironmentRow extends RowDataPacket {
  id: string
  name: string
  stage: EnvironmentRecord['stage']
  revision: string | number
  created_at: Date
  updated_at: Date
}

interface AccessRow extends RowDataPacket {
  user_id: string
  environment_id: string
  can_issue_tokens: number
  max_token_ttl_seconds: number | null
  max_active_tokens: number | null
  revision: string | number
  revoked_at: Date | null
}

interface PolicyRow extends RowDataPacket {
  environment_id: string
  self_service_enabled: number
  min_ttl_seconds: number
  default_ttl_seconds: number
  max_ttl_seconds: number
  max_active_tokens_per_user: number
  require_effective_key: number
  delivery_ttl_seconds: number
  revision: string | number
}

interface SigningKeyRow extends RowDataPacket {
  id: string
  environment_id: string
  kid: string
  secret_id: string
  key_state: SigningKeyRecord['keyState']
  issuance_enabled: number
  clock_skew_seconds: number
  retire_after: Date | null
  revision: string | number
}

interface SecretRow extends RowDataPacket {
  id: string
  ciphertext: string
  nonce: string
}

interface IdRow extends RowDataPacket {
  id: string
}

const userSelect = `
  SELECT BIN_TO_UUID(id) AS id, username, display_name, email, system_role, status,
    auth_provider, external_subject, revision, last_login_at, created_at, updated_at, deleted_at
  FROM users`

const tokenSelect = `
  SELECT BIN_TO_UUID(id) AS id, BIN_TO_UUID(user_id) AS user_id,
    BIN_TO_UUID(environment_id) AS environment_id, BIN_TO_UUID(signing_key_id) AS signing_key_id,
    token_name, HEX(token_fingerprint) AS token_fingerprint, token_nonce, bt1_version, kid,
    clock_skew_seconds, BIN_TO_UUID(issued_by) AS issued_by, issued_for_reason, issued_at,
    expires_at, accepted_until, disabled_at, BIN_TO_UUID(disabled_by) AS disabled_by,
    disable_reason, compromise_suspected, last_used_at, last_used_source, created_at, updated_at
  FROM user_tokens`

const environmentSelect = `
  SELECT BIN_TO_UUID(id) AS id, name, stage, revision, created_at, updated_at
  FROM environments`

const accessSelect = `
  SELECT BIN_TO_UUID(user_id) AS user_id, BIN_TO_UUID(environment_id) AS environment_id,
    can_issue_tokens, max_token_ttl_seconds, max_active_tokens, revision, revoked_at
  FROM user_environment_access`

const policySelect = `
  SELECT BIN_TO_UUID(environment_id) AS environment_id, self_service_enabled,
    min_ttl_seconds, default_ttl_seconds, max_ttl_seconds, max_active_tokens_per_user,
    require_effective_key, delivery_ttl_seconds, revision
  FROM environment_token_policies`

const signingKeySelect = `
  SELECT BIN_TO_UUID(id) AS id, BIN_TO_UUID(environment_id) AS environment_id, kid,
    BIN_TO_UUID(secret_id) AS secret_id, key_state, issuance_enabled, clock_skew_seconds,
    retire_after, revision
  FROM bt1_signing_keys`

const secretSelect = `
  SELECT BIN_TO_UUID(id) AS id, ciphertext, nonce
  FROM managed_secrets`

function date(value: string): Date {
  return new Date(value)
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null
  return (value instanceof Date ? value : new Date(value)).toISOString()
}

function mapUser(row: UserRow): UserRecord {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    systemRole: row.system_role,
    status: row.status,
    authProvider: row.auth_provider,
    externalSubject: row.external_subject.toString('utf8'),
    revision: Number(row.revision),
    lastLoginAt: iso(row.last_login_at),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
    deletedAt: iso(row.deleted_at),
  }
}

function mapToken(row: TokenRow): UserTokenRecord {
  return {
    id: row.id,
    userId: row.user_id,
    environmentId: row.environment_id,
    signingKeyId: row.signing_key_id,
    tokenName: row.token_name,
    tokenFingerprint: row.token_fingerprint.toLowerCase(),
    tokenNonce: row.token_nonce,
    bt1Version: row.bt1_version,
    kid: row.kid,
    clockSkewSeconds: row.clock_skew_seconds,
    issuedBy: row.issued_by,
    issuedForReason: row.issued_for_reason,
    issuedAt: iso(row.issued_at)!,
    expiresAt: iso(row.expires_at)!,
    acceptedUntil: iso(row.accepted_until)!,
    disabledAt: iso(row.disabled_at),
    disabledBy: row.disabled_by,
    disableReason: row.disable_reason,
    compromiseSuspected: Boolean(row.compromise_suspected),
    lastUsedAt: iso(row.last_used_at),
    lastUsedSource: row.last_used_source,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  }
}

function mapDelivery(row: DeliveryRow): EncryptedDelivery {
  return {
    tokenId: row.token_id,
    sessionId: row.session_id,
    idempotencyKeyHash: row.idempotency_key_hash.toLowerCase(),
    requestHash: row.request_hash.toLowerCase(),
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    createdAt: iso(row.created_at)!,
    expiresAt: iso(row.expires_at)!,
    purgedAt: iso(row.purged_at),
  }
}

function mapEnvironment(row: EnvironmentRow): EnvironmentRecord {
  return {
    id: row.id,
    name: row.name,
    stage: row.stage,
    revision: Number(row.revision),
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  }
}

function mapAccess(row: AccessRow): EnvironmentAccessRecord {
  return {
    userId: row.user_id,
    environmentId: row.environment_id,
    canIssueTokens: Boolean(row.can_issue_tokens),
    maxTokenTtlSeconds: row.max_token_ttl_seconds,
    maxActiveTokens: row.max_active_tokens,
    revision: Number(row.revision),
    revokedAt: iso(row.revoked_at),
  }
}

function mapPolicy(row: PolicyRow): TokenPolicyRecord {
  return {
    environmentId: row.environment_id,
    selfServiceEnabled: Boolean(row.self_service_enabled),
    minTtlSeconds: row.min_ttl_seconds,
    defaultTtlSeconds: row.default_ttl_seconds,
    maxTtlSeconds: row.max_ttl_seconds,
    maxActiveTokensPerUser: row.max_active_tokens_per_user,
    requireEffectiveKey: Boolean(row.require_effective_key),
    deliveryTtlSeconds: row.delivery_ttl_seconds,
    revision: Number(row.revision),
  }
}

function isDuplicateError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'ER_DUP_ENTRY'
  )
}

export class MySqlUserStore implements UserStore {
  constructor(
    private readonly pool: Pool,
    private readonly cipher: ValueCipher,
  ) {}

  async bootstrap(input: BootstrapInput): Promise<void> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.query(
        `INSERT IGNORE INTO environments
          (id, name, stage, revision, created_at, updated_at)
          VALUES (UUID_TO_BIN(?), ?, ?, 1, ?, ?)`,
        [
          input.environment.id,
          input.environment.name,
          input.environment.stage,
          date(input.now),
          date(input.now),
        ],
      )
      await connection.query(
        `INSERT IGNORE INTO environment_token_policies
          (environment_id, self_service_enabled, min_ttl_seconds, default_ttl_seconds,
           max_ttl_seconds, max_active_tokens_per_user, require_effective_key,
           delivery_ttl_seconds, revision, created_at, updated_at)
          VALUES (UUID_TO_BIN(?), ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        [
          input.environment.id,
          input.policy.selfServiceEnabled,
          input.policy.minTtlSeconds,
          input.policy.defaultTtlSeconds,
          input.policy.maxTtlSeconds,
          input.policy.maxActiveTokensPerUser,
          input.policy.requireEffectiveKey,
          input.policy.deliveryTtlSeconds,
          date(input.now),
          date(input.now),
        ],
      )

      const [adminRows] = await connection.query<UserRow[]>(
        `${userSelect} WHERE username = ? FOR UPDATE`,
        [input.admin.username],
      )
      let adminId: string
      if (adminRows[0]) {
        adminId = adminRows[0].id
      } else {
        adminId = randomUUID()
        await connection.query(
          `INSERT INTO users
            (id, username, display_name, email, system_role, status, auth_provider,
             external_subject, revision, created_at, updated_at)
            VALUES (UUID_TO_BIN(?), ?, ?, ?, 'ADMIN', 'ACTIVE', ?, ?, 1, ?, ?)`,
          [
            adminId,
            input.admin.username,
            input.admin.displayName,
            input.admin.email,
            input.admin.authProvider,
            Buffer.from(input.admin.externalSubject),
            date(input.now),
            date(input.now),
          ],
        )
      }
      await connection.query(
        `INSERT INTO user_environment_access
          (user_id, environment_id, can_issue_tokens, revision, granted_by, created_at, updated_at)
          VALUES (UUID_TO_BIN(?), UUID_TO_BIN(?), TRUE, 1, UUID_TO_BIN(?), ?, ?)
          ON DUPLICATE KEY UPDATE revoked_at = NULL, updated_at = VALUES(updated_at)`,
        [adminId, input.environment.id, adminId, date(input.now), date(input.now)],
      )

      const [keyRows] = await connection.query<Array<RowDataPacket & { id: string }>>(
        `SELECT BIN_TO_UUID(id) AS id FROM bt1_signing_keys
          WHERE environment_id = UUID_TO_BIN(?) AND issuance_enabled = TRUE FOR UPDATE`,
        [input.environment.id],
      )
      if (keyRows.length === 0) {
        const secretId = randomUUID()
        const keyId = randomUUID()
        const sealed = this.cipher.seal(
          input.signingKey.secret.toString('base64'),
          `managed-secret:${secretId}`,
        )
        await connection.query(
          `INSERT INTO managed_secrets
            (id, secret_kind, ciphertext, nonce, fingerprint, created_at, updated_at)
            VALUES (UUID_TO_BIN(?), 'BT1_SIGNING_KEY', ?, ?, UNHEX(?), ?, ?)`,
          [
            secretId,
            sealed.ciphertext,
            sealed.nonce,
            sha256Hex(input.signingKey.secret),
            date(input.now),
            date(input.now),
          ],
        )
        await connection.query(
          `INSERT INTO bt1_signing_keys
            (id, environment_id, kid, secret_id, key_state, issuance_enabled,
             clock_skew_seconds, revision, created_at, updated_at)
            VALUES (UUID_TO_BIN(?), UUID_TO_BIN(?), ?, UUID_TO_BIN(?), ?, TRUE, ?, 1, ?, ?)`,
          [
            keyId,
            input.environment.id,
            input.signingKey.kid,
            secretId,
            input.signingKey.keyState,
            input.signingKey.clockSkewSeconds,
            date(input.now),
            date(input.now),
          ],
        )
      }
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async getUserById(id: string): Promise<UserRecord | null> {
    const [rows] = await this.pool.query<UserRow[]>(`${userSelect} WHERE id = UUID_TO_BIN(?)`, [id])
    return rows[0] ? mapUser(rows[0]) : null
  }

  async getUserByUsername(username: string): Promise<UserRecord | null> {
    const [rows] = await this.pool.query<UserRow[]>(`${userSelect} WHERE username = ?`, [username])
    return rows[0] ? mapUser(rows[0]) : null
  }

  async getUserByExternalSubject(provider: string, subject: string): Promise<UserRecord | null> {
    const [rows] = await this.pool.query<UserRow[]>(
      `${userSelect} WHERE auth_provider = ? AND external_subject = ?`,
      [provider, Buffer.from(subject)],
    )
    return rows[0] ? mapUser(rows[0]) : null
  }

  async listUsers(query: UserListQuery): Promise<UserRecord[]> {
    const conditions: string[] = []
    const parameters: unknown[] = []
    if (query.role) {
      conditions.push('system_role = ?')
      parameters.push(query.role)
    }
    if (query.status) {
      conditions.push('status = ?')
      parameters.push(query.status)
    }
    const where = conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''
    const [rows] = await this.pool.query<UserRow[]>(
      `${userSelect}${where} ORDER BY created_at DESC LIMIT 1000`,
      parameters,
    )
    const users = rows.map(mapUser)
    const search = query.search?.toLocaleLowerCase()
    return users
      .filter(
        (user) =>
          !search ||
          user.username.toLocaleLowerCase().includes(search) ||
          user.displayName.toLocaleLowerCase().includes(search) ||
          user.email?.toLocaleLowerCase().includes(search),
      )
      .slice(0, 200)
  }

  async createUser(input: CreateUserInput, actor: UserRecord, now: string): Promise<UserRecord> {
    const id = randomUUID()
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      await connection.query(
        `INSERT INTO users
          (id, username, display_name, email, system_role, status, auth_provider,
           external_subject, revision, created_at, updated_at)
          VALUES (UUID_TO_BIN(?), ?, ?, ?, ?, 'PENDING', ?, ?, 1, ?, ?)`,
        [
          id,
          input.username,
          input.displayName,
          input.email,
          input.systemRole,
          input.authProvider,
          Buffer.from(input.externalSubject),
          date(now),
          date(now),
        ],
      )
      for (const environmentId of input.environmentIds) {
        const [environmentRows] = await connection.query<RowDataPacket[]>(
          'SELECT id FROM environments WHERE id = UUID_TO_BIN(?)',
          [environmentId],
        )
        if (environmentRows.length === 0) {
          throw new DomainError('ENVIRONMENT_NOT_FOUND', 404, '环境不存在')
        }
        await connection.query(
          `INSERT INTO user_environment_access
            (user_id, environment_id, can_issue_tokens, revision, granted_by, created_at, updated_at)
            VALUES (UUID_TO_BIN(?), UUID_TO_BIN(?), TRUE, 1, UUID_TO_BIN(?), ?, ?)`,
          [id, environmentId, actor.id, date(now), date(now)],
        )
      }
      await this.insertAudit(connection, {
        actor,
        eventType: 'user.created',
        targetType: 'user',
        targetId: id,
        correlationId: randomUUID(),
        payload: { username: input.username, role: input.systemRole },
        occurredAt: now,
      })
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      if (isDuplicateError(error))
        throw new DomainError('USERNAME_CONFLICT', 409, 'username 或 SSO 身份已存在')
      throw error
    } finally {
      connection.release()
    }
    return (await this.getUserById(id))!
  }

  async updateUser(
    id: string,
    input: UpdateUserInput,
    actor: UserRecord,
    now: string,
  ): Promise<UserRecord> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [rows] = await connection.query<UserRow[]>(
        `${userSelect} WHERE id = UUID_TO_BIN(?) FOR UPDATE`,
        [id],
      )
      const currentRow = rows[0]
      if (!currentRow) throw new DomainError('USER_NOT_FOUND', 404, '用户不存在')
      const current = mapUser(currentRow)
      if (input.expectedRevision && input.expectedRevision !== current.revision) {
        throw new DomainError('REVISION_CONFLICT', 412, '用户信息已被其他操作更新')
      }
      if (id === actor.id && input.systemRole && input.systemRole !== current.systemRole) {
        throw new DomainError('SELF_ROLE_CHANGE_FORBIDDEN', 409, '管理员不能修改自己的角色')
      }
      const removesAdmin =
        current.systemRole === 'ADMIN' &&
        current.status === 'ACTIVE' &&
        (input.systemRole === 'USER' || input.status === 'SUSPENDED' || input.status === 'DELETED')
      if (removesAdmin) {
        await connection.query(
          `SELECT revision FROM security_invariants WHERE lock_name = 'ACTIVE_ADMIN_GUARD' FOR UPDATE`,
        )
        const [activeAdmins] = await connection.query<IdRow[]>(
          `SELECT BIN_TO_UUID(id) AS id FROM users
            WHERE system_role = 'ADMIN' AND status = 'ACTIVE'`,
        )
        if (activeAdmins.length <= 1) {
          throw new DomainError('LAST_ADMIN_REQUIRED', 409, '系统必须至少保留一个有效管理员')
        }
      }
      const nextRole = input.systemRole ?? current.systemRole
      const nextStatus = input.status ?? current.status
      await connection.query(
        `UPDATE users SET display_name = ?, email = ?, system_role = ?, status = ?,
           deleted_at = ?, revision = revision + 1, updated_at = ? WHERE id = UUID_TO_BIN(?)`,
        [
          input.displayName ?? current.displayName,
          input.email === undefined ? current.email : input.email,
          nextRole,
          nextStatus,
          nextStatus === 'DELETED' ? date(now) : null,
          date(now),
          id,
        ],
      )
      if (nextStatus === 'SUSPENDED' || nextStatus === 'DELETED') {
        await connection.query(
          `UPDATE user_sessions SET revoked_at = ?
            WHERE user_id = UUID_TO_BIN(?) AND revoked_at IS NULL`,
          [date(now), id],
        )
      }
      await this.insertAudit(connection, {
        actor,
        eventType: 'user.updated',
        targetType: 'user',
        targetId: id,
        correlationId: randomUUID(),
        payload: { role: nextRole, status: nextStatus, previousRevision: current.revision },
        occurredAt: now,
      })
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
    return (await this.getUserById(id))!
  }

  async markUserLogin(id: string, now: string): Promise<UserRecord> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [rows] = await connection.query<UserRow[]>(
        `${userSelect} WHERE id = UUID_TO_BIN(?) FOR UPDATE`,
        [id],
      )
      const user = rows[0] ? mapUser(rows[0]) : null
      if (!user) throw new DomainError('USER_NOT_FOUND', 404, '用户不存在')
      if (user.status !== 'ACTIVE' && user.status !== 'PENDING') {
        throw new DomainError('USER_NOT_ACTIVE', 403, '用户已被暂停或删除')
      }
      const nextStatus = user.status === 'PENDING' ? 'ACTIVE' : user.status
      await connection.query(
        `UPDATE users SET status = ?, last_login_at = ?, updated_at = ?,
          revision = revision + 1 WHERE id = UUID_TO_BIN(?)`,
        [nextStatus, date(now), date(now), id],
      )
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
    return (await this.getUserById(id))!
  }

  async listEnvironmentsForUser(userId: string) {
    const [accessRows] = await this.pool.query<AccessRow[]>(
      `${accessSelect} WHERE user_id = UUID_TO_BIN(?) AND revoked_at IS NULL`,
      [userId],
    )
    const items = await Promise.all(
      accessRows.map(async (accessRow) => {
        const [environmentRows, policyRows] = await Promise.all([
          this.pool.query<EnvironmentRow[]>(`${environmentSelect} WHERE id = UUID_TO_BIN(?)`, [
            accessRow.environment_id,
          ]),
          this.pool.query<PolicyRow[]>(`${policySelect} WHERE environment_id = UUID_TO_BIN(?)`, [
            accessRow.environment_id,
          ]),
        ])
        const environment = environmentRows[0][0]
        const policy = policyRows[0][0]
        if (!environment || !policy) return null
        return {
          environment: mapEnvironment(environment),
          access: mapAccess(accessRow),
          policy: mapPolicy(policy),
        }
      }),
    )
    return items
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((left, right) => left.environment.name.localeCompare(right.environment.name))
  }

  async grantEnvironmentAccess(
    userId: string,
    environmentId: string,
    actor: UserRecord,
    now: string,
  ): Promise<EnvironmentAccessRecord> {
    await this.pool.query(
      `INSERT INTO user_environment_access
        (user_id, environment_id, can_issue_tokens, revision, granted_by, created_at, updated_at)
        VALUES (UUID_TO_BIN(?), UUID_TO_BIN(?), TRUE, 1, UUID_TO_BIN(?), ?, ?)
        ON DUPLICATE KEY UPDATE revoked_at = NULL, revision = revision + 1, updated_at = VALUES(updated_at)`,
      [userId, environmentId, actor.id, date(now), date(now)],
    )
    const environments = await this.listEnvironmentsForUser(userId)
    const item = environments.find((entry) => entry.environment.id === environmentId)
    if (!item) throw new DomainError('ENVIRONMENT_NOT_FOUND', 404, '环境不存在')
    return item.access
  }

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const id = randomUUID()
    await this.pool.query(
      `INSERT INTO user_sessions
        (id, user_id, session_token_hash, csrf_token_hash, auth_time, mfa_time, created_at,
         last_seen_at, idle_expires_at, absolute_expires_at)
        VALUES (UUID_TO_BIN(?), UUID_TO_BIN(?), UNHEX(?), UNHEX(?), ?, ?, ?, ?, ?, ?)`,
      [
        id,
        input.userId,
        input.sessionTokenHash,
        input.csrfTokenHash,
        date(input.now),
        input.mfaTime ? date(input.mfaTime) : null,
        date(input.now),
        date(input.now),
        date(input.idleExpiresAt),
        date(input.absoluteExpiresAt),
      ],
    )
    return {
      id,
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
  }

  async getSessionByTokenHash(hash: string, now: string): Promise<SessionRecord | null> {
    const [rows] = await this.pool.query<Array<RowDataPacket & Record<string, unknown>>>(
      `SELECT BIN_TO_UUID(id) AS id, BIN_TO_UUID(user_id) AS user_id,
        HEX(session_token_hash) AS session_token_hash, HEX(csrf_token_hash) AS csrf_token_hash,
        auth_time, mfa_time, created_at, last_seen_at, idle_expires_at, absolute_expires_at, revoked_at
      FROM user_sessions
      WHERE session_token_hash = UNHEX(?) AND revoked_at IS NULL
        AND idle_expires_at >= ? AND absolute_expires_at >= ?`,
      [hash, date(now), date(now)],
    )
    const row = rows[0]
    if (!row) return null
    const absoluteExpiresAt = iso(row.absolute_expires_at as Date)!
    const idleExpiresAt = new Date(
      Math.min(Date.parse(now) + 30 * 60_000, Date.parse(absoluteExpiresAt)),
    ).toISOString()
    await this.pool.query(
      `UPDATE user_sessions SET last_seen_at = ?, idle_expires_at = ?
        WHERE id = UUID_TO_BIN(?)`,
      [date(now), date(idleExpiresAt), String(row.id)],
    )
    return {
      id: String(row.id),
      userId: String(row.user_id),
      sessionTokenHash: String(row.session_token_hash).toLowerCase(),
      csrfTokenHash: String(row.csrf_token_hash).toLowerCase(),
      authTime: iso(row.auth_time as Date)!,
      mfaTime: iso(row.mfa_time as Date | null),
      createdAt: iso(row.created_at as Date)!,
      lastSeenAt: now,
      idleExpiresAt,
      absoluteExpiresAt,
      revokedAt: null,
    }
  }

  async revokeSession(id: string, userId: string, now: string): Promise<void> {
    await this.pool.query(
      `UPDATE user_sessions SET revoked_at = ?
        WHERE id = UUID_TO_BIN(?) AND user_id = UUID_TO_BIN(?) AND revoked_at IS NULL`,
      [date(now), id, userId],
    )
  }

  async revokeAllSessions(userId: string, now: string): Promise<void> {
    await this.pool.query(
      `UPDATE user_sessions SET revoked_at = ?
        WHERE user_id = UUID_TO_BIN(?) AND revoked_at IS NULL`,
      [date(now), userId],
    )
  }

  async getTokenIssuanceContext(
    userId: string,
    environmentId: string,
    now: string,
  ): Promise<TokenIssuanceContext | null> {
    const [user, accessResult, environmentResult, policyResult, keyResult, activeTokenResult] =
      await Promise.all([
        this.getUserById(userId),
        this.pool.query<AccessRow[]>(
          `${accessSelect} WHERE user_id = UUID_TO_BIN(?)
            AND environment_id = UUID_TO_BIN(?) AND revoked_at IS NULL`,
          [userId, environmentId],
        ),
        this.pool.query<EnvironmentRow[]>(`${environmentSelect} WHERE id = UUID_TO_BIN(?)`, [
          environmentId,
        ]),
        this.pool.query<PolicyRow[]>(`${policySelect} WHERE environment_id = UUID_TO_BIN(?)`, [
          environmentId,
        ]),
        this.pool.query<SigningKeyRow[]>(
          `${signingKeySelect} WHERE environment_id = UUID_TO_BIN(?) AND issuance_enabled = TRUE`,
          [environmentId],
        ),
        this.pool.query<IdRow[]>(
          `SELECT BIN_TO_UUID(id) AS id FROM user_tokens
            WHERE user_id = UUID_TO_BIN(?) AND environment_id = UUID_TO_BIN(?)
              AND disabled_at IS NULL AND accepted_until >= ?`,
          [userId, environmentId, date(now)],
        ),
      ])
    const accessRow = accessResult[0][0]
    const environmentRow = environmentResult[0][0]
    const policyRow = policyResult[0][0]
    const keyRow = keyResult[0][0]
    if (!user || !accessRow || !environmentRow || !policyRow || !keyRow) return null

    const [secretRows] = await this.pool.query<SecretRow[]>(
      `${secretSelect} WHERE id = UUID_TO_BIN(?) AND destroyed_at IS NULL`,
      [keyRow.secret_id],
    )
    const secretRow = secretRows[0]
    if (!secretRow) return null
    const secretBase64 = this.cipher.open(
      { ciphertext: secretRow.ciphertext, nonce: secretRow.nonce },
      `managed-secret:${secretRow.id}`,
    )
    const signingKey: SigningKeyRecord = {
      id: keyRow.id,
      environmentId: keyRow.environment_id,
      kid: keyRow.kid,
      secret: Buffer.from(secretBase64, 'base64'),
      keyState: keyRow.key_state,
      issuanceEnabled: Boolean(keyRow.issuance_enabled),
      clockSkewSeconds: keyRow.clock_skew_seconds,
      retireAfter: iso(keyRow.retire_after),
      revision: Number(keyRow.revision),
    }
    return {
      user,
      environment: mapEnvironment(environmentRow),
      access: mapAccess(accessRow),
      policy: mapPolicy(policyRow),
      signingKey,
      activeTokenCount: activeTokenResult[0].length,
    }
  }

  async commitToken(input: CommitTokenInput): Promise<TokenCommitResult> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const existing = await this.findDeliveryByIdempotency(
        connection,
        input.delivery.sessionId,
        input.delivery.idempotencyKeyHash,
        true,
      )
      if (existing) {
        if (existing.delivery.requestHash !== input.delivery.requestHash) {
          throw new DomainError('IDEMPOTENCY_CONFLICT', 409, '幂等键已用于不同的 Token 请求')
        }
        await connection.commit()
        return { ...existing, replayed: true }
      }
      await connection.query(
        `SELECT revision FROM user_environment_access
          WHERE user_id = UUID_TO_BIN(?) AND environment_id = UUID_TO_BIN(?)
            AND revoked_at IS NULL FOR UPDATE`,
        [input.token.userId, input.token.environmentId],
      )
      await connection.query(
        `SELECT revision FROM bt1_signing_keys
          WHERE id = UUID_TO_BIN(?) AND issuance_enabled = TRUE FOR UPDATE`,
        [input.token.signingKeyId],
      )
      const [activeTokens] = await connection.query<IdRow[]>(
        `SELECT BIN_TO_UUID(id) AS id FROM user_tokens
          WHERE user_id = UUID_TO_BIN(?) AND environment_id = UUID_TO_BIN(?)
            AND disabled_at IS NULL AND accepted_until >= ? FOR UPDATE`,
        [input.token.userId, input.token.environmentId, date(input.token.issuedAt)],
      )
      if (activeTokens.length >= input.maxActiveTokens) {
        throw new DomainError('TOKEN_POLICY_VIOLATION', 422, '活跃 Token 数已达到上限')
      }
      const token = input.token
      await connection.query(
        `INSERT INTO user_tokens
          (id, user_id, environment_id, signing_key_id, token_name, token_fingerprint,
           token_nonce, bt1_version, kid, clock_skew_seconds, issued_by, issued_for_reason,
           issued_at, expires_at, accepted_until, compromise_suspected, created_at, updated_at)
          VALUES (UUID_TO_BIN(?), UUID_TO_BIN(?), UUID_TO_BIN(?), UUID_TO_BIN(?), ?, UNHEX(?),
            ?, 'BT1', ?, ?, UUID_TO_BIN(?), ?, ?, ?, ?, FALSE, ?, ?)`,
        [
          token.id,
          token.userId,
          token.environmentId,
          token.signingKeyId,
          token.tokenName,
          token.tokenFingerprint,
          token.tokenNonce,
          token.kid,
          token.clockSkewSeconds,
          token.issuedBy,
          token.issuedForReason,
          date(token.issuedAt),
          date(token.expiresAt),
          date(token.acceptedUntil),
          date(token.createdAt),
          date(token.updatedAt),
        ],
      )
      const delivery = input.delivery
      await connection.query(
        `INSERT INTO token_deliveries
          (token_id, session_id, idempotency_key_hash, request_hash, ciphertext, nonce,
           created_at, expires_at)
          VALUES (UUID_TO_BIN(?), UUID_TO_BIN(?), UNHEX(?), UNHEX(?), ?, ?, ?, ?)`,
        [
          delivery.tokenId,
          delivery.sessionId,
          delivery.idempotencyKeyHash,
          delivery.requestHash,
          delivery.ciphertext,
          delivery.nonce,
          date(delivery.createdAt),
          date(delivery.expiresAt),
        ],
      )
      await this.insertAudit(connection, {
        actor: input.actor,
        eventType: 'token.issued',
        targetType: 'user_token',
        targetId: token.id,
        environmentId: token.environmentId,
        correlationId: input.correlationId,
        reason: token.issuedForReason,
        payload: {
          tokenName: token.tokenName,
          kid: token.kid,
          fingerprint: token.tokenFingerprint.slice(0, 12),
        },
        occurredAt: token.issuedAt,
      })
      await connection.commit()
      return { token, delivery, replayed: false }
    } catch (error) {
      await connection.rollback()
      if (isDuplicateError(error)) {
        const existing = await this.findDeliveryByIdempotency(
          this.pool,
          input.delivery.sessionId,
          input.delivery.idempotencyKeyHash,
          false,
        )
        if (existing && existing.delivery.requestHash === input.delivery.requestHash) {
          return { ...existing, replayed: true }
        }
        throw new DomainError('TOKEN_NAME_CONFLICT', 409, 'Token 名称或幂等键冲突')
      }
      throw error
    } finally {
      connection.release()
    }
  }

  async listTokens(userId: string): Promise<UserTokenRecord[]> {
    const [rows] = await this.pool.query<TokenRow[]>(
      `${tokenSelect} WHERE user_id = UUID_TO_BIN(?) ORDER BY issued_at DESC LIMIT 200`,
      [userId],
    )
    return rows.map(mapToken)
  }

  async getTokenById(id: string): Promise<UserTokenRecord | null> {
    const [rows] = await this.pool.query<TokenRow[]>(`${tokenSelect} WHERE id = UUID_TO_BIN(?)`, [
      id,
    ])
    return rows[0] ? mapToken(rows[0]) : null
  }

  async disableToken(input: DisableTokenInput): Promise<UserTokenRecord> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const ownerCondition = input.ownerUserId ? ' AND user_id = UUID_TO_BIN(?)' : ''
      const parameters = input.ownerUserId ? [input.tokenId, input.ownerUserId] : [input.tokenId]
      const [rows] = await connection.query<TokenRow[]>(
        `${tokenSelect} WHERE id = UUID_TO_BIN(?)${ownerCondition} FOR UPDATE`,
        parameters,
      )
      const row = rows[0]
      if (!row) throw new DomainError('TOKEN_NOT_FOUND', 404, 'Token 不存在')
      const token = mapToken(row)
      if (!token.disabledAt) {
        await connection.query(
          `UPDATE user_tokens SET disabled_at = ?, disabled_by = UUID_TO_BIN(?),
            disable_reason = ?, compromise_suspected = ?, updated_at = ? WHERE id = UUID_TO_BIN(?)`,
          [
            date(input.now),
            input.actor.id,
            input.reason,
            input.compromiseSuspected,
            date(input.now),
            input.tokenId,
          ],
        )
        await connection.query(
          `UPDATE token_deliveries SET ciphertext = NULL, nonce = NULL, purged_at = ?
            WHERE token_id = UUID_TO_BIN(?) AND purged_at IS NULL`,
          [date(input.now), input.tokenId],
        )
        await this.insertAudit(connection, {
          actor: input.actor,
          eventType: 'token.disabled',
          targetType: 'user_token',
          targetId: input.tokenId,
          environmentId: token.environmentId,
          correlationId: input.correlationId,
          reason: input.reason,
          payload: { runtimeEnforced: false, compromiseSuspected: input.compromiseSuspected },
          occurredAt: input.now,
        })
      }
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
    return (await this.getTokenById(input.tokenId))!
  }

  async purgeDelivery(tokenId: string, sessionId: string, now: string): Promise<void> {
    await this.pool.query(
      `UPDATE token_deliveries SET ciphertext = NULL, nonce = NULL, purged_at = ?
        WHERE token_id = UUID_TO_BIN(?) AND session_id = UUID_TO_BIN(?) AND purged_at IS NULL`,
      [date(now), tokenId, sessionId],
    )
  }

  async listAuditEvents(limit: number): Promise<AuditEventRecord[]> {
    const safeLimit = Math.max(1, Math.min(limit, 200))
    const [rows] = await this.pool.query<Array<RowDataPacket & Record<string, unknown>>>(
      `SELECT BIN_TO_UUID(id) AS id, sequence_no, BIN_TO_UUID(actor_user_id) AS actor_user_id,
        actor_role, event_type, target_type, BIN_TO_UUID(target_id) AS target_id,
        BIN_TO_UUID(environment_id) AS environment_id, correlation_id, reason, payload, occurred_at
      FROM audit_events ORDER BY sequence_no DESC LIMIT ${safeLimit}`,
    )
    return rows.map((row) => ({
      id: String(row.id),
      sequenceNo: Number(row.sequence_no),
      actorUserId: row.actor_user_id ? String(row.actor_user_id) : null,
      actorRole: (row.actor_role as AuditEventRecord['actorRole']) ?? null,
      eventType: String(row.event_type),
      targetType: String(row.target_type),
      targetId: row.target_id ? String(row.target_id) : null,
      environmentId: row.environment_id ? String(row.environment_id) : null,
      correlationId: String(row.correlation_id),
      reason: row.reason ? String(row.reason) : null,
      payload:
        typeof row.payload === 'string'
          ? (JSON.parse(row.payload) as Record<string, unknown>)
          : (row.payload as Record<string, unknown>),
      occurredAt: iso(row.occurred_at as Date)!,
    }))
  }

  async appendAudit(input: AppendAuditInput): Promise<void> {
    await this.insertAudit(this.pool, input)
  }

  private async findDeliveryByIdempotency(
    executor: DbExecutor,
    sessionId: string,
    idempotencyKeyHash: string,
    lock: boolean,
  ): Promise<{ token: UserTokenRecord; delivery: EncryptedDelivery } | null> {
    const [deliveryRows] = await executor.query<DeliveryRow[]>(
      `SELECT BIN_TO_UUID(token_id) AS token_id, BIN_TO_UUID(session_id) AS session_id,
        HEX(idempotency_key_hash) AS idempotency_key_hash, HEX(request_hash) AS request_hash,
        ciphertext, nonce, created_at, expires_at, purged_at
      FROM token_deliveries
      WHERE session_id = UUID_TO_BIN(?) AND idempotency_key_hash = UNHEX(?)${lock ? ' FOR UPDATE' : ''}`,
      [sessionId, idempotencyKeyHash],
    )
    const deliveryRow = deliveryRows[0]
    if (!deliveryRow) return null
    const [tokenRows] = await executor.query<TokenRow[]>(
      `${tokenSelect} WHERE id = UUID_TO_BIN(?)`,
      [deliveryRow.token_id],
    )
    if (!tokenRows[0]) return null
    return { token: mapToken(tokenRows[0]), delivery: mapDelivery(deliveryRow) }
  }

  private async insertAudit(executor: DbExecutor, input: AppendAuditInput): Promise<void> {
    await executor.query(
      `INSERT INTO audit_events
        (id, actor_user_id, actor_role, event_type, target_type, target_id, environment_id,
         correlation_id, reason, payload, occurred_at)
        VALUES (UUID_TO_BIN(?), ${input.actor ? 'UUID_TO_BIN(?)' : 'NULL'}, ?, ?, ?,
          ${input.targetId ? 'UUID_TO_BIN(?)' : 'NULL'},
          ${input.environmentId ? 'UUID_TO_BIN(?)' : 'NULL'}, ?, ?, ?, ?)`,
      [
        randomUUID(),
        ...(input.actor ? [input.actor.id] : []),
        input.actor?.systemRole ?? null,
        input.eventType,
        input.targetType,
        ...(input.targetId ? [input.targetId] : []),
        ...(input.environmentId ? [input.environmentId] : []),
        input.correlationId,
        input.reason ?? null,
        JSON.stringify(input.payload ?? {}),
        date(input.occurredAt),
      ],
    )
  }
}
