export const llmCallAuditMigration = {
  id: '006-llm-call-audit',
  statements: [
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      applied_at DATETIME(6) NOT NULL,
      PRIMARY KEY (id)
    ) ENGINE = InnoDB`,
    `CREATE TABLE llm_call_audits (
      id BINARY(16) NOT NULL,
      event_key BINARY(32) NOT NULL,
      environment_id BINARY(16) NOT NULL,
      owner_user_id BINARY(16) NULL,
      subject_username VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
      source_instance_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      source_request_id VARCHAR(1024) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
      source_schema_version SMALLINT UNSIGNED NOT NULL,
      occurred_at DATETIME(6) NOT NULL,
      received_at DATETIME(6) NOT NULL,
      method VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      request_path VARCHAR(2048) NOT NULL,
      requested_model VARCHAR(255) NOT NULL,
      client_protocol VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      is_stream BOOLEAN NOT NULL,
      response_status SMALLINT UNSIGNED NOT NULL,
      outcome VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      duration_ms BIGINT UNSIGNED NOT NULL,
      prompt_tokens BIGINT UNSIGNED NOT NULL,
      completion_tokens BIGINT UNSIGNED NOT NULL,
      total_tokens BIGINT UNSIGNED NOT NULL,
      client_aborted BOOLEAN NOT NULL,
      capture_complete BOOLEAN NOT NULL,
      message_count INT UNSIGNED NOT NULL,
      tool_count INT UNSIGNED NOT NULL,
      request_body_bytes BIGINT UNSIGNED NOT NULL,
      response_body_bytes BIGINT UNSIGNED NOT NULL,
      error_code VARCHAR(256) NOT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_llm_call_audit_event (environment_id, event_key),
      KEY idx_llm_call_audit_owner_page
        (environment_id, owner_user_id, occurred_at DESC, id DESC),
      KEY idx_llm_call_audit_received (received_at, id),
      CONSTRAINT fk_llm_call_audit_environment
        FOREIGN KEY (environment_id) REFERENCES environments (id),
      CONSTRAINT fk_llm_call_audit_owner
        FOREIGN KEY (owner_user_id) REFERENCES users (id),
      CONSTRAINT chk_llm_call_audit_schema CHECK (source_schema_version = 5),
      CONSTRAINT chk_llm_call_audit_username
        CHECK (OCTET_LENGTH(subject_username) BETWEEN 1 AND 64),
      CONSTRAINT chk_llm_call_audit_outcome
        CHECK (outcome IN ('SUCCEEDED', 'FAILED', 'ABORTED')),
      CONSTRAINT chk_llm_call_audit_status CHECK (response_status <= 999)
    ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`,
  ],
} as const
