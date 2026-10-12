import assert from 'node:assert/strict'
import test from 'node:test'

import { userModuleMigration } from './001-user-module.js'
import { modelMarketplaceMigration } from './002-model-marketplace.js'
import { modelAccessMigration } from './003-model-access.js'
import { marketplaceReleaseOrchestrationMigration } from './004-marketplace-release-orchestration.js'
import { modelOwnedAccessGroupsMigration } from './005-model-owned-access-groups.js'
import { llmCallAuditMigration } from './006-llm-call-audit.js'
import { accessGroupPublicationEvidenceMigration } from './007-access-group-publication-evidence.js'
import { llmCallAuditUsageComponentsMigration } from './008-llm-call-audit-usage-components.js'

import { openaiResponsesProtocolMigration } from './009-openai-responses-protocol.js'
import { openaiEmbeddingProtocolMigration } from './010-openai-embedding-protocol.js'

const migrations = [
  userModuleMigration,
  modelMarketplaceMigration,
  modelAccessMigration,
  marketplaceReleaseOrchestrationMigration,
  modelOwnedAccessGroupsMigration,
  llmCallAuditMigration,
  accessGroupPublicationEvidenceMigration,
  llmCallAuditUsageComponentsMigration,
  openaiResponsesProtocolMigration,
  openaiEmbeddingProtocolMigration,
]

test('every migration starts with the idempotent migration-table bootstrap', () => {
  for (const migration of migrations) {
    assert.match(
      migration.statements[0],
      /^CREATE TABLE IF NOT EXISTS schema_migrations/,
      migration.id,
    )
  }
})

test('publication evidence migration does not recreate a foreign key with the dropped name', () => {
  const statement = accessGroupPublicationEvidenceMigration.statements[1]

  assert.match(statement, /DROP FOREIGN KEY fk_access_publication_request/)
  assert.doesNotMatch(statement, /ADD CONSTRAINT fk_access_publication_request\b/)
  assert.match(statement, /ADD CONSTRAINT fk_access_group_publication_request/)
})

test('audit usage migration preserves v5 while adding nullable v6 component columns', () => {
  const statement = llmCallAuditUsageComponentsMigration.statements[1]

  assert.match(statement, /ADD COLUMN in_cache_tokens BIGINT UNSIGNED NULL/)
  assert.match(statement, /ADD COLUMN in_nocache_tokens BIGINT UNSIGNED NULL/)
  assert.match(statement, /ADD COLUMN out_tokens BIGINT UNSIGNED NULL/)
  assert.match(statement, /MODIFY COLUMN prompt_tokens BIGINT UNSIGNED NULL/)
  assert.match(statement, /MODIFY COLUMN completion_tokens BIGINT UNSIGNED NULL/)
  assert.match(statement, /MODIFY COLUMN total_tokens BIGINT UNSIGNED NULL/)
  assert.match(statement, /source_schema_version IN \(5, 6\)/)
})

test('Responses migration preserves historical coverage and existing protocols', () => {
  assert.match(
    openaiResponsesProtocolMigration.statements[1],
    /'OPENAI_CHAT_COMPLETIONS', 'ANTHROPIC_MESSAGES', 'OPENAI_RESPONSES'/,
  )
  assert.match(openaiResponsesProtocolMigration.statements[2], /NOT NULL DEFAULT 'UNSUPPORTED'/)
  assert.match(
    openaiResponsesProtocolMigration.statements[2],
    /'SUPPORTED', 'UNSUPPORTED', 'INVALID'/,
  )
})

test('Embedding migration retains all prior protocols and defaults historical coverage to unsupported', () => {
  assert.match(
    openaiEmbeddingProtocolMigration.statements[1],
    /'OPENAI_CHAT_COMPLETIONS', 'ANTHROPIC_MESSAGES', 'OPENAI_RESPONSES', 'OPENAI_EMBEDDING'/,
  )
  assert.match(openaiEmbeddingProtocolMigration.statements[2], /ADD COLUMN embedding_coverage/)
  assert.match(openaiEmbeddingProtocolMigration.statements[2], /NOT NULL DEFAULT 'UNSUPPORTED'/)
})
