export type SystemRole = 'USER' | 'ADMIN'
export type UserStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED' | 'DELETED'
export type EnvironmentStage = 'development' | 'staging' | 'production'
export type SigningKeyState = 'DRAFT' | 'PUBLISHED_UNVERIFIED' | 'ACTIVE' | 'RETIRING' | 'RETIRED'

export interface UserRecord {
  id: string
  username: string
  displayName: string
  email: string | null
  systemRole: SystemRole
  status: UserStatus
  authProvider: string
  externalSubject: string
  revision: number
  lastLoginAt: string | null
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

export interface EnvironmentRecord {
  id: string
  name: string
  stage: EnvironmentStage
  revision: number
  createdAt: string
  updatedAt: string
}

export interface EnvironmentAccessRecord {
  userId: string
  environmentId: string
  canIssueTokens: boolean
  maxTokenTtlSeconds: number | null
  maxActiveTokens: number | null
  revision: number
  revokedAt: string | null
}

export interface TokenPolicyRecord {
  environmentId: string
  selfServiceEnabled: boolean
  minTtlSeconds: number
  defaultTtlSeconds: number
  maxTtlSeconds: number
  maxActiveTokensPerUser: number
  requireEffectiveKey: boolean
  deliveryTtlSeconds: number
  revision: number
}

export interface SigningKeyRecord {
  id: string
  environmentId: string
  kid: string
  secret: Buffer
  keyState: SigningKeyState
  issuanceEnabled: boolean
  clockSkewSeconds: number
  retireAfter: string | null
  revision: number
}

export interface SessionRecord {
  id: string
  userId: string
  sessionTokenHash: string
  csrfTokenHash: string
  authTime: string
  mfaTime: string | null
  createdAt: string
  lastSeenAt: string
  idleExpiresAt: string
  absoluteExpiresAt: string
  revokedAt: string | null
}

export interface UserTokenRecord {
  id: string
  userId: string
  environmentId: string
  signingKeyId: string
  tokenName: string
  tokenFingerprint: string
  tokenNonce: string
  bt1Version: 'BT1'
  kid: string
  clockSkewSeconds: number
  issuedBy: string
  issuedForReason: string | null
  issuedAt: string
  expiresAt: string
  acceptedUntil: string
  disabledAt: string | null
  disabledBy: string | null
  disableReason: string | null
  compromiseSuspected: boolean
  lastUsedAt: string | null
  lastUsedSource: string | null
  createdAt: string
  updatedAt: string
}

export interface EncryptedDelivery {
  tokenId: string
  sessionId: string
  idempotencyKeyHash: string
  requestHash: string
  ciphertext: string | null
  nonce: string | null
  createdAt: string
  expiresAt: string
  purgedAt: string | null
}

export interface AuditEventRecord {
  id: string
  sequenceNo: number
  actorUserId: string | null
  actorRole: SystemRole | null
  eventType: string
  targetType: string
  targetId: string | null
  environmentId: string | null
  correlationId: string
  reason: string | null
  payload: Record<string, unknown>
  occurredAt: string
}

export interface BootstrapInput {
  admin: {
    username: string
    displayName: string
    email: string | null
    authProvider: string
    externalSubject: string
  }
  environment: {
    id: string
    name: string
    stage: EnvironmentStage
  }
  policy: Omit<TokenPolicyRecord, 'revision'>
  signingKey: {
    kid: string
    secret: Buffer
    keyState: SigningKeyState
    clockSkewSeconds: number
  }
  now: string
}

export interface UserListQuery {
  search?: string
  role?: SystemRole
  status?: UserStatus
}

export interface CreateUserInput {
  username: string
  displayName: string
  email: string | null
  systemRole: SystemRole
  authProvider: string
  externalSubject: string
  environmentIds: string[]
}

export interface UpdateUserInput {
  displayName?: string
  email?: string | null
  systemRole?: SystemRole
  status?: UserStatus
  expectedRevision?: number
}

export interface TokenIssuanceContext {
  user: UserRecord
  environment: EnvironmentRecord
  access: EnvironmentAccessRecord
  policy: TokenPolicyRecord
  signingKey: SigningKeyRecord
  activeTokenCount: number
}

export interface CommitTokenInput {
  token: UserTokenRecord
  delivery: EncryptedDelivery
  maxActiveTokens: number
  actor: UserRecord
  correlationId: string
}

export interface TokenCommitResult {
  token: UserTokenRecord
  delivery: EncryptedDelivery
  replayed: boolean
}

export interface DisableTokenInput {
  tokenId: string
  ownerUserId?: string
  actor: UserRecord
  reason: string
  compromiseSuspected: boolean
  now: string
  correlationId: string
}

export interface CreateSessionInput {
  userId: string
  sessionTokenHash: string
  csrfTokenHash: string
  mfaTime: string | null
  now: string
  idleExpiresAt: string
  absoluteExpiresAt: string
}

export interface AppendAuditInput {
  actor: UserRecord | null
  eventType: string
  targetType: string
  targetId: string | null
  environmentId?: string | null
  correlationId: string
  reason?: string | null
  payload?: Record<string, unknown>
  occurredAt: string
}

export interface UserStore {
  bootstrap(input: BootstrapInput): Promise<void>
  getUserById(id: string): Promise<UserRecord | null>
  getUserByUsername(username: string): Promise<UserRecord | null>
  getUserByExternalSubject(provider: string, subject: string): Promise<UserRecord | null>
  listUsers(query: UserListQuery): Promise<UserRecord[]>
  createUser(input: CreateUserInput, actor: UserRecord, now: string): Promise<UserRecord>
  updateUser(
    id: string,
    input: UpdateUserInput,
    actor: UserRecord,
    now: string,
  ): Promise<UserRecord>
  markUserLogin(id: string, now: string): Promise<UserRecord>
  listEnvironmentsForUser(userId: string): Promise<
    Array<{
      environment: EnvironmentRecord
      access: EnvironmentAccessRecord
      policy: TokenPolicyRecord
    }>
  >
  grantEnvironmentAccess(
    userId: string,
    environmentId: string,
    actor: UserRecord,
    now: string,
  ): Promise<EnvironmentAccessRecord>
  createSession(input: CreateSessionInput): Promise<SessionRecord>
  getSessionByTokenHash(hash: string, now: string): Promise<SessionRecord | null>
  revokeSession(id: string, userId: string, now: string): Promise<void>
  revokeAllSessions(userId: string, now: string): Promise<void>
  listSigningKeys(environmentId: string): Promise<SigningKeyRecord[]>
  markSigningKeysPublished(environmentId: string, now: string): Promise<void>
  getTokenIssuanceContext(
    userId: string,
    environmentId: string,
    now: string,
  ): Promise<TokenIssuanceContext | null>
  commitToken(input: CommitTokenInput): Promise<TokenCommitResult>
  listTokens(userId: string): Promise<UserTokenRecord[]>
  getTokenById(id: string): Promise<UserTokenRecord | null>
  disableToken(input: DisableTokenInput): Promise<UserTokenRecord>
  purgeDelivery(tokenId: string, sessionId: string, now: string): Promise<void>
  listAuditEvents(limit: number): Promise<AuditEventRecord[]>
  appendAudit(input: AppendAuditInput): Promise<void>
}
