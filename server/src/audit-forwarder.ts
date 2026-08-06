import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import { scanAuditBuffer } from './audit-forwarder-core.js'
import { loadAuditForwarderConfig } from './config/demo.js'

const config = loadAuditForwarderConfig()
let stopping = false

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    stopping = true
  })
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds))
}

async function loadOffset(): Promise<number> {
  try {
    const parsed = JSON.parse(await readFile(config.statePath, 'utf8')) as { offset?: unknown }
    return typeof parsed.offset === 'number' &&
      Number.isSafeInteger(parsed.offset) &&
      parsed.offset >= 0
      ? parsed.offset
      : 0
  } catch {
    return 0
  }
}

async function saveOffset(offset: number): Promise<void> {
  await mkdir(dirname(config.statePath), { recursive: true })
  const temporary = `${config.statePath}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify({ offset })}\n`, { mode: 0o600 })
  await rename(temporary, config.statePath)
}

async function readChunk(offset: number): Promise<{ buffer: Buffer; offset: number }> {
  const metadata = await stat(config.auditPath)
  const safeOffset = metadata.size < offset ? 0 : offset
  const length = Math.min(config.maxReadBytes, Math.max(metadata.size - safeOffset, 0))
  if (length === 0) return { buffer: Buffer.alloc(0), offset: safeOffset }
  const file = await open(config.auditPath, 'r')
  try {
    const buffer = Buffer.allocUnsafe(length)
    const result = await file.read(buffer, 0, length, safeOffset)
    return { buffer: buffer.subarray(0, result.bytesRead), offset: safeOffset }
  } finally {
    await file.close()
  }
}

async function send(records: ReturnType<typeof scanAuditBuffer>['records']): Promise<void> {
  const response = await fetch(`${config.consoleUrl}/api/internal/llm-call-audits/batches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.ingestToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      schemaVersion: 1,
      instanceId: config.instanceId,
      sentAt: new Date().toISOString(),
      records,
    }),
    signal: AbortSignal.timeout(10_000),
  })
  if (response.status !== 202) throw new Error(`console returned ${response.status}`)
}

async function run(): Promise<void> {
  let offset = await loadOffset()
  let failures = 0
  while (!stopping) {
    try {
      const chunk = await readChunk(offset)
      if (chunk.offset !== offset) {
        offset = chunk.offset
        await saveOffset(offset)
      }
      if (chunk.buffer.length === 0) {
        await delay(config.pollMillis)
        continue
      }
      const scan = scanAuditBuffer(chunk.buffer, offset, config.batchSize, new Date())
      if (scan.records.length > 0) await send(scan.records)
      if (scan.commitOffset > offset) {
        offset = scan.commitOffset
        await saveOffset(offset)
      }
      if (scan.records.length > 0 || scan.skipped > 0) {
        process.stdout.write(
          `[audit-forwarder] accepted=${scan.records.length} skipped=${scan.skipped} offset=${offset}\n`,
        )
      }
      failures = 0
      if (scan.incompleteTail) await delay(config.pollMillis)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        failures += 1
        process.stderr.write(
          `[audit-forwarder] delivery failed (${failures}): ${error instanceof Error ? error.message : 'unknown error'}\n`,
        )
      }
      await delay(Math.min(config.pollMillis * 2 ** Math.min(failures, 5), 30_000))
    }
  }
}

run().catch((error) => {
  process.stderr.write(
    `[audit-forwarder] stopped: ${error instanceof Error ? error.message : 'unknown error'}\n`,
  )
  process.exitCode = 1
})
