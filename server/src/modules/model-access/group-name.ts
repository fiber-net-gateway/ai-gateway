import { createHash } from 'node:crypto'

export function generateAccessGroupName(
  environmentId: string,
  modelId: string,
  logicalModelName: string,
): string {
  const digest = createHash('sha256')
    .update(`${environmentId}\n${modelId}`)
    .digest('hex')
    .slice(0, 10)
  const prefix = logicalModelName.replace(/[^A-Za-z0-9_-]/gu, '_').slice(0, 50)
  return `ma_${prefix}_${digest}`.slice(0, 64)
}

export function validAccessGroupName(value: string): boolean {
  return value.length >= 1 && value.length <= 64 && /^[A-Za-z0-9_-]+$/u.test(value)
}
