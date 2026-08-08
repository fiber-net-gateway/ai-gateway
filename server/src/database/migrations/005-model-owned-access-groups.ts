export const modelOwnedAccessGroupsMigration = {
  id: '005-model-owned-access-groups',
  statements: [
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      applied_at DATETIME(6) NOT NULL,
      PRIMARY KEY (id)
    ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`,
    `ALTER TABLE provider_access_groups
       ADD COLUMN model_id BINARY(16) NULL AFTER environment_id,
       ADD COLUMN logical_model_name VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL
         AFTER model_id,
       ADD UNIQUE KEY uq_model_access_group_model (environment_id, model_id),
       ADD CONSTRAINT fk_model_access_group_model
         FOREIGN KEY (model_id) REFERENCES marketplace_models (id)`,
  ],
} as const
