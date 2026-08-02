export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'DomainError'
  }
}

export function assertDomain(
  condition: unknown,
  code: string,
  statusCode: number,
  message: string,
  details?: Record<string, unknown>,
): asserts condition {
  if (!condition) {
    throw new DomainError(code, statusCode, message, details)
  }
}
