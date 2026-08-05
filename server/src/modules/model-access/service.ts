import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'

import type { Clock } from '../users/crypto.js'
import { DomainError } from '../users/errors.js'
import type { AuthenticatedActor } from '../users/services.js'
import type { UserStore } from '../users/types.js'
import type { MarketplaceEnvironmentRecord, MarketplaceStore } from '../model-marketplace/types.js'
import { generateAccessGroupName, validAccessGroupName } from './group-name.js'
import { renderAccessGroup } from './renderer.js'
import { AccessGroupPublisherError } from './rnacos-publisher.js'
import type {
  AccessGroupPublicationRecord,
  AccessGroupPublicationView,
  AccessGroupPublisher,
  AdminAccessRequestView,
  ApplicantAccessRequestView,
  ModelAccessDirectory,
  ModelAccessRequestRecord,
  ModelAccessRequestStatus,
  ModelAccessStore,
  ModelAccessGroupRecord,
  RequestCursor,
} from './types.js'

const controlCharacters = /[\u0000-\u001f\u007f]/u

function requestRevision(etag: string | undefined): number {
  const match = etag?.trim().match(/^(?:W\/)?"([0-9]+)"$/u)
  if (!match) throw new DomainError('IF_MATCH_REQUIRED', 428, '审批操作需要有效的 If-Match')
  const revision = Number(match[1])
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new DomainError('IF_MATCH_INVALID', 400, 'If-Match revision 不合法')
  }
  return revision
}

function groupRevision(etag: string | undefined): number {
  const match = etag?.trim().match(/^(?:W\/)?"([0-9]+)"$/u)
  if (!match) throw new DomainError('IF_MATCH_REQUIRED', 428, '发布操作需要有效的 If-Match')
  const revision = Number(match[1])
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new DomainError('IF_MATCH_INVALID', 400, 'If-Match revision 不合法')
  }
  return revision
}

function normalizeReason(value: string, minimum: number, field: string): string {
  const reason = value.trim()
  if (reason.length < minimum || reason.length > 500 || controlCharacters.test(reason)) {
    throw new DomainError('MODEL_ACCESS_REASON_INVALID', 422, '用途或审批说明不符合长度要求', {
      field,
    })
  }
  return reason
}

function safeMessage(value: string): string {
  return value.replace(controlCharacters, ' ').slice(0, 500)
}

export class ModelAccessService implements ModelAccessDirectory {
  private readonly groupQueues = new Map<string, Promise<unknown>>()

  constructor(
    private readonly store: ModelAccessStore,
    private readonly marketplaceStore: MarketplaceStore,
    private readonly userStore: UserStore,
    private readonly clock: Clock,
    private readonly cursorKey: Buffer,
    private readonly publisher: AccessGroupPublisher | null,
  ) {}

  parseRevision(etag: string | undefined): number {
    return requestRevision(etag)
  }

  parseGroupRevision(etag: string | undefined): number {
    return groupRevision(etag)
  }

  async ensureGroupForModel(input: {
    environmentId: string
    modelId: string
    logicalModelName: string
    actorId: string
  }): Promise<ModelAccessGroupRecord> {
    const groupName = generateAccessGroupName(
      input.environmentId,
      input.modelId,
      input.logicalModelName,
    )
    if (!validAccessGroupName(groupName)) {
      throw new DomainError('ACCESS_GROUP_NAME_INVALID', 500, '无法生成合法的申请授权组名称')
    }
    return this.store.ensureGroupForModel({
      id: randomUUID(),
      ...input,
      groupName,
      now: this.clock.now().toISOString(),
    })
  }

  getGroupsByIds(ids: string[]): Promise<ModelAccessGroupRecord[]> {
    return this.store.getGroupsByIds(ids)
  }

  async getGroupPublicationTargets(ids: string[]) {
    const targets = []
    for (const groupId of [...new Set(ids)]) {
      const snapshot = await this.store.getGroupSnapshot(groupId)
      if (!snapshot) continue
      const rendered = renderAccessGroup(snapshot.group, snapshot.usernames)
      const latest = await this.store.getLatestSuccessfulPublication(groupId)
      targets.push({
        group: snapshot.group,
        dataId: rendered.dataId,
        targetMd5: rendered.md5,
        publishedMd5: latest?.readbackMd5 ?? null,
      })
    }
    return targets
  }

  async publishGroup(input: {
    groupId: string
    actor: AuthenticatedActor
    expectedRevision: number
    correlationId: string
  }): Promise<AccessGroupPublicationView> {
    return this.withGroupLock(input.groupId, async () => {
      const snapshot = await this.store.getGroupSnapshot(input.groupId)
      if (!snapshot) throw new DomainError('ACCESS_GROUP_NOT_FOUND', 404, '申请授权组不存在')
      if (snapshot.group.revision !== input.expectedRevision) {
        throw new DomainError('ACCESS_GROUP_REVISION_CONFLICT', 412, '授权组已被其他操作更新', {
          serverRevision: snapshot.group.revision,
        })
      }
      if (!this.publisher) {
        throw new DomainError(
          'ACCESS_GROUP_PUBLISHER_UNAVAILABLE',
          503,
          '当前进程未配置用户组发布能力',
        )
      }
      const rendered = renderAccessGroup(snapshot.group, snapshot.usernames)
      const latest = await this.store.getLatestSuccessfulPublication(snapshot.group.id)
      const current = await this.publisher.read({
        environmentId: snapshot.group.environmentId,
        group: 'LLM-SERVER',
        dataId: rendered.dataId,
      })
      const publication = await this.store.createManualPublication({
        publicationId: randomUUID(),
        groupId: snapshot.group.id,
        actorId: input.actor.user.id,
        expectedOldMd5: latest?.readbackMd5 ?? null,
        now: this.clock.now().toISOString(),
      })
      let group: ModelAccessGroupRecord
      try {
        this.assertSafeGroupWrite(current, publication.targetMd5, publication.expectedOldMd5)
        const result =
          current.md5 === publication.targetMd5
            ? { readbackMd5: publication.targetMd5 }
            : await this.publisher.publish({
                environmentId: publication.environmentId,
                group: 'LLM-SERVER',
                dataId: publication.dataId,
                content: publication.targetContent,
                expectedMd5: publication.targetMd5,
                expectedOldMd5: publication.expectedOldMd5,
              })
        group = await this.store.markManualPublicationResult({
          publicationId: publication.id,
          state: 'PUBLISHED',
          readbackMd5: result.readbackMd5,
          now: this.clock.now().toISOString(),
        })
        await this.auditGroup(
          input.actor,
          'model_access.group.publication_succeeded',
          group,
          input.correlationId,
          {
            publicationId: publication.id,
            dataId: publication.dataId,
            targetMd5: publication.targetMd5,
            readbackMd5: result.readbackMd5,
          },
        )
        return this.groupPublicationView(group, publication.id, 'PUBLISHED', result.readbackMd5)
      } catch (error) {
        const code =
          error instanceof AccessGroupPublisherError || error instanceof DomainError
            ? error.code
            : 'RNACOS_UNAVAILABLE'
        const message =
          error instanceof AccessGroupPublisherError || error instanceof DomainError
            ? error.message
            : 'rnacos 发布失败'
        group = await this.store.markManualPublicationResult({
          publicationId: publication.id,
          state: 'FAILED',
          safeErrorCode: code,
          safeErrorMessage: safeMessage(message),
          now: this.clock.now().toISOString(),
        })
        await this.auditGroup(
          input.actor,
          'model_access.group.publication_failed',
          group,
          input.correlationId,
          {
            publicationId: publication.id,
            dataId: publication.dataId,
            safeErrorCode: code,
          },
        )
        return this.groupPublicationView(group, publication.id, 'FAILED', null)
      }
    })
  }

  getPublishedMembershipGroupIds(input: { groupIds: string[]; userId: string }): Promise<string[]> {
    return this.store.getPublishedMembershipGroupIds(input)
  }

  isPublishedMember(input: { groupIds: string[]; userId: string }): Promise<boolean> {
    return this.store.isPublishedMember(input)
  }

  async createRequest(input: {
    environmentId: string
    modelId: string
    reason: string
    idempotencyKey: string
    actor: AuthenticatedActor
    correlationId: string
  }): Promise<{ request: ApplicantAccessRequestView; replayed: boolean }> {
    this.validateIdempotencyKey(input.idempotencyKey)
    const reason = normalizeReason(input.reason, 10, '/reason')
    await this.requireEnvironmentAccess(input.actor.user.id, input.environmentId)
    const environment = await this.requirePublishedEnvironment(input.environmentId)
    const model = environment.publishedVersion!.models.find(
      (candidate) => candidate.id === input.modelId && !candidate.archivedAt,
    )
    if (!model) throw new DomainError('MODEL_NOT_FOUND', 404, '模型不存在')
    if (model.allowUserGroups.length === 0) {
      throw new DomainError('MODEL_ACCESS_OPEN_TO_ALL', 409, '该模型面向所有已认证用户，无需申请')
    }
    if (model.allowUserGroups.length !== 1) {
      throw new DomainError('MODEL_ACCESS_REQUEST_UNAVAILABLE', 409, '该模型没有唯一的申请授权组')
    }
    const group = (await this.store.getGroupsByIds([model.allowUserGroups[0].id]))[0]
    if (!group || group.modelId !== model.id) {
      throw new DomainError('MODEL_ACCESS_REQUEST_UNAVAILABLE', 409, '模型申请授权组关系不完整')
    }
    if (
      await this.store.isPublishedMember({
        groupIds: [group.id],
        userId: input.actor.user.id,
      })
    ) {
      throw new DomainError('MODEL_ACCESS_ALREADY_GRANTED', 409, '当前账号已经获得模型权限')
    }
    const now = this.clock.now().toISOString()
    const request: ModelAccessRequestRecord = {
      id: randomUUID(),
      environmentId: input.environmentId,
      applicantUserId: input.actor.user.id,
      applicantUsername: input.actor.user.username,
      applicantDisplayName: input.actor.user.displayName,
      modelId: model.id,
      logicalModelName: model.logicalModelName,
      modelDisplayName: model.displayName,
      groupId: group.id,
      groupName: group.groupName,
      reason,
      status: 'PENDING',
      publicationState: 'NOT_STARTED',
      activationState: 'UNKNOWN',
      decisionReason: null,
      decidedBy: null,
      decidedAt: null,
      latestPublicationId: null,
      grantRevision: null,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    }
    const requestHash = createHash('sha256')
      .update(
        JSON.stringify({ environmentId: input.environmentId, modelId: input.modelId, reason }),
      )
      .digest('hex')
    const result = await this.store.createRequest({
      request,
      idempotencyKeyHash: createHash('sha256').update(input.idempotencyKey).digest('hex'),
      requestHash,
    })
    if (!result.replayed) {
      await this.audit(
        input.actor,
        'model_access.request.created',
        result.request,
        input.correlationId,
        {
          modelId: model.id,
          groupId: group.id,
          reasonLength: reason.length,
        },
      )
    }
    return { request: this.applicantView(result.request), replayed: result.replayed }
  }

  async listForApplicant(input: {
    actor: AuthenticatedActor
    environmentId?: string
    status?: ModelAccessRequestStatus
    cursor?: string
    limit?: number
  }): Promise<{ items: ApplicantAccessRequestView[]; nextCursor: string | null }> {
    if (input.environmentId) {
      await this.requireEnvironmentAccess(input.actor.user.id, input.environmentId)
    }
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100)
    const records = await this.store.listForApplicant({
      applicantUserId: input.actor.user.id,
      environmentId: input.environmentId,
      status: input.status,
      before: input.cursor ? this.decodeCursor(input.cursor) : undefined,
      limit: limit + 1,
    })
    const page = records.slice(0, limit)
    return {
      items: await Promise.all(page.map((request) => this.effectiveApplicantView(request))),
      nextCursor:
        records.length > limit && page.length ? this.encodeCursor(page[page.length - 1]) : null,
    }
  }

  async listForAdmin(input: {
    environmentId?: string
    status?: ModelAccessRequestStatus
    search?: string
    cursor?: string
    limit?: number
  }): Promise<{ items: AdminAccessRequestView[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 100)
    const records = await this.store.listForAdmin({
      environmentId: input.environmentId,
      status: input.status,
      search: input.search,
      before: input.cursor ? this.decodeCursor(input.cursor) : undefined,
      limit: limit + 1,
    })
    const page = records.slice(0, limit)
    return {
      items: await Promise.all(page.map((request) => this.adminView(request))),
      nextCursor:
        records.length > limit && page.length ? this.encodeCursor(page[page.length - 1]) : null,
    }
  }

  async getForAdmin(requestId: string): Promise<AdminAccessRequestView> {
    const request = await this.store.getRequest(requestId)
    if (!request) throw new DomainError('MODEL_ACCESS_REQUEST_NOT_FOUND', 404, '权限申请不存在')
    return this.adminView(request)
  }

  async cancel(input: {
    requestId: string
    actor: AuthenticatedActor
    expectedRevision: number
    correlationId: string
  }): Promise<ApplicantAccessRequestView> {
    const request = await this.store.cancel({
      requestId: input.requestId,
      applicantUserId: input.actor.user.id,
      expectedRevision: input.expectedRevision,
      now: this.clock.now().toISOString(),
    })
    await this.audit(input.actor, 'model_access.request.cancelled', request, input.correlationId, {
      modelId: request.modelId,
    })
    return this.applicantView(request)
  }

  async approve(input: {
    requestId: string
    actor: AuthenticatedActor
    expectedRevision: number
    reason?: string
    correlationId: string
  }): Promise<AdminAccessRequestView> {
    const current = await this.requirePendingRequest(input.requestId)
    if (current.applicantUserId === input.actor.user.id) {
      throw new DomainError('SELF_APPROVAL_FORBIDDEN', 409, '申请人不能审批自己的权限申请')
    }
    const reason = input.reason?.trim() ? normalizeReason(input.reason, 1, '/reason') : null
    await this.validateApprovalTarget(current)
    return this.withGroupLock(current.groupId, async () => {
      const affectedModels = await this.validateApprovalTarget(current)
      const applicant = await this.userStore.getUserById(current.applicantUserId)
      if (
        !applicant ||
        applicant.status !== 'ACTIVE' ||
        applicant.username !== current.applicantUsername
      ) {
        throw new DomainError('APPLICANT_NOT_ACTIVE', 409, '申请人状态或用户名已变化，不能批准')
      }
      await this.requireEnvironmentAccess(applicant.id, current.environmentId)
      const now = this.clock.now().toISOString()
      const publicationId = randomUUID()
      const latest = await this.store.getLatestSuccessfulPublication(current.groupId)
      const committed = await this.store.approve({
        requestId: current.id,
        expectedRevision: input.expectedRevision,
        actorId: input.actor.user.id,
        decisionReason: reason,
        publication: {
          id: publicationId,
          requestId: current.id,
          publicationKind: 'ACCESS_APPROVAL',
          environmentId: current.environmentId,
          groupId: current.groupId,
          groupName: current.groupName,
          dataId: `ploto.ai-llm.user-group.${current.groupName}`,
          expectedOldMd5: latest?.readbackMd5 ?? null,
          attemptNumber: 1,
          state: 'PENDING',
          readbackMd5: null,
          safeErrorCode: null,
          safeErrorMessage: null,
          createdBy: input.actor.user.id,
          createdAt: now,
          startedAt: null,
          finishedAt: null,
        },
        now,
      })
      let approvalAuditError: unknown = null
      try {
        await this.audit(
          input.actor,
          'model_access.request.approved',
          committed.request,
          input.correlationId,
          {
            groupId: committed.request.groupId,
            modelId: committed.request.modelId,
            affectedModelIds: affectedModels.map((model) => model.id),
            publicationId,
          },
        )
      } catch (error) {
        approvalAuditError = error
      }
      const published = await this.publishNow(
        committed.publication,
        input.actor,
        input.correlationId,
      )
      if (approvalAuditError) throw approvalAuditError
      return this.adminView(published)
    })
  }

  async reject(input: {
    requestId: string
    actor: AuthenticatedActor
    expectedRevision: number
    reason: string
    correlationId: string
  }): Promise<AdminAccessRequestView> {
    const current = await this.requirePendingRequest(input.requestId)
    if (current.applicantUserId === input.actor.user.id) {
      throw new DomainError('SELF_APPROVAL_FORBIDDEN', 409, '申请人不能审批自己的权限申请')
    }
    const request = await this.store.reject({
      requestId: current.id,
      expectedRevision: input.expectedRevision,
      actorId: input.actor.user.id,
      reason: normalizeReason(input.reason, 1, '/reason'),
      now: this.clock.now().toISOString(),
    })
    await this.audit(input.actor, 'model_access.request.rejected', request, input.correlationId, {
      modelId: request.modelId,
      decisionReason: request.decisionReason,
    })
    return this.adminView(request)
  }

  async retryPublication(input: {
    requestId: string
    actor: AuthenticatedActor
    correlationId: string
  }): Promise<AdminAccessRequestView> {
    const current = await this.store.getRequest(input.requestId)
    if (!current) throw new DomainError('MODEL_ACCESS_REQUEST_NOT_FOUND', 404, '权限申请不存在')
    return this.withGroupLock(current.groupId, async () => {
      const publication = await this.store.createPublicationRetry({
        requestId: input.requestId,
        actorId: input.actor.user.id,
        publicationId: randomUUID(),
        now: this.clock.now().toISOString(),
      })
      const request = await this.publishNow(publication, input.actor, input.correlationId)
      return this.adminView(request)
    })
  }

  private async withGroupLock<T>(groupId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.groupQueues.get(groupId)
    const current = (previous ? previous.catch(() => undefined) : Promise.resolve()).then(
      async () => {
        const releaseLock = await this.store.acquirePublicationLock(groupId)
        try {
          return await operation()
        } finally {
          await releaseLock().catch(() => undefined)
        }
      },
    )
    this.groupQueues.set(groupId, current)
    try {
      return await current
    } finally {
      if (this.groupQueues.get(groupId) === current) {
        this.groupQueues.delete(groupId)
      }
    }
  }

  private async publishNow(
    publication: AccessGroupPublicationRecord,
    actor: AuthenticatedActor,
    correlationId: string,
  ): Promise<ModelAccessRequestRecord> {
    if (!publication.requestId) {
      throw new DomainError('PUBLICATION_NOT_FOUND', 404, '发布记录不存在')
    }
    if (!this.publisher) return (await this.store.getRequest(publication.requestId))!
    let request: ModelAccessRequestRecord
    let eventType: string
    let auditPayload: Record<string, unknown>
    try {
      const current = await this.publisher.read({
        environmentId: publication.environmentId,
        group: 'LLM-SERVER',
        dataId: publication.dataId,
      })
      this.assertSafeGroupWrite(current, publication.targetMd5, publication.expectedOldMd5)
      const result =
        current.md5 === publication.targetMd5
          ? { readbackMd5: publication.targetMd5 }
          : await this.publisher.publish({
              environmentId: publication.environmentId,
              group: 'LLM-SERVER',
              dataId: publication.dataId,
              content: publication.targetContent,
              expectedMd5: publication.targetMd5,
              expectedOldMd5: publication.expectedOldMd5,
            })
      request = await this.store.markPublicationResult({
        publicationId: publication.id,
        requestId: publication.requestId,
        state: 'PUBLISHED',
        readbackMd5: result.readbackMd5,
        now: this.clock.now().toISOString(),
      })
      eventType = 'model_access.group.publication_succeeded'
      auditPayload = {
        publicationId: publication.id,
        dataId: publication.dataId,
        targetMd5: publication.targetMd5,
        readbackMd5: result.readbackMd5,
      }
    } catch (error) {
      const code =
        error instanceof AccessGroupPublisherError || error instanceof DomainError
          ? error.code
          : 'RNACOS_UNAVAILABLE'
      const message =
        error instanceof AccessGroupPublisherError || error instanceof DomainError
          ? error.message
          : 'rnacos 发布失败'
      request = await this.store.markPublicationResult({
        publicationId: publication.id,
        requestId: publication.requestId,
        state: 'FAILED',
        safeErrorCode: code,
        safeErrorMessage: safeMessage(message),
        now: this.clock.now().toISOString(),
      })
      eventType = 'model_access.group.publication_failed'
      auditPayload = {
        publicationId: publication.id,
        dataId: publication.dataId,
        safeErrorCode: code,
      }
    }
    await this.audit(actor, eventType, request, correlationId, auditPayload)
    return request
  }

  private async requirePendingRequest(id: string): Promise<ModelAccessRequestRecord> {
    const request = await this.store.getRequest(id)
    if (!request) throw new DomainError('MODEL_ACCESS_REQUEST_NOT_FOUND', 404, '权限申请不存在')
    if (request.status !== 'PENDING') {
      throw new DomainError('REQUEST_ALREADY_DECIDED', 409, '申请已经处理')
    }
    return request
  }

  private async validateApprovalTarget(request: ModelAccessRequestRecord) {
    const environment = await this.requirePublishedEnvironment(request.environmentId)
    const affected = environment.publishedVersion!.models.filter(
      (model) =>
        !model.archivedAt && model.allowUserGroups.some((group) => group.id === request.groupId),
    )
    const target = affected.find((model) => model.id === request.modelId)
    const group = (await this.store.getGroupsByIds([request.groupId]))[0]
    if (!target || !group || group.modelId !== target.id) {
      throw new DomainError(
        'MODEL_ACCESS_TARGET_CHANGED',
        409,
        '模型授权组关系已变化，请拒绝后重新申请',
      )
    }
    return affected.map((model) => ({
      id: model.id,
      logicalModelName: model.logicalModelName,
      displayName: model.displayName,
    }))
  }

  private async affectedModels(request: ModelAccessRequestRecord) {
    const environment = await this.marketplaceStore.getEnvironment(request.environmentId)
    return (
      environment?.publishedVersion?.models
        .filter(
          (model) =>
            !model.archivedAt &&
            model.allowUserGroups.some((group) => group.id === request.groupId),
        )
        .map((model) => ({
          id: model.id,
          logicalModelName: model.logicalModelName,
          displayName: model.displayName,
        })) ?? []
    )
  }

  private async effectiveApplicantView(
    request: ModelAccessRequestRecord,
  ): Promise<ApplicantAccessRequestView> {
    if (
      request.status === 'APPROVED' &&
      request.grantRevision &&
      request.publicationState !== 'PUBLISHED'
    ) {
      const group = (await this.store.getGroupsByIds([request.groupId]))[0]
      if (group && group.publishedRevision >= request.grantRevision) {
        return this.applicantView({ ...request, publicationState: 'PUBLISHED' })
      }
    }
    return this.applicantView(request)
  }

  private applicantView(request: ModelAccessRequestRecord): ApplicantAccessRequestView {
    return {
      id: request.id,
      environmentId: request.environmentId,
      modelId: request.modelId,
      logicalModelName: request.logicalModelName,
      modelDisplayName: request.modelDisplayName,
      reason: request.reason,
      status: request.status,
      publicationState: request.publicationState,
      activationState: request.activationState,
      decisionReason: request.decisionReason,
      revision: request.revision,
      createdAt: request.createdAt,
      updatedAt: request.updatedAt,
    }
  }

  private async adminView(request: ModelAccessRequestRecord): Promise<AdminAccessRequestView> {
    const effective = await this.effectiveApplicantView(request)
    return {
      ...effective,
      applicantUserId: request.applicantUserId,
      applicantUsername: request.applicantUsername,
      applicantDisplayName: request.applicantDisplayName,
      groupId: request.groupId,
      groupName: request.groupName,
      decidedBy: request.decidedBy,
      decidedAt: request.decidedAt,
      latestPublicationId: request.latestPublicationId,
      affectedModels: await this.affectedModels(request),
    }
  }

  private async requireEnvironmentAccess(userId: string, environmentId: string): Promise<void> {
    const access = await this.userStore.listEnvironmentsForUser(userId)
    if (!access.some((item) => item.environment.id === environmentId)) {
      throw new DomainError('ENVIRONMENT_NOT_FOUND', 404, '环境不存在或无权访问')
    }
  }

  private async requirePublishedEnvironment(
    environmentId: string,
  ): Promise<MarketplaceEnvironmentRecord> {
    const environment = await this.marketplaceStore.getEnvironment(environmentId)
    if (!environment?.publishedVersion) {
      throw new DomainError('PUBLISHED_MODEL_NOT_FOUND', 404, '当前环境没有已发布模型快照')
    }
    return environment
  }

  private validateIdempotencyKey(value: string): void {
    if (value.length < 8 || value.length > 128 || /[^A-Za-z0-9._:-]/u.test(value)) {
      throw new DomainError('IDEMPOTENCY_KEY_REQUIRED', 400, '创建操作需要有效的 Idempotency-Key')
    }
  }

  private encodeCursor(record: Pick<ModelAccessRequestRecord, 'createdAt' | 'id'>): string {
    const payload = Buffer.from(
      JSON.stringify({ createdAt: record.createdAt, id: record.id }),
      'utf8',
    ).toString('base64url')
    const signature = createHmac('sha256', this.cursorKey)
      .update(`model-access-cursor:${payload}`)
      .digest('base64url')
    return `${payload}.${signature}`
  }

  private decodeCursor(value: string): RequestCursor {
    try {
      const [payload, signature, extra] = value.split('.')
      if (!payload || !signature || extra) throw new Error('invalid cursor shape')
      const expected = createHmac('sha256', this.cursorKey)
        .update(`model-access-cursor:${payload}`)
        .digest()
      const actual = Buffer.from(signature, 'base64url')
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw new Error('invalid cursor signature')
      }
      const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
        createdAt?: unknown
        id?: unknown
      }
      if (
        typeof decoded.createdAt !== 'string' ||
        !Number.isFinite(Date.parse(decoded.createdAt)) ||
        typeof decoded.id !== 'string' ||
        !/^[0-9a-f-]{36}$/iu.test(decoded.id)
      ) {
        throw new Error('invalid cursor payload')
      }
      return { createdAt: decoded.createdAt, id: decoded.id }
    } catch {
      throw new DomainError('CURSOR_INVALID', 400, '分页 cursor 不合法或签名无效')
    }
  }

  private async audit(
    actor: AuthenticatedActor,
    eventType: string,
    request: ModelAccessRequestRecord,
    correlationId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.userStore.appendAudit({
      actor: actor.user,
      eventType,
      targetType: 'access_request',
      targetId: request.id,
      environmentId: request.environmentId,
      correlationId,
      reason: eventType.endsWith('.rejected') ? request.decisionReason : null,
      payload,
      occurredAt: this.clock.now().toISOString(),
    })
  }

  private assertSafeGroupWrite(
    current: { state: 'PRESENT' | 'NOT_FOUND'; md5: string | null },
    targetMd5: string,
    expectedOldMd5: string | null,
  ): void {
    if (current.md5 === targetMd5) return
    const drifted =
      current.state === 'PRESENT' ? current.md5 !== expectedOldMd5 : expectedOldMd5 !== null
    if (drifted) {
      throw new DomainError(
        'ACCESS_GROUP_DRIFTED',
        409,
        '授权组 rnacos 内容与上次成功发布证据不一致',
      )
    }
  }

  private groupPublicationView(
    group: ModelAccessGroupRecord,
    publicationId: string,
    publicationState: 'PUBLISHED' | 'FAILED',
    readbackMd5: string | null,
  ): AccessGroupPublicationView {
    return {
      groupId: group.id,
      groupName: group.groupName,
      revision: group.revision,
      publishedRevision: group.publishedRevision,
      publicationId,
      publicationState,
      readbackMd5,
    }
  }

  private async auditGroup(
    actor: AuthenticatedActor,
    eventType: string,
    group: ModelAccessGroupRecord,
    correlationId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.userStore.appendAudit({
      actor: actor.user,
      eventType,
      targetType: 'access_group',
      targetId: group.id,
      environmentId: group.environmentId,
      correlationId,
      reason: null,
      payload,
      occurredAt: this.clock.now().toISOString(),
    })
  }
}
