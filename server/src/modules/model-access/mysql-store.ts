import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'

import { DomainError } from '../users/errors.js'
import { renderAccessGroup } from './renderer.js'
import type {
  AccessGroupPublicationRecord,
  ModelAccessRequestRecord,
  ModelAccessRequestStatus,
  ModelAccessStore,
  ProviderAccessGroupRecord,
  RequestCursor,
} from './types.js'

interface GroupRow extends RowDataPacket {
  id: string
  environment_id: string
  provider_id: string
  provider_name: string
  group_name: string
  revision: string | number
  published_revision: string | number
  created_by: string
  created_at: Date
  updated_at: Date
}

interface RequestRow extends RowDataPacket {
  id: string
  environment_id: string
  applicant_user_id: string
  applicant_username: string
  applicant_display_name: string
  model_id: string
  logical_model_name: string
  model_display_name: string
  group_id: string
  group_name: string
  provider_id: string
  provider_name: string
  reason: string
  request_status: ModelAccessRequestStatus
  publication_state: ModelAccessRequestRecord['publicationState']
  activation_state: ModelAccessRequestRecord['activationState']
  decision_reason: string | null
  decided_by: string | null
  decided_at: Date | null
  latest_publication_id: string | null
  grant_revision: string | number | null
  revision: string | number
  idempotency_key_hash?: string
  request_hash?: string
  created_at: Date
  updated_at: Date
}

interface MemberRow extends RowDataPacket {
  group_id: string
  user_id: string
  username: string
  added_revision: string | number
}

interface PublicationRow extends RowDataPacket {
  id: string
  request_id: string
  environment_id: string
  group_id: string
  group_revision: string | number
  group_name: string
  data_id: string
  target_content: string | Record<string, unknown>
  target_md5: string
  attempt_number: number
  publication_state: AccessGroupPublicationRecord['state']
  readback_md5: string | null
  safe_error_code: string | null
  safe_error_message: string | null
  created_by: string
  created_at: Date
  started_at: Date | null
  finished_at: Date | null
}

const groupSelect = `SELECT BIN_TO_UUID(id) AS id,
       BIN_TO_UUID(environment_id) AS environment_id,
       BIN_TO_UUID(provider_id) AS provider_id, provider_name, group_name,
       revision, published_revision, BIN_TO_UUID(created_by) AS created_by,
       created_at, updated_at
  FROM provider_access_groups`

const requestSelect = `SELECT BIN_TO_UUID(id) AS id,
       BIN_TO_UUID(environment_id) AS environment_id,
       BIN_TO_UUID(applicant_user_id) AS applicant_user_id,
       applicant_username, applicant_display_name,
       BIN_TO_UUID(model_id) AS model_id, logical_model_name, model_display_name,
       BIN_TO_UUID(group_id) AS group_id, group_name,
       BIN_TO_UUID(provider_id) AS provider_id, provider_name,
       reason, request_status, publication_state, activation_state,
       decision_reason, BIN_TO_UUID(decided_by) AS decided_by, decided_at,
       BIN_TO_UUID(latest_publication_id) AS latest_publication_id,
       grant_revision, revision, idempotency_key_hash, request_hash,
       created_at, updated_at
  FROM model_access_requests`

const publicationSelect = `SELECT BIN_TO_UUID(id) AS id,
       BIN_TO_UUID(request_id) AS request_id,
       BIN_TO_UUID(environment_id) AS environment_id,
       BIN_TO_UUID(group_id) AS group_id,
       group_revision, group_name, data_id,
       target_content,
       target_md5, attempt_number, publication_state, readback_md5,
       safe_error_code, safe_error_message, BIN_TO_UUID(created_by) AS created_by,
       created_at, started_at, finished_at
  FROM access_group_publications`

function integer(value: string | number): number {
  const result = Number(value)
  if (!Number.isSafeInteger(result)) throw new Error('database revision exceeds safe integer range')
  return result
}

function groupFromRow(row: GroupRow): ProviderAccessGroupRecord {
  return {
    id: row.id,
    environmentId: row.environment_id,
    providerId: row.provider_id,
    providerName: row.provider_name,
    groupName: row.group_name,
    revision: integer(row.revision),
    publishedRevision: integer(row.published_revision),
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function requestFromRow(row: RequestRow): ModelAccessRequestRecord {
  return {
    id: row.id,
    environmentId: row.environment_id,
    applicantUserId: row.applicant_user_id,
    applicantUsername: row.applicant_username,
    applicantDisplayName: row.applicant_display_name,
    modelId: row.model_id,
    logicalModelName: row.logical_model_name,
    modelDisplayName: row.model_display_name,
    groupId: row.group_id,
    groupName: row.group_name,
    providerId: row.provider_id,
    providerName: row.provider_name,
    reason: row.reason,
    status: row.request_status,
    publicationState: row.publication_state,
    activationState: row.activation_state,
    decisionReason: row.decision_reason,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at?.toISOString() ?? null,
    latestPublicationId: row.latest_publication_id,
    grantRevision: row.grant_revision === null ? null : integer(row.grant_revision),
    revision: integer(row.revision),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

function publicationFromRow(row: PublicationRow): AccessGroupPublicationRecord {
  return {
    id: row.id,
    requestId: row.request_id,
    environmentId: row.environment_id,
    groupId: row.group_id,
    groupRevision: integer(row.group_revision),
    groupName: row.group_name,
    dataId: row.data_id,
    targetContent:
      typeof row.target_content === 'string'
        ? row.target_content
        : JSON.stringify(row.target_content),
    targetMd5: row.target_md5,
    attemptNumber: row.attempt_number,
    state: row.publication_state,
    readbackMd5: row.readback_md5,
    safeErrorCode: row.safe_error_code,
    safeErrorMessage: row.safe_error_message,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    finishedAt: row.finished_at?.toISOString() ?? null,
  }
}

function placeholders(size: number): string {
  return Array.from({ length: size }, () => 'UUID_TO_BIN(?)').join(', ')
}

function duplicateEntry(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'code' in error && error.code === 'ER_DUP_ENTRY'
  )
}

function requirePendingRevision(row: RequestRow, expectedRevision: number): void {
  const revision = integer(row.revision)
  if (revision !== expectedRevision) {
    throw new DomainError('REQUEST_REVISION_CONFLICT', 412, '申请已被其他操作更新', {
      serverRevision: revision,
    })
  }
  if (row.request_status !== 'PENDING') {
    throw new DomainError('REQUEST_ALREADY_DECIDED', 409, '申请已经处理')
  }
}

export class MySqlModelAccessStore implements ModelAccessStore {
  constructor(private readonly pool: Pool) {}

  async acquirePublicationLock(groupId: string): Promise<() => Promise<void>> {
    const connection = await this.pool.getConnection()
    const lockName = `ai-console:access:${groupId}`
    try {
      const [rows] = await connection.query<Array<RowDataPacket & { acquired: number }>>(
        'SELECT GET_LOCK(?, 15) AS acquired',
        [lockName],
      )
      if (Number(rows[0]?.acquired) !== 1) {
        throw new DomainError('PUBLICATION_LOCK_TIMEOUT', 503, '等待授权组发布锁超时')
      }
    } catch (error) {
      connection.release()
      throw error
    }
    return async () => {
      try {
        await connection.query('SELECT RELEASE_LOCK(?) AS released', [lockName])
      } finally {
        connection.release()
      }
    }
  }

  async ensureGroupForProvider(input: {
    id: string
    environmentId: string
    providerId: string
    providerName: string
    groupName: string
    actorId: string
    now: string
  }): Promise<ProviderAccessGroupRecord> {
    const existing = await this.groupForProvider(input.environmentId, input.providerId)
    if (existing) {
      if (existing.providerName !== input.providerName) {
        throw new DomainError('ACCESS_GROUP_PROVIDER_MISMATCH', 409, 'Provider 授权组关系不一致')
      }
      return existing
    }
    try {
      await this.pool.query(
        `INSERT INTO provider_access_groups
          (id, environment_id, provider_id, provider_name, group_name,
           revision, published_revision, created_by, created_at, updated_at)
         VALUES (UUID_TO_BIN(?), UUID_TO_BIN(?), UUID_TO_BIN(?), ?, ?,
                 0, 0, UUID_TO_BIN(?), ?, ?)`,
        [
          input.id,
          input.environmentId,
          input.providerId,
          input.providerName,
          input.groupName,
          input.actorId,
          input.now,
          input.now,
        ],
      )
    } catch (error) {
      if (!duplicateEntry(error)) throw error
    }
    const result = await this.groupForProvider(input.environmentId, input.providerId)
    if (!result || result.providerName !== input.providerName) {
      throw new DomainError('ACCESS_GROUP_NAME_CONFLICT', 409, '授权组名称冲突')
    }
    return result
  }

  async getGroupsByIds(ids: string[]): Promise<ProviderAccessGroupRecord[]> {
    if (ids.length === 0) return []
    const unique = [...new Set(ids)]
    const [rows] = await this.pool.query<GroupRow[]>(
      `${groupSelect} WHERE id IN (${placeholders(unique.length)})`,
      unique,
    )
    return rows.map(groupFromRow)
  }

  async getGroupSnapshot(
    groupId: string,
  ): Promise<{ group: ProviderAccessGroupRecord; usernames: string[] } | null> {
    const groups = await this.getGroupsByIds([groupId])
    if (!groups[0]) return null
    const [members] = await this.pool.query<MemberRow[]>(
      `SELECT BIN_TO_UUID(group_id) AS group_id, BIN_TO_UUID(user_id) AS user_id,
              username, added_revision
         FROM provider_access_group_members
        WHERE group_id = UUID_TO_BIN(?) ORDER BY username`,
      [groupId],
    )
    return { group: groups[0], usernames: members.map((member) => member.username) }
  }

  async markGroupPublished(input: {
    groupId: string
    revision: number
    now: string
  }): Promise<ProviderAccessGroupRecord> {
    await this.pool.query(
      `UPDATE provider_access_groups
          SET published_revision = ?, updated_at = ?
        WHERE id = UUID_TO_BIN(?) AND revision = ?`,
      [input.revision, input.now, input.groupId, input.revision],
    )
    const groups = await this.getGroupsByIds([input.groupId])
    const group = groups[0]
    if (!group) throw new DomainError('ACCESS_GROUP_NOT_FOUND', 404, '申请授权组不存在')
    if (group.revision !== input.revision || group.publishedRevision < input.revision) {
      throw new DomainError('ACCESS_GROUP_REVISION_CHANGED', 409, '申请授权组已发生变化')
    }
    return group
  }

  async isPublishedMember(input: { groupIds: string[]; userId: string }): Promise<boolean> {
    return (await this.getPublishedMembershipGroupIds(input)).length > 0
  }

  async getPublishedMembershipGroupIds(input: {
    groupIds: string[]
    userId: string
  }): Promise<string[]> {
    if (input.groupIds.length === 0) return []
    const unique = [...new Set(input.groupIds)]
    const [rows] = await this.pool.query<MemberRow[]>(
      `SELECT BIN_TO_UUID(group_id) AS group_id, BIN_TO_UUID(user_id) AS user_id,
              username, added_revision
         FROM provider_access_group_members
        WHERE user_id = UUID_TO_BIN(?) AND group_id IN (${placeholders(unique.length)})`,
      [input.userId, ...unique],
    )
    const groups = new Map((await this.getGroupsByIds(unique)).map((group) => [group.id, group]))
    return rows.flatMap((member) => {
      const group = groups.get(member.group_id)
      return group && group.publishedRevision >= integer(member.added_revision)
        ? [member.group_id]
        : []
    })
  }

  async createRequest(input: {
    request: ModelAccessRequestRecord
    idempotencyKeyHash: string
    requestHash: string
  }): Promise<{ request: ModelAccessRequestRecord; replayed: boolean }> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [replayRows] = await connection.query<RequestRow[]>(
        `${requestSelect}
         WHERE applicant_user_id = UUID_TO_BIN(?) AND idempotency_key_hash = ?
         LIMIT 1 FOR UPDATE`,
        [input.request.applicantUserId, input.idempotencyKeyHash],
      )
      if (replayRows.length) {
        if (replayRows[0].request_hash !== input.requestHash) {
          throw new DomainError('IDEMPOTENCY_CONFLICT', 409, 'Idempotency-Key 已用于其他请求')
        }
        await connection.commit()
        return { request: requestFromRow(replayRows[0]), replayed: true }
      }
      const [existingRows] = await connection.query<RequestRow[]>(
        `${requestSelect}
         WHERE environment_id = UUID_TO_BIN(?) AND applicant_user_id = UUID_TO_BIN(?)
           AND model_id = UUID_TO_BIN(?) AND request_status IN ('PENDING', 'APPROVED')
         ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [input.request.environmentId, input.request.applicantUserId, input.request.modelId],
      )
      const existing = existingRows[0]
      if (existing?.request_status === 'PENDING') {
        throw new DomainError('MODEL_ACCESS_REQUEST_PENDING', 409, '该模型已有待审批申请', {
          requestId: existing.id,
        })
      }
      if (existing?.request_status === 'APPROVED') {
        throw new DomainError('MODEL_ACCESS_REQUEST_APPROVED', 409, '该模型已有批准记录', {
          requestId: existing.id,
        })
      }
      await connection.query(
        `INSERT INTO model_access_requests
          (id, environment_id, applicant_user_id, applicant_username,
           applicant_display_name, model_id, logical_model_name, model_display_name,
           group_id, group_name, provider_id, provider_name, reason,
           request_status, publication_state, activation_state,
           decision_reason, decided_by, decided_at, latest_publication_id,
           grant_revision, revision, idempotency_key_hash, request_hash,
           created_at, updated_at)
         VALUES (UUID_TO_BIN(?), UUID_TO_BIN(?), UUID_TO_BIN(?), ?, ?,
                 UUID_TO_BIN(?), ?, ?, UUID_TO_BIN(?), ?, UUID_TO_BIN(?), ?, ?,
                 'PENDING', 'NOT_STARTED', 'UNKNOWN', NULL, NULL, NULL, NULL,
                 NULL, 1, ?, ?, ?, ?)`,
        [
          input.request.id,
          input.request.environmentId,
          input.request.applicantUserId,
          input.request.applicantUsername,
          input.request.applicantDisplayName,
          input.request.modelId,
          input.request.logicalModelName,
          input.request.modelDisplayName,
          input.request.groupId,
          input.request.groupName,
          input.request.providerId,
          input.request.providerName,
          input.request.reason,
          input.idempotencyKeyHash,
          input.requestHash,
          input.request.createdAt,
          input.request.updatedAt,
        ],
      )
      await connection.commit()
      return { request: input.request, replayed: false }
    } catch (error) {
      await connection.rollback()
      if (duplicateEntry(error)) {
        throw new DomainError('MODEL_ACCESS_REQUEST_PENDING', 409, '该模型已有待审批申请')
      }
      throw error
    } finally {
      connection.release()
    }
  }

  async listForApplicant(input: {
    applicantUserId: string
    environmentId?: string
    status?: ModelAccessRequestStatus
    before?: RequestCursor
    limit: number
  }): Promise<ModelAccessRequestRecord[]> {
    const where = ['applicant_user_id = UUID_TO_BIN(?)']
    const parameters: Array<string | number> = [input.applicantUserId]
    this.appendFilters(where, parameters, input)
    const [rows] = await this.pool.query<RequestRow[]>(
      `${requestSelect} WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      [...parameters, input.limit],
    )
    return rows.map(requestFromRow)
  }

  async listForAdmin(input: {
    environmentId?: string
    status?: ModelAccessRequestStatus
    search?: string
    before?: RequestCursor
    limit: number
  }): Promise<ModelAccessRequestRecord[]> {
    const where = ['1 = 1']
    const parameters: Array<string | number> = []
    this.appendFilters(where, parameters, input)
    if (input.search?.trim()) {
      const value = `%${input.search.trim()}%`
      where.push(
        `(applicant_username LIKE ? OR applicant_display_name LIKE ?
          OR logical_model_name LIKE ? OR model_display_name LIKE ?)`,
      )
      parameters.push(value, value, value, value)
    }
    const [rows] = await this.pool.query<RequestRow[]>(
      `${requestSelect} WHERE ${where.join(' AND ')}
       ORDER BY created_at DESC, id DESC LIMIT ?`,
      [...parameters, input.limit],
    )
    return rows.map(requestFromRow)
  }

  async getRequest(id: string): Promise<ModelAccessRequestRecord | null> {
    const [rows] = await this.pool.query<RequestRow[]>(
      `${requestSelect} WHERE id = UUID_TO_BIN(?) LIMIT 1`,
      [id],
    )
    return rows[0] ? requestFromRow(rows[0]) : null
  }

  async cancel(input: {
    requestId: string
    applicantUserId: string
    expectedRevision: number
    now: string
  }): Promise<ModelAccessRequestRecord> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const row = await this.lockRequest(connection, input.requestId)
      if (row.applicant_user_id !== input.applicantUserId) {
        throw new DomainError('MODEL_ACCESS_REQUEST_NOT_FOUND', 404, '权限申请不存在')
      }
      requirePendingRevision(row, input.expectedRevision)
      await connection.query(
        `UPDATE model_access_requests
            SET request_status = 'CANCELLED', revision = revision + 1, updated_at = ?
          WHERE id = UUID_TO_BIN(?)`,
        [input.now, input.requestId],
      )
      const result = await this.lockRequest(connection, input.requestId)
      await connection.commit()
      return requestFromRow(result)
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async approve(input: {
    requestId: string
    expectedRevision: number
    actorId: string
    decisionReason: string | null
    publication: Omit<AccessGroupPublicationRecord, 'groupRevision' | 'targetContent' | 'targetMd5'>
    now: string
  }): Promise<{ request: ModelAccessRequestRecord; publication: AccessGroupPublicationRecord }> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const requestRow = await this.lockRequest(connection, input.requestId)
      requirePendingRevision(requestRow, input.expectedRevision)
      const [groupRows] = await connection.query<GroupRow[]>(
        `${groupSelect} WHERE id = UUID_TO_BIN(?) LIMIT 1 FOR UPDATE`,
        [requestRow.group_id],
      )
      if (!groupRows[0])
        throw new DomainError('ACCESS_GROUP_NOT_FOUND', 409, '模型申请授权组不存在')
      const group = groupFromRow(groupRows[0])
      group.revision += 1
      group.updatedAt = input.now
      await connection.query(
        `UPDATE provider_access_groups SET revision = ?, updated_at = ? WHERE id = UUID_TO_BIN(?)`,
        [group.revision, input.now, group.id],
      )
      await connection.query(
        `INSERT INTO provider_access_group_members
          (group_id, user_id, username, source_request_id, added_revision, added_by, added_at)
         VALUES (UUID_TO_BIN(?), UUID_TO_BIN(?), ?, UUID_TO_BIN(?), ?, UUID_TO_BIN(?), ?)
         ON DUPLICATE KEY UPDATE username = username`,
        [
          group.id,
          requestRow.applicant_user_id,
          requestRow.applicant_username,
          requestRow.id,
          group.revision,
          input.actorId,
          input.now,
        ],
      )
      const [memberRows] = await connection.query<MemberRow[]>(
        `SELECT BIN_TO_UUID(group_id) AS group_id, BIN_TO_UUID(user_id) AS user_id,
                username, added_revision
           FROM provider_access_group_members
          WHERE group_id = UUID_TO_BIN(?) ORDER BY username`,
        [group.id],
      )
      const rendered = renderAccessGroup(
        group,
        memberRows.map((member) => member.username),
      )
      const publication: AccessGroupPublicationRecord = {
        ...input.publication,
        groupRevision: group.revision,
        groupName: group.groupName,
        dataId: rendered.dataId,
        targetContent: rendered.content,
        targetMd5: rendered.md5,
      }
      await this.insertPublication(connection, publication)
      await connection.query(
        `UPDATE model_access_requests
            SET request_status = 'APPROVED', publication_state = 'PENDING',
                decision_reason = ?, decided_by = UUID_TO_BIN(?), decided_at = ?,
                latest_publication_id = UUID_TO_BIN(?), grant_revision = ?,
                revision = revision + 1, updated_at = ?
          WHERE id = UUID_TO_BIN(?)`,
        [
          input.decisionReason,
          input.actorId,
          input.now,
          publication.id,
          group.revision,
          input.now,
          requestRow.id,
        ],
      )
      const result = await this.lockRequest(connection, input.requestId)
      await connection.commit()
      return { request: requestFromRow(result), publication }
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async reject(input: {
    requestId: string
    expectedRevision: number
    actorId: string
    reason: string
    now: string
  }): Promise<ModelAccessRequestRecord> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const row = await this.lockRequest(connection, input.requestId)
      requirePendingRevision(row, input.expectedRevision)
      await connection.query(
        `UPDATE model_access_requests
            SET request_status = 'REJECTED', decision_reason = ?,
                decided_by = UUID_TO_BIN(?), decided_at = ?,
                revision = revision + 1, updated_at = ?
          WHERE id = UUID_TO_BIN(?)`,
        [input.reason, input.actorId, input.now, input.now, input.requestId],
      )
      const result = await this.lockRequest(connection, input.requestId)
      await connection.commit()
      return requestFromRow(result)
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async createPublicationRetry(input: {
    requestId: string
    actorId: string
    publicationId: string
    now: string
  }): Promise<AccessGroupPublicationRecord> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const request = await this.lockRequest(connection, input.requestId)
      if (request.request_status !== 'APPROVED' || request.publication_state !== 'FAILED') {
        throw new DomainError('PUBLICATION_RETRY_NOT_ALLOWED', 409, '当前状态不能重试发布')
      }
      const [rows] = await connection.query<PublicationRow[]>(
        `${publicationSelect} WHERE id = UUID_TO_BIN(?) LIMIT 1 FOR UPDATE`,
        [request.latest_publication_id],
      )
      if (!rows[0]) throw new DomainError('PUBLICATION_NOT_FOUND', 409, '找不到可重试的发布内容')
      const previous = publicationFromRow(rows[0])
      const [groupRows] = await connection.query<GroupRow[]>(
        `${groupSelect} WHERE id = UUID_TO_BIN(?) LIMIT 1 FOR UPDATE`,
        [request.group_id],
      )
      if (!groupRows[0] || integer(groupRows[0].revision) !== previous.groupRevision) {
        throw new DomainError('PUBLICATION_SUPERSEDED', 409, '该发布已被更新的授权组修订取代')
      }
      const publication: AccessGroupPublicationRecord = {
        ...previous,
        id: input.publicationId,
        attemptNumber: previous.attemptNumber + 1,
        state: 'PENDING',
        readbackMd5: null,
        safeErrorCode: null,
        safeErrorMessage: null,
        createdBy: input.actorId,
        createdAt: input.now,
        startedAt: null,
        finishedAt: null,
      }
      await this.insertPublication(connection, publication)
      await connection.query(
        `UPDATE model_access_requests
            SET latest_publication_id = UUID_TO_BIN(?), publication_state = 'PENDING',
                revision = revision + 1, updated_at = ?
          WHERE id = UUID_TO_BIN(?)`,
        [publication.id, input.now, input.requestId],
      )
      await connection.commit()
      return publication
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  async markPublicationResult(input: {
    publicationId: string
    requestId: string
    state: 'PUBLISHED' | 'FAILED'
    readbackMd5?: string
    safeErrorCode?: string
    safeErrorMessage?: string
    now: string
  }): Promise<ModelAccessRequestRecord> {
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [rows] = await connection.query<PublicationRow[]>(
        `${publicationSelect} WHERE id = UUID_TO_BIN(?) LIMIT 1 FOR UPDATE`,
        [input.publicationId],
      )
      if (!rows[0] || rows[0].request_id !== input.requestId) {
        throw new DomainError('PUBLICATION_NOT_FOUND', 404, '发布记录不存在')
      }
      const publication = publicationFromRow(rows[0])
      await connection.query(
        `UPDATE access_group_publications
            SET publication_state = ?, readback_md5 = ?, safe_error_code = ?,
                safe_error_message = ?, started_at = COALESCE(started_at, ?), finished_at = ?
          WHERE id = UUID_TO_BIN(?)`,
        [
          input.state,
          input.readbackMd5 ?? null,
          input.safeErrorCode ?? null,
          input.safeErrorMessage ?? null,
          input.now,
          input.now,
          input.publicationId,
        ],
      )
      if (input.state === 'PUBLISHED') {
        await connection.query(
          `UPDATE provider_access_groups
              SET published_revision = GREATEST(published_revision, ?), updated_at = ?
            WHERE id = UUID_TO_BIN(?)`,
          [publication.groupRevision, input.now, publication.groupId],
        )
      }
      await connection.query(
        `UPDATE model_access_requests
            SET publication_state = ?, revision = revision + 1, updated_at = ?
          WHERE id = UUID_TO_BIN(?) AND latest_publication_id = UUID_TO_BIN(?)`,
        [input.state, input.now, input.requestId, input.publicationId],
      )
      const request = await this.lockRequest(connection, input.requestId)
      await connection.commit()
      return requestFromRow(request)
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  private async groupForProvider(
    environmentId: string,
    providerId: string,
  ): Promise<ProviderAccessGroupRecord | null> {
    const [rows] = await this.pool.query<GroupRow[]>(
      `${groupSelect}
       WHERE environment_id = UUID_TO_BIN(?) AND provider_id = UUID_TO_BIN(?) LIMIT 1`,
      [environmentId, providerId],
    )
    return rows[0] ? groupFromRow(rows[0]) : null
  }

  private appendFilters(
    where: string[],
    parameters: Array<string | number>,
    input: {
      environmentId?: string
      status?: ModelAccessRequestStatus
      before?: RequestCursor
    },
  ): void {
    if (input.environmentId) {
      where.push('environment_id = UUID_TO_BIN(?)')
      parameters.push(input.environmentId)
    }
    if (input.status) {
      where.push('request_status = ?')
      parameters.push(input.status)
    }
    if (input.before) {
      where.push('(created_at < ? OR (created_at = ? AND id < UUID_TO_BIN(?)))')
      parameters.push(input.before.createdAt, input.before.createdAt, input.before.id)
    }
  }

  private async lockRequest(connection: PoolConnection, id: string): Promise<RequestRow> {
    const [rows] = await connection.query<RequestRow[]>(
      `${requestSelect} WHERE id = UUID_TO_BIN(?) LIMIT 1 FOR UPDATE`,
      [id],
    )
    if (!rows[0]) throw new DomainError('MODEL_ACCESS_REQUEST_NOT_FOUND', 404, '权限申请不存在')
    return rows[0]
  }

  private async insertPublication(
    connection: PoolConnection,
    publication: AccessGroupPublicationRecord,
  ): Promise<void> {
    await connection.query<ResultSetHeader>(
      `INSERT INTO access_group_publications
        (id, request_id, environment_id, group_id, group_revision, group_name,
         data_id, target_content, target_md5, attempt_number, publication_state,
         readback_md5, safe_error_code, safe_error_message, created_by,
         created_at, started_at, finished_at)
       VALUES (UUID_TO_BIN(?), UUID_TO_BIN(?), UUID_TO_BIN(?), UUID_TO_BIN(?), ?, ?,
               ?, ?, ?, ?, ?, ?, ?, ?, UUID_TO_BIN(?), ?, ?, ?)`,
      [
        publication.id,
        publication.requestId,
        publication.environmentId,
        publication.groupId,
        publication.groupRevision,
        publication.groupName,
        publication.dataId,
        publication.targetContent,
        publication.targetMd5,
        publication.attemptNumber,
        publication.state,
        publication.readbackMd5,
        publication.safeErrorCode,
        publication.safeErrorMessage,
        publication.createdBy,
        publication.createdAt,
        publication.startedAt,
        publication.finishedAt,
      ],
    )
  }
}

export const modelAccessRuntimeSql = [groupSelect, requestSelect, publicationSelect] as const
