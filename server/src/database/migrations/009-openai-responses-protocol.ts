export const openaiResponsesProtocolMigration = {
  id: '009-openai-responses-protocol',
  statements: [
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      applied_at DATETIME(6) NOT NULL,
      PRIMARY KEY (id)
    ) ENGINE = InnoDB`,
    `ALTER TABLE marketplace_provider_protocols
      DROP CHECK chk_provider_protocol_type,
      ADD CONSTRAINT chk_provider_protocol_type CHECK (
        protocol_type IN ('OPENAI_CHAT_COMPLETIONS', 'ANTHROPIC_MESSAGES', 'OPENAI_RESPONSES')
      )`,
    `ALTER TABLE model_marketplace_projections
      ADD COLUMN responses_coverage VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin
        NOT NULL DEFAULT 'UNSUPPORTED' AFTER anthropic_coverage,
      ADD CONSTRAINT chk_model_projection_responses_coverage
        CHECK (responses_coverage IN ('SUPPORTED', 'UNSUPPORTED', 'INVALID'))`,
  ],
} as const
