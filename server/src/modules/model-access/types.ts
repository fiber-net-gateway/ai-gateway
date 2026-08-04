import type { RnacosConfig } from '../../config/env.js'

export type ModelAccessRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'
export type AccessPublicationState = 'NOT_STARTED' | 'PENDING' | 'PUBLISHED' | 'FAILED'
export type AccessActivationState = 'UNKNOWN' | 'PENDING' | 'EFFECTIVE' | 'PARTIAL' | 'REJECTED'

export interface ProviderAccessGroupRecord {
  id: string
  environmentId: string
  providerId: string
  providerName: string
  groupName: string
  revision: number
  publishedRevision: number
  createdBy: string
  createdAt: string
  updatedAt: string
}

export interface ProviderAccessGroupMemberRecord {
  groupId: string
  userId: string
  username: string
  sourceRequestId: string
  addedRevision: number
  addedBy: string
  addedAt: string
}

export interface ModelAccessRequestRecord {
  id: string
  environmentId: string
  applicantUserId: string
  applicantUsername: string
  applicantDisplayName: string
  modelId: string
  logicalModelName: string
  modelDisplayName: string
  groupId: string
  groupName: string
  providerId: string
  providerName: string
  reason: string
  status: ModelAccessRequestStatus
  publicationState: AccessPublicationState
  activationState: AccessActivationState
  decisionReason: string | null
  decidedBy: string | null
  decidedAt: string | null
  latestPublicationId: string | null
  grantRevision: number | null
  revision: number
  createdAt: string
  updatedAt: string
}

export interface AccessGroupPublicationRecord {
  id: string
  requestId: string
  environmentId: string
  groupId: string
  groupRevision: number
  groupName: string
  dataId: string
  targetContent: string
  targetMd5: string
  attemptNumber: number
  state: 'PENDING' | 'PUBLISHED' | 'FAILED'
  readbackMd5: string | null
  safeErrorCode: string | null
  safeErrorMessage: string | null
  createdBy: string
  createdAt: string
  startedAt: string | null
  finishedAt: string | null
}

export interface RequestCursor {
  createdAt: string
  id: string
}

export interface ModelAccessStore {
  acquirePublicationLock(groupId: string): Promise<() => Promise<void>>
  ensureGroupForProvider(input: {
    id: string
    environmentId: string
    providerId: string
    providerName: string
    groupName: string
    actorId: string
    now: string
  }): Promise<ProviderAccessGroupRecord>
  getGroupsByIds(ids: string[]): Promise<ProviderAccessGroupRecord[]>
  getGroupSnapshot(
    groupId: string,
  ): Promise<{ group: ProviderAccessGroupRecord; usernames: string[] } | null>
  markGroupPublished(input: {
    groupId: string
    revision: number
    now: string
  }): Promise<ProviderAccessGroupRecord>
  getPublishedMembershipGroupIds(input: { groupIds: string[]; userId: string }): Promise<string[]>
  isPublishedMember(input: { groupIds: string[]; userId: string }): Promise<boolean>
  createRequest(input: {
    request: ModelAccessRequestRecord
    idempotencyKeyHash: string
    requestHash: string
  }): Promise<{ request: ModelAccessRequestRecord; replayed: boolean }>
  listForApplicant(input: {
    applicantUserId: string
    environmentId?: string
    status?: ModelAccessRequestStatus
    before?: RequestCursor
    limit: number
  }): Promise<ModelAccessRequestRecord[]>
  listForAdmin(input: {
    environmentId?: string
    status?: ModelAccessRequestStatus
    search?: string
    before?: RequestCursor
    limit: number
  }): Promise<ModelAccessRequestRecord[]>
  getRequest(id: string): Promise<ModelAccessRequestRecord | null>
  cancel(input: {
    requestId: string
    applicantUserId: string
    expectedRevision: number
    now: string
  }): Promise<ModelAccessRequestRecord>
  approve(input: {
    requestId: string
    expectedRevision: number
    actorId: string
    decisionReason: string | null
    publication: Omit<AccessGroupPublicationRecord, 'groupRevision' | 'targetContent' | 'targetMd5'>
    now: string
  }): Promise<{
    request: ModelAccessRequestRecord
    publication: AccessGroupPublicationRecord
  }>
  reject(input: {
    requestId: string
    expectedRevision: number
    actorId: string
    reason: string
    now: string
  }): Promise<ModelAccessRequestRecord>
  createPublicationRetry(input: {
    requestId: string
    actorId: string
    publicationId: string
    now: string
  }): Promise<AccessGroupPublicationRecord>
  markPublicationResult(input: {
    publicationId: string
    requestId: string
    state: 'PUBLISHED' | 'FAILED'
    readbackMd5?: string
    safeErrorCode?: string
    safeErrorMessage?: string
    now: string
  }): Promise<ModelAccessRequestRecord>
}

export interface AccessGroupPublisher {
  publish(input: {
    environmentId: string
    group: 'LLM-SERVER'
    dataId: string
    content: string
    expectedMd5: string
  }): Promise<{ readbackMd5: string }>
}

export interface ModelAccessDirectory {
  ensureGroupForProvider(input: {
    environmentId: string
    providerId: string
    providerName: string
    actorId: string
  }): Promise<ProviderAccessGroupRecord>
  getGroupsByIds(ids: string[]): Promise<ProviderAccessGroupRecord[]>
  ensureGroupPublished(input: {
    environmentId: string
    groupId: string
  }): Promise<ProviderAccessGroupRecord>
  getPublishedMembershipGroupIds(input: { groupIds: string[]; userId: string }): Promise<string[]>
  isPublishedMember(input: { groupIds: string[]; userId: string }): Promise<boolean>
}

export interface RnacosPublisherOptions extends RnacosConfig {
  timeoutMillis?: number
}

export interface ApplicantAccessRequestView {
  id: string
  environmentId: string
  modelId: string
  logicalModelName: string
  modelDisplayName: string
  reason: string
  status: ModelAccessRequestStatus
  publicationState: AccessPublicationState
  activationState: AccessActivationState
  decisionReason: string | null
  revision: number
  createdAt: string
  updatedAt: string
}

export interface AdminAccessRequestView extends ApplicantAccessRequestView {
  applicantUserId: string
  applicantUsername: string
  applicantDisplayName: string
  providerId: string
  providerName: string
  groupId: string
  groupName: string
  decidedBy: string | null
  decidedAt: string | null
  latestPublicationId: string | null
  affectedModels: Array<{ id: string; logicalModelName: string; displayName: string }>
}
