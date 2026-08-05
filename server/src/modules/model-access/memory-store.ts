import { DomainError } from '../users/errors.js'
import { renderAccessGroup } from './renderer.js'
import type {
  AccessGroupPublicationRecord,
  ModelAccessRequestRecord,
  ModelAccessRequestStatus,
  ModelAccessStore,
  ModelAccessGroupMemberRecord,
  ModelAccessGroupRecord,
  RequestCursor,
} from './types.js'

function copy<T>(value: T): T {
  return structuredClone(value)
}

function isBefore(request: ModelAccessRequestRecord, cursor: RequestCursor): boolean {
  return (
    request.createdAt < cursor.createdAt ||
    (request.createdAt === cursor.createdAt && request.id < cursor.id)
  )
}

function sortRequests(records: ModelAccessRequestRecord[]): ModelAccessRequestRecord[] {
  return records.sort(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
  )
}

export class MemoryModelAccessStore implements ModelAccessStore {
  private readonly groups = new Map<string, ModelAccessGroupRecord>()
  private readonly groupByModel = new Map<string, string>()
  private readonly members = new Map<string, ModelAccessGroupMemberRecord>()
  private readonly requests = new Map<string, ModelAccessRequestRecord>()
  private readonly idempotency = new Map<string, { requestHash: string; requestId: string }>()
  private readonly publications = new Map<string, AccessGroupPublicationRecord>()

  async acquirePublicationLock(): Promise<() => Promise<void>> {
    return async () => undefined
  }

  async ensureGroupForModel(input: {
    id: string
    environmentId: string
    modelId: string
    logicalModelName: string
    groupName: string
    actorId: string
    now: string
  }): Promise<ModelAccessGroupRecord> {
    const modelKey = `${input.environmentId}:${input.modelId}`
    const existingId = this.groupByModel.get(modelKey)
    if (existingId) {
      const existing = this.groups.get(existingId)!
      if (existing.logicalModelName !== input.logicalModelName) {
        throw new DomainError('ACCESS_GROUP_MODEL_MISMATCH', 409, '模型授权组关系不一致')
      }
      return copy(existing)
    }
    const conflict = [...this.groups.values()].some(
      (group) => group.environmentId === input.environmentId && group.groupName === input.groupName,
    )
    if (conflict) throw new DomainError('ACCESS_GROUP_NAME_CONFLICT', 409, '授权组名称冲突')
    const group: ModelAccessGroupRecord = {
      id: input.id,
      environmentId: input.environmentId,
      modelId: input.modelId,
      logicalModelName: input.logicalModelName,
      groupName: input.groupName,
      revision: 0,
      publishedRevision: 0,
      createdBy: input.actorId,
      createdAt: input.now,
      updatedAt: input.now,
    }
    this.groups.set(group.id, group)
    this.groupByModel.set(modelKey, group.id)
    return copy(group)
  }

  async getGroupsByIds(ids: string[]): Promise<ModelAccessGroupRecord[]> {
    return ids.flatMap((id) => {
      const group = this.groups.get(id)
      return group ? [copy(group)] : []
    })
  }

  async getGroupSnapshot(
    groupId: string,
  ): Promise<{ group: ModelAccessGroupRecord; usernames: string[] } | null> {
    const group = this.groups.get(groupId)
    if (!group) return null
    const usernames = [...this.members.values()]
      .filter((member) => member.groupId === groupId)
      .map((member) => member.username)
    return { group: copy(group), usernames }
  }

  async getLatestSuccessfulPublication(
    groupId: string,
  ): Promise<AccessGroupPublicationRecord | null> {
    const publication = [...this.publications.values()]
      .filter((candidate) => candidate.groupId === groupId && candidate.state === 'PUBLISHED')
      .sort(
        (left, right) =>
          right.groupRevision - left.groupRevision ||
          right.attemptNumber - left.attemptNumber ||
          right.createdAt.localeCompare(left.createdAt),
      )[0]
    return publication ? copy(publication) : null
  }

  async createManualPublication(input: {
    publicationId: string
    groupId: string
    actorId: string
    expectedOldMd5: string | null
    now: string
  }): Promise<AccessGroupPublicationRecord> {
    const snapshot = await this.getGroupSnapshot(input.groupId)
    if (!snapshot) throw new DomainError('ACCESS_GROUP_NOT_FOUND', 404, '申请授权组不存在')
    const rendered = renderAccessGroup(snapshot.group, snapshot.usernames)
    const attemptNumber =
      Math.max(
        0,
        ...[...this.publications.values()]
          .filter(
            (publication) =>
              publication.groupId === input.groupId &&
              publication.groupRevision === snapshot.group.revision,
          )
          .map((publication) => publication.attemptNumber),
      ) + 1
    const publication: AccessGroupPublicationRecord = {
      id: input.publicationId,
      requestId: null,
      publicationKind: 'MANUAL_SYNC',
      environmentId: snapshot.group.environmentId,
      groupId: snapshot.group.id,
      groupRevision: snapshot.group.revision,
      groupName: snapshot.group.groupName,
      dataId: rendered.dataId,
      targetContent: rendered.content,
      targetMd5: rendered.md5,
      expectedOldMd5: input.expectedOldMd5,
      attemptNumber,
      state: 'PENDING',
      readbackMd5: null,
      safeErrorCode: null,
      safeErrorMessage: null,
      createdBy: input.actorId,
      createdAt: input.now,
      startedAt: null,
      finishedAt: null,
    }
    this.publications.set(publication.id, publication)
    return copy(publication)
  }

  async markManualPublicationResult(input: {
    publicationId: string
    state: 'PUBLISHED' | 'FAILED'
    readbackMd5?: string
    safeErrorCode?: string
    safeErrorMessage?: string
    now: string
  }): Promise<ModelAccessGroupRecord> {
    const publication = this.publications.get(input.publicationId)
    if (!publication || publication.publicationKind !== 'MANUAL_SYNC') {
      throw new DomainError('PUBLICATION_NOT_FOUND', 404, '发布记录不存在')
    }
    publication.state = input.state
    publication.readbackMd5 = input.readbackMd5 ?? null
    publication.safeErrorCode = input.safeErrorCode ?? null
    publication.safeErrorMessage = input.safeErrorMessage ?? null
    publication.startedAt ??= input.now
    publication.finishedAt = input.now
    const group = this.groups.get(publication.groupId)
    if (!group) throw new DomainError('ACCESS_GROUP_NOT_FOUND', 404, '申请授权组不存在')
    if (input.state === 'PUBLISHED') {
      group.publishedRevision = Math.max(group.publishedRevision, publication.groupRevision)
      group.updatedAt = input.now
    }
    return copy(group)
  }

  async markGroupPublished(input: {
    groupId: string
    revision: number
    now: string
  }): Promise<ModelAccessGroupRecord> {
    const group = this.groups.get(input.groupId)
    if (!group) throw new DomainError('ACCESS_GROUP_NOT_FOUND', 404, '申请授权组不存在')
    if (group.revision !== input.revision) {
      throw new DomainError('ACCESS_GROUP_REVISION_CHANGED', 409, '申请授权组已发生变化')
    }
    group.publishedRevision = Math.max(group.publishedRevision, input.revision)
    group.updatedAt = input.now
    return copy(group)
  }

  async isPublishedMember(input: { groupIds: string[]; userId: string }): Promise<boolean> {
    return (await this.getPublishedMembershipGroupIds(input)).length > 0
  }

  async getPublishedMembershipGroupIds(input: {
    groupIds: string[]
    userId: string
  }): Promise<string[]> {
    return input.groupIds.filter((groupId) => {
      const group = this.groups.get(groupId)
      const member = this.members.get(`${groupId}:${input.userId}`)
      return Boolean(group && member && group.publishedRevision >= member.addedRevision)
    })
  }

  async createRequest(input: {
    request: ModelAccessRequestRecord
    idempotencyKeyHash: string
    requestHash: string
  }): Promise<{ request: ModelAccessRequestRecord; replayed: boolean }> {
    const key = `${input.request.applicantUserId}:${input.idempotencyKeyHash}`
    const replay = this.idempotency.get(key)
    if (replay) {
      if (replay.requestHash !== input.requestHash) {
        throw new DomainError('IDEMPOTENCY_CONFLICT', 409, 'Idempotency-Key 已用于其他请求')
      }
      return { request: copy(this.requests.get(replay.requestId)!), replayed: true }
    }
    const pending = [...this.requests.values()].find(
      (request) =>
        request.applicantUserId === input.request.applicantUserId &&
        request.environmentId === input.request.environmentId &&
        request.modelId === input.request.modelId &&
        request.status === 'PENDING',
    )
    if (pending) {
      throw new DomainError('MODEL_ACCESS_REQUEST_PENDING', 409, '该模型已有待审批申请', {
        requestId: pending.id,
      })
    }
    const approved = [...this.requests.values()].find(
      (request) =>
        request.applicantUserId === input.request.applicantUserId &&
        request.environmentId === input.request.environmentId &&
        request.modelId === input.request.modelId &&
        request.status === 'APPROVED',
    )
    if (approved) {
      throw new DomainError('MODEL_ACCESS_REQUEST_APPROVED', 409, '该模型已有批准记录', {
        requestId: approved.id,
      })
    }
    this.requests.set(input.request.id, copy(input.request))
    this.idempotency.set(key, {
      requestHash: input.requestHash,
      requestId: input.request.id,
    })
    return { request: copy(input.request), replayed: false }
  }

  async listForApplicant(input: {
    applicantUserId: string
    environmentId?: string
    status?: ModelAccessRequestStatus
    before?: RequestCursor
    limit: number
  }): Promise<ModelAccessRequestRecord[]> {
    return copy(
      sortRequests(
        [...this.requests.values()].filter(
          (request) =>
            request.applicantUserId === input.applicantUserId &&
            (!input.environmentId || request.environmentId === input.environmentId) &&
            (!input.status || request.status === input.status) &&
            (!input.before || isBefore(request, input.before)),
        ),
      ).slice(0, input.limit),
    )
  }

  async listForAdmin(input: {
    environmentId?: string
    status?: ModelAccessRequestStatus
    search?: string
    before?: RequestCursor
    limit: number
  }): Promise<ModelAccessRequestRecord[]> {
    const search = input.search?.trim().toLocaleLowerCase()
    return copy(
      sortRequests(
        [...this.requests.values()].filter(
          (request) =>
            (!input.environmentId || request.environmentId === input.environmentId) &&
            (!input.status || request.status === input.status) &&
            (!input.before || isBefore(request, input.before)) &&
            (!search ||
              request.applicantUsername.toLocaleLowerCase().includes(search) ||
              request.applicantDisplayName.toLocaleLowerCase().includes(search) ||
              request.logicalModelName.toLocaleLowerCase().includes(search) ||
              request.modelDisplayName.toLocaleLowerCase().includes(search)),
        ),
      ).slice(0, input.limit),
    )
  }

  async getRequest(id: string): Promise<ModelAccessRequestRecord | null> {
    const request = this.requests.get(id)
    return request ? copy(request) : null
  }

  async cancel(input: {
    requestId: string
    applicantUserId: string
    expectedRevision: number
    now: string
  }): Promise<ModelAccessRequestRecord> {
    const request = this.requireRequest(input.requestId)
    if (request.applicantUserId !== input.applicantUserId) {
      throw new DomainError('MODEL_ACCESS_REQUEST_NOT_FOUND', 404, '权限申请不存在')
    }
    this.requirePendingRevision(request, input.expectedRevision)
    request.status = 'CANCELLED'
    request.revision += 1
    request.updatedAt = input.now
    return copy(request)
  }

  async approve(input: {
    requestId: string
    expectedRevision: number
    actorId: string
    decisionReason: string | null
    publication: Omit<AccessGroupPublicationRecord, 'groupRevision' | 'targetContent' | 'targetMd5'>
    now: string
  }): Promise<{ request: ModelAccessRequestRecord; publication: AccessGroupPublicationRecord }> {
    const request = this.requireRequest(input.requestId)
    this.requirePendingRevision(request, input.expectedRevision)
    const group = this.groups.get(request.groupId)
    if (!group) throw new DomainError('ACCESS_GROUP_NOT_FOUND', 409, '模型申请授权组不存在')
    group.revision += 1
    group.updatedAt = input.now
    const memberKey = `${group.id}:${request.applicantUserId}`
    if (!this.members.has(memberKey)) {
      this.members.set(memberKey, {
        groupId: group.id,
        userId: request.applicantUserId,
        username: request.applicantUsername,
        sourceRequestId: request.id,
        addedRevision: group.revision,
        addedBy: input.actorId,
        addedAt: input.now,
      })
    }
    const usernames = [...this.members.values()]
      .filter((member) => member.groupId === group.id)
      .map((member) => member.username)
    const rendered = renderAccessGroup(group, usernames)
    const publication: AccessGroupPublicationRecord = {
      ...copy(input.publication),
      groupRevision: group.revision,
      targetContent: rendered.content,
      targetMd5: rendered.md5,
      dataId: rendered.dataId,
      groupName: group.groupName,
    }
    this.publications.set(publication.id, publication)
    request.status = 'APPROVED'
    request.publicationState = 'PENDING'
    request.decisionReason = input.decisionReason
    request.decidedBy = input.actorId
    request.decidedAt = input.now
    request.latestPublicationId = publication.id
    request.grantRevision = group.revision
    request.revision += 1
    request.updatedAt = input.now
    return { request: copy(request), publication: copy(publication) }
  }

  async reject(input: {
    requestId: string
    expectedRevision: number
    actorId: string
    reason: string
    now: string
  }): Promise<ModelAccessRequestRecord> {
    const request = this.requireRequest(input.requestId)
    this.requirePendingRevision(request, input.expectedRevision)
    request.status = 'REJECTED'
    request.decisionReason = input.reason
    request.decidedBy = input.actorId
    request.decidedAt = input.now
    request.revision += 1
    request.updatedAt = input.now
    return copy(request)
  }

  async createPublicationRetry(input: {
    requestId: string
    actorId: string
    publicationId: string
    now: string
  }): Promise<AccessGroupPublicationRecord> {
    const request = this.requireRequest(input.requestId)
    if (request.status !== 'APPROVED' || request.publicationState !== 'FAILED') {
      throw new DomainError('PUBLICATION_RETRY_NOT_ALLOWED', 409, '当前状态不能重试发布')
    }
    const previous = request.latestPublicationId
      ? this.publications.get(request.latestPublicationId)
      : undefined
    if (!previous) throw new DomainError('PUBLICATION_NOT_FOUND', 409, '找不到可重试的发布内容')
    const group = this.groups.get(request.groupId)
    if (!group || group.revision !== previous.groupRevision) {
      throw new DomainError('PUBLICATION_SUPERSEDED', 409, '该发布已被更新的授权组修订取代')
    }
    const publication: AccessGroupPublicationRecord = {
      ...copy(previous),
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
    this.publications.set(publication.id, publication)
    request.latestPublicationId = publication.id
    request.publicationState = 'PENDING'
    request.revision += 1
    request.updatedAt = input.now
    return copy(publication)
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
    const publication = this.publications.get(input.publicationId)
    const request = this.requireRequest(input.requestId)
    if (!publication || publication.requestId !== request.id) {
      throw new DomainError('PUBLICATION_NOT_FOUND', 404, '发布记录不存在')
    }
    publication.state = input.state
    publication.readbackMd5 = input.readbackMd5 ?? null
    publication.safeErrorCode = input.safeErrorCode ?? null
    publication.safeErrorMessage = input.safeErrorMessage ?? null
    publication.startedAt ??= input.now
    publication.finishedAt = input.now
    if (request.latestPublicationId === publication.id) {
      request.publicationState = input.state
      request.revision += 1
      request.updatedAt = input.now
    }
    if (input.state === 'PUBLISHED') {
      const group = this.groups.get(publication.groupId)
      if (group) {
        group.publishedRevision = Math.max(group.publishedRevision, publication.groupRevision)
        group.updatedAt = input.now
      }
    }
    return copy(request)
  }

  private requireRequest(id: string): ModelAccessRequestRecord {
    const request = this.requests.get(id)
    if (!request) throw new DomainError('MODEL_ACCESS_REQUEST_NOT_FOUND', 404, '权限申请不存在')
    return request
  }

  private requirePendingRevision(
    request: ModelAccessRequestRecord,
    expectedRevision: number,
  ): void {
    if (request.revision !== expectedRevision) {
      throw new DomainError('REQUEST_REVISION_CONFLICT', 412, '申请已被其他操作更新', {
        serverRevision: request.revision,
      })
    }
    if (request.status !== 'PENDING') {
      throw new DomainError('REQUEST_ALREADY_DECIDED', 409, '申请已经处理')
    }
  }
}
