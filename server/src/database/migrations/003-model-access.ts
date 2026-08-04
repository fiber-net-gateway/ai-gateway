export const modelAccessMigration = {
  id: '003-model-access',
  statements: [
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      applied_at DATETIME(6) NOT NULL,
      PRIMARY KEY (id)
    ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`,
    `CREATE TABLE IF NOT EXISTS provider_access_groups (
      id BINARY(16) NOT NULL,
      environment_id BINARY(16) NOT NULL,
      provider_id BINARY(16) NOT NULL,
      provider_name VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      group_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
      published_revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
      created_by BINARY(16) NOT NULL,
      created_at DATETIME(6) NOT NULL,
      updated_at DATETIME(6) NOT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_provider_access_group_provider (environment_id, provider_id),
      UNIQUE KEY uq_provider_access_group_name (environment_id, group_name),
      KEY idx_provider_access_groups_environment (environment_id, updated_at, id),
      CONSTRAINT chk_provider_access_group_name CHECK (
        OCTET_LENGTH(group_name) BETWEEN 1 AND 64
        AND group_name REGEXP '^[A-Za-z0-9_-]+$'
      ),
      CONSTRAINT chk_provider_access_group_revision CHECK (published_revision <= revision),
      CONSTRAINT fk_provider_access_group_environment
        FOREIGN KEY (environment_id) REFERENCES environments (id),
      CONSTRAINT fk_provider_access_group_creator FOREIGN KEY (created_by) REFERENCES users (id)
    ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`,
    `ALTER TABLE marketplace_release_resources
       DROP CHECK chk_release_resource_kind,
       ADD CONSTRAINT chk_release_resource_kind
         CHECK (resource_kind IN ('USER_GROUP', 'PROVIDER', 'MODELS'))`,
    `CREATE TABLE IF NOT EXISTS model_access_requests (
      id BINARY(16) NOT NULL,
      environment_id BINARY(16) NOT NULL,
      applicant_user_id BINARY(16) NOT NULL,
      applicant_username VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
      applicant_display_name VARCHAR(128) NOT NULL,
      model_id BINARY(16) NOT NULL,
      logical_model_name VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      model_display_name VARCHAR(100) NOT NULL,
      group_id BINARY(16) NOT NULL,
      group_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      provider_id BINARY(16) NOT NULL,
      provider_name VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      reason VARCHAR(500) NOT NULL,
      request_status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      publication_state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      activation_state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      decision_reason VARCHAR(500) NULL,
      decided_by BINARY(16) NULL,
      decided_at DATETIME(6) NULL,
      latest_publication_id BINARY(16) NULL,
      grant_revision BIGINT UNSIGNED NULL,
      revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
      idempotency_key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      created_at DATETIME(6) NOT NULL,
      updated_at DATETIME(6) NOT NULL,
      pending_slot TINYINT GENERATED ALWAYS AS (
        CASE WHEN request_status = 'PENDING' THEN 1 ELSE NULL END
      ) STORED,
      PRIMARY KEY (id),
      UNIQUE KEY uq_model_access_idempotency (applicant_user_id, idempotency_key_hash),
      UNIQUE KEY uq_model_access_pending
        (environment_id, applicant_user_id, model_id, pending_slot),
      KEY idx_model_access_admin_page
        (environment_id, request_status, created_at, id),
      KEY idx_model_access_applicant_page
        (applicant_user_id, environment_id, created_at, id),
      CONSTRAINT chk_model_access_request_status CHECK (
        request_status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')
      ),
      CONSTRAINT chk_model_access_publication_state CHECK (
        publication_state IN ('NOT_STARTED', 'PENDING', 'PUBLISHED', 'FAILED')
      ),
      CONSTRAINT chk_model_access_activation_state CHECK (
        activation_state IN ('UNKNOWN', 'PENDING', 'EFFECTIVE', 'PARTIAL', 'REJECTED')
      ),
      CONSTRAINT chk_model_access_decision CHECK (
        (request_status IN ('PENDING', 'CANCELLED') AND decided_by IS NULL AND decided_at IS NULL)
        OR (request_status IN ('APPROVED', 'REJECTED') AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
      ),
      CONSTRAINT fk_model_access_environment FOREIGN KEY (environment_id) REFERENCES environments (id),
      CONSTRAINT fk_model_access_applicant FOREIGN KEY (applicant_user_id) REFERENCES users (id),
      CONSTRAINT fk_model_access_group FOREIGN KEY (group_id) REFERENCES provider_access_groups (id),
      CONSTRAINT fk_model_access_decider FOREIGN KEY (decided_by) REFERENCES users (id)
    ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`,
    `CREATE TABLE IF NOT EXISTS provider_access_group_members (
      group_id BINARY(16) NOT NULL,
      user_id BINARY(16) NOT NULL,
      username VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NOT NULL,
      source_request_id BINARY(16) NOT NULL,
      added_revision BIGINT UNSIGNED NOT NULL,
      added_by BINARY(16) NOT NULL,
      added_at DATETIME(6) NOT NULL,
      PRIMARY KEY (group_id, user_id),
      KEY idx_access_group_members_user (user_id, group_id),
      CONSTRAINT fk_access_group_member_group FOREIGN KEY (group_id) REFERENCES provider_access_groups (id),
      CONSTRAINT fk_access_group_member_user FOREIGN KEY (user_id) REFERENCES users (id),
      CONSTRAINT fk_access_group_member_request FOREIGN KEY (source_request_id) REFERENCES model_access_requests (id),
      CONSTRAINT fk_access_group_member_actor FOREIGN KEY (added_by) REFERENCES users (id)
    ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`,
    `CREATE TABLE IF NOT EXISTS access_group_publications (
      id BINARY(16) NOT NULL,
      request_id BINARY(16) NOT NULL,
      environment_id BINARY(16) NOT NULL,
      group_id BINARY(16) NOT NULL,
      group_revision BIGINT UNSIGNED NOT NULL,
      group_name VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      data_id VARCHAR(256) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      target_content LONGTEXT NOT NULL,
      target_md5 CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      attempt_number SMALLINT UNSIGNED NOT NULL,
      publication_state VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      readback_md5 CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
      safe_error_code VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
      safe_error_message VARCHAR(500) NULL,
      created_by BINARY(16) NOT NULL,
      created_at DATETIME(6) NOT NULL,
      started_at DATETIME(6) NULL,
      finished_at DATETIME(6) NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_access_publication_attempt (request_id, attempt_number),
      KEY idx_access_publication_group (group_id, group_revision, created_at, id),
      CONSTRAINT chk_access_publication_state CHECK (
        publication_state IN ('PENDING', 'PUBLISHED', 'FAILED')
      ),
      CONSTRAINT chk_access_publication_content CHECK (JSON_VALID(target_content)),
      CONSTRAINT fk_access_publication_request FOREIGN KEY (request_id) REFERENCES model_access_requests (id),
      CONSTRAINT fk_access_publication_environment FOREIGN KEY (environment_id) REFERENCES environments (id),
      CONSTRAINT fk_access_publication_group FOREIGN KEY (group_id) REFERENCES provider_access_groups (id),
      CONSTRAINT fk_access_publication_creator FOREIGN KEY (created_by) REFERENCES users (id)
    ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`,
  ],
} as const
