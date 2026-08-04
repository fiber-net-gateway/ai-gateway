export const modelOwnedAccessGroupsMigration = {
  id: '005-model-owned-access-groups',
  statements: [
    `ALTER TABLE provider_access_groups
       ADD COLUMN model_id BINARY(16) NULL AFTER environment_id,
       ADD COLUMN logical_model_name VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL
         AFTER model_id,
       ADD UNIQUE KEY uq_model_access_group_model (environment_id, model_id),
       ADD CONSTRAINT fk_model_access_group_model
         FOREIGN KEY (model_id) REFERENCES marketplace_models (id)`,
  ],
} as const
