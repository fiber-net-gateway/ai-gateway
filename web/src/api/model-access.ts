import { request } from './client'

export type ModelAccessRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED'
export type AccessPublicationState = 'NOT_STARTED' | 'PENDING' | 'PUBLISHED' | 'FAILED'
export type AccessActivationState = 'UNKNOWN' | 'PENDING' | 'EFFECTIVE' | 'PARTIAL' | 'REJECTED'

export interface ApplicantAccessRequest {
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

export interface AdminAccessRequest extends ApplicantAccessRequest {
  applicantUserId: string
  applicantUsername: string
  applicantDisplayName: string
  groupId: string
  groupName: string
  decidedBy: string | null
  decidedAt: string | null
  latestPublicationId: string | null
  affectedModels: Array<{ id: string; logicalModelName: string; displayName: string }>
}

async function idempotencyKey(): Promise<string> {
  return (await request<{ key: string }>('/api/idempotency-keys', { method: 'POST' })).key
}

function queryString(values: Record<string, string | number | undefined>) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== '') query.set(key, String(value))
  }
  return query.toString()
}

export const modelAccessApi = {
  publishGroup: (groupId: string, revision: number) =>
    request<{
      groupId: string
      groupName: string
      revision: number
      publishedRevision: number
      publicationId: string
      publicationState: 'PUBLISHED' | 'FAILED'
      readbackMd5: string | null
    }>(`/api/admin/model-access-groups/${groupId}/publish`, {
      method: 'POST',
      headers: { 'If-Match': `"${revision}"` },
    }),
  mine: (filters: { environmentId?: string; status?: ModelAccessRequestStatus } = {}) =>
    request<{ items: ApplicantAccessRequest[]; nextCursor: string | null }>(
      `/api/me/model-access-requests?${queryString(filters)}`,
    ),
  create: async (environmentId: string, modelId: string, reason: string) =>
    request<ApplicantAccessRequest>(
      `/api/environments/${environmentId}/models/${modelId}/access-requests`,
      {
        method: 'POST',
        headers: { 'Idempotency-Key': await idempotencyKey() },
        body: JSON.stringify({ reason }),
      },
    ),
  cancel: (requestId: string, revision: number) =>
    request<ApplicantAccessRequest>(`/api/me/model-access-requests/${requestId}/cancel`, {
      method: 'POST',
      headers: { 'If-Match': `"${revision}"` },
    }),
  listAdmin: (
    filters: {
      environmentId?: string
      status?: ModelAccessRequestStatus
      search?: string
    } = {},
  ) =>
    request<{ items: AdminAccessRequest[]; nextCursor: string | null }>(
      `/api/admin/model-access-requests?${queryString(filters)}`,
    ),
  approve: (requestId: string, revision: number, reason: string) =>
    request<AdminAccessRequest>(`/api/admin/model-access-requests/${requestId}/approve`, {
      method: 'POST',
      headers: { 'If-Match': `"${revision}"` },
      body: JSON.stringify({ reason: reason.trim() || undefined }),
    }),
  reject: (requestId: string, revision: number, reason: string) =>
    request<AdminAccessRequest>(`/api/admin/model-access-requests/${requestId}/reject`, {
      method: 'POST',
      headers: { 'If-Match': `"${revision}"` },
      body: JSON.stringify({ reason }),
    }),
  retryPublication: (requestId: string) =>
    request<AdminAccessRequest>(`/api/admin/model-access-requests/${requestId}/retry-publication`, {
      method: 'POST',
    }),
}
