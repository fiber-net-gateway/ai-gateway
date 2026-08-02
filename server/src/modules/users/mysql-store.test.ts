import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

test('MySQL repository keeps runtime queries single-table and free of subqueries', async () => {
  const source = await readFile(new URL('./mysql-store.ts', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /\bJOIN\b/u)
  assert.doesNotMatch(source, /\bUNION\b/u)
  assert.doesNotMatch(source, /SELECT\s+COUNT\s*\(/u)
  assert.doesNotMatch(source, /\(\s*SELECT\b/u)
})
