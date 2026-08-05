import { createHash } from 'node:crypto'

import type { ModelAccessGroupRecord } from './types.js'

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

export function renderAccessGroup(
  group: ModelAccessGroupRecord,
  usernames: string[],
): { dataId: string; content: string; md5: string } {
  const users = [...new Set(usernames.filter(Boolean))].sort(compareUtf8)
  const content = JSON.stringify({
    version: group.revision + 1,
    data: { name: group.groupName, users },
  })
  return {
    dataId: `ploto.ai-llm.user-group.${group.groupName}`,
    content,
    md5: createHash('md5').update(content, 'utf8').digest('hex'),
  }
}
