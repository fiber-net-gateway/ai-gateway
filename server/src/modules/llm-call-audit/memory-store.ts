import type {
  LlmCallAuditListQuery,
  LlmCallAuditRecord,
  LlmCallAuditStore,
  NewLlmCallAuditRecord,
} from './types.js'

function copy<T>(value: T): T {
  return structuredClone(value)
}

function beforeCursor(
  record: LlmCallAuditRecord,
  cursor: NonNullable<LlmCallAuditListQuery['cursor']>,
): boolean {
  return (
    record.occurredAt < cursor.occurredAt ||
    (record.occurredAt === cursor.occurredAt && record.id < cursor.id)
  )
}

export class MemoryLlmCallAuditStore implements LlmCallAuditStore {
  private readonly records = new Map<string, LlmCallAuditRecord>()

  async appendBatch(records: NewLlmCallAuditRecord[]) {
    let accepted = 0
    let duplicates = 0
    for (const record of records) {
      const key = `${record.environmentId}:${record.eventKey}`
      if (this.records.has(key)) {
        duplicates += 1
        continue
      }
      this.records.set(key, copy(record))
      accepted += 1
    }
    return { accepted, duplicates }
  }

  async listForOwner(query: LlmCallAuditListQuery): Promise<LlmCallAuditRecord[]> {
    const search = query.search?.toLocaleLowerCase()
    return [...this.records.values()]
      .filter((record) => {
        if (record.environmentId !== query.environmentId) return false
        if (record.ownerUserId !== query.ownerUserId) return false
        if (query.cursor && !beforeCursor(record, query.cursor)) return false
        if (query.from && record.occurredAt < query.from) return false
        if (query.to && record.occurredAt > query.to) return false
        if (query.outcome && record.outcome !== query.outcome) return false
        if (query.protocol && record.clientProtocol !== query.protocol) return false
        if (
          search &&
          !record.sourceRequestId.toLocaleLowerCase().includes(search) &&
          !record.path.toLocaleLowerCase().includes(search) &&
          !record.requestedModel.toLocaleLowerCase().includes(search)
        ) {
          return false
        }
        return true
      })
      .sort(
        (left, right) =>
          right.occurredAt.localeCompare(left.occurredAt) || right.id.localeCompare(left.id),
      )
      .slice(0, query.limit)
      .map(copy)
  }
}
