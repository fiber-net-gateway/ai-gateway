export const llmCallAuditUsageComponentsMigration = {
  id: '008-llm-call-audit-usage-components',
  statements: [
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      applied_at DATETIME(6) NOT NULL,
      PRIMARY KEY (id)
    ) ENGINE = InnoDB`,
    `ALTER TABLE llm_call_audits
      ADD COLUMN in_cache_tokens BIGINT UNSIGNED NULL AFTER duration_ms,
      ADD COLUMN in_nocache_tokens BIGINT UNSIGNED NULL AFTER in_cache_tokens,
      ADD COLUMN out_tokens BIGINT UNSIGNED NULL AFTER in_nocache_tokens,
      MODIFY COLUMN prompt_tokens BIGINT UNSIGNED NULL,
      MODIFY COLUMN completion_tokens BIGINT UNSIGNED NULL,
      MODIFY COLUMN total_tokens BIGINT UNSIGNED NULL,
      DROP CHECK chk_llm_call_audit_schema,
      ADD CONSTRAINT chk_llm_call_audit_schema CHECK (source_schema_version IN (5, 6))`,
  ],
} as const
