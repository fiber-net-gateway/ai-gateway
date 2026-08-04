export const marketplaceReleaseOrchestrationMigration = {
  id: '004-marketplace-release-orchestration',
  statements: [
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      applied_at DATETIME(6) NOT NULL,
      PRIMARY KEY (id)
    ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`,
    `ALTER TABLE marketplace_releases
       ADD COLUMN revision BIGINT UNSIGNED NOT NULL DEFAULT 1 AFTER activation_state,
       ADD COLUMN started_at DATETIME(6) NULL AFTER created_at,
       ADD COLUMN finished_at DATETIME(6) NULL AFTER started_at,
       ADD COLUMN updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) AFTER finished_at,
       ADD KEY idx_marketplace_release_workflow
         (environment_id, workflow_state, created_at, id)`,
  ],
} as const
