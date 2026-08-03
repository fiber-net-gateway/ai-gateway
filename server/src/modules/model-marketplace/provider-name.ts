import type { RandomSource } from '../users/crypto.js'

function slugPrefix(logicalModelName: string): string {
  const normalized = logicalModelName.replace(/[^A-Za-z0-9_]/gu, '_').slice(0, 40)
  return normalized || 'model'
}

export function generateProviderName(logicalModelName: string, random: RandomSource): string {
  return `mp_${slugPrefix(logicalModelName)}_${random.bytes(6).toString('hex')}`
}
