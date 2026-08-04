import type { Pool, RowDataPacket } from 'mysql2/promise'

import { userModuleMigration } from './migrations/001-user-module.js'
import { modelMarketplaceMigration } from './migrations/002-model-marketplace.js'
import { modelAccessMigration } from './migrations/003-model-access.js'
import { marketplaceReleaseOrchestrationMigration } from './migrations/004-marketplace-release-orchestration.js'

const migrations = [
  userModuleMigration,
  modelMarketplaceMigration,
  modelAccessMigration,
  marketplaceReleaseOrchestrationMigration,
]

export async function runMigrations(pool: Pool): Promise<void> {
  const connection = await pool.getConnection()
  let lockAcquired = false
  try {
    const [lockRows] = await connection.query<Array<RowDataPacket & { acquired: number }>>(
      "SELECT GET_LOCK('ai-server-console:migrations', 30) AS acquired",
    )
    lockAcquired = Number(lockRows[0]?.acquired) === 1
    if (!lockAcquired) throw new Error('could not acquire MySQL migration lock')

    for (const migration of migrations) {
      await connection.query(migration.statements[0])
      const [rows] = await connection.query<Array<RowDataPacket & { id: string }>>(
        'SELECT id FROM schema_migrations WHERE id = ?',
        [migration.id],
      )
      if (rows.length > 0) continue

      for (const statement of migration.statements.slice(1)) {
        await connection.query(statement)
      }
      await connection.query(
        'INSERT INTO schema_migrations (id, applied_at) VALUES (?, UTC_TIMESTAMP(6))',
        [migration.id],
      )
    }
  } finally {
    if (lockAcquired) await connection.query("SELECT RELEASE_LOCK('ai-server-console:migrations')")
    connection.release()
  }
}
