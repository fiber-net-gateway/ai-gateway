function stringValue(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback
}

function integerValue(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name]?.trim()
  const value = raw ? Number(raw) : fallback
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return value
}

function httpUrl(name: string, fallback: string): string {
  const url = new URL(stringValue(name, fallback))
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${name} must use http or https`)
  }
  return url.toString().replace(/\/$/u, '')
}

export interface DemoProviderConfig {
  host: string
  port: number
}

export function loadDemoProviderConfig(): DemoProviderConfig {
  return {
    host: stringValue('DEMO_PROVIDER_HOST', '0.0.0.0'),
    port: integerValue('DEMO_PROVIDER_PORT', 8081, 1, 65_535),
  }
}

export interface DemoBootstrapConfig {
  consoleUrl: string
  username: string
  providerBaseUrl: string
  timeoutMillis: number
}

export function loadDemoBootstrapConfig(): DemoBootstrapConfig {
  return {
    consoleUrl: httpUrl('DEMO_CONSOLE_URL', 'http://127.0.0.1:3000'),
    username: stringValue('DEMO_ADMIN_USERNAME', 'admin'),
    providerBaseUrl: httpUrl('DEMO_PROVIDER_BASE_URL', 'http://127.0.0.1:8081'),
    timeoutMillis: integerValue('DEMO_BOOTSTRAP_TIMEOUT_MS', 120_000, 5_000, 600_000),
  }
}

export interface AuditForwarderConfig {
  consoleUrl: string
  ingestToken: string
  auditPath: string
  statePath: string
  instanceId: string
  pollMillis: number
  batchSize: number
  maxReadBytes: number
}

export function loadAuditForwarderConfig(): AuditForwarderConfig {
  const ingestToken = process.env.AUDIT_INGEST_TOKEN ?? ''
  if (Buffer.byteLength(ingestToken, 'utf8') < 32 || /\s/u.test(ingestToken)) {
    throw new Error('AUDIT_INGEST_TOKEN must contain at least 32 bytes and no whitespace')
  }
  const instanceId = stringValue('AUDIT_FORWARDER_INSTANCE_ID', 'ai-server-demo-1')
  if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(instanceId)) {
    throw new Error('AUDIT_FORWARDER_INSTANCE_ID is invalid')
  }
  return {
    consoleUrl: httpUrl('AUDIT_FORWARDER_CONSOLE_URL', 'http://127.0.0.1:3000'),
    ingestToken,
    auditPath: stringValue('AUDIT_FORWARDER_FILE', '/var/log/ai-server/audit.ndjson'),
    statePath: stringValue('AUDIT_FORWARDER_STATE_FILE', '/var/lib/audit-forwarder/state.json'),
    instanceId,
    pollMillis: integerValue('AUDIT_FORWARDER_POLL_MS', 1_000, 100, 60_000),
    batchSize: integerValue('AUDIT_FORWARDER_BATCH_SIZE', 50, 1, 100),
    maxReadBytes: integerValue(
      'AUDIT_FORWARDER_MAX_READ_BYTES',
      4 * 1024 * 1024,
      64 * 1024,
      16 * 1024 * 1024,
    ),
  }
}
