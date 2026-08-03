import { randomUUID } from 'node:crypto'

import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'

import { DomainError } from '../users/errors.js'
import type {
  ActivationState,
  MarketplaceEnvironmentRecord,
  MarketplaceModelRecord,
  MarketplaceProviderRecord,
  MarketplaceReleaseRecord,
  MarketplaceReleaseResourceRecord,
  MarketplaceStore,
  MarketplaceVersionRecord,
  ProtocolCoverage,
  PublicationState,
} from './types.js'
import { protocolCoverage, validateModelGraph } from './validation.js'

type Executor = Pick<Pool, 'query'> | Pick<PoolConnection, 'query'>

interface VersionRow extends RowDataPacket {
  id: string
  environment_id: string
  version_kind: MarketplaceVersionRecord['kind']
  version_state: MarketplaceVersionRecord['state']
  base_release_version_id: string | null
  schema_version: number
  revision: string | number
  created_by: string
  created_at: Date
  updated_at: Date
  frozen_at: Date | null
}

interface ReleaseRow extends RowDataPacket {
  id: string
  environment_id: string
  version_id: string
  release_number: string | number
  workflow_state: 'PENDING'
  publication_state: PublicationState
  activation_state: ActivationState
  created_by: string
  created_at: Date
}

interface ReleaseResourceRow extends RowDataPacket {
  id: string
  resource_kind: MarketplaceReleaseResourceRecord['kind']
  group_name: 'LLM-SERVER'
  data_id: string
  dependency_order: number
  resource_state: 'PENDING'
}

interface ModelIdentityRow extends RowDataPacket {
  id: string
  logical_model_name: string
  created_by: string
  created_at: Date
  archived_at: Date | null
}

interface ModelSpecRow extends RowDataPacket {
  model_id: string
  display_name: string
  description: string
  prefix_max_bytes: number
  max_primary_attempts: number
  fallback_enabled: number
  retryable_statuses: string | number[]
  rate_limit_enabled: number
  rate_limit_window_millis: string | null
  rate_limit_max_tokens: string | null
  updated_by: string
  updated_at: Date
}

interface ProviderIdentityRow extends RowDataPacket {
  id: string
  provider_name: string
  ownership: MarketplaceProviderRecord['ownership']
  owner_model_id: string | null
}

interface ProviderSpecRow extends RowDataPacket {
  provider_id: string
  display_name: string
  base_url: string
}

interface BindingRow extends RowDataPacket {
  model_id: string
  provider_id: string
  route_role: MarketplaceProviderRecord['routeRole']
  sort_order: number
}

interface ProtocolRow extends RowDataPacket {
  provider_id: string
  protocol_type: MarketplaceProviderRecord['protocols'][number]['type']
  request_path: string
  upstream_model_name: string
}

interface TokenIdentityRow extends RowDataPacket {
  id: string
  provider_id: string
  token_name: string
  created_at: Date
}

interface TokenSpecRow extends RowDataPacket {
  token_id: string
  provider_id: string
  secret_id: string
  fingerprint_suffix: string
  updated_at: Date
}

interface TagRow extends RowDataPacket {
  model_id: string
  tag: string
  sort_order: number
}

interface GroupRow extends RowDataPacket {
  model_id: string
  user_group_id: string
  user_group_name: string
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null
}

function integer(value: string | number): number {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) throw new Error('database revision exceeds safe integer range')
  return parsed
}

function jsonArray(value: string | number[]): number[] {
  return Array.isArray(value) ? value.map(Number) : (JSON.parse(value) as number[])
}

function placeholders(size: number): string {
  return Array.from({ length: size }, () => '?').join(', ')
}

export class MySqlMarketplaceStore implements MarketplaceStore {
  constructor(private readonly pool: Pool) {}

  async ensureEnvironment(input: {
    environmentId: string
    actorId: string
    now: string
  }): Promise<MarketplaceEnvironmentRecord> {
    let environment = await this.getEnvironment(input.environmentId)
    if (environment) return environment
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      const [environmentRows] = await connection.query<RowDataPacket[]>(
        'SELECT BIN_TO_UUID(id) AS id FROM environments WHERE id = UUID_TO_BIN(?) FOR UPDATE',
        [input.environmentId],
      )
      if (environmentRows.length === 0) {
        throw new DomainError('ENVIRONMENT_NOT_FOUND', 404, '环境不存在')
      }
      const [draftRows] = await connection.query<VersionRow[]>(
        `${versionSelect}
         WHERE environment_id = UUID_TO_BIN(?) AND version_kind = 'DRAFT' AND version_state = 'OPEN'
         ORDER BY updated_at DESC
         LIMIT 1`,
        [input.environmentId],
      )
      if (draftRows.length === 0) {
        await connection.query(
          `INSERT INTO configuration_versions
            (id, environment_id, version_kind, version_state, base_release_version_id,
             schema_version, revision, created_by, created_at, updated_at, frozen_at, abandoned_at)
           VALUES (UUID_TO_BIN(?), UUID_TO_BIN(?), 'DRAFT', 'OPEN', NULL,
                   1, 1, UUID_TO_BIN(?), ?, ?, NULL, NULL)`,
          [randomUUID(), input.environmentId, input.actorId, input.now, input.now],
        )
      }
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
    environment = await this.getEnvironment(input.environmentId)
    if (!environment) throw new Error('failed to create marketplace draft')
    return environment
  }

  async getEnvironment(environmentId: string): Promise<MarketplaceEnvironmentRecord | null> {
    const [draftRows] = await this.pool.query<VersionRow[]>(
      `${versionSelect}
       WHERE environment_id = UUID_TO_BIN(?) AND version_kind = 'DRAFT' AND version_state = 'OPEN'
       ORDER BY updated_at DESC
       LIMIT 1`,
      [environmentId],
    )
    if (draftRows.length === 0) return null
    const [releaseRows] = await this.pool.query<ReleaseRow[]>(
      `${releaseSelect}
       WHERE environment_id = UUID_TO_BIN(?)
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      [environmentId],
    )
    const latestRelease = releaseRows[0]
      ? {
          ...releaseFromRow(releaseRows[0]),
          resources: await this.loadReleaseResources(releaseRows[0].id),
        }
      : null
    const publishedVersion =
      releaseRows[0] && releaseRows[0].publication_state === 'PUBLISHED'
        ? await this.loadVersion(releaseRows[0].version_id)
        : null
    return {
      draft: await this.loadVersionRow(draftRows[0]),
      publishedVersion,
      latestRelease,
      publicationState: releaseRows[0]?.publication_state ?? 'NEVER',
      activationState: releaseRows[0]?.activation_state ?? 'UNKNOWN',
    }
  }

  async saveDraft(input: {
    environmentId: string
    expectedRevision: number
    actorId: string
    now: string
    models: MarketplaceModelRecord[]
  }): Promise<MarketplaceVersionRecord> {
    const environment = await this.getEnvironment(input.environmentId)
    if (!environment) throw new DomainError('DRAFT_NOT_FOUND', 404, '环境草稿不存在')
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      await this.lockDraft(connection, environment.draft.id, input.expectedRevision)
      await persistSnapshot(connection, {
        versionId: environment.draft.id,
        environmentId: input.environmentId,
        actorId: input.actorId,
        now: input.now,
        models: input.models,
      })
      const [update] = await connection.query<ResultSetHeader>(
        `UPDATE configuration_versions
         SET revision = revision + 1, updated_at = ?
         WHERE id = UUID_TO_BIN(?) AND revision = ? AND version_state = 'OPEN'`,
        [input.now, environment.draft.id, input.expectedRevision],
      )
      if (update.affectedRows !== 1) throw revisionConflict(input.expectedRevision)
      await refreshProjection(connection, {
        environmentId: input.environmentId,
        versionId: environment.draft.id,
        revision: input.expectedRevision + 1,
        models: input.models,
        latestRelease: environment.latestRelease,
        publicationState: environment.publicationState,
        activationState: environment.activationState,
        now: input.now,
      })
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
    return this.loadVersion(environment.draft.id)
  }

  async createRelease(input: {
    environmentId: string
    expectedRevision: number
    actorId: string
    now: string
  }): Promise<{
    draft: MarketplaceVersionRecord
    frozenVersion: MarketplaceVersionRecord
    release: MarketplaceReleaseRecord
  }> {
    const environment = await this.getEnvironment(input.environmentId)
    if (!environment) throw new DomainError('DRAFT_NOT_FOUND', 404, '环境草稿不存在')
    const frozenId = randomUUID()
    const releaseId = randomUUID()
    const releaseNumber = (environment.latestRelease?.releaseNumber ?? 0) + 1
    const releaseResources = resourcesForVersion(environment.draft)
    const connection = await this.pool.getConnection()
    try {
      await connection.beginTransaction()
      await this.lockDraft(connection, environment.draft.id, input.expectedRevision)
      await connection.query(
        `INSERT INTO configuration_versions
          (id, environment_id, version_kind, version_state, base_release_version_id,
           schema_version, revision, created_by, created_at, updated_at, frozen_at, abandoned_at)
         VALUES (UUID_TO_BIN(?), UUID_TO_BIN(?), 'RELEASE', 'FROZEN', ?,
                 ?, 1, UUID_TO_BIN(?), ?, ?, ?, NULL)`,
        [
          frozenId,
          input.environmentId,
          environment.draft.baseReleaseVersionId
            ? Buffer.from(environment.draft.baseReleaseVersionId.replaceAll('-', ''), 'hex')
            : null,
          environment.draft.schemaVersion,
          input.actorId,
          input.now,
          input.now,
          input.now,
        ],
      )
      await persistSnapshot(connection, {
        versionId: frozenId,
        environmentId: input.environmentId,
        actorId: input.actorId,
        now: input.now,
        models: environment.draft.models,
      })
      await connection.query(
        `INSERT INTO marketplace_releases
          (id, environment_id, version_id, release_number, workflow_state,
           publication_state, activation_state, created_by, created_at)
         VALUES (UUID_TO_BIN(?), UUID_TO_BIN(?), UUID_TO_BIN(?), ?, 'PENDING',
                 'NEVER', 'UNKNOWN', UUID_TO_BIN(?), ?)`,
        [releaseId, input.environmentId, frozenId, releaseNumber, input.actorId, input.now],
      )
      for (const resource of releaseResources) {
        await connection.query(
          `INSERT INTO marketplace_release_resources
            (id, release_id, resource_kind, group_name, data_id, dependency_order,
             resource_state, old_safe_digest, new_safe_digest, old_md5, new_md5,
             content_bytes, error_code, safe_error_message, retry_count, started_at, finished_at)
           VALUES (UUID_TO_BIN(?), UUID_TO_BIN(?), ?, ?, ?, ?, 'PENDING',
                   NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL)`,
          [
            resource.id,
            releaseId,
            resource.kind,
            resource.group,
            resource.dataId,
            resource.dependencyOrder,
          ],
        )
      }
      await connection.query(
        `UPDATE configuration_versions
         SET base_release_version_id = UUID_TO_BIN(?), revision = revision + 1, updated_at = ?
         WHERE id = UUID_TO_BIN(?) AND revision = ? AND version_state = 'OPEN'`,
        [frozenId, input.now, environment.draft.id, input.expectedRevision],
      )
      await connection.commit()
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
    const draft = await this.loadVersion(environment.draft.id)
    const frozenVersion = await this.loadVersion(frozenId)
    return {
      draft,
      frozenVersion,
      release: {
        id: releaseId,
        environmentId: input.environmentId,
        versionId: frozenId,
        releaseNumber,
        state: 'PENDING',
        createdBy: input.actorId,
        createdAt: input.now,
        resources: releaseResources,
      },
    }
  }

  private async lockDraft(
    connection: PoolConnection,
    draftId: string,
    expectedRevision: number,
  ): Promise<void> {
    const [rows] = await connection.query<VersionRow[]>(
      `${versionSelect} WHERE id = UUID_TO_BIN(?) FOR UPDATE`,
      [draftId],
    )
    const row = rows[0]
    if (!row) throw new DomainError('DRAFT_NOT_FOUND', 404, '环境草稿不存在')
    if (row.version_state !== 'OPEN')
      throw new DomainError('DRAFT_NOT_OPEN', 409, '当前配置版本不可编辑')
    if (integer(row.revision) !== expectedRevision) {
      throw new DomainError('REVISION_CONFLICT', 412, '草稿已被其他操作更新', {
        serverRevision: integer(row.revision),
      })
    }
  }

  private async loadReleaseResources(
    releaseId: string,
  ): Promise<MarketplaceReleaseResourceRecord[]> {
    const [rows] = await this.pool.query<ReleaseResourceRow[]>(
      `SELECT BIN_TO_UUID(id) AS id, resource_kind, group_name, data_id,
              dependency_order, resource_state
       FROM marketplace_release_resources
       WHERE release_id = UUID_TO_BIN(?)
       ORDER BY dependency_order, id`,
      [releaseId],
    )
    return rows.map((row) => ({
      id: row.id,
      kind: row.resource_kind,
      group: row.group_name,
      dataId: row.data_id,
      dependencyOrder: row.dependency_order,
      state: row.resource_state,
    }))
  }

  private async loadVersion(versionId: string): Promise<MarketplaceVersionRecord> {
    const [rows] = await this.pool.query<VersionRow[]>(
      `${versionSelect} WHERE id = UUID_TO_BIN(?)`,
      [versionId],
    )
    if (!rows[0]) throw new DomainError('CONFIG_VERSION_NOT_FOUND', 404, '配置版本不存在')
    return this.loadVersionRow(rows[0])
  }

  private async loadVersionRow(row: VersionRow): Promise<MarketplaceVersionRecord> {
    const [
      models,
      specs,
      providers,
      providerSpecs,
      bindings,
      protocols,
      tokens,
      tokenSpecs,
      groups,
      tags,
    ] = await Promise.all([
      this.pool.query<ModelIdentityRow[]>(
        `SELECT BIN_TO_UUID(id) AS id, logical_model_name, BIN_TO_UUID(created_by) AS created_by,
                  created_at, archived_at
           FROM marketplace_models
           WHERE environment_id = UUID_TO_BIN(?)`,
        [row.environment_id],
      ),
      this.pool.query<ModelSpecRow[]>(
        `SELECT BIN_TO_UUID(model_id) AS model_id, display_name, description, prefix_max_bytes,
                  max_primary_attempts, fallback_enabled, retryable_statuses, rate_limit_enabled,
                  rate_limit_window_millis, rate_limit_max_tokens,
                  BIN_TO_UUID(updated_by) AS updated_by, updated_at
           FROM marketplace_model_specs
           WHERE version_id = UUID_TO_BIN(?)`,
        [row.id],
      ),
      this.pool.query<ProviderIdentityRow[]>(
        `SELECT BIN_TO_UUID(id) AS id, provider_name, ownership,
                  BIN_TO_UUID(owner_model_id) AS owner_model_id
           FROM marketplace_providers
           WHERE environment_id = UUID_TO_BIN(?)`,
        [row.environment_id],
      ),
      this.pool.query<ProviderSpecRow[]>(
        `SELECT BIN_TO_UUID(provider_id) AS provider_id, display_name, base_url
           FROM marketplace_provider_specs
           WHERE version_id = UUID_TO_BIN(?)`,
        [row.id],
      ),
      this.pool.query<BindingRow[]>(
        `SELECT BIN_TO_UUID(model_id) AS model_id, BIN_TO_UUID(provider_id) AS provider_id,
                  route_role, sort_order
           FROM marketplace_model_provider_bindings
           WHERE version_id = UUID_TO_BIN(?)`,
        [row.id],
      ),
      this.pool.query<ProtocolRow[]>(
        `SELECT BIN_TO_UUID(provider_id) AS provider_id, protocol_type, request_path,
                  upstream_model_name
           FROM marketplace_provider_protocols
           WHERE version_id = UUID_TO_BIN(?)`,
        [row.id],
      ),
      this.pool.query<TokenIdentityRow[]>(
        `SELECT BIN_TO_UUID(id) AS id, BIN_TO_UUID(provider_id) AS provider_id,
                  token_name, created_at
           FROM marketplace_provider_tokens
           WHERE environment_id = UUID_TO_BIN(?)`,
        [row.environment_id],
      ),
      this.pool.query<TokenSpecRow[]>(
        `SELECT BIN_TO_UUID(token_id) AS token_id, BIN_TO_UUID(provider_id) AS provider_id,
                  BIN_TO_UUID(secret_id) AS secret_id, fingerprint_suffix, updated_at
           FROM marketplace_provider_token_specs
           WHERE version_id = UUID_TO_BIN(?)`,
        [row.id],
      ),
      this.pool.query<GroupRow[]>(
        `SELECT BIN_TO_UUID(model_id) AS model_id, BIN_TO_UUID(user_group_id) AS user_group_id,
                  user_group_name
           FROM marketplace_model_user_groups
           WHERE version_id = UUID_TO_BIN(?)`,
        [row.id],
      ),
      this.pool.query<TagRow[]>(
        `SELECT BIN_TO_UUID(model_id) AS model_id, tag, sort_order
           FROM marketplace_model_tags
           WHERE version_id = UUID_TO_BIN(?)`,
        [row.id],
      ),
    ])
    return assembleVersion(
      row,
      models[0],
      specs[0],
      providers[0],
      providerSpecs[0],
      bindings[0],
      protocols[0],
      tokens[0],
      tokenSpecs[0],
      groups[0],
      tags[0],
    )
  }
}

const versionSelect = `SELECT BIN_TO_UUID(id) AS id, BIN_TO_UUID(environment_id) AS environment_id,
  version_kind, version_state, BIN_TO_UUID(base_release_version_id) AS base_release_version_id,
  schema_version, revision, BIN_TO_UUID(created_by) AS created_by,
  created_at, updated_at, frozen_at
  FROM configuration_versions`

const releaseSelect = `SELECT BIN_TO_UUID(id) AS id, BIN_TO_UUID(environment_id) AS environment_id,
  BIN_TO_UUID(version_id) AS version_id, release_number, workflow_state,
  publication_state, activation_state, BIN_TO_UUID(created_by) AS created_by, created_at
  FROM marketplace_releases`

function releaseFromRow(row: ReleaseRow): MarketplaceReleaseRecord {
  return {
    id: row.id,
    environmentId: row.environment_id,
    versionId: row.version_id,
    releaseNumber: integer(row.release_number),
    state: row.workflow_state,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    resources: [],
  }
}

function resourcesForVersion(
  version: MarketplaceVersionRecord,
): MarketplaceReleaseResourceRecord[] {
  const providerNames = [
    ...new Set(
      version.models.flatMap((model) => model.providers.map((provider) => provider.providerName)),
    ),
  ].sort((left, right) => left.localeCompare(right, 'en'))
  return [
    ...providerNames.map((providerName, index) => ({
      id: randomUUID(),
      kind: 'PROVIDER' as const,
      group: 'LLM-SERVER' as const,
      dataId: `ploto.ai-llm.provider.${providerName}`,
      dependencyOrder: index,
      state: 'PENDING' as const,
    })),
    {
      id: randomUUID(),
      kind: 'MODELS',
      group: 'LLM-SERVER',
      dataId: 'ploto.ai-llm.models',
      dependencyOrder: providerNames.length,
      state: 'PENDING',
    },
  ]
}

function assembleVersion(
  version: VersionRow,
  modelIdentities: ModelIdentityRow[],
  modelSpecs: ModelSpecRow[],
  providerIdentities: ProviderIdentityRow[],
  providerSpecs: ProviderSpecRow[],
  bindings: BindingRow[],
  protocols: ProtocolRow[],
  tokenIdentities: TokenIdentityRow[],
  tokenSpecs: TokenSpecRow[],
  groups: GroupRow[],
  tags: TagRow[],
): MarketplaceVersionRecord {
  const modelById = new Map(modelIdentities.map((model) => [model.id, model]))
  const providerById = new Map(providerIdentities.map((provider) => [provider.id, provider]))
  const providerSpecById = new Map(
    providerSpecs.map((provider) => [provider.provider_id, provider]),
  )
  const tokenById = new Map(tokenIdentities.map((token) => [token.id, token]))
  const protocolsByProvider = new Map<string, MarketplaceProviderRecord['protocols']>()
  for (const protocol of protocols) {
    const list = protocolsByProvider.get(protocol.provider_id) ?? []
    list.push({
      type: protocol.protocol_type,
      path: protocol.request_path,
      upstreamModelName: protocol.upstream_model_name,
    })
    protocolsByProvider.set(protocol.provider_id, list)
  }
  const tokensByProvider = new Map<string, MarketplaceProviderRecord['tokens']>()
  for (const tokenSpec of tokenSpecs) {
    const identity = tokenById.get(tokenSpec.token_id)
    if (!identity || identity.provider_id !== tokenSpec.provider_id) {
      throw new DomainError('CONFIG_GRAPH_INVALID', 422, 'Token 引用关系不完整')
    }
    const list = tokensByProvider.get(tokenSpec.provider_id) ?? []
    list.push({
      id: identity.id,
      name: identity.token_name,
      secretId: tokenSpec.secret_id,
      fingerprintSuffix: tokenSpec.fingerprint_suffix,
      updatedAt: tokenSpec.updated_at.toISOString(),
    })
    tokensByProvider.set(tokenSpec.provider_id, list)
  }
  const bindingsByModel = new Map<string, BindingRow[]>()
  for (const binding of bindings) {
    const list = bindingsByModel.get(binding.model_id) ?? []
    list.push(binding)
    bindingsByModel.set(binding.model_id, list)
  }
  const groupsByModel = new Map<string, MarketplaceModelRecord['allowUserGroups']>()
  for (const group of groups) {
    const list = groupsByModel.get(group.model_id) ?? []
    list.push({ id: group.user_group_id, name: group.user_group_name })
    groupsByModel.set(group.model_id, list)
  }
  const tagsByModel = new Map<string, TagRow[]>()
  for (const tag of tags) {
    const list = tagsByModel.get(tag.model_id) ?? []
    list.push(tag)
    tagsByModel.set(tag.model_id, list)
  }
  const models = modelSpecs.map((spec): MarketplaceModelRecord => {
    const identity = modelById.get(spec.model_id)
    if (!identity) throw new DomainError('CONFIG_GRAPH_INVALID', 422, '模型身份引用不完整')
    const modelProviders = (bindingsByModel.get(spec.model_id) ?? []).map((binding) => {
      const provider = providerById.get(binding.provider_id)
      const providerSpec = providerSpecById.get(binding.provider_id)
      if (!provider || !providerSpec) {
        throw new DomainError('CONFIG_GRAPH_INVALID', 422, '供应商引用关系不完整')
      }
      return {
        id: provider.id,
        providerName: provider.provider_name,
        ownership: provider.ownership,
        ownerModelId: provider.owner_model_id,
        displayName: providerSpec.display_name,
        baseUrl: providerSpec.base_url,
        routeRole: binding.route_role,
        sortOrder: binding.sort_order,
        protocols: protocolsByProvider.get(provider.id) ?? [],
        tokens: tokensByProvider.get(provider.id) ?? [],
      }
    })
    return {
      id: identity.id,
      logicalModelName: identity.logical_model_name,
      displayName: spec.display_name,
      description: spec.description,
      tags: (tagsByModel.get(identity.id) ?? [])
        .sort((left, right) => left.sort_order - right.sort_order)
        .map((tag) => tag.tag),
      prefixMaxBytes: spec.prefix_max_bytes,
      maxPrimaryAttempts: spec.max_primary_attempts,
      fallbackEnabled: Boolean(spec.fallback_enabled),
      retryableStatuses: jsonArray(spec.retryable_statuses),
      rateLimit: spec.rate_limit_enabled
        ? {
            windowDurationMillis: spec.rate_limit_window_millis!,
            maxTokensPerWindow: spec.rate_limit_max_tokens!,
          }
        : null,
      allowUserGroups: groupsByModel.get(identity.id) ?? [],
      providers: modelProviders,
      createdBy: identity.created_by,
      createdAt: identity.created_at.toISOString(),
      updatedBy: spec.updated_by,
      updatedAt: spec.updated_at.toISOString(),
      archivedAt: iso(identity.archived_at),
    }
  })
  return {
    id: version.id,
    environmentId: version.environment_id,
    kind: version.version_kind,
    state: version.version_state,
    baseReleaseVersionId: version.base_release_version_id,
    schemaVersion: version.schema_version,
    revision: integer(version.revision),
    models,
    createdBy: version.created_by,
    createdAt: version.created_at.toISOString(),
    updatedAt: version.updated_at.toISOString(),
    frozenAt: iso(version.frozen_at),
  }
}

async function persistSnapshot(
  executor: Executor,
  input: {
    versionId: string
    environmentId: string
    actorId: string
    now: string
    models: MarketplaceModelRecord[]
  },
): Promise<void> {
  for (const model of input.models) {
    await executor.query(
      `INSERT INTO marketplace_models
        (id, environment_id, logical_model_name, created_by, created_at, archived_by, archived_at)
       VALUES (UUID_TO_BIN(?), UUID_TO_BIN(?), ?, UUID_TO_BIN(?), ?, ?, ?)
       ON DUPLICATE KEY UPDATE archived_by = VALUES(archived_by), archived_at = VALUES(archived_at)`,
      [
        model.id,
        input.environmentId,
        model.logicalModelName,
        model.createdBy,
        model.createdAt,
        model.archivedAt ? Buffer.from(input.actorId.replaceAll('-', ''), 'hex') : null,
        model.archivedAt,
      ],
    )
  }
  const providers = new Map(
    input.models.flatMap((model) => model.providers.map((provider) => [provider.id, provider])),
  )
  for (const provider of providers.values()) {
    await executor.query(
      `INSERT INTO marketplace_providers
        (id, environment_id, provider_name, ownership, owner_model_id,
         created_by, created_at, archived_by, archived_at)
       VALUES (UUID_TO_BIN(?), UUID_TO_BIN(?), ?, ?, ?, UUID_TO_BIN(?), ?, NULL, NULL)
       ON DUPLICATE KEY UPDATE provider_name = provider_name`,
      [
        provider.id,
        input.environmentId,
        provider.providerName,
        provider.ownership,
        provider.ownerModelId
          ? Buffer.from(provider.ownerModelId.replaceAll('-', ''), 'hex')
          : null,
        input.actorId,
        input.now,
      ],
    )
  }
  const tokens = new Map(
    [...providers.values()].flatMap((provider) =>
      provider.tokens.map((token) => [token.id, { ...token, providerId: provider.id }]),
    ),
  )
  for (const token of tokens.values()) {
    await executor.query(
      `INSERT INTO marketplace_provider_tokens
        (id, environment_id, provider_id, token_name, created_by, created_at, retired_by, retired_at)
       VALUES (UUID_TO_BIN(?), UUID_TO_BIN(?), UUID_TO_BIN(?), ?, UUID_TO_BIN(?), ?, NULL, NULL)
       ON DUPLICATE KEY UPDATE token_name = token_name`,
      [token.id, input.environmentId, token.providerId, token.name, input.actorId, token.updatedAt],
    )
  }
  for (const table of [
    'marketplace_provider_token_specs',
    'marketplace_provider_protocols',
    'marketplace_model_provider_bindings',
    'marketplace_provider_specs',
    'marketplace_model_user_groups',
    'marketplace_model_tags',
    'marketplace_model_specs',
  ]) {
    await executor.query(`DELETE FROM ${table} WHERE version_id = UUID_TO_BIN(?)`, [
      input.versionId,
    ])
  }
  for (const model of input.models) {
    await executor.query(
      `INSERT INTO marketplace_model_specs
        (version_id, model_id, display_name, description, prefix_max_bytes,
         max_primary_attempts, fallback_enabled, retryable_statuses, rate_limit_enabled,
         rate_limit_window_millis, rate_limit_max_tokens, updated_by, updated_at)
       VALUES (UUID_TO_BIN(?), UUID_TO_BIN(?), ?, ?, ?, ?, ?, ?, ?, ?, ?, UUID_TO_BIN(?), ?)`,
      [
        input.versionId,
        model.id,
        model.displayName,
        model.description,
        model.prefixMaxBytes,
        model.maxPrimaryAttempts,
        model.fallbackEnabled,
        JSON.stringify(model.retryableStatuses),
        model.rateLimit !== null,
        model.rateLimit?.windowDurationMillis ?? null,
        model.rateLimit?.maxTokensPerWindow ?? null,
        model.updatedBy,
        model.updatedAt,
      ],
    )
    for (const [sortOrder, tag] of model.tags.entries()) {
      await executor.query(
        `INSERT INTO marketplace_model_tags (version_id, model_id, tag, sort_order)
         VALUES (UUID_TO_BIN(?), UUID_TO_BIN(?), ?, ?)`,
        [input.versionId, model.id, tag, sortOrder],
      )
    }
    for (const group of model.allowUserGroups) {
      await executor.query(
        `INSERT INTO marketplace_model_user_groups
          (version_id, model_id, user_group_id, user_group_name)
         VALUES (UUID_TO_BIN(?), UUID_TO_BIN(?), UUID_TO_BIN(?), ?)`,
        [input.versionId, model.id, group.id, group.name],
      )
    }
    for (const provider of model.providers) {
      await executor.query(
        `INSERT INTO marketplace_model_provider_bindings
          (version_id, model_id, provider_id, route_role, sort_order)
         VALUES (UUID_TO_BIN(?), UUID_TO_BIN(?), UUID_TO_BIN(?), ?, ?)`,
        [input.versionId, model.id, provider.id, provider.routeRole, provider.sortOrder],
      )
    }
  }
  for (const provider of providers.values()) {
    await executor.query(
      `INSERT INTO marketplace_provider_specs
        (version_id, provider_id, display_name, base_url, updated_by, updated_at)
       VALUES (UUID_TO_BIN(?), UUID_TO_BIN(?), ?, ?, UUID_TO_BIN(?), ?)`,
      [
        input.versionId,
        provider.id,
        provider.displayName,
        provider.baseUrl,
        input.actorId,
        input.now,
      ],
    )
    for (const protocol of provider.protocols) {
      await executor.query(
        `INSERT INTO marketplace_provider_protocols
          (version_id, provider_id, protocol_type, request_path, upstream_model_name,
           updated_by, updated_at)
         VALUES (UUID_TO_BIN(?), UUID_TO_BIN(?), ?, ?, ?, UUID_TO_BIN(?), ?)`,
        [
          input.versionId,
          provider.id,
          protocol.type,
          protocol.path,
          protocol.upstreamModelName,
          input.actorId,
          input.now,
        ],
      )
    }
    for (const token of provider.tokens) {
      await executor.query(
        `INSERT INTO marketplace_provider_token_specs
          (version_id, token_id, provider_id, secret_id, fingerprint_suffix,
           updated_by, updated_at)
         VALUES (UUID_TO_BIN(?), UUID_TO_BIN(?), UUID_TO_BIN(?), UUID_TO_BIN(?), ?, UUID_TO_BIN(?), ?)`,
        [
          input.versionId,
          token.id,
          provider.id,
          token.secretId,
          token.fingerprintSuffix,
          input.actorId,
          token.updatedAt,
        ],
      )
    }
  }
}

async function refreshProjection(
  executor: Executor,
  input: {
    environmentId: string
    versionId: string
    revision: number
    models: MarketplaceModelRecord[]
    latestRelease: MarketplaceReleaseRecord | null
    publicationState: PublicationState
    activationState: ActivationState
    now: string
  },
) {
  await executor.query(
    `DELETE FROM model_marketplace_projections
     WHERE environment_id = UUID_TO_BIN(?) AND view_kind = 'ADMIN_DRAFT'`,
    [input.environmentId],
  )
  for (const model of input.models.filter((candidate) => !candidate.archivedAt)) {
    const coverage: { openai: ProtocolCoverage; anthropic: ProtocolCoverage } =
      protocolCoverage(model)
    const issues = validateModelGraph(model)
    await executor.query(
      `INSERT INTO model_marketplace_projections
        (environment_id, view_kind, model_id, source_version_id, source_revision,
         logical_model_name, display_name, description_excerpt, openai_coverage,
         anthropic_coverage, provider_count, configured_token_count, tokenless_provider_count,
         access_mode, draft_state, publication_state, activation_state,
         latest_release_id, latest_release_at, validation_error_count,
         validation_warning_count, updated_at)
       VALUES (UUID_TO_BIN(?), 'ADMIN_DRAFT', UUID_TO_BIN(?), UUID_TO_BIN(?), ?,
               ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.environmentId,
        model.id,
        input.versionId,
        input.revision,
        model.logicalModelName,
        model.displayName,
        model.description.slice(0, 300),
        coverage.openai,
        coverage.anthropic,
        model.providers.length,
        model.providers.reduce((sum, provider) => sum + provider.tokens.length, 0),
        model.providers.filter((provider) => provider.tokens.length === 0).length,
        model.allowUserGroups.length ? 'GROUP_RESTRICTED' : 'ALL_AUTHENTICATED',
        issues.some((issue) => issue.severity === 'ERROR') ? 'INVALID' : 'MODIFIED',
        input.publicationState,
        input.activationState,
        input.latestRelease ? Buffer.from(input.latestRelease.id.replaceAll('-', ''), 'hex') : null,
        input.latestRelease?.createdAt ?? null,
        issues.filter((issue) => issue.severity === 'ERROR').length,
        issues.filter((issue) => issue.severity === 'WARNING').length,
        input.now,
      ],
    )
  }
}

function revisionConflict(expectedRevision: number): DomainError {
  return new DomainError('REVISION_CONFLICT', 412, '草稿已被其他操作更新', {
    expectedRevision,
  })
}

export const marketplaceRuntimeSql = [versionSelect, releaseSelect] as const
