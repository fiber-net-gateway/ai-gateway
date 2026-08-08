export const accessGroupPublicationEvidenceMigration = {
  id: '007-access-group-publication-evidence',
  statements: [
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      applied_at DATETIME(6) NOT NULL,
      PRIMARY KEY (id)
    ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`,
    `ALTER TABLE access_group_publications
       DROP FOREIGN KEY fk_access_publication_request,
       DROP INDEX uq_access_publication_attempt,
       MODIFY request_id BINARY(16) NULL,
       ADD COLUMN publication_kind VARCHAR(24) CHARACTER SET ascii COLLATE ascii_bin
         NOT NULL DEFAULT 'ACCESS_APPROVAL' AFTER request_id,
       ADD COLUMN expected_old_md5 CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL
         AFTER target_md5,
       ADD UNIQUE KEY uq_access_group_publication_attempt
         (group_id, group_revision, attempt_number),
       ADD CONSTRAINT chk_access_publication_kind CHECK (
         publication_kind IN ('ACCESS_APPROVAL', 'MANUAL_SYNC')
       ),
       ADD CONSTRAINT fk_access_group_publication_request
         FOREIGN KEY (request_id) REFERENCES model_access_requests (id)`,
  ],
} as const
