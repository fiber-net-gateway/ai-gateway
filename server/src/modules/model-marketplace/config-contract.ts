export const int64Max = 9_223_372_036_854_775_807n

const unsignedDecimal = /^(0|[1-9][0-9]*)$/u

export function parseNonNegativeInt64(value: string): bigint | null {
  if (!unsignedDecimal.test(value)) return null
  const parsed = BigInt(value)
  return parsed <= int64Max ? parsed : null
}

export function int64JsonLiteral(value: string, positive: boolean): string {
  const parsed = parseNonNegativeInt64(value)
  if (parsed === null || (positive && parsed === 0n)) {
    throw new Error('stored rate-limit value is outside the ai-server int64 contract')
  }
  return `__marketplace_int64_${value}`
}
