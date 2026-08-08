import assert from 'node:assert/strict'
import test from 'node:test'

import { userModuleMigration } from './001-user-module.js'
import { modelMarketplaceMigration } from './002-model-marketplace.js'
import { modelAccessMigration } from './003-model-access.js'
import { marketplaceReleaseOrchestrationMigration } from './004-marketplace-release-orchestration.js'
import { modelOwnedAccessGroupsMigration } from './005-model-owned-access-groups.js'
import { llmCallAuditMigration } from './006-llm-call-audit.js'
import { accessGroupPublicationEvidenceMigration } from './007-access-group-publication-evidence.js'

const migrations = [
  userModuleMigration,
  modelMarketplaceMigration,
  modelAccessMigration,
  marketplaceReleaseOrchestrationMigration,
  modelOwnedAccessGroupsMigration,
  llmCallAuditMigration,
  accessGroupPublicationEvidenceMigration,
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
