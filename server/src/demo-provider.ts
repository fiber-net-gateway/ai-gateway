import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'

import { loadDemoProviderConfig } from './config/demo.js'

const config = loadDemoProviderConfig()

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > 1024 * 1024) throw new Error('request body too large')
    chunks.push(buffer)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('request body must be an object')
  }
  return value as Record<string, unknown>
}

function lastUserText(body: Record<string, unknown>): string {
  if (!Array.isArray(body.messages)) return 'demo request'
  for (let index = body.messages.length - 1; index >= 0; index -= 1) {
    const message = body.messages[index]
    if (typeof message !== 'object' || message === null) continue
    const candidate = message as Record<string, unknown>
    if (candidate.role === 'user' && typeof candidate.content === 'string') {
      return candidate.content.slice(0, 120)
    }
  }
  return 'demo request'
}

function usage(text: string) {
  const promptTokens = Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 4))
  return { prompt_tokens: promptTokens, completion_tokens: 12, total_tokens: promptTokens + 12 }
}

function json(reply: ServerResponse, status: number, body: unknown): void {
  const content = JSON.stringify(body)
  reply.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(content),
  })
  reply.end(content)
}

async function chat(request: IncomingMessage, reply: ServerResponse): Promise<void> {
  const body = await readJson(request)
  const model = typeof body.model === 'string' ? body.model : 'fiber-demo-upstream'
  const input = lastUserText(body)
  const content = `Fiber demo provider received: ${input}`
  const id = `chatcmpl-demo-${randomUUID()}`
  const tokenUsage = usage(input)
  if (body.stream === true) {
    reply.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    reply.write(
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })}\n\n`,
    )
    reply.write(
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`,
    )
    reply.write(
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: tokenUsage })}\n\n`,
    )
    reply.end('data: [DONE]\n\n')
    return
  }
  json(reply, 200, {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1_000),
    model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: tokenUsage,
  })
}

const server = createServer((request, reply) => {
  if (request.method === 'GET' && request.url === '/health') {
    json(reply, 200, { status: 'ok', service: 'fiber-demo-provider' })
    return
  }
  if (request.method === 'POST' && request.url === '/v1/chat/completions') {
    void chat(request, reply).catch(() => {
      if (!reply.headersSent) json(reply, 400, { error: { message: 'invalid demo request' } })
      else reply.destroy()
    })
    return
  }
  json(reply, 404, { error: { message: 'not found' } })
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => server.close())
}

server.listen(config.port, config.host, () => {
  process.stdout.write(`demo provider listening on ${config.host}:${config.port}\n`)
})
